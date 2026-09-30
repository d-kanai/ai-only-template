// @vitest-environment node
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { Database } from "../infra/database";

// 各 feature の *.api.ts は、モジュールの評価時に `new <Api>(new <Command>(new Postgres<X>Repository(getDatabase().db)))` で
// Route Handler を 1 回だけ組み立てる（組み立ては api ファイルごと。.claude/rules/backend.md の「presentation」）。
// このテストは「全 feature の api ファイルをすべて読み込んでも、Repository に渡る db は 1 つ（= プールは Next のサーバプロセスで 1 つ）」を固定する。
// WHY: api ファイルごとに getDatabase() を呼ぶ設計は、getDatabase が同じものを返すことに依存している。呼ぶたびに
//   新しいプールを作る実装に変わると、api ファイルの数だけプールができて max_connections を食いつぶす（Issue #132）。
//   モジュールの読み直し（HMR）で同じプールが返ることは shared/infra/database.test.ts が固定する。
// WHY shared に置く: 検査するのは特定の feature ではなく、feature をまたぐプール（shared/infra/database.ts）の使われ方。
//   todo の下に置くと、feature を足したときにその feature の api ファイルが対象から漏れる（Issue #180）。

// apps/backend/features/。feature・api ファイル・Repository の数を固定せずに列挙するのは、足したときにこのテストを直さなくてよいようにするため。
const FEATURES_DIR = new URL("../../features/", import.meta.url);

function featureNames(): string[] {
  return readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

// features/<feature>/<layer>/ の中で、名前が suffix で終わるファイルの絶対パス。
// WHY 絶対パス: vi.doMock と import() はこのテストファイルからの相対で解決されるので、api ファイルが書く
//   "../infra/<x>-repository.postgres" と同じモジュールを指すよう、ファイルの実体のパスで渡す。
function filesIn(features: string[], layer: string, suffix: string): string[] {
  return features.flatMap((feature) => {
    const dir = new URL(`${feature}/${layer}/`, FEATURES_DIR);
    // WHY 無い層を飛ばす: api や Postgres の Repository を持たない feature もありうる（数の検証は下の toBeGreaterThan）。
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(suffix))
      .map((file) => fileURLToPath(new URL(file, dir)));
  });
}

const features = featureNames();
const apiFiles = filesIn(features, "presentation", ".api.ts");
const repositoryFiles = filesIn(features, "infra", "-repository.postgres.ts");

// Repository のクラス（コンストラクタで db を受け取る）か。export の中から関数ではなくクラスだけを包むために見る。
// WHY prototype で判定: アロー関数は prototype を持たないので包まない。Repository のファイルの export は今はクラスだけ。
//   通常の function 宣言を export すると prototype を持つのでクラスとして包まれ、new 無しで呼ぶと TypeError
//   （Class constructor ... cannot be invoked without 'new'）になる。そういう export を足すときはここの判定を直す。
function isConstructor(value: unknown): value is new (db: Database) => object {
  return typeof value === "function" && value.prototype !== undefined;
}

afterEach(async () => {
  for (const file of repositoryFiles) vi.doUnmock(file);
  const { closeDatabase } = await import("../infra/database");
  await closeDatabase();
  vi.resetModules();
});

test("全 feature の api ファイルをすべて読み込んでも、Repository に渡る db は getDatabase() の 1 つだけ", async () => {
  // WHY resetModules: このファイルより前に読み込まれた api モジュールが残っていると、組み立てが再実行されず記録できない。
  vi.resetModules();
  const received: Database[] = [];
  for (const file of repositoryFiles) {
    // WHY モック: api ファイルは Repository の実体を export しないので、受け取った db を記録するサブクラスに差し替えて結線を確かめる
    vi.doMock(file, async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return Object.fromEntries(
        Object.entries(actual).map(([name, value]) => {
          if (!isConstructor(value)) return [name, value];
          // WHY クラス名に依存しない: feature ごとに PostgresTodoRepository などの名前が違うので、クラスの export をすべて包む。
          class RecordingRepository extends value {
            constructor(db: Database) {
              super(db);
              received.push(db);
            }
          }
          return [name, RecordingRepository];
        }),
      );
    });
  }

  await Promise.all(apiFiles.map((file) => import(file)));
  const { getDatabase } = await import("../infra/database");

  // 列挙が空だと Repository も 0 個で、下の検証が意味を持たないまま通る。
  expect(features.length).toBeGreaterThan(0);
  expect(apiFiles.length).toBeGreaterThan(0);
  expect(repositoryFiles.length).toBeGreaterThan(0);
  // api ファイルごとに 1 回組み立てる（Repository は api ファイルの数だけ作られる）。
  expect(received).toHaveLength(apiFiles.length);
  // 渡った db はすべて同じ 1 つで、それは getDatabase() が返す db。
  expect(new Set(received).size).toBe(1);
  expect(received[0]).toBe(getDatabase().db);
});
