// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { CreateTodoResponse } from "../../features/todo/internal/presentation/create-todo.api";
import type { DeleteTodoApi } from "../../features/todo/internal/presentation/delete-todo.api";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import {
  bodylessRequest,
  context,
  createTodo,
  emptyTodos,
  expectProblem,
  logEntries,
  notFoundProblem,
  sortedLogs,
  statusRows,
  type TodoApis,
  todoApis,
  todoRows,
} from "./support";

// API 仕様（Issue #219）: delete-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（DeleteTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする）は list-todos.api-spec.test.ts の冒頭、
//   応答に加えて DB の行も見る WHY は create-todo.api-spec.test.ts の冒頭。

let database: TestDatabase;
let apis: TodoApis;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  // 削除の API は通知しない。
  apis = todoApis(database.db, () => undefined);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
});

// WHY 戻り値を DeleteTodoApi の handle の型にする: 対の api ファイルの型を使い、この仕様が delete-todo.api のものだと import で示す
//   （rule-tests/api-spec.test.ts の api-spec-uses-own-api）。
async function deleteTodo(id: string): ReturnType<DeleteTodoApi["handle"]> {
  return apis.deleteTodo(
    bodylessRequest("DELETE", `/api/todos/${id}`),
    context(id),
  );
}

// 作った Todo の todos の行（作成日時は行では Date）。
function rowOf(todo: CreateTodoResponse) {
  return { ...todo, createdAt: new Date(todo.createdAt) };
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./delete-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    // 削除の後に返す内容は無い（204 で本文が空）。
    And("Todo を削除すると、何も返さずに成功を伝える", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      const response = await deleteTodo(milk.id);

      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");
    });
  });

  Scenario("記録", ({ And }) => {
    // WHY ほかの Todo を置く: 条件（where）の欠けた DELETE ですべてを消す誤り・別の Todo を消す取り違えを見分ける。
    // 変更の記録（.feature には書かない。create-todo.api-spec.test.ts の冒頭）: 削除の前の記録（2 件の Todo の作成の 4 件。消した
    //   Todo の分も）は消えずに残り（insert のみの監査）、消した Todo の消す前の全列の before が 1 件だけ足される（cascade で
    //   消えた完了の履歴の行は記録しない）。
    And("削除した Todo は無くなり、ほかの Todo は残る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      const bread = await createTodo(apis, "パンを買う");
      const created = await logEntries(database.db);

      await deleteTodo(milk.id);

      await expect(todoRows(database.db)).resolves.toStrictEqual([
        rowOf(bread),
      ]);
      // WHY 件数も見る: 作成の記録が無い（空）と、「消えずに残る」が何も確かめないまま通る。
      expect(created).toHaveLength(4);
      await expect(logEntries(database.db)).resolves.toStrictEqual(
        sortedLogs([
          ...created,
          {
            tableName: "todos",
            rowId: milk.id,
            operation: "delete",
            changes: {
              id: { before: milk.id },
              title: { before: milk.title },
              completed: { before: milk.completed },
              created_at: { before: milk.createdAt },
            },
            actorId: null,
          },
        ]),
      );
    });

    // 外部キーの on delete cascade で消える（履歴の DELETE は書かない。schema.ts の todoStatusChanges）。ほかの Todo の履歴は残る。
    And("削除した Todo の完了の履歴も無くなる", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      const bread = await createTodo(apis, "パンを買う");

      await deleteTodo(milk.id);

      await expect(statusRows(database.db)).resolves.toStrictEqual([
        {
          todoId: bread.id,
          position: 0,
          completed: false,
          changedAt: new Date(bread.createdAt),
        },
      ]);
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装・無い id で別の Todo を消す誤りを通さない。
    And("存在しない Todo は、存在しないと伝えられる", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      const response = await deleteTodo(MISSING_ID);

      await expectProblem(
        response,
        notFoundProblem(MISSING_ID, `/api/todos/${MISSING_ID}`),
      );
      await expect(todoRows(database.db)).resolves.toStrictEqual([rowOf(milk)]);
    });

    And(
      "削除済みの Todo をもう一度削除すると、存在しないと伝えられる",
      async () => {
        const milk = await createTodo(apis, "牛乳を買う");
        await deleteTodo(milk.id);
        const logs = await logEntries(database.db);

        const response = await deleteTodo(milk.id);

        await expectProblem(
          response,
          notFoundProblem(milk.id, `/api/todos/${milk.id}`),
        );
        await expect(logEntries(database.db)).resolves.toStrictEqual(logs);
      },
    );
  });
});
