// @vitest-environment node
import { now } from "@repo/shared/now";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
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
import { DomainError } from "../domain/domain-error";
import { deleteEntry, insertEntry } from "./change-log";
import { changeLogs } from "./schema";
import { writeInTransaction } from "./write";

// WHY 時計（now）を差し替える: ログの行の time と、recordChange が occurred_at に入れる時刻を決めた値にして、
//   行を丸ごと比べるため。
vi.mock("@repo/shared/now");

afterEach(() => {
  vi.mocked(now).mockReset();
  vi.restoreAllMocks();
});

// 書き込みの本体に使う架空の表。WHY 実在の表（todos）を使わない: writeInTransaction は表によらない汎用の処理で、
//   shared/infra のテストから feature の表を参照しない。表はテスト用のスキーマに作る（beforeAll）。
const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  itemName: text("item_name").notNull(),
});

const ID = "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e";
const OTHER_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = new Date("2026-09-30T09:00:00.000Z");

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
  vi.mocked(now).mockReturnValue(TIMESTAMP);
});

// logger（@repo/shared/logger）は info を console.log、warn を console.warn に 1 行の JSON で渡す。出力を黙らせて行を読む。
function captureLogs() {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const lines = (spy: typeof info) =>
    spy.mock.calls.map(([line]) => JSON.parse(String(line)));
  return { info: () => lines(info), warn: () => lines(warn) };
}

// performance.now の 1 回目（開始）と 2 回目（終了）の値を決める。所要時間（event.duration_ms）はその差。
function fixElapsed(start: number, end: number) {
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(start)
    .mockReturnValueOnce(end);
}

