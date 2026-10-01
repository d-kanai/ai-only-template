// @vitest-environment node
import { boolean, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { classifyColumns, maskRow } from "./column-classification";

// 列の分類（public / sensitive）と、ログに出す行の値のマスク（Issue #216）。
// WHY 架空の表を使う: 分類と表の組み合わせはテストごとに変えたい（分類の無い表・分類に無い列）。実在の表（todos）の分類は
//   features/todo のテスト（todo-repository.postgres.test.ts）が Writer のログで固定する。
// キーは Drizzle のプロパティ名（itemName）、DB の列名は item_name（maskRow が受け取る行のキー）。
const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  itemName: text("item_name").notNull(),
  memo: text("memo"),
  done: boolean("done").notNull(),
});

const ID = "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e";

describe("classifyColumns", () => {
  test("渡した分類をそのまま返す（schema.ts で <表>Columns として export する値）", () => {
    const table = pgTable("returns_as_is", {
      id: uuid("id").primaryKey(),
      note: text("note"),
    });
    const columns = { id: "public", note: "sensitive" } as const;

    expect(classifyColumns(table, columns)).toBe(columns);
  });

  test("すべての列を分類しないと型エラーになり、表に無い列を書いても型エラーになる", () => {
    const table = pgTable("typed", {
      id: uuid("id").primaryKey(),
      note: text("note"),
    });

    // @ts-expect-error note の分類が無い（全列の網羅を型で強制する）
    classifyColumns(table, { id: "public" });
    classifyColumns(table, {
      id: "public",
      note: "sensitive",
      // @ts-expect-error 表に無い列（プロパティ名の取り違え）
      other: "public",
    });
    // @ts-expect-error public / sensitive 以外の分類
    classifyColumns(table, { id: "public", note: "secret" });
  });
});

describe("maskRow（DB の列名 → 値の行を、分類でマスクする）", () => {
  const classified = pgTable("classified_items", {
    id: uuid("id").primaryKey(),
    itemName: text("item_name").notNull(),
    memo: text("memo"),
    done: boolean("done").notNull(),
  });
  classifyColumns(classified, {
    id: "public",
    itemName: "sensitive",
    memo: "sensitive",
    done: "public",
  });

  test("public の列は値をそのまま、sensitive の列は *** にする（キーは DB の列名のまま）", () => {
    expect(
      maskRow(classified, {
        id: ID,
        item_name: "牛乳",
        memo: "午後に買う",
        done: false,
      }),
    ).toStrictEqual({ id: ID, item_name: "***", memo: "***", done: false });
  });

  // WHY null は null のまま: 値が無いことは個人情報ではない（Issue #216 の既定の判断。apps/shared/log-event.ts の sensitive と同じ）。
  test("sensitive の列でも null は null のまま出す", () => {
    expect(maskRow(classified, { id: ID, memo: null })).toStrictEqual({
      id: ID,
      memo: null,
    });
  });

  // fail closed: 分類を登録していない表は、どの列が個人情報か分からないので、全列を *** にする。
  test("分類を登録していない表は、すべての列（id も）を *** にする", () => {
    expect(
      maskRow(items, { id: ID, item_name: "牛乳", memo: null, done: true }),
    ).toStrictEqual({ id: "***", item_name: "***", memo: null, done: "***" });
  });

  // fail closed: 型を通さずに分類が欠けた・public / sensitive 以外になった（as で外した）列と、表に無い列名も、public と
  //   言えないので *** にする。
  test("分類に無い列・public でも sensitive でもない分類の列・表に無い列名は *** にする", () => {
    const partial = pgTable("partial_items", {
      id: uuid("id").primaryKey(),
      note: text("note"),
      label: text("label"),
    });
    classifyColumns(partial, { id: "public", label: "secret" } as never);

    expect(
      maskRow(partial, {
        id: ID,
        note: "メモ",
        label: "ラベル",
        unknown_column: "x",
      }),
    ).toStrictEqual({
      id: ID,
      note: "***",
      label: "***",
      unknown_column: "***",
    });
  });

  // WHY プロパティ名ではなく DB の列名で引く: 変更履歴（change-log.ts）の before / after のキーは DB の列名。プロパティ名の
  //   itemName を行のキーに渡されても public と取り違えない。
  test("DB の列名でなくプロパティ名のキーは、表に無い列名として *** にする", () => {
    expect(maskRow(classified, { done: true, itemName: "牛乳" })).toStrictEqual(
      { done: true, itemName: "***" },
    );
  });

  // WHY Object.prototype の名前（toString など）を分類と取り違えない: オブジェクトを素のキーで引くと、継承した
  //   プロパティが「ある」になりうる。
  test("Object.prototype の名前の列名も *** にする", () => {
    expect(maskRow(classified, { toString: "x" })).toStrictEqual({
      toString: "***",
    });
  });
});
