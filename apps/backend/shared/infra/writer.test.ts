// @vitest-environment node
import { now } from "@repo/shared/now";
import { DrizzleQueryError, sql } from "drizzle-orm";
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
import type { Transaction } from "../application/transaction";
import { changeLogs } from "./schema";
import {
  type DrizzleTransaction,
  PostgresWriter,
  transactionOf,
  writerOf,
} from "./writer";

// WHY 時計（now）を差し替える: ログの行の time と、recordChange が occurred_at に入れる時刻を決めた値にして、
//   行を丸ごと比べるため。
vi.mock("@repo/shared/now");

afterEach(() => {
  vi.mocked(now).mockReset();
  vi.restoreAllMocks();
});

// 書き込みに使う架空の表。WHY 実在の表（todos）を使わない: Writer は表によらない汎用の処理で、shared/infra のテストから
//   feature の表を参照しない。表はテスト用のスキーマに作る（beforeAll）。
// WHY id に DB の既定値を付けない: id を渡さない行の id を Writer が作ることを、DB の既定値に頼らずに確かめる。
const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  itemName: text("item_name").notNull(),
});

const ID = "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e";
const OTHER_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TIMESTAMP = new Date("2026-09-30T09:00:00.000Z");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

// drizzle のトランザクションを張り、その tx で作った Writer で work を実行する（本番は PostgresTransactionRunner が同じことをする）。
function inWriter<T>(
  work: (writer: PostgresWriter, tx: DrizzleTransaction) => Promise<T>,
  actorId: string | null = null,
): Promise<T> {
  return database.db.transaction((tx) =>
    work(new PostgresWriter(tx, actorId), tx),
  );
}

// logger（@repo/shared/logger）は INFO（db_write の start / done）を console.log、WARNING（failed）を console.warn に 1 行の JSON で
//   渡す。出力を黙らせて行を読む。
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

// 書き込みの前後のログの行（Issue #205・#209。どれも event.name は db_write で、表・操作・行の id を持つ）。
function startLine(operation: string, rows: object) {
  return {
    severity: "INFO",
    time: TIMESTAMP.toISOString(),
    message: "db write start",
    event: { name: "db_write", phase: "start" },
    db: { collection: { name: "items" }, operation: { name: operation } },
    ...rows,
  };
}

function doneLine(
  operation: string,
  rows: object,
  durationMs: number,
  changes: object[],
) {
  return {
    ...startLine(operation, rows),
    message: "db write done",
    event: { name: "db_write", phase: "done", duration_ms: durationMs },
    changes,
  };
}

// change_logs の行（id は DB が作るので形だけを見る）。
function changeLogRows() {
  return database.db.select().from(changeLogs);
}

