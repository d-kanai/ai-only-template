// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { CreateTodoResponse } from "../../features/todo/internal/presentation/create-todo.api";
import type { RenameTodoResponse } from "../../features/todo/internal/presentation/rename-todo.api";
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
  rawRequest,
  sortedLogs,
  statusRows,
  storeTodo,
  type TodoApis,
  todoApis,
  todoRows,
  validationProblem,
} from "./support";

// API 仕様（Issue #219）: rename-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（RenameTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする）は list-todos.api-spec.test.ts の冒頭、
//   応答に加えて DB の行も見る WHY は create-todo.api-spec.test.ts の冒頭。

let database: TestDatabase;
let apis: TodoApis;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  // 名前の変更は通知しない。前提（完了にする）で呼ばれる通知は見ないので捨てる。
  apis = todoApis(database.db, () => undefined);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
});

async function putTitle(id: string, body: unknown): Promise<Response> {
  return apis.putTitle(
    jsonRequest("PUT", `/api/todos/${id}/title`, body),
    context(id),
  );
}

// 作った Todo の todos の行（作成日時は行では Date）。
function rowOf(todo: CreateTodoResponse) {
  return { ...todo, createdAt: new Date(todo.createdAt) };
}

// Todo を作り、作成までの変更の記録（todos と完了の履歴の insert）を控える。拒否・差分の無い変更の後に記録が増えないことを見るため。
async function createWithLogs(
  title: string,
): Promise<{ todo: CreateTodoResponse; logs: ChangeEntry[] }> {
  const todo = await createTodo(apis, title);
  return { todo, logs: await logEntries(database.db) };
}

