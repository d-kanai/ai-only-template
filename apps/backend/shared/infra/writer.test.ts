// @vitest-environment node
import { now } from "@repo/shared/now";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
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
import { ColumnClassifier } from "./column-classification";
import { changeLogs } from "./schema";
import { type DrizzleTransaction, PostgresWriter } from "./writer";

// WHY 時計（now）を差し替える: ログの行の time と、ChangeRecords.recordChange が occurred_at に入れる時刻を決めた値にして、
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
// 列の分類（Issue #216）。本番の表は schema.ts の隣に置く（rule-tests/schema.test.ts の column-classification）。item_name は
//   利用者が書く自由文の想定で sensitive（ログの before / after で ***）、id は public（値のまま）。
ColumnClassifier.classify(items, { id: "public", itemName: "sensitive" });

// 分類を登録していない表（fail closed: ログの before / after は全列 ***）。amount は integer で、形の違う値を渡すと
//   データ例外（22P02）になり、pg の message に入力値が入る（失敗のログのマスクを確かめる）。
const notes = pgTable("notes", {
  id: uuid("id").primaryKey(),
  body: text("body").notNull(),
  amount: integer("amount"),
});

// 番兵の値（個人情報の代わり）。ログの JSON のどこにも出ないことを確かめる。
const SENTINEL = "番兵-alice@example.com";

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
  await database.db.execute(
    sql`create table notes (id uuid primary key, body text not null, amount integer)`,
  );
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate change_logs, items, notes`);
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
    // given
    const logs = captureLogs();
    fixElapsed(1000, 1012.4);
    const row = { id: ID, itemName: "牛乳" };
    let linesBeforeInsert: unknown[] = [];

    // when
    const inserted = await inWriter(async (writer, tx) => {
      const original = tx.insert.bind(tx);
      vi.spyOn(tx, "insert").mockImplementation((table) => {
        linesBeforeInsert = logs.info();
        return original(table);
      });
      return writer.insert(items, [row]);
    });

    // then
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
    // WHY changes に before / after を出し、分類が sensitive の列（item_name）だけ *** にする（Issue #216）: 何がどう変わったかを
    //   ログで追え、個人情報は出さない。change_logs の表には生の値（牛乳）が残る（上）。insert は before が null。
    expect(logs.info()).toStrictEqual([
      startLine("insert", rows),
      doneLine("insert", rows, 12, [
        {
          table: "items",
          row_id: ID,
          operation: "insert",
          before: null,
          after: { id: ID, item_name: "***" },
        },
      ]),
    ]);
    expect(logs.warn()).toStrictEqual([]);
  });

  // WHY 複数行は row_ids: 1 文で書いた行をすべてログから引けるようにする（1 行なら row_id。Issue #205 の形のまま）。
  test("複数の行は 1 文で INSERT し、行ごとに変更履歴を書き、ログは row_ids に行の id を並べる", async () => {
    // given
    const logs = captureLogs();
    fixElapsed(0, 3);
    const rows = [
      { id: ID, itemName: "牛乳" },
      { id: OTHER_ID, itemName: "卵" },
    ];

    // when
    await inWriter((writer) => writer.insert(items, rows));

    // then
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
        {
          table: "items",
          row_id: ID,
          operation: "insert",
          before: null,
          after: { id: ID, item_name: "***" },
        },
        {
          table: "items",
          row_id: OTHER_ID,
          operation: "insert",
          before: null,
          after: { id: OTHER_ID, item_name: "***" },
        },
      ]),
    ]);
  });

  // WHY Writer が id を作る: 前のログと変更履歴に、文を実行する前に行の id が要る（DB の既定値の id は INSERT の後にしか分からない）。
  test("id の無い行には uuid（v4）の id を作って INSERT し、その id をログと変更履歴に使う（id のある行はその id のまま）", async () => {
    // given
    const logs = captureLogs();

    // when
    const inserted = await inWriter((writer) =>
      writer.insert(items, [
        { itemName: "牛乳" } as typeof items.$inferInsert,
        { id: OTHER_ID, itemName: "卵" },
      ]),
    );

    // then
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
    // given
    const logs = captureLogs();

    // when
    const inserted = await inWriter((writer) =>
      writer.insert(items, [
        {
          id: undefined,
          itemName: "牛乳",
        } as unknown as typeof items.$inferInsert,
      ]),
    );

    // then
    const generated = inserted[0]?.id;
    expect(generated).toMatch(UUID_PATTERN);
    expect(inserted).toStrictEqual([{ id: generated, itemName: "牛乳" }]);
    expect(logs.info()[0]).toMatchObject({ row_id: generated });
    expect((await changeLogRows()).map((row) => row.rowId)).toEqual([
      generated,
    ]);
  });

  test("行が空なら SQL を発行せず、ログも変更履歴も出さずに空配列を返す", async () => {
    // given
    const logs = captureLogs();
    let insertCallCount = -1;

    // when
    const inserted = await inWriter(async (writer, tx) => {
      const insert = vi.spyOn(tx, "insert");
      const result = await writer.insert(items, []);
      insertCallCount = insert.mock.calls.length;
      return result;
    });

    // then
    expect(insertCallCount).toBe(0);
    expect(inserted).toStrictEqual([]);
    expect(logs.info()).toStrictEqual([]);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
  });
});

describe("PostgresWriter の update", () => {
  // WHY before は DB が UPDATE の直前に持っていた値（呼び出し側の読み込んだときの値ではない）: Writer が同じトランザクションで
  //   行を FOR UPDATE で読み、その値を before にする。呼び出し側は変えた列だけを渡す。
  test("id の行の渡した列だけを UPDATE して更新後の行を返し、変更履歴に DB が UPDATE の直前に持っていた値を before、渡した値を after に書く", async () => {
    // given
    await database.db.insert(items).values({ id: ID, itemName: "牛乳" });
    const logs = captureLogs();
    fixElapsed(10, 15);

    // when
    const updated = await inWriter((writer) =>
      writer.update(items, ID, { itemName: "卵" }),
    );

    // then
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
      // update は渡した列だけの before / after（変更履歴の changes と同じ列）。
      doneLine("update", rows, 5, [
        {
          table: "items",
          row_id: ID,
          operation: "update",
          before: { item_name: "***" },
          after: { item_name: "***" },
        },
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
    // given
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

    // when
    const updated = await inWriter(async (writer, tx) => {
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
      return writer.update(items, ID, { itemName: "卵" });
    });

    // then
    expect(updated).toStrictEqual({ id: ID, itemName: "卵" });
    expect(probed).toEqual(["update", "delete"]);
    await expect(database.db.select().from(items)).resolves.toStrictEqual([
      { id: ID, itemName: "卵" },
    ]);
  });

  test("渡した列が空なら SQL を発行せず、ログも変更履歴も出さずに undefined を返す（行が無くてもエラーにしない）", async () => {
    // given
    const logs = captureLogs();
    let calls: { select: unknown[]; update: unknown[] } | undefined;

    // when
    const updated = await inWriter(async (writer, tx) => {
      const select = vi.spyOn(tx, "select");
      const update = vi.spyOn(tx, "update");
      const result = await writer.update(items, ID, {});
      calls = { select: select.mock.calls, update: update.mock.calls };
      return result;
    });

    // then
    expect(calls).toEqual({ select: [], update: [] });
    expect(updated).toBeUndefined();
    expect(logs.info()).toStrictEqual([]);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
  });

  // WHY Error（DomainError の not_found にしない）: 呼び出し側（Repository）は同じトランザクションで行を FOR UPDATE で読んでから
  //   update するので、行が無いのは呼び出し側の実装ミス（500）。
  test("id の行が無ければ、表と id を message に持つ Error を投げ、失敗のログ（WARNING）を出し、変更履歴を書かない", async () => {
    // given
    const logs = captureLogs();
    fixElapsed(0, 2);
    const error = new Error(`items has no row to update: ${ID}`);

    // when
    const promise = inWriter((writer) =>
      writer.update(items, ID, { itemName: "卵" }),
    );

    // then
    await expect(promise).rejects.toEqual(error);

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
    // given
    await database.db.insert(items).values({ id: ID, itemName: "牛乳" });
    const logs = captureLogs();
    fixElapsed(0, 1);

    // when
    const deleted = await inWriter((writer) => writer.delete(items, ID));

    // then
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
      // delete は消した行の全列の before と、null の after。
      doneLine("delete", rows, 1, [
        {
          table: "items",
          row_id: ID,
          operation: "delete",
          before: { id: ID, item_name: "***" },
          after: null,
        },
      ]),
    ]);
  });

  // 無い id でも前後のログは出す（後のログの changes が空で、何も消さなかったことが分かる）。
  test("id の行が無ければ何も消さずに undefined を返し、変更履歴を書かず、後のログの changes は空になる", async () => {
    // given
    await database.db.insert(items).values({ id: OTHER_ID, itemName: "卵" });
    const logs = captureLogs();
    fixElapsed(0, 1);

    // when
    const deleted = await inWriter((writer) => writer.delete(items, ID));

    // then
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
    // given
    const logs = captureLogs();
    fixElapsed(1000, 1012.6);

    // when
    await inWriter((writer) => writer.delete(items, ID));

    // then
    expect(logs.info()[1]).toMatchObject({ event: { duration_ms: 13 } });
  });

  test("組み立てで渡した actorId を変更履歴の actorId に入れる", async () => {
    // given
    captureLogs();

    // when
    await inWriter(async (writer) => {
      await writer.insert(items, [{ id: ID, itemName: "牛乳" }]);
      await writer.update(items, ID, { itemName: "卵" });
      await writer.delete(items, ID);
    }, ACTOR_ID);

    // then
    expect((await changeLogRows()).map((row) => row.actorId)).toEqual([
      ACTOR_ID,
      ACTOR_ID,
      ACTOR_ID,
    ]);
  });

  test("select は同じトランザクションの drizzle の select（書いた行が見える）", async () => {
    // given
    captureLogs();

    // when
    const rows = await inWriter(async (writer) => {
      await writer.insert(items, [{ id: ID, itemName: "牛乳" }]);
      return writer.select().from(items);
    });

    // then
    expect(rows).toStrictEqual([{ id: ID, itemName: "牛乳" }]);
  });

  // WHY トランザクションが戻ると記録も残らない: 記録は本体と同じトランザクション（tx）で書く。別の接続で書くと、本体が戻っても
  //   記録だけが残る。
  test("書き込みの後にトランザクションが戻ると、本体も変更履歴も残らない", async () => {
    // given
    captureLogs();
    const failure = new Error("rollback");

    // when
    const promise = inWriter(async (writer) => {
      await writer.insert(items, [{ id: ID, itemName: "牛乳" }]);
      throw failure;
    });

    // then
    await expect(promise).rejects.toBe(failure);

    await expect(database.db.select().from(items)).resolves.toStrictEqual([]);
    await expect(changeLogRows()).resolves.toStrictEqual([]);
  });

  // WHY 一時的な CHECK 制約で change_logs の INSERT を失敗させる: 記録の失敗を書き込みの失敗として扱い（失敗のログと例外）、
  //   同じトランザクションの本体も戻ることを確かめる。not valid で既存の行を検査せずに張り、後始末（finally）で外す。
  test("変更履歴の INSERT が失敗すると、失敗のログを出して例外を投げ、本体の書き込みも戻る", async () => {
    // given
    const logs = captureLogs();
    await database.db.execute(
      sql`alter table change_logs add constraint tmp_reject_all_logs check (table_name = '') not valid`,
    );
    try {
      // when
      const promise = inWriter((writer) =>
        writer.insert(items, [{ id: ID, itemName: "牛乳" }]),
      );

      // then
      await expect(promise).rejects.toMatchObject({ cause: { code: "23514" } });

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

  // WHY DB のエラーの message・params をそのまま出さない（Issue #216）: drizzle-orm の DrizzleQueryError の message は
  //   「Failed query: <SQL>\nparams: <値>」で、行の値（個人情報を含みうる）がログに出る。元の pg のエラーの message も、データ例外
  //   （SQLSTATE 22 系。22P02 の invalid input syntax for type uuid: "<入力>" など）は入力値を含む。
  //   - params: 値はすべて ***（個数だけ分かる）。logger のスキーマ（db_write の params）が sensitive で落とす。
  //   - message: pg のエラーの message の引用符（"..."）の部分を Writer が *** にしてから出す（最初の " から最後の " まで）。
  //   何の失敗かは SQLSTATE（db.response.status_code）・制約の名前（constraint）・message の残りで分かる。
  // 失敗のログの行（DB のエラーの項目だけを変える）。statusCode が無ければ db.response を出さない。
  function failedLine(
    operation: string,
    durationMs: number,
    failure: {
      collection?: string;
      statusCode?: string;
      rowId?: string;
      rest: object;
    },
  ) {
    return {
      severity: "WARNING",
      time: TIMESTAMP.toISOString(),
      message: "db write failed",
      event: { name: "db_write", phase: "failed", duration_ms: durationMs },
      db: {
        collection: { name: failure.collection ?? "items" },
        operation: { name: operation },
        ...(failure.statusCode === undefined
          ? {}
          : { response: { status_code: failure.statusCode } }),
      },
      row_id: failure.rowId ?? ID,
      ...failure.rest,
    };
  }

  test("DB のエラー（一意制約違反）のとき、失敗のログは pg のエラーの name・引用符の部分を *** にした message・SQLSTATE（23505）・制約の名前と、値を *** にした params を出す（行の値を出さない）", async () => {
    // given
    const row = { id: ID, itemName: SENTINEL };
    await database.db.insert(items).values(row);
    const logs = captureLogs();
    fixElapsed(3000, 3004);

    // when
    const promise = inWriter((writer) => writer.insert(items, [row]));

    // then
    await expect(promise).rejects.toMatchObject({
      cause: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "items_pkey"',
      },
    });

    expect(logs.warn()).toStrictEqual([
      failedLine("insert", 4, {
        statusCode: "23505",
        rest: {
          constraint: "items_pkey",
          params: ["***", "***"],
          error: {
            type: "error",
            message: 'duplicate key value violates unique constraint "***"',
          },
        },
      }),
    ]);
    expect(JSON.stringify(logs.warn())).not.toContain(SENTINEL);
  });

  // 22P02 の pg の message は「invalid input syntax for type integer: "<入力>"」で、入力値をそのまま含む（実測。入力に " を含めても
  //   pg は逃がさずに "<入力>" と書く）。番兵の値を integer の列に渡し、message と params のどちらにも出ないことを確かめる。
  test('DB のエラー（データ例外 22P02）のとき、pg の message の入力値（引用符の中。入力が " を含んでも）と params の値をログに出さない', async () => {
    // given
    const input = `${SENTINEL}" tail "x`;
    const logs = captureLogs();
    fixElapsed(0, 2);

    // when
    const promise = inWriter((writer) =>
      writer.insert(notes, [
        { id: ID, body: SENTINEL, amount: input as unknown as number },
      ]),
    );

    // then
    await expect(promise).rejects.toMatchObject({
      cause: {
        code: "22P02",
        message: `invalid input syntax for type integer: "${input}"`,
      },
    });

    expect(logs.warn()).toStrictEqual([
      failedLine("insert", 2, {
        collection: "notes",
        statusCode: "22P02",
        rest: {
          params: ["***", "***", "***"],
          error: {
            type: "error",
            message: 'invalid input syntax for type integer: "***"',
          },
        },
      }),
    ]);
    const json = JSON.stringify(logs.warn());
    expect(json).not.toContain(SENTINEL);
    expect(json).not.toContain("tail");
  });

  // 想定外の形の DrizzleQueryError（cause が Error でない・code / constraint が文字列でない）と、引用符の数の違う message。
  //   drizzle の delete を差し替えて投げさせる。
  test.each([
    [
      "cause が無いときは、DrizzleQueryError の name と params（***）だけを出す（message は SQL と値を含むので出さない）",
      new DrizzleQueryError("select $1", [SENTINEL], undefined),
      { rest: { params: ["***"], error: { type: "Error" } } },
    ],
    [
      "cause が code・constraint を持たない Error のときは、cause の name と message を出す",
      new DrizzleQueryError("select 1", [], new Error("boom")),
      { rest: { params: [], error: { type: "Error", message: "boom" } } },
    ],
    [
      "cause の code・constraint が文字列でないときは、db.response・constraint を出さない",
      new DrizzleQueryError(
        "select 1",
        [],
        Object.assign(new Error("boom"), { code: 23505, constraint: 1 }),
      ),
      { rest: { params: [], error: { type: "Error", message: "boom" } } },
    ],
    [
      "message の引用符が 1 つだけなら、その後ろをすべて *** にする",
      new DrizzleQueryError(
        "select 1",
        [],
        new Error(`invalid value: "${SENTINEL}`),
      ),
      {
        rest: {
          params: [],
          error: { type: "Error", message: 'invalid value: "***' },
        },
      },
    ],
    [
      'message の引用符が 3 つ以上なら、最初の " から最後の " までを 1 つの *** にし、外側は残す',
      new DrizzleQueryError(
        "select 1",
        [],
        new Error(`null value in column "a" of relation "${SENTINEL}" end`),
      ),
      {
        rest: {
          params: [],
          error: { type: "Error", message: 'null value in column "***" end' },
        },
      },
    ],
  ])("DB のエラーの %s", async (_label, thrown, expected) => {
    // given
    const logs = captureLogs();
    fixElapsed(0, 1);

    // when
    const promise = inWriter(async (writer, tx) => {
      vi.spyOn(tx, "delete").mockImplementation(() => {
        throw thrown;
      });
      return writer.delete(items, ID);
    });

    // then
    await expect(promise).rejects.toBe(thrown);

    expect(logs.warn()).toStrictEqual([failedLine("delete", 1, expected)]);
    expect(JSON.stringify(logs.warn())).not.toContain(SENTINEL);
  });
});