describe("PostgresWriter の insert", () => {
  test("行を INSERT して DB が保存した行を返し、同じトランザクションで変更履歴（全列の after）を書き、前後に 1 行ずつログを出す", async () => {
    const logs = captureLogs();
    fixElapsed(1000, 1012.4);
    const row = { id: ID, itemName: "牛乳" };
    let linesBeforeInsert: unknown[] = [];

    const inserted = await inWriter(async (writer, tx) => {
      const original = tx.insert.bind(tx);
      vi.spyOn(tx, "insert").mockImplementation((table) => {
        linesBeforeInsert = logs.info();
        return original(table);
      });
      return writer.insert(items, [row]);
    });

    expect(inserted).toStrictEqual([row]);
    await expect(database.db.select().from(items)).resolves.toStrictEqual([
      row,
    ]);
    await expect(changeLogRows()).resolves.toStrictEqual([
      {
        id: expect.any(String),
        tableName: "items",
        rowId: ID,
        operation: "insert",
        changes: { id: { after: ID }, item_name: { after: "牛乳" } },
        actorId: null,
        occurredAt: TIMESTAMP,
      },
    ]);
    const rows = { row_id: ID };
    expect(linesBeforeInsert).toStrictEqual([startLine("insert", rows)]);
    // WHY changes に値（before / after）を出さない: 個人情報を含みうる。値は change_logs に残る。
    expect(logs.info()).toStrictEqual([
      startLine("insert", rows),
      doneLine("insert", rows, 12, [
        { table: "items", row_id: ID, operation: "insert" },
      ]),
    ]);
    expect(logs.warn()).toStrictEqual([]);
  });

  // WHY 複数行は row_ids: 1 文で書いた行をすべてログから引けるようにする（1 行なら row_id。Issue #205 の形のまま）。
  test("複数の行は 1 文で INSERT し、行ごとに変更履歴を書き、ログは row_ids に行の id を並べる", async () => {
    const logs = captureLogs();
    fixElapsed(0, 3);
    const rows = [
      { id: ID, itemName: "牛乳" },
      { id: OTHER_ID, itemName: "卵" },
    ];

    await inWriter((writer) => writer.insert(items, rows));

    await expect(
      database.db.select().from(items).orderBy(items.itemName),
    ).resolves.toStrictEqual([rows[1], rows[0]]);
    expect(
      (await changeLogRows()).map(({ rowId, operation }) => ({
        rowId,
        operation,
      })),
    ).toEqual(
      expect.arrayContaining([
        { rowId: ID, operation: "insert" },
        { rowId: OTHER_ID, operation: "insert" },
      ]),
    );
    expect(await changeLogRows()).toHaveLength(2);
    const ids = { row_ids: [ID, OTHER_ID] };
    expect(logs.info()).toStrictEqual([
      startLine("insert", ids),
      doneLine("insert", ids, 3, [
        { table: "items", row_id: ID, operation: "insert" },
        { table: "items", row_id: OTHER_ID, operation: "insert" },
      ]),
    ]);
  });

  // WHY Writer が id を作る: 前のログと変更履歴に、文を実行する前に行の id が要る（DB の既定値の id は INSERT の後にしか分からない）。
  test("id の無い行には uuid（v4）の id を作って INSERT し、その id をログと変更履歴に使う（id のある行はその id のまま）", async () => {
    const logs = captureLogs();

    const inserted = await inWriter((writer) =>
      writer.insert(items, [
        { itemName: "牛乳" } as typeof items.$inferInsert,
        { id: OTHER_ID, itemName: "卵" },
      ]),
    );

    const generated = inserted[0]?.id;
    expect(generated).toMatch(UUID_PATTERN);
    expect(inserted).toStrictEqual([
      { id: generated, itemName: "牛乳" },
      { id: OTHER_ID, itemName: "卵" },
    ]);
    expect(logs.info()[0]).toMatchObject({ row_ids: [generated, OTHER_ID] });
    expect((await changeLogRows()).map((row) => row.rowId).sort()).toEqual(
      [generated, OTHER_ID].sort(),
    );
  });

  // WHY id: undefined を明示した行も「id の無い行」として扱う: スプレッドで後から row を重ねると、undefined の id が作った id を
  //   上書きし、INSERT の id が NULL（NOT NULL 違反）になり、ログと変更履歴の row_id も undefined になる。
  test("id: undefined を明示した行にも uuid（v4）の id を作って INSERT し、その id をログと変更履歴に使う", async () => {
    const logs = captureLogs();

    const inserted = await inWriter((writer) =>
      writer.insert(items, [
        {
          id: undefined,
          itemName: "牛乳",
        } as unknown as typeof items.$inferInsert,
      ]),
    );

    const generated = inserted[0]?.id;
    expect(generated).toMatch(UUID_PATTERN);
    expect(inserted).toStrictEqual([{ id: generated, itemName: "牛乳" }]);
    expect(logs.info()[0]).toMatchObject({ row_id: generated });
    expect((await changeLogRows()).map((row) => row.rowId)).toEqual([
      generated,
    ]);
  });

  test("行が空なら SQL を発行せず、ログも変更履歴も出さずに空配列を返す", async () => {
    const logs = captureLogs();

    const inserted = await inWriter(async (writer, tx) => {
      const insert = vi.spyOn(tx, "insert");
      const result = await writer.insert(items, []);
      expect(insert).not.toHaveBeenCalled();
      return result;
    });

    expect(inserted).toStrictEqual([]);
    expect(logs.info()).toStrictEqual([]);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
  });
});

