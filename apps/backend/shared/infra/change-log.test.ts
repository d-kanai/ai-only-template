// @vitest-environment node
import { Clock } from "@repo/shared/now";
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
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
import { TestDatabase } from "../../test-support/database";
import { ChangeRecords } from "./change-log";
import { changeLogs } from "./schema";

// WHY 時計（Clock.now）を差し替える: ChangeRecords.recordChange が occurred_at に入れる時刻を決めた値で確かめるため。
vi.mock("@repo/shared/now", { spy: true });

afterEach(() => {
  vi.mocked(Clock.now).mockReset();
  vi.restoreAllMocks();
});

// 変更履歴の組み立ての入力に使う架空の表。WHY 実在の表（todos）を使わない: 組み立ては表によらない汎用の処理で、
//   プロパティ名と DB の列名が違う列（itemName → item_name）・数値・日時の列を 1 つの表で確かめるため。
const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  itemName: text("item_name").notNull(),
  count: integer("count").notNull(),
  done: boolean("done").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const ROW = {
  id: "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e",
  itemName: "牛乳",
  count: 2,
  done: false,
  createdAt: new Date("2026-09-30T01:02:03.456Z"),
};

describe("ChangeRecords.insertEntry", () => {
  test("行の全列を DB の列名で after に持つ insert の記録にする（日時は ISO 8601 の文字列）", () => {
    expect(ChangeRecords.insertEntry(items, ROW, ACTOR_ID)).toStrictEqual({
      tableName: "items",
      rowId: ROW.id,
      operation: "insert",
      changes: {
        id: { after: ROW.id },
        item_name: { after: "牛乳" },
        count: { after: 2 },
        done: { after: false },
        created_at: { after: "2026-09-30T01:02:03.456Z" },
      },
      actorId: ACTOR_ID,
    });
  });

  test("actorId が null（ログインが無い）なら actorId は null", () => {
    expect(ChangeRecords.insertEntry(items, ROW, null)).toMatchObject({
      actorId: null,
    });
  });

  test("null の列は null のまま記録する", () => {
    const nullable = pgTable("nullables", {
      id: uuid("id").primaryKey(),
      note: text("note"),
    });

    expect(
      ChangeRecords.insertEntry(nullable, { id: ROW.id, note: null }, null)
        .changes,
    ).toStrictEqual({ id: { after: ROW.id }, note: { after: null } });
  });
});

describe("ChangeRecords.deleteEntry", () => {
  test("消した行の全列を DB の列名で before に持つ delete の記録にする", () => {
    expect(ChangeRecords.deleteEntry(items, ROW, ACTOR_ID)).toStrictEqual({
      tableName: "items",
      rowId: ROW.id,
      operation: "delete",
      changes: {
        id: { before: ROW.id },
        item_name: { before: "牛乳" },
        count: { before: 2 },
        done: { before: false },
        created_at: { before: "2026-09-30T01:02:03.456Z" },
      },
      actorId: ACTOR_ID,
    });
  });
});

describe("ChangeRecords.updateEntries", () => {
  test("変わった列（ChangedProps.of の差分）だけを、origin の値を before・差分の値を after にした update の記録 1 件にする", () => {
    expect(
      ChangeRecords.updateEntries(
        items,
        ROW.id,
        ROW,
        { itemName: "豆乳", createdAt: new Date("2026-10-01T00:00:00.000Z") },
        ACTOR_ID,
      ),
    ).toStrictEqual([
      {
        tableName: "items",
        rowId: ROW.id,
        operation: "update",
        changes: {
          item_name: { before: "牛乳", after: "豆乳" },
          created_at: {
            before: "2026-09-30T01:02:03.456Z",
            after: "2026-10-01T00:00:00.000Z",
          },
        },
        actorId: ACTOR_ID,
      },
    ]);
  });

  // WHY 空にする: 差分の無い update は何も書かない（SQL を発行しない）ので、変更の記録も残さない。
  test("変わった列が無ければ記録しない（空配列）", () => {
    expect(
      ChangeRecords.updateEntries(items, ROW.id, ROW, {}, ACTOR_ID),
    ).toStrictEqual([]);
  });

  // WHY origin に表の列でない項目（Entity の statusChanges など）があってもよい: 比べるのは差分の key だけ。
  test("origin に表の列でない項目があっても、差分の key だけを記録する", () => {
    const origin = { ...ROW, history: [1, 2] };

    expect(
      ChangeRecords.updateEntries(items, ROW.id, origin, { done: true }, null),
    ).toStrictEqual([
      {
        tableName: "items",
        rowId: ROW.id,
        operation: "update",
        changes: { done: { before: false, after: true } },
        actorId: null,
      },
    ]);
  });
});

