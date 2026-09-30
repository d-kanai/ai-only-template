// @vitest-environment node
import { readdirSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import type { Database } from "../../../shared/infra/database";

// 各 *.api.ts は、モジュールの評価時に `new <Api>(new <Command>(new PostgresTodoRepository(getDatabase().db)))` で
// Route Handler を 1 回だけ組み立てる（組み立ては api ファイルごと。list-todos.api.ts の GET のコメント）。
// このテストは「api ファイルをすべて読み込んでも、Repository に渡る db は 1 つ（= プールは Next のサーバプロセスで 1 つ）」を固定する。
// WHY: api ファイルごとに getDatabase() を呼ぶ設計は、getDatabase が同じものを返すことに依存している。呼ぶたびに
//   新しいプールを作る実装に変わると、api ファイルの数だけプールができて max_connections を食いつぶす（Issue #132）。
//   モジュールの読み直し（HMR）で同じプールが返ることは shared/infra/database.test.ts が固定する。

// presentation の api ファイル（拡張子を除いた名前）。数を固定せずに読むのは、api を足したときにこのテストを直さなくてよいようにするため。
function apiModuleNames(): string[] {
  return readdirSync(new URL(".", import.meta.url))
    .filter((file) => file.endsWith(".api.ts"))
    .map((file) => file.replace(/\.ts$/, ""));
}

afterEach(async () => {
  vi.doUnmock("../infra/todo-repository.postgres");
  const { closeDatabase } = await import("../../../shared/infra/database");
  await closeDatabase();
  vi.resetModules();
});

test("api ファイルをすべて読み込んでも、Repository に渡る db は getDatabase() の 1 つだけ", async () => {
  // WHY resetModules: このファイルより前に読み込まれた api モジュールが残っていると、組み立てが再実行されず記録できない。
  vi.resetModules();
  const received: Database[] = [];
  // Repository を、受け取った db を記録するサブクラスに差し替える（api ファイルは Repository の実体を export しないため）。
  vi.doMock("../infra/todo-repository.postgres", async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../infra/todo-repository.postgres")
      >();
    class RecordingRepository extends actual.PostgresTodoRepository {
      constructor(db: Database) {
        super(db);
        received.push(db);
      }
    }
    return { ...actual, PostgresTodoRepository: RecordingRepository };
  });

  const names = apiModuleNames();
  await Promise.all(names.map((name) => import(`./${name}`)));
  const { getDatabase } = await import("../../../shared/infra/database");

  expect(names.length).toBeGreaterThan(0);
  // api ファイルごとに 1 回組み立てる（Repository は api ファイルの数だけ作られる）。
  expect(received).toHaveLength(names.length);
  // 渡った db はすべて同じ 1 つで、それは getDatabase() が返す db。
  expect(new Set(received).size).toBe(1);
  expect(received[0]).toBe(getDatabase().db);
});
