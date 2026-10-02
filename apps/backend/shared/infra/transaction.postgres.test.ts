// @vitest-environment node
import { sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import { changeLogs } from "./schema";
import { PostgresTransactionRunner } from "./transaction.postgres";
import { PostgresWriter } from "./writer";

afterEach(() => {
  vi.restoreAllMocks();
});

// 書き込みに使う架空の表（writer.test.ts と同じ理由で feature の表を使わない）。
const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  itemName: text("item_name").notNull(),
});

const ID = "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

// 実 Postgres（compose.yaml）に対して実行する。
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  await database.db.execute(
    sql`create table items (id uuid primary key, item_name text not null)`,
  );
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate change_logs, items`);
  // WHY console.log を黙らせる: Writer が書き込みの前後にログを出す（形は writer.test.ts が固定する）。
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("PostgresTransactionRunner", () => {
  test("work が resolve したら COMMIT し、work の値を返す（書いた行が別の接続から見える）", async () => {
    // given
    const runner = new PostgresTransactionRunner(database.db);

    // when
    const result = await runner.run(async (tx) => {
      await PostgresWriter.of(tx).insert(items, [{ id: ID, itemName: "牛乳" }]);
      return "done";
    });

    // then
    expect(result).toBe("done");
    await expect(database.db.select().from(items)).resolves.toStrictEqual([
      { id: ID, itemName: "牛乳" },
    ]);
  });

  test("work が reject したら ROLLBACK し、同じ例外で reject する（書いた行も変更履歴も残らない）", async () => {
    // given
    const runner = new PostgresTransactionRunner(database.db);
    const failure = new Error("boom");

    // when
    const promise = runner.run(async (tx) => {
      await PostgresWriter.of(tx).insert(items, [{ id: ID, itemName: "牛乳" }]);
      throw failure;
    });

    // then
    await expect(promise).rejects.toBe(failure);

    await expect(database.db.select().from(items)).resolves.toStrictEqual([]);
    await expect(database.db.select().from(changeLogs)).resolves.toStrictEqual(
      [],
    );
  });

  // WHY work の中は 1 つのトランザクション: 同じ tx で書いた行は COMMIT の前でも同じ tx から見え、別の接続からは見えない。
  test("work に渡す tx は、1 つのトランザクションの PostgresWriter（COMMIT の前は別の接続から書いた行が見えない）", async () => {
    // given
    const runner = new PostgresTransactionRunner(database.db);

    // when
    const seen = await runner.run(async (tx) => {
      const writer = PostgresWriter.of(tx);
      await writer.insert(items, [{ id: ID, itemName: "牛乳" }]);
      return {
        isWriter: writer instanceof PostgresWriter,
        inside: await writer.select().from(items),
        outside: await database.db.select().from(items),
      };
    });

    // then
    expect(seen).toStrictEqual({
      isWriter: true,
      inside: [{ id: ID, itemName: "牛乳" }],
      outside: [],
    });
  });

  // WHY actorId を runner が持つ: 変更履歴の actor は要求の文脈（ログインした利用者）で、要求ごとに組み立てる runner に渡す。
  test("組み立てで渡した actorId を変更履歴の actorId に入れる（既定は null）", async () => {
    // given: beforeEach で change_logs と items を空にしてある
    // when
    await new PostgresTransactionRunner(database.db, ACTOR_ID).run((tx) =>
      PostgresWriter.of(tx).insert(items, [{ id: ID, itemName: "牛乳" }]),
    );
    await new PostgresTransactionRunner(database.db).run((tx) =>
      PostgresWriter.of(tx).delete(items, ID),
    );
    const actors = await database.db
      .select({ operation: changeLogs.operation, actorId: changeLogs.actorId })
      .from(changeLogs);

    // then
    expect(actors).toEqual(
      expect.arrayContaining([
        { operation: "insert", actorId: ACTOR_ID },
        { operation: "delete", actorId: null },
      ]),
    );
    expect(actors).toHaveLength(2);
  });
});
