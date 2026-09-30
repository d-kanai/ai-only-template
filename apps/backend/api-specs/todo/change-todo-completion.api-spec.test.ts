// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { ChangeTodoCompletionResponse } from "../../features/todo/internal/presentation/change-todo-completion.api";
import type { CreateTodoResponse } from "../../features/todo/internal/presentation/create-todo.api";
import type { ChangeEntry } from "../../shared/infra/change-log";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import {
  changeCompletion,
  context,
  createTodo,
  emptyTodos,
  expectProblem,
  jsonRequest,
  logEntries,
  notFoundProblem,
  sortedLogs,
  statusInsertLog,
  statusRowOf,
  statusRows,
  storeTodo,
  type TodoApis,
  todoApis,
  todoRows,
  validationProblem,
} from "./support";

// API 仕様（Issue #219）: change-todo-completion.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler
//   （ChangeTodoCompletionApi.handle）を呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする）は
//   list-todos.api-spec.test.ts の冒頭、応答に加えて DB の行も見る WHY は create-todo.api-spec.test.ts の冒頭。

let database: TestDatabase;
let apis: TodoApis;
// 完了の通知の口に渡されたメッセージ（呼ばれた順）。
// WHY 本番の notify（notification の expose）ではなく記録する関数を渡す: notify はログに出すだけで、仕様から結果を読めない
//   （vi は使わない）。notify につながっていることは change-todo-completion.api.test.ts の「本番の PUT」のテストが見る。
const notifications: string[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  apis = todoApis(database.db, (message) => {
    notifications.push(message);
  });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
  notifications.length = 0;
});

async function putCompletion(id: string, body: unknown): Promise<Response> {
  return apis.putCompletion(
    jsonRequest("PUT", `/api/todos/${id}/completion`, body),
    context(id),
  );
}

// 完了の Todo を用意する（作って完了にする）。用意で送られた通知は、確かめる対象ではないので消す。
async function completedTodo(title: string): Promise<CreateTodoResponse> {
  const todo = await createTodo(apis, title);
  await changeCompletion(apis, todo.id, true);
  notifications.length = 0;
  return { ...todo, completed: true };
}

// 完了の履歴の 1 件目（作成時の未完了）。
function createdStatus(todo: CreateTodoResponse) {
  return {
    todoId: todo.id,
    position: 0,
    completed: false,
    changedAt: new Date(todo.createdAt),
  };
}