describe("PostgresWriter の update", () => {
  // WHY before は DB が UPDATE の直前に持っていた値（呼び出し側の読み込んだときの値ではない）: Writer が同じトランザクションで
  //   行を FOR UPDATE で読み、その値を before にする。呼び出し側は変えた列だけを渡す。
  test("id の行の渡した列だけを UPDATE して更新後の行を返し、変更履歴に DB が UPDATE の直前に持っていた値を before、渡した値を after に書く", async () => {
    await database.db.insert(items).values({ id: ID, itemName: "牛乳" });
    const logs = captureLogs();
    fixElapsed(10, 15);

    const updated = await inWriter((writer) =>
      writer.update(items, ID, { itemName: "卵" }),
    );

    expect(updated).toStrictEqual({ id: ID, itemName: "卵" });
    await expect(database.db.select().from(items)).resolves.toStrictEqual([
      { id: ID, itemName: "卵" },
    ]);
    await expect(changeLogRows()).resolves.toStrictEqual([
      {
        id: expect.any(String),
        tableName: "items",
        rowId: ID,
        operation: "update",
        changes: { item_name: { before: "牛乳", after: "卵" } },
        actorId: null,
        occurredAt: TIMESTAMP,
      },
    ]);
    const rows = { row_id: ID };
    expect(logs.info()).toStrictEqual([
      startLine("update", rows),
      doneLine("update", rows, 5, [
        { table: "items", row_id: ID, operation: "update" },
      ]),
    ]);
  });

  // WHY FOR UPDATE で読む: before を読んでから UPDATE するまでの間に別のトランザクションが同じ行を変えると、before が
  //   UPDATE の直前の値でなくなる。ロックすれば別のトランザクションの UPDATE / DELETE はこのトランザクションの終わりまで待つ。
  // WHY UPDATE の前（before の SELECT の後）で別の接続から書く: UPDATE 文の後だと、UPDATE 自体の行ロックで同じ結果になり、
  //   SELECT の FOR UPDATE を外しても通ってしまう（Issue #215 の reviewer の実測）。drizzle の tx の update を、別の接続での
  //   書き込みを試みてから本物の UPDATE を実行するものに差し替え、before を読んだ時点でロックが取れていることを確かめる。
  // WHY 別の接続の書き込みを終えてから本物の UPDATE を実行する（並行にしない）: 並行だと、ロックが無くても先に走った本物の UPDATE の
  //   ロックで待ちになることがあり、結果が実行順に左右される。
  // lock_timeout を短くして、待つ（= ロックがある）ことを 55P03（lock_not_available）で確かめる（時間の長さで判定しない）。
  test("update は before を読む時点で行を FOR UPDATE でロックするので、UPDATE の前でも別のトランザクションはその行を UPDATE / DELETE できない", async () => {
    await database.db.insert(items).values({ id: ID, itemName: "牛乳" });
    captureLogs();
    const writeFromOtherConnection = (
      write: (other: DrizzleTransaction) => Promise<unknown>,
    ) =>
      database.db.transaction(async (other) => {
        await other.execute(sql`set local lock_timeout = '50ms'`);
        await write(other);
      });
    const probed: string[] = [];

    await inWriter(async (writer, tx) => {
      const realUpdate = tx.update.bind(tx);
      // writer.ts の update の chain（update(table).set(changes).where(where).returning()）の形で受け、returning の前に確かめる。
      vi.spyOn(tx, "update").mockImplementation(((table: typeof items) => ({
        set: (changes: Partial<typeof items.$inferInsert>) => ({
          where: (where: ReturnType<typeof sql>) => ({
            returning: async () => {
              await expect(
                writeFromOtherConnection((other) =>
                  other.update(items).set({ itemName: "他" }),
                ),
              ).rejects.toMatchObject({ cause: { code: "55P03" } });
              probed.push("update");
              await expect(
                writeFromOtherConnection((other) => other.delete(items)),
              ).rejects.toMatchObject({ cause: { code: "55P03" } });
              probed.push("delete");
              return realUpdate(table).set(changes).where(where).returning();
            },
          }),
        }),
      })) as never);
      await expect(
        writer.update(items, ID, { itemName: "卵" }),
      ).resolves.toStrictEqual({ id: ID, itemName: "卵" });
    });

    expect(probed).toEqual(["update", "delete"]);
    await expect(database.db.select().from(items)).resolves.toStrictEqual([
      { id: ID, itemName: "卵" },
    ]);
  });

  test("渡した列が空なら SQL を発行せず、ログも変更履歴も出さずに undefined を返す（行が無くてもエラーにしない）", async () => {
    const logs = captureLogs();

    const updated = await inWriter(async (writer, tx) => {
      const select = vi.spyOn(tx, "select");
      const update = vi.spyOn(tx, "update");
      const result = await writer.update(items, ID, {});
      expect({ select: select.mock.calls, update: update.mock.calls }).toEqual({
        select: [],
        update: [],
      });
      return result;
    });

    expect(updated).toBeUndefined();
    expect(logs.info()).toStrictEqual([]);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
  });

  // WHY Error（DomainError の not_found にしない）: 呼び出し側（Repository）は同じトランザクションで行を FOR UPDATE で読んでから
  //   update するので、行が無いのは呼び出し側の実装ミス（500）。
  test("id の行が無ければ、表と id を message に持つ Error を投げ、失敗のログ（WARNING）を出し、変更履歴を書かない", async () => {
    const logs = captureLogs();
    fixElapsed(0, 2);
    const error = new Error(`items has no row to update: ${ID}`);

    await expect(
      inWriter((writer) => writer.update(items, ID, { itemName: "卵" })),
    ).rejects.toEqual(error);

    expect(logs.info()).toStrictEqual([startLine("update", { row_id: ID })]);
    expect(logs.warn()).toStrictEqual([
      {
        severity: "WARNING",
        time: TIMESTAMP.toISOString(),
        message: "db write failed",
        event: { name: "db_write", phase: "failed", duration_ms: 2 },
        db: { collection: { name: "items" }, operation: { name: "update" } },
        row_id: ID,
        error: { type: "Error", message: error.message },
      },
    ]);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
  });
});