// WHY 黙って捨てずに Error にする: 表に無い key（Entity の項目名の取り違え）や JSON にできない値を記録から落とすと、
//   変更の記録が欠けたことに気づけない。どちらも呼び出し側（Repository）の実装ミス。
describe("組み立てられない入力", () => {
  test("表に無い key があれば、表と key の名前を持つ Error を投げる", () => {
    expect(() =>
      ChangeRecords.insertEntry(
        items,
        { ...ROW, history: "x" } as typeof ROW,
        null,
      ),
    ).toThrow(new Error("items has no column: history"));
  });

  test("Object.prototype にある名前（toString）も表に無い key として扱う", () => {
    expect(() =>
      ChangeRecords.updateEntries(
        items,
        ROW.id,
        ROW,
        { toString: "x" } as never,
        null,
      ),
    ).toThrow(new Error("items has no column: toString"));
  });

  test.each([
    ["配列", [1]],
    ["オブジェクト", { a: 1 }],
    ["undefined", undefined],
    ["bigint", BigInt(1)],
  ])(
    "列の値が文字列・数値・真偽値・null・Date でない（%s）なら Error を投げる",
    (_label, value) => {
      expect(() =>
        ChangeRecords.deleteEntry(
          items,
          { ...ROW, count: value } as never,
          null,
        ),
      ).toThrow(new Error("items.count has a value that cannot be recorded"));
    },
  );
});

// 実 Postgres（compose.yaml）に対して実行する。
describe("ChangeRecords.recordChange", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await TestDatabase.create();
    await database.migrate();
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.db.execute(sql`truncate change_logs`);
  });

  test("記録を change_logs に 1 行ずつ入れる（id は DB が作り、occurred_at は Clock.now()、同じ呼び出しの行は同じ時刻）", async () => {
    const occurredAt = new Date("2026-09-30T09:00:00.000Z");
    vi.mocked(Clock.now).mockReturnValueOnce(occurredAt);
    const inserted = ChangeRecords.insertEntry(items, ROW, ACTOR_ID);
    const updated = ChangeRecords.updateEntries(
      items,
      ROW.id,
      ROW,
      { count: 3 },
      null,
    );

    await ChangeRecords.recordChange(database.db, [inserted, ...updated]);

    const rows = await database.db
      .select()
      .from(changeLogs)
      .orderBy(changeLogs.operation);
    expect(rows).toStrictEqual([
      { id: expect.any(String), ...inserted, occurredAt },
      { id: expect.any(String), ...updated[0], occurredAt },
    ]);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  // WHY: 差分の無い update・無い id の delete は記録が 0 件になる。drizzle-orm の insert は空の values を受け付けないので、
  //   SQL を発行せずに終える。
  test("記録が 0 件なら SQL を発行しない", async () => {
    const insert = vi.spyOn(database.db, "insert");

    await ChangeRecords.recordChange(database.db, []);

    expect(insert).not.toHaveBeenCalled();
    await expect(database.db.select().from(changeLogs)).resolves.toEqual([]);
  });
});
