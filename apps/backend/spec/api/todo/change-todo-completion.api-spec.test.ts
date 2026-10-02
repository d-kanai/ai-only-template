// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  type MockInstance,
  vi,
} from "vitest";
import type { ChangeTodoCompletionResponse } from "../../../features/todo/internal/presentation/change-todo-completion.api";
import type { ChangeEntry } from "../../../shared/infra/change-log";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../test-support/database";
import { aTodo, type BuiltTodo } from "../../../test-support/todo/todo-builder";
import {
  changeTodoCompletionApi,
  context,
  emptyTodos,
  expectProblem,
  jsonRequest,
  logEntries,
  notFoundProblem,
  sortedLogs,
  statusInsertLog,
  statusRowOf,
  statusRows,
  statusRowsOf,
  todoResponseOf,
  todoRowOf,
  todoRows,
  validationProblem,
} from "./support";

// API 仕様（Issue #219）: change-todo-completion.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler
//   （ChangeTodoCompletionApi.handle）を呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする・前提は
//   ビルダーで作る）は list-todos.api-spec.test.ts の冒頭、応答に加えて DB の行も見る WHY は create-todo.api-spec.test.ts の冒頭。
// 前提をビルダーで作るので、変更の記録（change_logs）と通知は前提の分を含まず、完了の変更が残したものだけになる。

let database: TestDatabase;
let handler: ReturnType<typeof changeTodoCompletionApi>;
// 完了の通知は本物の notification モジュール（expose の Notifier。support.ts の組み立て）が送り、今の送り先はログ（console.log の
//   JSON 1 行）だけ。通知の確かめは、そのログの行を読んで行う。
// WHY console.log を差し替える（テストダブル無しの例外。Issue #258）: ログは本番の部品の外（実行環境の出力先）で、差し替えずには
//   仕様から読めない。ログに限って差し替えてよい（daiki の判断 2026-10-02。rule-tests/api-spec.test.ts の api-spec-no-vi が
//   vi.spyOn(console, ...) だけを通す）。mockImplementation で出力も止める（db_write の行などでテストの出力を埋めない）。
// WHY step ごとに張って外す: 前の step の行を数えない。
let log: MockInstance<typeof console.log>;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  handler = changeTodoCompletionApi(database.db);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
});

// ログに出た通知の本文（出た順）。ログの行のうち event.name が notification のもの（notification-sender.log.ts）だけを読む。
// 限界: 通知の行は Notifier の notify の中で同期に出る（send の本体が await の前に logger.emit を呼ぶ）ので、handler の応答の後に読めば揃っている。
//   送信が本当に非同期になった（await の後にログを出す）ら、ここで待つ必要がある。
function notifications(): string[] {
  return log.mock.calls
    .map(
      ([line]) =>
        JSON.parse(String(line)) as {
          event: { name: string };
          notification?: string;
        },
    )
    .filter((entry) => entry.event.name === "notification")
    .map((entry) => entry.notification ?? "");
}

async function putCompletion(id: string, body: unknown): Promise<Response> {
  return handler(
    jsonRequest("PUT", `/api/todos/${id}/completion`, body),
    context(id),
  );
}

// 未完了の Todo（履歴は作成時の未完了の 1 件）と、完了の Todo（履歴は作成時の未完了と完了の 2 件）。ビルダーの既定の履歴。
function uncompletedTodo(title: string): Promise<BuiltTodo> {
  return aTodo(database.db).title(title).build();
}

function completedTodo(title: string): Promise<BuiltTodo> {
  return aTodo(database.db).title(title).completed(true).build();
}

