// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { ListTodosResponse } from "../../features/todo/internal/presentation/list-todos.api";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import { aTodo } from "../../test-support/todo/todo-builder";
import {
  bodylessRequest,
  emptyTodos,
  expectProblem,
  internalErrorProblem,
  listTodosApi,
  todoResponseOf,
} from "./support";

// API 仕様（Issue #219）: list-todos.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（ListTodosApi.handle）を
//   呼んで確かめる。状態コード・本文・DB の行の検証はこのファイルに閉じ、.feature には業務の言葉だけを書く。
// WHY テストダブルを使わない（vi を import しない・InMemory も無し）: 本番と同じ部品の組み合わせで API が仕様どおりに振る舞うことを
//   確かめるのが目的で、差し替えるとその部分を確かめなくなる。handler の分岐ごとの細かいケースは presentation の UT（*.api.test.ts）が持つ。
// WHY `*` の step を And で定義する: vitest-cucumber 8.0.0 は英語の方言で `*` を And のキーワードとして読む
//   （node_modules/@amiceli/vitest-cucumber の parser の lang.json で "and": ["* ", "And "]。2026-09-30 に実測）。
// WHY 各 step の前に表を空にする（beforeEach）: vitest-cucumber は step 1 つを Vitest の test 1 つとして実行する。ファイルの
//   最上位の beforeEach はすべての test（= step）の前に動くので、どの step も空の状態から自分で前提を用意する（前の step に依存しない）。
// WHY 前提の Todo はテストデータビルダー（aTodo。test-support/todo/todo-builder.ts）で表に直接入れ、step が呼ぶ API は仕様の対象の 1 つ
//   だけにする（ユーザー判断 2026-10-01、Issue #240）: 前提の用意を対象でない API（作成・完了など）に依存させず、作成日時を決めた Todo・
//   壊れた Todo も同じ書き方で作る。ほかの API の handler を呼ばないことは rule-tests/api-spec.test.ts の api-spec-own-api-only が止める。
//   ほかの api-spec も同じ。

let database: TestDatabase;
let handler: ReturnType<typeof listTodosApi>;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  handler = listTodosApi(database.db);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
});

async function listTodos(): Promise<Response> {
  return handler(bodylessRequest("GET", "/api/todos"));
}

// 作成日時と id を決めた未完了の Todo（完了の履歴は作成時の未完了の 1 件。ビルダーの既定）。
function uncompletedTodo(id: string, title: string, createdAt: Date) {
  return aTodo(database.db).id(id).title(title).createdAt(createdAt);
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
    // 表の Todo（id・タイトル・完了かどうか・作成日時）と同じ内容が一覧に出る。作成日時は ISO 8601 の文字列。
    And("各 Todo は、タイトル・完了かどうか・作成日時を持つ", async () => {
      const milk = await aTodo(database.db).title("牛乳を買う").build();

      const response = await listTodos();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [todoResponseOf(milk)],
      } satisfies ListTodosResponse);
    });

    And("完了にした Todo も一覧に含まれる", async () => {
      const milk = await aTodo(database.db)
        .title("牛乳を買う")
        .completed(true)
        .build();

      const response = await listTodos();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [todoResponseOf({ ...milk, completed: true })],
      } satisfies ListTodosResponse);
    });
  });

  Scenario("ソート", ({ And }) => {
    // WHY 新しいものから表に入れる: 入れた順のまま返す実装でも通らないように、入れた順と作成日時の順を逆にする。
    And("作成した順（古いものが先）に並ぶ", async () => {
      const newest = await uncompletedTodo(
        "00000000-0000-4000-8000-000000000001",
        "卵を買う",
        new Date("2026-09-03T00:00:00.000Z"),
      ).build();
      const oldest = await uncompletedTodo(
        "00000000-0000-4000-8000-000000000003",
        "牛乳を買う",
        new Date("2026-09-01T00:00:00.000Z"),
      ).build();
      const middle = await uncompletedTodo(
        "00000000-0000-4000-8000-000000000002",
        "パンを買う",
        new Date("2026-09-02T00:00:00.000Z"),
      ).build();

      const response = await listTodos();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [oldest, middle, newest].map(todoResponseOf),
      } satisfies ListTodosResponse);
    });

    // 作成日時が同じなら Todo の id の昇順（todo-repository.postgres.ts の selectTodos の ORDER BY）。
    // WHY 2 回呼んで比べ、id の順とも比べる: 「毎回同じ順」だけでは、たまたま同じ順だった 2 回を見分けられない。決まった規則
    //   （id の昇順）で並ぶことを、入れた順（id の順と違う）と比べて確かめる。
    And("同じ日時に作られた Todo は、毎回同じ順で並ぶ", async () => {
      const createdAt = new Date("2026-09-01T00:00:00.000Z");
      const third = await uncompletedTodo(
        "00000000-0000-4000-8000-000000000003",
        "卵を買う",
        createdAt,
      ).build();
      const first = await uncompletedTodo(
        "00000000-0000-4000-8000-000000000001",
        "牛乳を買う",
        createdAt,
      ).build();
      const second = await uncompletedTodo(
        "00000000-0000-4000-8000-000000000002",
        "パンを買う",
        createdAt,
      ).build();
      const expected = {
        todos: [first, second, third].map(todoResponseOf),
      } satisfies ListTodosResponse;

      for (const response of [await listTodos(), await listTodos()]) {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual(expected);
      }
    });
  });

  Scenario("異常系", ({ And }) => {
    // 完了の履歴の日時が作成日時より前の Todo は不変条件の違反で、クライアントには直せないサーバ側の誤り（500。
    //   todo-repository.postgres.ts の toTodo）。履歴の無い Todo・最後の履歴が todos.completed と食い違う Todo（デプロイの途中で
    //   古い版が作った・completed だけを変えたもの）は Repository が補って読むので壊れていない（Issue #194・#237。repairHistory）。
    //   補っても直らない並びの壊れた履歴だけが 500 になる。
    // WHY 正しい Todo も 1 件置く: 壊れた 1 件を黙って外して残りを返す実装を通さない。
    // 例外は toProblemResponse が logger.emit（server_error。ERROR なので console.error）で標準エラーに 1 行出す（vi を使わないので抑えない）。
    And(
      "壊れた Todo（完了の履歴の日時が、作られた日時より前のもの）が 1 件でもあると、一覧は取得できず、サーバの誤りとして伝えられる",
      async () => {
        const createdAt = new Date("2026-09-01T00:00:00.000Z");
        await uncompletedTodo(
          "00000000-0000-4000-8000-000000000001",
          "牛乳を買う",
          createdAt,
        ).build();
        await uncompletedTodo(
          "00000000-0000-4000-8000-000000000002",
          "パンを買う",
          createdAt,
        )
          .statusChanges([
            {
              completed: false,
              changedAt: new Date("2026-08-31T00:00:00.000Z"),
            },
          ])
          .build();

        const response = await listTodos();

        await expectProblem(response, internalErrorProblem("/api/todos"));
      },
    );
  });
});
