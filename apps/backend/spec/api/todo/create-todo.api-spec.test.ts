// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { CreateTodoResponse } from "../../../features/todo/internal/presentation/create-todo.api";
import { TestDatabase } from "../../../test-support/database";
import {
  CreateTodoApiAssembly,
  TodoSpecLogs,
  TodoSpecProblems,
  TodoSpecRequests,
  TodoSpecRows,
} from "./support";

// API 仕様（Issue #219）: create-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（CreateTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする）は list-todos.api-spec.test.ts の冒頭。
// WHY 応答に加えて DB の行も見る: 応答が正しくても永続化がずれる誤り（列の取り違え・履歴や変更の記録の書き忘れ）は応答だけでは
//   見逃す（API ジャーニーと同じ方針。Issue #187）。拒否した要求は何も書かないこと（表と変更の記録が空のまま）も見る。
// WHY 変更の記録（change_logs）は .feature に書かず、同じ操作の結果を確かめる step の中で確かめる（ユーザー指示 2026-10-01）:
//   変更の記録は Writer（shared/drizzle/writer.ts）が文ごとに自動で残す技術の仕組みで、業務の仕様ではない（.feature の禁止語。
//   rule-tests/feature-business-language.ts）。記録の書き忘れ・中身のずれを見逃さないよう、検証そのものは step の実装に残す。
//   ほかの api-spec（rename / change-todo-completion / delete）も同じ。
// 前提の Todo が要る step は、ほかの api-spec と同じくテストデータビルダー（TodoBuilder.of）で作る（list-todos.api-spec.test.ts の冒頭）。
//   今の step はどれも空の状態から作るので、前提は無い。

let database: TestDatabase;
let handler: ReturnType<typeof CreateTodoApiAssembly.handler>;

beforeAll(async () => {
  database = await TestDatabase.create();
  await database.migrate();
  handler = CreateTodoApiAssembly.handler(database.db);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await TodoSpecRows.empty(database.db);
});

async function postTodo(body: unknown): Promise<Response> {
  return handler(TodoSpecRequests.json("POST", "/api/todos", body));
}

// Todo を作り、作った Todo（応答の本文）を返す。
async function createTodo(title: string): Promise<CreateTodoResponse> {
  const response = await postTodo({ title });
  expect(response.status).toBe(201);
  return (await response.json()) as CreateTodoResponse;
}

// 拒否した要求の後、Todo・完了の履歴・変更の記録のどれにも行が無い。
async function expectNothingStored(): Promise<void> {
  await expect(TodoSpecRows.todos(database.db)).resolves.toStrictEqual([]);
  await expect(TodoSpecRows.statuses(database.db)).resolves.toStrictEqual([]);
  await expect(TodoSpecLogs.entries(database.db)).resolves.toStrictEqual([]);
}

