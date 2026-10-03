// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { DeleteTodoApi } from "../../../features/todo/internal/presentation/delete-todo.api";
import { TestDatabase } from "../../../test-support/database";
import { TodoBuilder } from "../../../test-support/todo/todo-builder";
import {
  DeleteTodoApiAssembly,
  TodoSpecExpected,
  TodoSpecLogs,
  TodoSpecProblems,
  TodoSpecRequests,
  TodoSpecRows,
} from "./support";

// API 仕様（Issue #219）: delete-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（DeleteTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする・前提はビルダーで作る）は
//   list-todos.api-spec.test.ts の冒頭、応答に加えて DB の行も見る WHY は create-todo.api-spec.test.ts の冒頭。
// 前提をビルダーで作るので、変更の記録（change_logs）は前提の分を含まず、削除が残した記録だけになる。

let database: TestDatabase;
let handler: ReturnType<typeof DeleteTodoApiAssembly.handler>;

beforeAll(async () => {
  database = await TestDatabase.create();
  await database.migrate();
  handler = DeleteTodoApiAssembly.handler(database.db);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await TodoSpecRows.empty(database.db);
});

// WHY 戻り値を DeleteTodoApi の handle の型にする: 対の api ファイルの型を使い、この仕様が delete-todo.api のものだと import で示す
//   （rule-tests/api-spec.test.ts の api-spec-uses-own-api）。
async function deleteTodo(id: string): ReturnType<DeleteTodoApi["handle"]> {
  return handler(
    TodoSpecRequests.bodyless("DELETE", `/api/todos/${id}`),
    TodoSpecRequests.context(id),
  );
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./delete-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  // WHY 削除の step は保存された Todo の行を見る: 削除 = 消す Todo 自身の振る舞い（Issue #249）。
  Scenario("削除", ({ And }) => {
    // WHY ほかの Todo を置く: 条件（where）の欠けた DELETE ですべてを消す誤り・別の Todo を消す取り違えを見分ける。
    // 変更の記録（.feature には書かない。create-todo.api-spec.test.ts の冒頭）: 消した Todo の消す前の全列の before が 1 件だけ残る
    //   （日時は ISO 8601 の文字列。cascade で消えた完了の履歴の行は記録しない。前提はビルダーで入れたので記録を残さない）。
    And("削除した Todo は無くなり、ほかの Todo は残る", async () => {
      // given
      const milk = await TodoBuilder.of(database.db)
        .title("牛乳を買う")
        .build();
      const bread = await TodoBuilder.of(database.db)
        .title("パンを買う")
        .build();

      // when
      await deleteTodo(milk.id);

      // then
      await expect(TodoSpecRows.todos(database.db)).resolves.toStrictEqual([
        TodoSpecExpected.row(bread),
      ]);
      await expect(TodoSpecLogs.entries(database.db)).resolves.toStrictEqual([
        {
          tableName: "todos",
          rowId: milk.id,
          operation: "delete",
          changes: {
            id: { before: milk.id },
            title: { before: milk.title },
            completed: { before: milk.completed },
            created_at: { before: milk.createdAt.toISOString() },
          },
          actorId: null,
        },
      ]);
    });
  });

  Scenario("レスポンス", ({ And }) => {
    // 削除の後に返す内容は無い（204 で本文が空）。
    And("Todo を削除すると、本文の無い成功のレスポンスが返る", async () => {
      // given
      const milk = await TodoBuilder.of(database.db)
        .title("牛乳を買う")
        .build();

      // when
      const response = await deleteTodo(milk.id);

      // then
      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");
    });
  });

  Scenario("記録", ({ And }) => {
    // 外部キーの on delete cascade で消える（履歴の DELETE は書かない。schema.ts の todoStatusChanges）。ほかの Todo の履歴は残る。
    // WHY 消す Todo を完了にしておく: 履歴が 2 件ある Todo でも 1 件目だけを消す誤りを見分ける。
    And("削除した Todo の完了の履歴も無くなる", async () => {
      // given
      const milk = await TodoBuilder.of(database.db)
        .title("牛乳を買う")
        .completed(true)
        .build();
      const bread = await TodoBuilder.of(database.db)
        .title("パンを買う")
        .build();

      // when
      await deleteTodo(milk.id);

      // then
      await expect(TodoSpecRows.statuses(database.db)).resolves.toStrictEqual(
        TodoSpecExpected.statusRows(bread),
      );
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装・無い id で別の Todo を消す誤りを通さない。
    And("存在しない Todo は、存在しないというエラーが返る", async () => {
      // given
      const milk = await TodoBuilder.of(database.db)
        .title("牛乳を買う")
        .build();

      // when
      const response = await deleteTodo(MISSING_ID);

      // then
      await TodoSpecProblems.expectResponse(
        response,
        TodoSpecProblems.notFound(MISSING_ID, `/api/todos/${MISSING_ID}`),
      );
      await expect(TodoSpecRows.todos(database.db)).resolves.toStrictEqual([
        TodoSpecExpected.row(milk),
      ]);
    });

    And(
      "削除済みの Todo をもう一度削除すると、存在しないというエラーが返る",
      async () => {
        // given
        const milk = await TodoBuilder.of(database.db)
          .title("牛乳を買う")
          .build();
        await deleteTodo(milk.id);
        const logs = await TodoSpecLogs.entries(database.db);

        // when
        const response = await deleteTodo(milk.id);

        // then
        await TodoSpecProblems.expectResponse(
          response,
          TodoSpecProblems.notFound(milk.id, `/api/todos/${milk.id}`),
        );
        await expect(TodoSpecLogs.entries(database.db)).resolves.toStrictEqual(
          logs,
        );
      },
    );
  });
});