describe("PostgresWriter の delete", () => {
  test("id の行を DELETE して消した行を返し、変更履歴に消す前の全列を before に書く", async () => {
    await database.db.insert(items).values({ id: ID, itemName: "牛乳" });
    const logs = captureLogs();
    fixElapsed(0, 1);

    const deleted = await inWriter((writer) => writer.delete(items, ID));

    expect(deleted).toStrictEqual({ id: ID, itemName: "牛乳" });
    await expect(database.db.select().from(items)).resolves.toStrictEqual([]);
    await expect(changeLogRows()).resolves.toStrictEqual([
      {
        id: expect.any(String),
        tableName: "items",
        rowId: ID,
        operation: "delete",
        changes: { id: { before: ID }, item_name: { before: "牛乳" } },
        actorId: null,
        occurredAt: TIMESTAMP,
      },
    ]);
    const rows = { row_id: ID };
    expect(logs.info()).toStrictEqual([
      startLine("delete", rows),
      doneLine("delete", rows, 1, [
        { table: "items", row_id: ID, operation: "delete" },
      ]),
    ]);
  });

  // 無い id でも前後のログは出す（後のログの changes が空で、何も消さなかったことが分かる）。
  test("id の行が無ければ何も消さずに undefined を返し、変更履歴を書かず、後のログの changes は空になる", async () => {
    await database.db.insert(items).values({ id: OTHER_ID, itemName: "卵" });
    const logs = captureLogs();
    fixElapsed(0, 1);

    const deleted = await inWriter((writer) => writer.delete(items, ID));

    expect(deleted).toBeUndefined();
    await expect(database.db.select().from(items)).resolves.toHaveLength(1);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
    expect(logs.info()).toStrictEqual([
      startLine("delete", { row_id: ID }),
      doneLine("delete", { row_id: ID }, 1, []),
    ]);
  });
});

