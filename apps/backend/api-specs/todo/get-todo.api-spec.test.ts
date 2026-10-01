// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { GetTodoResponse } from "../../features/todo/internal/presentation/get-todo.api";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import {
  bodylessRequest,
  changeCompletion,
  context,
  createTodo,
  emptyTodos,
  expectProblem,
  internalErrorProblem,
  jsonRequest,
  notFoundProblem,
  storeTodo,
  type TodoApis,
  todoApis,
} from "./support";

// API 仕様（Issue #219）: get-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（GetTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする）は list-todos.api-spec.test.ts の冒頭。

let database: TestDatabase;
let apis: TodoApis;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  // 詳細の API は通知しない。前提（完了にする）で呼ばれる通知は見ないので捨てる。
  apis = todoApis(database.db, () => undefined);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
});

async function getTodo(id: string): Promise<Response> {
  return apis.getTodo(bodylessRequest("GET", `/api/todos/${id}`), context(id));
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./get-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    // 作成の応答（id・タイトル・完了かどうか・作成日時）と同じ内容が返る。
    // WHY 2 件作って 1 件目を見る: 指定した Todo を返すこと（先頭や最後の 1 件を返す誤り）を見分ける。
    And(
      "作った Todo の詳細を見ると、タイトル・完了かどうか・作成日時が返る",
      async () => {
        const milk = await createTodo(apis, "牛乳を買う");
        await createTodo(apis, "パンを買う");

        const response = await getTodo(milk.id);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual(
          milk satisfies GetTodoResponse,
        );
      },
    );

    And("完了にした Todo は、完了として返る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      await changeCompletion(apis, milk.id, true);

      const response = await getTodo(milk.id);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...milk,
        completed: true,
      } satisfies GetTodoResponse);
    });

    And("名前を変えた Todo は、新しいタイトルで返る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      const renamed = await apis.putTitle(
        jsonRequest("PUT", `/api/todos/${milk.id}/title`, {
          title: "豆乳を買う",
        }),
        context(milk.id),
      );
      expect(renamed.status).toBe(200);

      const response = await getTodo(milk.id);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...milk,
        title: "豆乳を買う",
      } satisfies GetTodoResponse);
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装を通さない。
    And("存在しない Todo は、存在しないと伝えられる", async () => {
      await createTodo(apis, "牛乳を買う");

      const response = await getTodo(MISSING_ID);

      await expectProblem(
        response,
        notFoundProblem(MISSING_ID, `/api/todos/${MISSING_ID}`),
      );
    });

    // uuid の形でない id は、無い Todo と同じ 404（画面から見て「無い Todo」。get-todo.api.ts の parseUuidParam）。
    And(
      "Todo を指す値の形が正しくないときも、存在しないと伝えられる",
      async () => {
        const response = await getTodo("missing");

        await expectProblem(
          response,
          notFoundProblem("missing", "/api/todos/missing"),
        );
      },
    );

    And("削除した Todo は、存在しないと伝えられる", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      const deleted = await apis.deleteTodo(
        bodylessRequest("DELETE", `/api/todos/${milk.id}`),
        context(milk.id),
      );
      expect(deleted.status).toBe(204);

      const response = await getTodo(milk.id);

      await expectProblem(
        response,
        notFoundProblem(milk.id, `/api/todos/${milk.id}`),
      );
    });

    // 完了の履歴の無い Todo は不変条件の違反で、クライアントには直せないサーバ側の誤り（500。todo-repository.postgres.ts の toTodo）。
    // 例外は toProblemResponse が logger.emit（server_error。ERROR なので console.error）で標準エラーに 1 行出す（vi を使わないので抑えない）。
    And(
      "壊れた Todo（完了の履歴が無いもの）は、サーバの誤りとして伝えられる",
      async () => {
        const id = "00000000-0000-4000-8000-000000000001";
        await storeTodo(database.db, {
          id,
          title: "牛乳を買う",
          completed: false,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          statusChanges: [],
        });

        const response = await getTodo(id);

        await expectProblem(response, internalErrorProblem(`/api/todos/${id}`));
      },
    );
  });
});
