// @vitest-environment node
import { getTableConfig, type IndexedColumn } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import { todoStatusChanges } from "./schema";

// 表の宣言のうち、実行時のクエリでは評価されない部分（index などの追加設定のコールバック）の仕様。
// WHY テストする: 追加設定のコールバックは drizzle-kit（pnpm db:generate）だけが評価し、Repository のテストでは呼ばれない。
//   getTableConfig で評価すれば、「(todo_id, position) が一意」という永続化の契約（同じ Todo の同じ位置に 2 回足せない。
//   同時更新は SQLSTATE 23505 で失敗する。schema.ts の WHY）をコードとして固定できる。
describe("todo_status_changes の表の宣言", () => {
  test("(todo_id, position) の一意 index を持つ（同じ Todo の同じ位置に履歴を 2 回足せない）", () => {
    const { indexes } = getTableConfig(todoStatusChanges);

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
        name: "todo_status_changes_todo_id_position_index",
        unique: true,
        columns: ["todo_id", "position"],
      },
    ]);
  });
});
