// @vitest-environment node
import { getTableConfig, type IndexedColumn } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { changeLogs } from "./schema";

// 表の宣言のうち、実行時のクエリでは評価されない部分（index などの追加設定のコールバック）の仕様。
// WHY テストする: 追加設定のコールバックは drizzle-kit（pnpm db:generate）と getTableConfig だけが評価し、Repository の
//   テストでは呼ばれない（features/todo/internal/infra/schema.test.ts と同じ）。
describe("change_logs の表の宣言", () => {
  test("(table_name, row_id) の index を持つ（1 つの行の変更履歴を引く検索に使う。一意ではない）", () => {
    const { indexes } = getTableConfig(changeLogs);

    expect(
      indexes.map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
        columns: (index.config.columns as IndexedColumn[]).map(
          (column) => column.name,
        ),
      })),
    ).toEqual([
      {
        name: "change_logs_table_name_row_id_index",
        unique: false,
        columns: ["table_name", "row_id"],
      },
    ]);
  });
});