// 完了の履歴が、前提の履歴（statusRowsOf）の後ろに added の 1 件ずつが足されたものになっている。足した行の日時は API が now() で
//   決めるので、値の代わりに作成日時以上であることを見る。
async function expectAddedStatus(
  todo: BuiltTodo,
  added: readonly boolean[],
): Promise<void> {
  const rows = await statusRows(database.db);
  const before = statusRowsOf(todo);
  expect(rows).toStrictEqual([
    ...before,
    ...added.map((completed, index) => ({
      todoId: todo.id,
      position: before.length + index,
      completed,
      changedAt: rows[before.length + index]?.changedAt,
    })),
  ]);
  for (const row of rows) {
    expect(row.changedAt.getTime()).toBeGreaterThanOrEqual(
      todo.createdAt.getTime(),
    );
  }
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./change-todo-completion.feature");

describeFeature(feature, ({ Scenario }) => {
  // WHY 更新の step は保存された Todo の行を見る: 更新 = 完了かどうかを変える Todo 自身の振る舞い（Issue #249）。返る内容は
  //   レスポンスの step、完了の履歴は記録の step が見る。
  Scenario("更新", ({ And }) => {
    // WHY ほかの Todo を置く: 条件（where）の欠けた UPDATE ですべての Todo を完了にする誤りを見分ける。作成日時を古くして、
    //   行の順（作成日時の順）で先頭に来るようにする。
    And(
      "未完了の Todo を完了にすると、完了として保存され、ほかの Todo は変わらない",
      async () => {
        const bread = await aTodo(database.db)
          .title("パンを買う")
          .createdAt(new Date("2026-09-01T00:00:00.000Z"))
          .build();
        const milk = await uncompletedTodo("牛乳を買う");

        await putCompletion(milk.id, { completed: true });

        await expect(todoRows(database.db)).resolves.toStrictEqual([
          todoRowOf(bread),
          todoRowOf({ ...milk, completed: true }),
        ]);
      },
    );

    And("完了の Todo を未完了に戻すと、未完了として保存される", async () => {
      const milk = await completedTodo("牛乳を買う");

      await putCompletion(milk.id, { completed: false });

      await expect(todoRows(database.db)).resolves.toStrictEqual([
        todoRowOf({ ...milk, completed: false }),
      ]);
    });
  });

  Scenario("レスポンス", ({ And }) => {
    And("未完了の Todo を完了にすると、完了になった Todo が返る", async () => {
      const milk = await uncompletedTodo("牛乳を買う");

      const response = await putCompletion(milk.id, { completed: true });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...todoResponseOf(milk),
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
          ...todoResponseOf(milk),
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
        todoResponseOf(milk) satisfies ChangeTodoCompletionResponse,
      );
    });
  });

  Scenario("記録", ({ And }) => {
    // 変更の記録は、todos の completed の update と、完了の履歴の insert（全列）の 2 件だけ（前提はビルダーで入れたので記録を残さない。
    //   .feature には書かない。create-todo.api-spec.test.ts の冒頭）。
    And("完了にすると、完了の履歴に「完了」が 1 件足される", async () => {
      const milk = await uncompletedTodo("牛乳を買う");

      await putCompletion(milk.id, { completed: true });

      await expectAddedStatus(milk, [true]);
      const completion = await statusRowOf(database.db, milk.id, 1);
      await expect(logEntries(database.db)).resolves.toStrictEqual(
        sortedLogs([
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

    And("未完了に戻すと、完了の履歴に「未完了」が 1 件足される", async () => {
      const milk = await completedTodo("牛乳を買う");

      await putCompletion(milk.id, { completed: false });

      await expectAddedStatus(milk, [false]);
    });

    // 変わらない変更は書かない（Todo.changeCompletion が同じ Todo を返し、Repository の update は何も書かない）。
    And("既に完了の Todo を完了にしても、履歴は増えない", async () => {
      const milk = await completedTodo("牛乳を買う");

      await putCompletion(milk.id, { completed: true });

      await expect(statusRows(database.db)).resolves.toStrictEqual(
        statusRowsOf(milk),
      );
    });
  });

  Scenario("副作用", ({ And }) => {
    // 通知の本文は id だけの英語（Issue #208）。同じ要求をもう一度送っても（既に完了）通知は増えない。
    And(
      "未完了から完了に変わったときだけ、完了の通知が 1 件送られる",
      async () => {
        const milk = await uncompletedTodo("牛乳を買う");

        await putCompletion(milk.id, { completed: true });
        await putCompletion(milk.id, { completed: true });

        expect(notifications()).toStrictEqual([`Todo completed: ${milk.id}`]);
      },
    );

    And("未完了に戻したときは通知されない", async () => {
      const milk = await completedTodo("牛乳を買う");

      const response = await putCompletion(milk.id, { completed: false });

      expect(response.status).toBe(200);
      expect(notifications()).toStrictEqual([]);
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装を通さない。無い Todo への要求は通知もしない。
    And("存在しない Todo は、存在しないと伝えられる", async () => {
      await uncompletedTodo("牛乳を買う");

      const response = await putCompletion(MISSING_ID, { completed: true });

      await expectProblem(
        response,
        notFoundProblem(MISSING_ID, `/api/todos/${MISSING_ID}/completion`),
      );
      expect(notifications()).toStrictEqual([]);
    });

    // 文字列の "true" も拒否する（型の違い。json-body.ts の toProblemError の request.field.notBoolean）。
    And(
      "完了かどうかが真偽値でないと、形が違うという理由で拒否され、何も変わらない",
      async () => {
        const milk = await uncompletedTodo("牛乳を買う");

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
          todoRowOf(milk),
        ]);
        await expect(logEntries(database.db)).resolves.toStrictEqual([]);
        expect(notifications()).toStrictEqual([]);
      },
    );
  });
});
