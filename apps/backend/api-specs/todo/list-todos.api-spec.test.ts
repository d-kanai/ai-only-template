// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { ListTodosResponse } from "../../features/todo/internal/presentation/list-todos.api";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import {
  bodylessRequest,
  changeCompletion,
  createTodo,
  emptyTodos,
  expectProblem,
  internalErrorProblem,
  type StoredTodo,
  storeTodo,
  type TodoApis,
  todoApis,
} from "./support";

// API 仕様（Issue #219）: list-todos.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（ListTodosApi.handle）を
//   呼んで確かめる。状態コード・本文・DB の行の検証はこのファイルに閉じ、.feature には業務の言葉だけを書く。
// WHY テストダブルを使わない（vi を import しない・InMemory も無し）: 本番と同じ部品の組み合わせで API が仕様どおりに振る舞うことを
//   確かめるのが目的で、差し替えるとその部分を確かめなくなる。handler の分岐ごとの細かいケースは presentation の UT（*.api.test.ts）が持つ。
// WHY `*` の step を And で定義する: vitest-cucumber 8.0.0 は英語の方言で `*` を And のキーワードとして読む
//   （node_modules/@amiceli/vitest-cucumber の parser の lang.json で "and": ["* ", "And "]。2026-09-30 に実測）。
// WHY 各 step の前に表を空にする（beforeEach）: vitest-cucumber は step 1 つを Vitest の test 1 つとして実行する。ファイルの
//   最上位の beforeEach はすべての test（= step）の前に動くので、どの step も空の状態から自分で前提を用意する（前の step に依存しない）。

let database: TestDatabase;
let apis: TodoApis;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  // 一覧の API は通知しない。前提（完了にする）で呼ばれる通知は見ないので捨てる。
  apis = todoApis(database.db, () => undefined);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
});

async function listTodos(): Promise<Response> {
  return apis.listTodos(bodylessRequest("GET", "/api/todos"));
}

// 一覧の 1 件の期待値（表に直接入れた Todo から）。作成日時は ISO 8601 の文字列で返る。
function itemOf(todo: StoredTodo): ListTodosResponse["todos"][number] {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// 未完了のまま作られた Todo（完了の履歴は作成時の未完了の 1 件）。
function uncompletedTodo(
  id: string,
  title: string,
  createdAt: Date,
): StoredTodo {
  return {
    id,
    title,
    completed: false,
    createdAt,
    statusChanges: [{ completed: false, changedAt: createdAt }],
  };
}

const feature = await loadFeature("./list-todos.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    And("Todo が無ければ、空の一覧が返る", async () => {
      const response = await listTodos();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [],
      } satisfies ListTodosResponse);
    });

    // 作成の応答（id・タイトル・完了かどうか・作成日時）と同じ内容が一覧に出る。
    And("各 Todo は、タイトル・完了かどうか・作成日時を持つ", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      const response = await listTodos();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [milk],
      } satisfies ListTodosResponse);
    });

    And("完了にした Todo も一覧に含まれる", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      await changeCompletion(apis, milk.id, true);

      const response = await listTodos();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [{ ...milk, completed: true }],
      } satisfies ListTodosResponse);
    });
  });

  Scenario("ソート", ({ And }) => {
    // WHY 新しいものから表に入れる: 入れた順のまま返す実装でも通らないように、入れた順と作成日時の順を逆にする。
    And("作成した順（古いものが先）に並ぶ", async () => {
      const oldest = uncompletedTodo(
        "00000000-0000-4000-8000-000000000003",
        "牛乳を買う",
        new Date("2026-09-01T00:00:00.000Z"),
      );
      const middle = uncompletedTodo(
        "00000000-0000-4000-8000-000000000002",
        "パンを買う",
        new Date("2026-09-02T00:00:00.000Z"),
      );
      const newest = uncompletedTodo(
        "00000000-0000-4000-8000-000000000001",
        "卵を買う",
        new Date("2026-09-03T00:00:00.000Z"),
      );
      for (const todo of [newest, oldest, middle]) {
        await storeTodo(database.db, todo);
      }

      const response = await listTodos();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [itemOf(oldest), itemOf(middle), itemOf(newest)],
      } satisfies ListTodosResponse);
    });

    // 作成日時が同じなら Todo の id の昇順（todo-repository.postgres.ts の selectTodos の ORDER BY）。
    // WHY 2 回呼んで比べ、id の順とも比べる: 「毎回同じ順」だけでは、たまたま同じ順だった 2 回を見分けられない。決まった規則
    //   （id の昇順）で並ぶことを、入れた順（id の順と違う）と比べて確かめる。
    And("同じ日時に作られた Todo は、毎回同じ順で並ぶ", async () => {
      const createdAt = new Date("2026-09-01T00:00:00.000Z");
      const first = uncompletedTodo(
        "00000000-0000-4000-8000-000000000001",
        "牛乳を買う",
        createdAt,
      );
      const second = uncompletedTodo(
        "00000000-0000-4000-8000-000000000002",
        "パンを買う",
        createdAt,
      );
      const third = uncompletedTodo(
        "00000000-0000-4000-8000-000000000003",
        "卵を買う",
        createdAt,
      );
      for (const todo of [third, first, second]) {
        await storeTodo(database.db, todo);
      }
      const expected = {
        todos: [itemOf(first), itemOf(second), itemOf(third)],
      } satisfies ListTodosResponse;

      for (const response of [await listTodos(), await listTodos()]) {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual(expected);
      }
    });
  });

  Scenario("異常系", ({ And }) => {
    // 完了の履歴の無い Todo は不変条件の違反で、クライアントには直せないサーバ側の誤り（500。todo-repository.postgres.ts の toTodo）。
    // WHY 正しい Todo も 1 件置く: 壊れた 1 件を黙って外して残りを返す実装を通さない。
    // 例外は toProblemResponse が logger.emit（server_error。ERROR なので console.error）で標準エラーに 1 行出す（vi を使わないので抑えない）。
    And(
      "壊れた Todo（完了の履歴が無いもの）が 1 件でもあると、一覧は取得できず、サーバの誤りとして伝えられる",
      async () => {
        const createdAt = new Date("2026-09-01T00:00:00.000Z");
        await storeTodo(
          database.db,
          uncompletedTodo(
            "00000000-0000-4000-8000-000000000001",
            "牛乳を買う",
            createdAt,
          ),
        );
        await storeTodo(database.db, {
          ...uncompletedTodo(
            "00000000-0000-4000-8000-000000000002",
            "パンを買う",
            createdAt,
          ),
          statusChanges: [],
        });

        const response = await listTodos();

        await expectProblem(response, internalErrorProblem("/api/todos"));
      },
    );
  });
});
