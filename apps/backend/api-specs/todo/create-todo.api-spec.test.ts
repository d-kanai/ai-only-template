// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { CreateTodoResponse } from "../../features/todo/internal/presentation/create-todo.api";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import {
  createTodo,
  emptyTodos,
  expectProblem,
  jsonRequest,
  logEntries,
  rawRequest,
  sortedLogs,
  statusInsertLog,
  statusRowOf,
  statusRows,
  type TodoApis,
  todoApis,
  todoInsertLog,
  todoRows,
  validationProblem,
} from "./support";

// API 仕様（Issue #219）: create-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（CreateTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする）は list-todos.api-spec.test.ts の冒頭。
// WHY 応答に加えて DB の行も見る: 応答が正しくても永続化がずれる誤り（列の取り違え・履歴や変更の記録の書き忘れ）は応答だけでは
//   見逃す（API ジャーニーと同じ方針。Issue #187）。拒否した要求は何も書かないこと（表と変更の記録が空のまま）も見る。

let database: TestDatabase;
let apis: TodoApis;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  // 作成の API は通知しない。
  apis = todoApis(database.db, () => undefined);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
});

async function postTodo(body: unknown): Promise<Response> {
  return apis.postTodo(jsonRequest("POST", "/api/todos", body));
}

// 拒否した要求の後、Todo・完了の履歴・変更の記録のどれにも行が無い。
async function expectNothingStored(): Promise<void> {
  await expect(todoRows(database.db)).resolves.toStrictEqual([]);
  await expect(statusRows(database.db)).resolves.toStrictEqual([]);
  await expect(logEntries(database.db)).resolves.toStrictEqual([]);
}

const feature = await loadFeature("./create-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    // id と作成日時は API が決める（randomUUID と now()）ので、形と範囲を確かめる。作成日時は要求の前後の時刻の間。
    And("タイトルを渡すと、未完了の Todo が作られて返る", async () => {
      const before = Date.now();

      const response = await postTodo({ title: "牛乳を買う" });

      const after = Date.now();
      expect(response.status).toBe(201);
      const body = (await response.json()) as CreateTodoResponse;
      expect(body).toStrictEqual({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        title: "牛乳を買う",
        completed: false,
        createdAt: new Date(Date.parse(body.createdAt)).toISOString(),
      } satisfies CreateTodoResponse);
      expect(Date.parse(body.createdAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(body.createdAt)).toBeLessThanOrEqual(after);
    });

    And("タイトルの前後の空白は除かれる", async () => {
      const response = await postTodo({ title: " \t牛乳を買う　" });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        title: "牛乳を買う",
      });
    });

    // 上限は domain の TODO_TITLE_MAX_LENGTH（100）。文字数はコードポイント数（絵文字 1 つは String#length では 2）。
    And("100 文字のタイトルまで作れる（絵文字は 1 文字と数える）", async () => {
      const title = "🍎".repeat(100);

      const response = await postTodo({ title });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ title });
    });
  });

  Scenario("記録", ({ And }) => {
    // 行の全列（id・タイトル・完了かどうか・作成日時）が応答と同じ。作成日時は行では Date（schema.ts の mode "date"）。
    And("作った Todo が、返った内容のとおりに保存される", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      await expect(todoRows(database.db)).resolves.toStrictEqual([
        { ...milk, createdAt: new Date(milk.createdAt) },
      ]);
    });

    // 作成日時に未完了（Todo.create）。
    And("完了の履歴に、作成時の「未完了」が 1 件残る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      await expect(statusRows(database.db)).resolves.toStrictEqual([
        {
          todoId: milk.id,
          position: 0,
          completed: false,
          changedAt: new Date(milk.createdAt),
        },
      ]);
    });

    And("変更の記録に、Todo と完了の履歴の作成が残る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      const created = await statusRowOf(database.db, milk.id, 0);
      await expect(logEntries(database.db)).resolves.toStrictEqual(
        sortedLogs([todoInsertLog(milk), statusInsertLog(created)]),
      );
    });
  });

  Scenario("異常系", ({ And }) => {
    // 拒否は 400 の Problem Details（validation error。title が空のキー）。空白だけも前後を除くと空。
    And(
      "タイトルが空（空白だけも含む）だと、空という理由で拒否され、何も保存されない",
      async () => {
        for (const title of ["", "  "]) {
          const response = await postTodo({ title });

          await expectProblem(
            response,
            validationProblem("/api/todos", {
              detail: "Title must not be empty.",
              key: "todo.title.empty",
              errors: [
                {
                  pointer: "#/title",
                  key: "todo.title.empty",
                  detail: "Title must not be empty.",
                },
              ],
            }),
          );
        }
        await expectNothingStored();
      },
    );

    And(
      "101 文字のタイトルは、長すぎるという理由で拒否され、何も保存されない",
      async () => {
        const response = await postTodo({ title: "🍎".repeat(101) });

        await expectProblem(
          response,
          validationProblem("/api/todos", {
            detail: "Title must be at most 100 characters.",
            key: "todo.title.tooLong",
            params: { max: 100 },
            errors: [
              {
                pointer: "#/title",
                key: "todo.title.tooLong",
                params: { max: 100 },
                detail: "Title must be at most 100 characters.",
              },
            ],
          }),
        );
        await expectNothingStored();
      },
    );

    And(
      "タイトルが文字列でないと、形が違うという理由で拒否され、何も保存されない",
      async () => {
        const response = await postTodo({ title: 1 });

        await expectProblem(
          response,
          validationProblem("/api/todos", {
            detail: "title must be a string.",
            key: "request.field.notString",
            params: { path: "title" },
            errors: [
              {
                pointer: "#/title",
                key: "request.field.notString",
                params: { path: "title" },
                detail: "title must be a string.",
              },
            ],
          }),
        );
        await expectNothingStored();
      },
    );

    // 作成で完了かどうかは受け付けない（作った Todo は常に未完了）。黙って捨てずに拒否する（json-body.ts の requestBodySchema）。
    And(
      "決められていない項目があると、拒否され、何も保存されない",
      async () => {
        const response = await postTodo({
          title: "牛乳を買う",
          completed: true,
        });

        await expectProblem(
          response,
          validationProblem("/api/todos", {
            detail: "Request body has unknown fields: completed.",
            key: "request.body.unknownKeys",
            params: { keys: "completed" },
            errors: [
              {
                pointer: "#",
                key: "request.body.unknownKeys",
                params: { keys: "completed" },
                detail: "Request body has unknown fields: completed.",
              },
            ],
          }),
        );
        await expectNothingStored();
      },
    );

    // JSON として読めない本文。項目が無いので errors は付かない。
    And("内容が読み取れない形式だと、拒否され、何も保存されない", async () => {
      const response = await apis.postTodo(
        rawRequest("POST", "/api/todos", "{title:"),
      );

      await expectProblem(
        response,
        validationProblem("/api/todos", {
          detail: "Request body must be valid JSON.",
          key: "request.body.notJson",
        }),
      );
      await expectNothingStored();
    });
  });
});
