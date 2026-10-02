// @vitest-environment node
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { Database } from "../infra/database";

// 各 feature の *.api.ts は、モジュールの評価時に `new <Api>(new <Command>(new Postgres<X>Repository(AppDatabase.get().db)))` で
// Route Handler を 1 回だけ組み立てる（組み立ては api ファイルごと。.claude/rules/code/backend.md の「presentation」）。
// このテストは「全 feature の api ファイルをすべて読み込んでも、Repository に渡る db は 1 つ（= プールは Next のサーバプロセスで 1 つ）」を固定する。
// WHY: api ファイルごとに AppDatabase.get() を呼ぶ設計は、AppDatabase.get が同じものを返すことに依存している。呼ぶたびに
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

// features/<feature>/internal/<layer>/ の中で、名前が suffix で終わるファイルの絶対パス。
// WHY 絶対パス: vi.doMock と import() はこのテストファイルからの相対で解決されるので、api ファイルが書く
//   "../infra/<x>-repository.postgres" と同じモジュールを指すよう、ファイルの実体のパスで渡す。
function filesIn(features: string[], layer: string, suffix: string): string[] {
  return features.flatMap((feature) => {
    const dir = new URL(`${feature}/internal/${layer}/`, FEATURES_DIR);
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

// Repository のコンストラクタが受け取った db（beforeAll で api ファイルを読み込んだときに記録する）。
const received: Database[] = [];

// WHY 読み込みを test ではなく beforeAll で行う（Issue #202）: Stryker の vitest-runner は beforeEach でテスト id を立て、
//   afterEach で消す（@stryker-mutator/vitest-runner 10.0.0 の dist/src/stryker-setup.js）。test の中で api ファイルを
//   読み込むと、そこから読み込まれる schema.ts などのモジュールの評価（読み込み時にだけ実行される static な変異）が
//   「このテスト中に実行された」と記録され、static かつテストに覆われた hybrid になる。ignoreStatic（stryker.config.mjs）は
//   hybrid を Ignored にせず、覆ったテストだけで判定するので、実行時の振る舞いに現れない列定義の変異がこの 1 テストで
//   判定されて Survived になっていた（schema.ts の 35 件）。beforeAll はテスト id が無い文脈なので、ここでの評価は
//   static のままになる。AppDatabase.get() の呼び出しは test の中に残し、database.ts の変異はこのテストでも判定させる。
beforeAll(async () => {
  // WHY resetModules: このファイルより前に読み込まれた api モジュールが残っていると、組み立てが再実行されず記録できない。
  vi.resetModules();
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
});

// WHY afterAll: 読み込みを beforeAll で行うので、モックの解除とプールの後始末もファイルの最後に 1 回行う。
afterAll(async () => {
  for (const file of repositoryFiles) vi.doUnmock(file);
  const { AppDatabase } = await import("../infra/database");
  await AppDatabase.close();
  vi.resetModules();
});

test("全 feature の api ファイルをすべて読み込んでも、Repository に渡る db は AppDatabase.get() の 1 つだけ", async () => {
  // given: beforeAll で全 feature の api ファイルを読み込み、Repository が受け取った db を記録してある
  // when
  // beforeAll の resetModules 後に読み込まれた database モジュール（api ファイルが使ったもの）を取る。
  const { AppDatabase } = await import("../infra/database");

  // then
  // 列挙が空だと Repository も 0 個で、下の検証が意味を持たないまま通る。
  expect(features.length).toBeGreaterThan(0);
  expect(apiFiles.length).toBeGreaterThan(0);
  expect(repositoryFiles.length).toBeGreaterThan(0);
  // api ファイルごとに 1 回組み立てる（Repository は api ファイルの数だけ作られる）。
  expect(received).toHaveLength(apiFiles.length);
  // 渡った db はすべて同じ 1 つで、それは AppDatabase.get() が返す db。
  expect(new Set(received).size).toBe(1);
  expect(received[0]).toBe(AppDatabase.get().db);
});
