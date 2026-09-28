// @vitest-environment node
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  createTestDatabase,
  type TestDatabase,
} from "@/backend/shared/infra/database.test-support";
import { DrizzleTransactionRunner } from "@/backend/shared/infra/drizzle-transaction-runner";

// 実 Postgres（compose.yaml）に対して、commit / rollback を確かめる。
// WHY todos ではなくこのテスト専用の表を使う: runner は feature（Todo）に依存しない共通部品で、
//   テストもマイグレーション（drizzle/）の中身に依存させないため。表はテスト用のスキーマの中に作る（database.test-support.ts）。
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.db.execute(sql`create table items (name text not null)`);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate items`);
});

async function itemNames(): Promise<string[]> {
  const result = await database.db.execute<{ name: string }>(
    sql`select name from items order by name`,
  );
  return result.rows.map((row) => row.name);
}

describe("DrizzleTransactionRunner", () => {
  test("fn が正常に終わると commit され、fn の中で保存した行が残る", async () => {
    const runner = new DrizzleTransactionRunner(database.db);

    await runner.run(async (tx) => {
      await tx.execute(sql`insert into items (name) values ('a')`);
      await tx.execute(sql`insert into items (name) values ('b')`);
    });

    await expect(itemNames()).resolves.toEqual(["a", "b"]);
  });

  test("fn が例外を投げると rollback され、fn の中で保存した行は残らず、同じ例外を投げ直す", async () => {
    const runner = new DrizzleTransactionRunner(database.db);
    const error = new Error("途中で失敗");

    await expect(
      runner.run(async (tx) => {
        await tx.execute(sql`insert into items (name) values ('a')`);
        throw error;
      }),
    ).rejects.toBe(error);

    await expect(itemNames()).resolves.toEqual([]);
  });

  test("fn の戻り値をそのまま返す", async () => {
    const runner = new DrizzleTransactionRunner(database.db);

    await expect(runner.run(async () => ({ id: 1 }))).resolves.toEqual({
      id: 1,
    });
  });

  test("fn に渡る executor はトランザクションの中にある（commit 前の行は外から見えない）", async () => {
    const runner = new DrizzleTransactionRunner(database.db);

    const seenFromOutside = await runner.run(async (tx) => {
      await tx.execute(sql`insert into items (name) values ('a')`);
      return itemNames();
    });

    expect(seenFromOutside).toEqual([]);
    await expect(itemNames()).resolves.toEqual(["a"]);
  });
});