describe("writeInTransaction", () => {
  // 行の形は Cloud Logging の特別フィールドと OTel semconv の DB の名前（db.collection.name・db.operation.name。Issue #209。
  //   https://opentelemetry.io/docs/specs/semconv/registry/attributes/db/ ）。
  test("書き込みの前後に 1 行ずつログ（event.name は db_write、phase は start / done。表・行の id・操作、後は所要時間と記録の表・行の id・操作）を出す", async () => {
    const logs = captureLogs();
    fixElapsed(1000, 1012.4);
    const row = { id: ID, itemName: "牛乳" };
    let linesBeforeWrite: unknown[] = [];

    await writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "insert" },
      async (tx) => {
        linesBeforeWrite = logs.info();
        await tx.insert(items).values(row);
        return [
          insertEntry(items, row, null),
          deleteEntry(items, { id: OTHER_ID, itemName: "卵" }, null),
        ];
      },
    );

    const start = {
      severity: "INFO",
      time: TIMESTAMP.toISOString(),
      message: "db write start",
      event: { name: "db_write", phase: "start" },
      db: { collection: { name: "items" }, operation: { name: "insert" } },
      row_id: ID,
    };
    expect(linesBeforeWrite).toStrictEqual([start]);
    // WHY changes に値（before / after）を出さない: 個人情報を含みうる。値は change_logs に残る。
    expect(logs.info()).toStrictEqual([
      start,
      {
        severity: "INFO",
        time: TIMESTAMP.toISOString(),
        message: "db write done",
        event: { name: "db_write", phase: "done", duration_ms: 12 },
        db: { collection: { name: "items" }, operation: { name: "insert" } },
        row_id: ID,
        changes: [
          { table: "items", row_id: ID, operation: "insert" },
          { table: "items", row_id: OTHER_ID, operation: "delete" },
        ],
      },
    ]);
    expect(logs.warn()).toStrictEqual([]);
  });

  // WHY 四捨五入: 12.6 は 13。切り捨て・差でなく和（2012.6）では落ちる。
  test("所要時間はミリ秒の整数に丸める（開始と終了の差を四捨五入）", async () => {
    const logs = captureLogs();
    fixElapsed(1000, 1012.6);

    await writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "update" },
      async () => [],
    );

    expect(logs.info()[1]).toMatchObject({ event: { duration_ms: 13 } });
  });

  test("書き込みの本体と、返した記録（change_logs）を同じトランザクションで書く", async () => {
    captureLogs();
    const row = { id: ID, itemName: "牛乳" };
    const entry = insertEntry(items, row, null);

    await writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "insert" },
      async (tx) => {
        await tx.insert(items).values(row);
        return [entry];
      },
    );

    await expect(database.db.select().from(items)).resolves.toStrictEqual([
      row,
    ]);
    await expect(database.db.select().from(changeLogs)).resolves.toStrictEqual([
      { id: expect.any(String), ...entry, occurredAt: TIMESTAMP },
    ]);
  });

  test("記録が 0 件なら change_logs に何も書かず、後のログの changes は空配列になる", async () => {
    const logs = captureLogs();

    await writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "delete" },
      async () => [],
    );

    await expect(database.db.select().from(changeLogs)).resolves.toEqual([]);
    expect(logs.info()[1]).toMatchObject({
      message: "db write done",
      changes: [],
    });
  });

  // WHY warn（error にしない）: not_found などの DomainError は 404 の正常な結果。500 になる例外は presentation の
  //   toProblemResponse が logger.error で別に残す。
  test("書き込みが失敗すると、失敗のログ（所要時間と例外の type・message）を warn で 1 行出し、同じ例外を投げ直し、本体を戻す", async () => {
    const logs = captureLogs();
    fixElapsed(2000, 2003);
    const error = new DomainError("not_found", "todo.notFound", { id: ID });

    const result = writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "update" },
      async (tx) => {
        await tx.insert(items).values({ id: ID, itemName: "牛乳" });
        throw error;
      },
    );

    await expect(result).rejects.toBe(error);
    expect(logs.info()).toStrictEqual([
      {
        severity: "INFO",
        time: TIMESTAMP.toISOString(),
        message: "db write start",
        event: { name: "db_write", phase: "start" },
        db: { collection: { name: "items" }, operation: { name: "update" } },
        row_id: ID,
      },
    ]);
    expect(logs.warn()).toStrictEqual([
      {
        severity: "WARNING",
        time: TIMESTAMP.toISOString(),
        message: "db write failed",
        event: { name: "db_write", phase: "failed", duration_ms: 3 },
        db: { collection: { name: "items" }, operation: { name: "update" } },
        row_id: ID,
        error: { type: "DomainError", message: error.message },
      },
    ]);
    await expect(database.db.select().from(items)).resolves.toEqual([]);
  });

  // WHY DB のエラーは message を出さない: drizzle-orm の DrizzleQueryError の message は「Failed query: <SQL>\nparams: <値>」で、
  //   行の値（個人情報を含みうる）がログに出る。元の pg のエラーの message も、データ例外（SQLSTATE 22 系。22P02 の
  //   invalid input syntax for type uuid: "<入力>" など）は入力値を含む。何の失敗かは SQLSTATE（db.response.status_code）と
  //   制約の名前（constraint）で分かる。
  // 失敗のログの行（DB のエラーの項目だけを変える）。statusCode が無ければ db.response を出さない。
  function failedLine(
    operation: string,
    durationMs: number,
    failure: { statusCode?: string; rest: object },
  ) {
    return {
      severity: "WARNING",
      time: TIMESTAMP.toISOString(),
      message: "db write failed",
      event: { name: "db_write", phase: "failed", duration_ms: durationMs },
      db: {
        collection: { name: "items" },
        operation: { name: operation },
        ...(failure.statusCode === undefined
          ? {}
          : { response: { status_code: failure.statusCode } }),
      },
      row_id: ID,
      ...failure.rest,
    };
  }

  test("DB のエラー（一意制約違反）のとき、失敗のログは pg のエラーの name（error.type）・SQLSTATE（23505）・制約の名前だけを出し、message（SQL と値）を出さない", async () => {
    const row = { id: ID, itemName: "牛乳" };
    await database.db.insert(items).values(row);
    const logs = captureLogs();
    fixElapsed(3000, 3004);

    const result = writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "insert" },
      async (tx) => {
        await tx.insert(items).values(row);
        return [];
      },
    );

    await expect(result).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(logs.warn()).toStrictEqual([
      failedLine("insert", 4, {
        statusCode: "23505",
        rest: { constraint: "items_pkey", error: { type: "error" } },
      }),
    ]);
    expect(JSON.stringify(logs.warn())).not.toContain("牛乳");
  });

  // 22P02 の pg の message は「invalid input syntax for type uuid: "<入力>"」で、入力値をそのまま含む。
  test("DB のエラー（データ例外 22P02。uuid の形でない値）のとき、失敗のログの行のどこにも入力値を含まない", async () => {
    const input = "牛乳-not-a-uuid";
    const logs = captureLogs();
    fixElapsed(0, 2);

    const result = writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "delete" },
      async (tx) => {
        await tx.delete(items).where(eq(items.id, input));
        return [];
      },
    );

    await expect(result).rejects.toMatchObject({
      cause: {
        code: "22P02",
        message: `invalid input syntax for type uuid: "${input}"`,
      },
    });
    expect(logs.warn()).toStrictEqual([
      failedLine("delete", 2, {
        statusCode: "22P02",
        rest: { error: { type: "error" } },
      }),
    ]);
    expect(JSON.stringify(logs.warn())).not.toContain(input);
  });

  // 想定外の形の DrizzleQueryError（cause が Error でない・code / constraint が文字列でない）。cause が Error でなければ元の例外を、
  //   code / constraint が文字列でなければその項目を出さない。
  test.each([
    [
      "cause が無いときは、元の DrizzleQueryError をそのまま出す",
      new DrizzleQueryError("select 1", [], undefined),
      {
        rest: {
          error: { type: "Error", message: "Failed query: select 1\nparams: " },
        },
      },
    ],
    [
      "cause が code・constraint を持たない Error のときは、cause の name だけを出す",
      new DrizzleQueryError("select 1", [], new Error("boom")),
      { rest: { error: { type: "Error" } } },
    ],
    [
      "cause の code・constraint が文字列でないときは、db.response・constraint を出さない",
      new DrizzleQueryError(
        "select 1",
        [],
        Object.assign(new Error("boom"), { code: 23505, constraint: 1 }),
      ),
      { rest: { error: { type: "Error" } } },
    ],
  ])("DB のエラーの %s", async (_label, thrown, expected) => {
    const logs = captureLogs();
    fixElapsed(0, 1);

    const result = writeInTransaction(
      database.db,
      { table: items, rowId: ID, operation: "update" },
      async () => {
        throw thrown;
      },
    );

    await expect(result).rejects.toBe(thrown);
    expect(logs.warn()).toStrictEqual([failedLine("update", 1, expected)]);
  });

  // WHY 一時的な CHECK 制約で change_logs の INSERT を失敗させる: 記録を本体と別のトランザクション（またはトランザクションの
  //   外）で書くと、記録の失敗で本体だけが残る。not valid で既存の行を検査せずに張り、後始末（finally）で外す。
  test("記録（change_logs）の INSERT が失敗すると、本体の書き込みも戻し、失敗のログを出して例外を投げる", async () => {
    const logs = captureLogs();
    const row = { id: ID, itemName: "牛乳" };
    await database.db.execute(
      sql`alter table change_logs add constraint tmp_reject_all_logs check (table_name = '') not valid`,
    );
    try {
      const result = writeInTransaction(
        database.db,
        { table: items, rowId: ID, operation: "insert" },
        async (tx) => {
          await tx.insert(items).values(row);
          return [insertEntry(items, row, null)];
        },
      );

      await expect(result).rejects.toMatchObject({
        cause: { code: "23514" },
      });
      await expect(database.db.select().from(items)).resolves.toEqual([]);
      expect(logs.warn()).toMatchObject([
        { message: "db write failed", row_id: ID },
      ]);
      expect(logs.info()).toHaveLength(1);
    } finally {
      await database.db.execute(
        sql`alter table change_logs drop constraint tmp_reject_all_logs`,
      );
    }
  });
});