// 完了の履歴の position 番目を、日時を除いて比べる形にする。日時は API が now() で決めるので、作成日時以上であることを別に見る。
async function expectAddedStatus(
  todo: CreateTodoResponse,
  added: readonly boolean[],
): Promise<void> {
  const rows = await statusRows(database.db);
  expect(rows).toStrictEqual([
    createdStatus(todo),
    ...added.map((completed, index) => ({
      todoId: todo.id,
      position: index + 1,
      completed,
      changedAt: rows[index + 1]?.changedAt,
    })),
  ]);
  for (const row of rows) {
    expect(row.changedAt.getTime()).toBeGreaterThanOrEqual(
      Date.parse(todo.createdAt),
    );
  }
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./change-todo-completion.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    And("未完了の Todo を完了にすると、完了になった Todo が返る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      const response = await putCompletion(milk.id, { completed: true });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...milk,
        completed: true,
      } satisfies ChangeTodoCompletionResponse);
    });

    And(
      "完了の Todo を未完了に戻すと、未完了になった Todo が返る",
      async () => {
        const milk = await completedTodo("牛乳を買う");

        const response = await putCompletion(milk.id, { completed: false });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
          ...milk,
          completed: false,
        } satisfies ChangeTodoCompletionResponse);
      },
    );

    // 同じ要求を何度送っても結果が同じ（冪等。change-todo-completion.api.ts の冒頭）。
    And("既に完了の Todo を完了にしても、同じ結果が返る", async () => {
      const milk = await completedTodo("牛乳を買う");

      const response = await putCompletion(milk.id, { completed: true });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual(
        milk satisfies ChangeTodoCompletionResponse,
      );
    });
  });

  Scenario("記録", ({ And }) => {
    // WHY ほかの Todo を置く: 条件（where）の欠けた UPDATE ですべての Todo を完了にする誤りを見分ける。作成日時を古くして表に
    //   直接入れ、行の順（作成日時の順）で先頭に来るようにする。
    And("完了にしたことが保存され、ほかの Todo は変わらない", async () => {
      const bread = {
        id: "00000000-0000-4000-8000-000000000001",
        title: "パンを買う",
        completed: false,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      };
      await storeTodo(database.db, {
        ...bread,
        statusChanges: [{ completed: false, changedAt: bread.createdAt }],
      });
      const milk = await createTodo(apis, "牛乳を買う");

      await putCompletion(milk.id, { completed: true });

      await expect(todoRows(database.db)).resolves.toStrictEqual([
        bread,
        { ...milk, completed: true, createdAt: new Date(milk.createdAt) },
      ]);
    });

    And("完了にすると、完了の履歴に「完了」が 1 件足される", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      await putCompletion(milk.id, { completed: true });

      await expectAddedStatus(milk, [true]);
    });

    And("未完了に戻すと、完了の履歴に「未完了」が 1 件足される", async () => {
      const milk = await completedTodo("牛乳を買う");

      await putCompletion(milk.id, { completed: false });

      await expectAddedStatus(milk, [true, false]);
    });

    // 変わらない変更は書かない（Todo.changeCompletion が同じ Todo を返し、Repository の update は何も書かない）。
    And("既に完了の Todo を完了にしても、履歴は増えない", async () => {
      const milk = await completedTodo("牛乳を買う");
      const before = await statusRows(database.db);

      await putCompletion(milk.id, { completed: true });

      await expect(statusRows(database.db)).resolves.toStrictEqual(before);
    });

    // 作成の 2 件に、todos の completed の update と、完了の履歴の insert（全列）が足される。
    And("変更の記録に、完了かどうかの変更と履歴の追加が残る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      const created = await logEntries(database.db);

      await putCompletion(milk.id, { completed: true });

      const completion = await statusRowOf(database.db, milk.id, 1);
      await expect(logEntries(database.db)).resolves.toStrictEqual(
        sortedLogs([
          ...created,
          {
            tableName: "todos",
            rowId: milk.id,
            operation: "update",
            changes: { completed: { before: false, after: true } },
            actorId: null,
          } satisfies ChangeEntry,
          statusInsertLog(completion),
        ]),
      );
    });
  });

  Scenario("副作用", ({ And }) => {
    // 通知の本文は id だけの英語（Issue #208）。同じ要求をもう一度送っても（既に完了）通知は増えない。
    And(
      "未完了から完了に変わったときだけ、完了の通知が 1 件送られる",
      async () => {
        const milk = await createTodo(apis, "牛乳を買う");

        await putCompletion(milk.id, { completed: true });
        await putCompletion(milk.id, { completed: true });

        expect(notifications).toStrictEqual([`Todo completed: ${milk.id}`]);
      },
    );

    And("未完了に戻したときは通知されない", async () => {
      const milk = await completedTodo("牛乳を買う");

      const response = await putCompletion(milk.id, { completed: false });

      expect(response.status).toBe(200);
      expect(notifications).toStrictEqual([]);
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装を通さない。無い Todo への要求は通知もしない。
    And("存在しない Todo は、存在しないと伝えられる", async () => {
      await createTodo(apis, "牛乳を買う");

      const response = await putCompletion(MISSING_ID, { completed: true });

      await expectProblem(
        response,
        notFoundProblem(MISSING_ID, `/api/todos/${MISSING_ID}/completion`),
      );
      expect(notifications).toStrictEqual([]);
    });

    // 文字列の "true" も拒否する（型の違い。json-body.ts の toProblemError の request.field.notBoolean）。
    And(
      "完了かどうかが真偽値でないと、形が違うという理由で拒否され、何も変わらない",
      async () => {
        const milk = await createTodo(apis, "牛乳を買う");
        const logs = await logEntries(database.db);

        const response = await putCompletion(milk.id, { completed: "true" });

        await expectProblem(
          response,
          validationProblem(`/api/todos/${milk.id}/completion`, {
            detail: "completed must be a boolean.",
            key: "request.field.notBoolean",
            params: { path: "completed" },
            errors: [
              {
                pointer: "#/completed",
                key: "request.field.notBoolean",
                params: { path: "completed" },
                detail: "completed must be a boolean.",
              },
            ],
          }),
        );
        await expect(todoRows(database.db)).resolves.toStrictEqual([
          { ...milk, createdAt: new Date(milk.createdAt) },
        ]);
        await expect(logEntries(database.db)).resolves.toStrictEqual(logs);
        expect(notifications).toStrictEqual([]);
      },
    );
  });
});