describe("PostgresWriter の共通の振る舞い", () => {
  // WHY 四捨五入: 12.6 は 13。切り捨て・差でなく和（2012.6）では落ちる。
  test("所要時間はミリ秒の整数に丸める（開始と終了の差を四捨五入）", async () => {
    const logs = captureLogs();
    fixElapsed(1000, 1012.6);

    await inWriter((writer) => writer.delete(items, ID));

    expect(logs.info()[1]).toMatchObject({ event: { duration_ms: 13 } });
  });

  test("組み立てで渡した actorId を変更履歴の actorId に入れる", async () => {
    captureLogs();

    await inWriter(async (writer) => {
      await writer.insert(items, [{ id: ID, itemName: "牛乳" }]);
      await writer.update(items, ID, { itemName: "卵" });
      await writer.delete(items, ID);
    }, ACTOR_ID);

    expect((await changeLogRows()).map((row) => row.actorId)).toEqual([
      ACTOR_ID,
      ACTOR_ID,
      ACTOR_ID,
    ]);
  });

  test("select は同じトランザクションの drizzle の select（書いた行が見える）", async () => {
    captureLogs();

    const rows = await inWriter(async (writer) => {
      await writer.insert(items, [{ id: ID, itemName: "牛乳" }]);
      return writer.select().from(items);
    });

    expect(rows).toStrictEqual([{ id: ID, itemName: "牛乳" }]);
  });

  // WHY トランザクションが戻ると記録も残らない: 記録は本体と同じトランザクション（tx）で書く。別の接続で書くと、本体が戻っても
  //   記録だけが残る。
  test("書き込みの後にトランザクションが戻ると、本体も変更履歴も残らない", async () => {
    captureLogs();
    const failure = new Error("rollback");

    await expect(
      inWriter(async (writer) => {
        await writer.insert(items, [{ id: ID, itemName: "牛乳" }]);
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(database.db.select().from(items)).resolves.toStrictEqual([]);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
  });

  // WHY 一時的な CHECK 制約で change_logs の INSERT を失敗させる: 記録の失敗を書き込みの失敗として扱い（失敗のログと例外）、
  //   同じトランザクションの本体も戻ることを確かめる。not valid で既存の行を検査せずに張り、後始末（finally）で外す。
  test("変更履歴の INSERT が失敗すると、失敗のログを出して例外を投げ、本体の書き込みも戻る", async () => {
    const logs = captureLogs();
    await database.db.execute(
      sql`alter table change_logs add constraint tmp_reject_all_logs check (table_name = '') not valid`,
    );
    try {
      await expect(
        inWriter((writer) =>
          writer.insert(items, [{ id: ID, itemName: "牛乳" }]),
        ),
      ).rejects.toMatchObject({ cause: { code: "23514" } });

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

    await expect(
      inWriter((writer) => writer.insert(items, [row])),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    expect(logs.warn()).toStrictEqual([
      failedLine("insert", 4, {
        statusCode: "23505",
        rest: { constraint: "items_pkey", error: { type: "error" } },
      }),
    ]);
    expect(JSON.stringify(logs.warn())).not.toContain("牛乳");
  });

  // 22P02 の pg の message は「invalid input syntax for type uuid: "<入力>"」で、入力値をそのまま含む。ここでは入力値が delete の
  //   id なので row_id には出る（呼び出し側が渡した id で、以前の writeInTransaction と同じ。Repository に来る id は presentation が
  //   uuid の形を確かめた値）が、error・db・constraint には出ないことを確かめる。
  test("DB のエラー（データ例外 22P02。uuid の形でない値）のとき、失敗のログの error・db・constraint に pg の message（入力値）を含まない", async () => {
    const input = "牛乳-not-a-uuid";
    const logs = captureLogs();
    fixElapsed(0, 2);

    await expect(
      inWriter((writer) => writer.delete(items, input)),
    ).rejects.toMatchObject({
      cause: {
        code: "22P02",
        message: `invalid input syntax for type uuid: "${input}"`,
      },
    });

    const [line] = logs.warn();
    expect({ ...line, row_id: undefined }).toStrictEqual({
      ...failedLine("delete", 2, {
        statusCode: "22P02",
        rest: { error: { type: "error" } },
      }),
      row_id: undefined,
    });
    expect(line.row_id).toBe(input);
  });

  // 想定外の形の DrizzleQueryError（cause が Error でない・code / constraint が文字列でない）。cause が Error でなければ元の例外を、
  //   code / constraint が文字列でなければその項目を出さない。drizzle の delete を差し替えて投げさせる。
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

    await expect(
      inWriter(async (writer, tx) => {
        vi.spyOn(tx, "delete").mockImplementation(() => {
          throw thrown;
        });
        return writer.delete(items, ID);
      }),
    ).rejects.toBe(thrown);

    expect(logs.warn()).toStrictEqual([failedLine("delete", 1, expected)]);
  });
});

describe("transactionOf / writerOf", () => {
  test("transactionOf で Transaction にした Writer は、writerOf で同じ Writer として取り出せる", async () => {
    await inWriter(async (writer) => {
      expect(writerOf(transactionOf(writer))).toBe(writer);
    });
  });

  // WHY Error にする: InMemory の runner の tx などを Postgres の Repository に渡すのは組み立ての誤りで、黙って別の接続で
  //   書かせない。
  test("PostgresWriter でない Transaction を渡すと、Error を投げる", () => {
    const foreign = {} as unknown as Transaction;

    expect(() => writerOf(foreign)).toThrow(
      new Error("the transaction was not started by PostgresTransactionRunner"),
    );
  });
});