// 拒否した要求の後、Todo の行と変更の記録が要求の前のまま。
async function expectUnchanged(
  todo: CreateTodoResponse,
  logs: ChangeEntry[],
): Promise<void> {
  await expect(todoRows(database.db)).resolves.toStrictEqual([rowOf(todo)]);
  await expect(logEntries(database.db)).resolves.toStrictEqual(logs);
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./rename-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    And("名前を変えると、新しいタイトルの Todo が返る", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      const response = await putTitle(milk.id, { title: "豆乳を買う" });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...milk,
        title: "豆乳を買う",
      } satisfies RenameTodoResponse);
    });

    // WHY 完了にしてから変える: 未完了のままだと、完了かどうかを既定値（未完了）で上書きする誤りを見分けられない。
    And("名前を変えても、完了かどうかと作成日時は変わらない", async () => {
      const milk = await createTodo(apis, "牛乳を買う");
      await changeCompletion(apis, milk.id, true);

      const response = await putTitle(milk.id, { title: "豆乳を買う" });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...milk,
        title: "豆乳を買う",
        completed: true,
      } satisfies RenameTodoResponse);
    });

    And("タイトルの前後の空白は除かれる", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      const response = await putTitle(milk.id, { title: " 豆乳を買う\t" });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        title: "豆乳を買う",
      });
    });
  });

  Scenario("記録", ({ And }) => {
    // WHY ほかの Todo を置く: 条件（where）の欠けた UPDATE ですべての Todo の名前を変える誤りを見分ける。作成日時を古くして表に
    //   直接入れ、一覧の順（作成日時の順）で先頭に来るようにする。
    And("新しいタイトルが保存され、ほかの Todo は変わらない", async () => {
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

      await putTitle(milk.id, { title: "豆乳を買う" });

      await expect(todoRows(database.db)).resolves.toStrictEqual([
        bread,
        rowOf({ ...milk, title: "豆乳を買う" }),
      ]);
    });

    And("名前を変えても、完了の履歴は増えない", async () => {
      const milk = await createTodo(apis, "牛乳を買う");

      await putTitle(milk.id, { title: "豆乳を買う" });

      await expect(statusRows(database.db)).resolves.toStrictEqual([
        {
          todoId: milk.id,
          position: 0,
          completed: false,
          changedAt: new Date(milk.createdAt),
        },
      ]);
    });

    // 変わった列（title）だけの記録が 1 件足される（shared/infra/writer.ts の update）。
    And("変更の記録に、タイトルの変更前と変更後が残る", async () => {
      const { todo: milk, logs } = await createWithLogs("牛乳を買う");

      await putTitle(milk.id, { title: "豆乳を買う" });

      await expect(logEntries(database.db)).resolves.toStrictEqual(
        sortedLogs([
          ...logs,
          {
            tableName: "todos",
            rowId: milk.id,
            operation: "update",
            changes: { title: { before: "牛乳を買う", after: "豆乳を買う" } },
            actorId: null,
          },
        ]),
      );
    });

    // 差分の無い変更は書かない（changedProps が空なら Writer は SQL も記録も出さない）。応答は成功。
    And("同じタイトルに変えると、変更の記録は増えない", async () => {
      const { todo: milk, logs } = await createWithLogs("牛乳を買う");

      const response = await putTitle(milk.id, { title: "牛乳を買う" });

      expect(response.status).toBe(200);
      await expectUnchanged(milk, logs);
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装を通さない。
    And("存在しない Todo は、存在しないと伝えられる", async () => {
      const { todo: milk, logs } = await createWithLogs("牛乳を買う");

      const response = await putTitle(MISSING_ID, { title: "豆乳を買う" });

      await expectProblem(
        response,
        notFoundProblem(MISSING_ID, `/api/todos/${MISSING_ID}/title`),
      );
      await expectUnchanged(milk, logs);
    });

    // 指す値の形（uuid）を内容より先に確かめる（rename-todo.api.ts の handle）: 存在しえない Todo への要求は、内容を直しても
    //   成功しないので 400 ではなく 404。
    // WHY 形の正しくない値だけ: uuid の形で存在しない Todo は、内容を読んだ後に command が探すので、内容の誤りが先に 400 になる
    //   （2026-09-30 に、uuid の形の値で書いたこの step が 400 で失敗して確かめた）。
    And(
      "Todo を指す値の形が正しくないときは、送った内容に誤りがあっても、存在しないと伝えられる",
      async () => {
        const response = await apis.putTitle(
          rawRequest("PUT", "/api/todos/missing/title", "{title:"),
          context("missing"),
        );

        await expectProblem(
          response,
          notFoundProblem("missing", "/api/todos/missing/title"),
        );
      },
    );

    And(
      "タイトルが空だと、空という理由で拒否され、タイトルは変わらない",
      async () => {
        const { todo: milk, logs } = await createWithLogs("牛乳を買う");

        const response = await putTitle(milk.id, { title: " " });

        await expectProblem(
          response,
          validationProblem(`/api/todos/${milk.id}/title`, {
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
        await expectUnchanged(milk, logs);
      },
    );

    And(
      "101 文字のタイトルは、長すぎるという理由で拒否され、タイトルは変わらない",
      async () => {
        const { todo: milk, logs } = await createWithLogs("牛乳を買う");

        const response = await putTitle(milk.id, { title: "🍎".repeat(101) });

        await expectProblem(
          response,
          validationProblem(`/api/todos/${milk.id}/title`, {
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
        await expectUnchanged(milk, logs);
      },
    );

    // 完了かどうかの変更は別の API（/completion）。黙って捨てずに拒否し、名前も変えない（json-body.ts の requestBodySchema）。
    And("完了かどうかを一緒に送ると、拒否され、何も変わらない", async () => {
      const { todo: milk, logs } = await createWithLogs("牛乳を買う");

      const response = await putTitle(milk.id, {
        title: "豆乳を買う",
        completed: true,
      });

      await expectProblem(
        response,
        validationProblem(`/api/todos/${milk.id}/title`, {
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
      await expectUnchanged(milk, logs);
    });
  });
});