describe("PostgresWriter の db_write の changes（before / after）のマスク", () => {
  // fail closed（Issue #216）: 分類を登録していない表は、どの列が個人情報か分からないので、id も含めて全列の値を *** にする。
  //   change_logs の表には生の値を残す（監査。マスクはログだけ）。null は null のまま。
  test("分類を登録していない表の insert / update / delete は、before / after の全列の値を *** にする（change_logs には生の値）", async () => {
    // given
    const logs = captureLogs();

    // when
    await inWriter(async (writer) => {
      await writer.insert(notes, [{ id: ID, body: SENTINEL, amount: 3 }]);
      await writer.update(notes, ID, { body: "卵", amount: null });
      await writer.delete(notes, ID);
    });

    // then
    const changes = logs
      .info()
      .filter((line) => line.event.phase === "done")
      .map((line) => line.changes);
    expect(changes).toStrictEqual([
      [
        {
          table: "notes",
          row_id: ID,
          operation: "insert",
          before: null,
          after: { id: "***", body: "***", amount: "***" },
        },
      ],
      [
        {
          table: "notes",
          row_id: ID,
          operation: "update",
          before: { body: "***", amount: "***" },
          after: { body: "***", amount: null },
        },
      ],
      [
        {
          table: "notes",
          row_id: ID,
          operation: "delete",
          before: { id: "***", body: "***", amount: null },
          after: null,
        },
      ],
    ]);
    expect(JSON.stringify(logs.info())).not.toContain(SENTINEL);
    // WHY 操作の順に並べ直す: 3 件は同じ occurred_at（時計を固定）で、select の順は決まらない。
    const order = ["insert", "update", "delete"];
    expect(
      (await changeLogRows())
        .map(({ operation, changes }) => ({ operation, changes }))
        .sort(
          (a, b) => order.indexOf(a.operation) - order.indexOf(b.operation),
        ),
    ).toEqual([
      {
        operation: "insert",
        changes: {
          id: { after: ID },
          body: { after: SENTINEL },
          amount: { after: 3 },
        },
      },
      {
        operation: "update",
        changes: {
          body: { before: SENTINEL, after: "卵" },
          amount: { before: 3, after: null },
        },
      },
      {
        operation: "delete",
        changes: {
          id: { before: ID },
          body: { before: "卵" },
          amount: { before: null },
        },
      },
    ]);
  });
});

describe("asTransaction / PostgresWriter.of", () => {
  test("asTransaction で Transaction にした Writer は、PostgresWriter.of で同じ Writer として取り出せる", async () => {
    // given: 前提なし
    // when
    const { writer, found } = await inWriter(async (writer) => ({
      writer,
      found: PostgresWriter.of(writer.asTransaction()),
    }));

    // then
    expect(found).toBe(writer);
  });

  // WHY Error にする: InMemory の runner の tx などを Postgres の Repository に渡すのは組み立ての誤りで、黙って別の接続で
  //   書かせない。
  test("PostgresWriter でない Transaction を渡すと、Error を投げる", () => {
    // given
    const foreign = {} as unknown as Transaction;

    // when
    const action = () => PostgresWriter.of(foreign);

    // then
    expect(action).toThrow(
      new Error("the transaction was not started by PostgresTransactionRunner"),
    );
  });
});
