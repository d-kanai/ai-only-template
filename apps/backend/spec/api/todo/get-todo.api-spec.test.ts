// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { GetTodoResponse } from "../../../features/todo/internal/presentation/get-todo.api";
import { TestDatabase } from "../../../test-support/database";
import { TodoBuilder } from "../../../test-support/todo/todo-builder";
import {
  GetTodoApiAssembly,
  TodoSpecExpected,
  TodoSpecProblems,
  TodoSpecRequests,
  TodoSpecRows,
} from "./support";

// API 仕様（Issue #219）: get-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（GetTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする・前提はビルダーで作る）は
//   list-todos.api-spec.test.ts の冒頭。

let database: TestDatabase;
let handler: ReturnType<typeof GetTodoApiAssembly.handler>;

beforeAll(async () => {
  database = await TestDatabase.create();
  await database.migrate();
  handler = GetTodoApiAssembly.handler(database.db);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await TodoSpecRows.empty(database.db);
});

async function getTodo(id: string): Promise<Response> {
  return handler(
    TodoSpecRequests.bodyless("GET", `/api/todos/${id}`),
    TodoSpecRequests.context(id),
  );
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./get-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    // 表の Todo（id・タイトル・完了かどうか・作成日時）と同じ内容が返る。作成日時は ISO 8601 の文字列。
    // WHY 2 件入れて 1 件目を見る: 指定した Todo を返すこと（先頭や最後の 1 件を返す誤り）を見分ける。
    And(
      "作った Todo の詳細を見ると、タイトル・完了かどうか・作成日時が返る",
      async () => {
        // given
        const milk = await TodoBuilder.of(database.db)
          .title("牛乳を買う")
          .build();
        await TodoBuilder.of(database.db).title("パンを買う").build();

        // when
        const response = await getTodo(milk.id);

        // then
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual(
          TodoSpecExpected.response(milk) satisfies GetTodoResponse,
        );
      },
    );

    And("完了にした Todo は、完了として返る", async () => {
      // given
      const milk = await TodoBuilder.of(database.db)
        .title("牛乳を買う")
        .completed(true)
        .build();

      // when
      const response = await getTodo(milk.id);

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...TodoSpecExpected.response(milk),
        completed: true,
      } satisfies GetTodoResponse);
    });

    // 名前を変えた後の Todo = 表のタイトルが新しいものになった Todo（完了の履歴は名前の変更で増えない）。名前の変更の API は通さず、
    //   その後の状態をビルダーで作る（冒頭の WHY）。名前の変更が表に書く内容は rename-todo の仕様が確かめる。
    And("名前を変えた Todo は、新しいタイトルで返る", async () => {
      // given
      const milk = await TodoBuilder.of(database.db)
        .title("豆乳を買う")
        .build();

      // when
      const response = await getTodo(milk.id);

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...TodoSpecExpected.response(milk),
        title: "豆乳を買う",
      } satisfies GetTodoResponse);
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装を通さない。
    And("存在しない Todo は、存在しないというエラーが返る", async () => {
      // given
      await TodoBuilder.of(database.db).title("牛乳を買う").build();

      // when
      const response = await getTodo(MISSING_ID);

      // then
      await TodoSpecProblems.expectResponse(
        response,
        TodoSpecProblems.notFound(MISSING_ID, `/api/todos/${MISSING_ID}`),
      );
    });

    // uuid の形でない id は、無い Todo と同じ 404（画面から見て「無い Todo」。get-todo.api.ts の ResourceId.parseUuid）。
    And(
      "Todo を指定する値の形式が正しくないときも、存在しないというエラーが返る",
      async () => {
        // given: beforeEach で Todo を空にしてある
        // when
        const response = await getTodo("missing");

        // then
        await TodoSpecProblems.expectResponse(
          response,
          TodoSpecProblems.notFound("missing", "/api/todos/missing"),
        );
      },
    );

    // 削除の後の状態（行が無い）を、削除の API を通さずに作る（support.ts の TodoSpecRows.remove）。
    And("削除した Todo は、存在しないというエラーが返る", async () => {
      // given
      const milk = await TodoBuilder.of(database.db)
        .title("牛乳を買う")
        .build();
      await TodoSpecRows.remove(database.db, milk.id);

      // when
      const response = await getTodo(milk.id);

      // then
      await TodoSpecProblems.expectResponse(
        response,
        TodoSpecProblems.notFound(milk.id, `/api/todos/${milk.id}`),
      );
    });

    // 完了の履歴の日時が作成日時より前の Todo は不変条件の違反で、クライアントには直せないサーバ側の誤り（500。
    //   todo-repository.postgres.ts の toTodo）。履歴の無い Todo・最後の履歴が todos.completed と食い違う Todo も同じく 500
    //   （Repository は補わない。Issue #260）。
    // 例外は ProblemResponse.from が logger.emit（server_error。ERROR なので console.error）で標準エラーに 1 行出す（vi を使わないので抑えない）。
    And(
      "壊れた Todo（完了の履歴の日時が作成日時より前のもの）は、サーバエラーになる",
      async () => {
        // given
        const { id } = await TodoBuilder.of(database.db)
          .title("牛乳を買う")
          .createdAt(new Date("2026-09-01T00:00:00.000Z"))
          .statusChanges([
            {
              completed: false,
              changedAt: new Date("2026-08-31T00:00:00.000Z"),
            },
          ])
          .build();

        // when
        const response = await getTodo(id);

        // then
        await TodoSpecProblems.expectResponse(
          response,
          TodoSpecProblems.internalError(`/api/todos/${id}`),
        );
      },
    );
  });
});