const feature = await loadFeature("./create-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  // WHY 作成の step は保存された Todo の行を見る: 作成 = 作られる Todo 自身の振る舞い（Issue #249）。返る内容はレスポンスの step が見る。
  Scenario("作成", ({ And }) => {
    // id と作成日時は API が決める（randomUUID と now()）ので、形と範囲を確かめる。作成日時は要求の前後の時刻の間。
    // 変更の記録も、Todo と完了の履歴の作成（insert）の 2 件だけが残る（冒頭の WHY のとおり .feature には書かない。作る操作の
    //   結果を確かめるこの step に置く）。
    And("タイトルを指定すると、未完了の Todo が作られる", async () => {
      // given
      const before = Date.now();

      // when
      const milk = await createTodo("牛乳を買う");
      const after = Date.now();
      const rows = await TodoSpecRows.todos(database.db);
      // then
      expect(rows).toStrictEqual([
        {
          id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
          title: "牛乳を買う",
          completed: false,
          createdAt: expect.any(Date),
        },
      ]);
      expect(rows[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(rows[0]?.createdAt.getTime()).toBeLessThanOrEqual(after);
      const created = await TodoSpecRows.status(database.db, milk.id, 0);
      await expect(TodoSpecLogs.entries(database.db)).resolves.toStrictEqual(
        TodoSpecLogs.sorted([
          TodoSpecLogs.todoInsert(milk),
          TodoSpecLogs.statusInsert(created),
        ]),
      );
    });

    And("タイトルの前後の空白は除かれる", async () => {
      // given: beforeEach で Todo を空にしてある
      // when
      await createTodo(" \t牛乳を買う　");

      // then
      await expect(TodoSpecRows.todos(database.db)).resolves.toMatchObject([
        { title: "牛乳を買う" },
      ]);
    });

    // 上限は domain の TODO_TITLE_MAX_LENGTH（100）。文字数はコードポイント数（絵文字 1 つは String#length では 2）。
    And("100 文字のタイトルまで作れる（絵文字は 1 文字と数える）", async () => {
      // given
      const title = "🍎".repeat(100);

      // when
      await createTodo(title);

      // then
      await expect(TodoSpecRows.todos(database.db)).resolves.toMatchObject([
        { title },
      ]);
    });
  });

  Scenario("レスポンス", ({ And }) => {
    // 応答の全項目（id・タイトル・完了かどうか・作成日時）が保存された行と同じ。作成日時は応答では ISO 8601 の文字列、行では Date
    //   （schema.ts の mode "date"）。
    // WHY 前後に空白のあるタイトルで作る: 要求のタイトルを（空白を除く前のまま）返す誤りを、保存された行との違いで見分ける。
    And("作った Todo が、保存された内容で返る", async () => {
      // given: beforeEach で Todo を空にしてある
      // when
      const response = await postTodo({ title: " 牛乳を買う\t" });

      // then
      expect(response.status).toBe(201);
      const [row] = await TodoSpecRows.todos(database.db);
      expect(row).toBeDefined();
      await expect(response.json()).resolves.toStrictEqual({
        id: row?.id ?? "",
        title: "牛乳を買う",
        completed: false,
        createdAt: row?.createdAt.toISOString() ?? "",
      } satisfies CreateTodoResponse);
    });
  });

  Scenario("記録", ({ And }) => {
    // 作成日時に未完了（Todo.create）。
    And("完了の履歴に、作成時の「未完了」が 1 件残る", async () => {
      // given: beforeEach で Todo を空にしてある
      // when
      const milk = await createTodo("牛乳を買う");

      // then
      await expect(TodoSpecRows.statuses(database.db)).resolves.toStrictEqual([
        {
          todoId: milk.id,
          position: 0,
          completed: false,
          changedAt: new Date(milk.createdAt),
        },
      ]);
    });
  });

  Scenario("異常系", ({ And }) => {
    // 拒否は 400 の Problem Details（validation error。title が空のキー）。空白だけも前後を除くと空。
    And(
      "タイトルが空（空白だけも含む）だと、空という理由で拒否され、何も保存されない",
      async () => {
        // given: beforeEach で Todo を空にしてある
        for (const title of ["", "  "]) {
          // when
          const response = await postTodo({ title });

          // then
          await TodoSpecProblems.expectResponse(
            response,
            TodoSpecProblems.validation("/api/todos", {
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
        // given: beforeEach で Todo を空にしてある
        // when
        const response = await postTodo({ title: "🍎".repeat(101) });

        // then
        await TodoSpecProblems.expectResponse(
          response,
          TodoSpecProblems.validation("/api/todos", {
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
      "タイトルが文字列でないと、型が違うという理由で拒否され、何も保存されない",
      async () => {
        // given: beforeEach で Todo を空にしてある
        // when
        const response = await postTodo({ title: 1 });

        // then
        await TodoSpecProblems.expectResponse(
          response,
          TodoSpecProblems.validation("/api/todos", {
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

    // 作成で完了かどうかは受け付けない（作った Todo は常に未完了）。黙って捨てずに拒否する（json-body.ts の RequestBody.schema）。
    And("想定外の項目があると、拒否され、何も保存されない", async () => {
      // given: beforeEach で Todo を空にしてある
      // when
      const response = await postTodo({
        title: "牛乳を買う",
        completed: true,
      });

      // then
      await TodoSpecProblems.expectResponse(
        response,
        TodoSpecProblems.validation("/api/todos", {
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
    });

    // JSON として読めない本文。項目が無いので errors は付かない。
    And(
      "リクエストの本文が読み取れない形式だと、拒否され、何も保存されない",
      async () => {
        // given: beforeEach で Todo を空にしてある
        // when
        const response = await handler(
          TodoSpecRequests.raw("POST", "/api/todos", "{title:"),
        );

        // then
        await TodoSpecProblems.expectResponse(
          response,
          TodoSpecProblems.validation("/api/todos", {
            detail: "Request body must be valid JSON.",
            key: "request.body.notJson",
          }),
        );
        await expectNothingStored();
      },
    );
  });
});
