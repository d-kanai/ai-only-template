// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { RenameTodoResponse } from "../../../features/todo/internal/presentation/rename-todo.api";
import type { ChangeEntry } from "../../../shared/infra/change-log";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../test-support/database";
import { aTodo, type BuiltTodo } from "../../../test-support/todo/todo-builder";
import {
  context,
  emptyTodos,
  expectProblem,
  jsonRequest,
  logEntries,
  notFoundProblem,
  rawRequest,
  renameTodoApi,
  statusRows,
  statusRowsOf,
  todoResponseOf,
  todoRowOf,
  todoRows,
  validationProblem,
} from "./support";

// API 仕様（Issue #219）: rename-todo.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（RenameTodoApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義・各 step の前に表を空にする・前提はビルダーで作る）は
//   list-todos.api-spec.test.ts の冒頭、応答に加えて DB の行も見る WHY は create-todo.api-spec.test.ts の冒頭。
// 前提をビルダーで作るので変更の記録（change_logs）は前提の分を含まず、名前の変更が残した記録だけになる（記録が空のままなら何も
//   書いていない）。

let database: TestDatabase;
let handler: ReturnType<typeof renameTodoApi>;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  handler = renameTodoApi(database.db);
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await emptyTodos(database.db);
});

async function putTitle(id: string, body: unknown): Promise<Response> {
  return handler(
    jsonRequest("PUT", `/api/todos/${id}/title`, body),
    context(id),
  );
}

// 拒否した要求・差分の無い変更の後、Todo の行が前提のままで、変更の記録が無い（前提はビルダーで入れたので記録は空から始まる）。
async function expectUnchanged(todo: BuiltTodo): Promise<void> {
  await expect(todoRows(database.db)).resolves.toStrictEqual([todoRowOf(todo)]);
  await expect(logEntries(database.db)).resolves.toStrictEqual([]);
}

// uuid の形だが、どの Todo も指さない id。
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const feature = await loadFeature("./rename-todo.feature");

describeFeature(feature, ({ Scenario }) => {
  // WHY 更新の step は保存された Todo の行を見る: 更新 = 名前を変える Todo 自身の振る舞い（Issue #249）。返る内容はレスポンスの
  //   step が見る。
  Scenario("更新", ({ And }) => {
    // WHY ほかの Todo を置く: 条件（where）の欠けた UPDATE ですべての Todo の名前を変える誤りを見分ける。作成日時を古くして、
    //   行の順（作成日時の順）で先頭に来るようにする。
    // 変更の記録には、変わった列（title）の変更前と変更後だけの記録が 1 件だけ残る（shared/infra/writer.ts の update。前提は
    //   ビルダーで入れたので記録を残さない）。
    // WHY 変更の記録をこの step で見る: .feature に書かない（create-todo.api-spec.test.ts の冒頭）。名前を変える操作の結果を確かめる
    //   step に置く。
    And("新しいタイトルが保存され、ほかの Todo は変わらない", async () => {
      // given
      const bread = await aTodo(database.db)
        .title("パンを買う")
        .createdAt(new Date("2026-09-01T00:00:00.000Z"))
        .build();
      const milk = await aTodo(database.db).title("牛乳を買う").build();

      // when
      await putTitle(milk.id, { title: "豆乳を買う" });

      // then
      await expect(todoRows(database.db)).resolves.toStrictEqual([
        todoRowOf(bread),
        todoRowOf({ ...milk, title: "豆乳を買う" }),
      ]);
      await expect(logEntries(database.db)).resolves.toStrictEqual([
        {
          tableName: "todos",
          rowId: milk.id,
          operation: "update",
          changes: { title: { before: "牛乳を買う", after: "豆乳を買う" } },
          actorId: null,
        } satisfies ChangeEntry,
      ]);
    });

    // WHY 完了の Todo を変える: 未完了のままだと、完了かどうかを既定値（未完了）で上書きする誤りを見分けられない。
    // WHY 作成日時を古い日時に決める: 今の日時で上書きする誤りを、作成日時の違いで見分ける。
    And("名前を変えても、完了かどうかと作成日時は変わらない", async () => {
      // given
      const milk = await aTodo(database.db)
        .title("牛乳を買う")
        .completed(true)
        .createdAt(new Date("2026-09-01T00:00:00.000Z"))
        .build();

      // when
      await putTitle(milk.id, { title: "豆乳を買う" });

      // then
      await expect(todoRows(database.db)).resolves.toStrictEqual([
        {
          id: milk.id,
          title: "豆乳を買う",
          completed: true,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ]);
    });

    And("タイトルの前後の空白は除かれる", async () => {
      // given
      const milk = await aTodo(database.db).title("牛乳を買う").build();

      // when
      await putTitle(milk.id, { title: " 豆乳を買う\t" });

      // then
      await expect(todoRows(database.db)).resolves.toMatchObject([
        { title: "豆乳を買う" },
      ]);
    });

    // 差分の無い変更は書かない（ChangedProps.of が空なら Writer は SQL も記録も出さない）。応答は成功。Todo の行に加えて、
    //   変更の記録が無いことも見る（expectUnchanged。.feature には書かない）。
    And("同じタイトルに変えても、何も変わらない", async () => {
      // given
      const milk = await aTodo(database.db).title("牛乳を買う").build();

      // when
      const response = await putTitle(milk.id, { title: "牛乳を買う" });

      // then
      expect(response.status).toBe(200);
      await expectUnchanged(milk);
    });
  });

  Scenario("レスポンス", ({ And }) => {
    // WHY 完了の Todo を古い作成日時で置く: 応答の完了かどうか・作成日時を、既定値や今の日時で埋める誤りを見分ける。
    // WHY 前後に空白のあるタイトルで変える: 要求のタイトルを（空白を除く前のまま）返す誤りを見分ける。
    And("名前を変えると、新しいタイトルの Todo が返る", async () => {
      // given
      const milk = await aTodo(database.db)
        .title("牛乳を買う")
        .completed(true)
        .createdAt(new Date("2026-09-01T00:00:00.000Z"))
        .build();

      // when
      const response = await putTitle(milk.id, { title: " 豆乳を買う\t" });

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...todoResponseOf(milk),
        title: "豆乳を買う",
      } satisfies RenameTodoResponse);
    });
  });

  Scenario("記録", ({ And }) => {
    And("名前を変えても、完了の履歴は増えない", async () => {
      // given
      const milk = await aTodo(database.db).title("牛乳を買う").build();

      // when
      await putTitle(milk.id, { title: "豆乳を買う" });

      // then
      await expect(statusRows(database.db)).resolves.toStrictEqual(
        statusRowsOf(milk),
      );
    });
  });

  Scenario("異常系", ({ And }) => {
    // WHY 別の Todo を 1 件置く: 空のときだけ「無い」と返す実装を通さない。
    And("存在しない Todo は、存在しないと伝えられる", async () => {
      // given
      const milk = await aTodo(database.db).title("牛乳を買う").build();

      // when
      const response = await putTitle(MISSING_ID, { title: "豆乳を買う" });

      // then
      await expectProblem(
        response,
        notFoundProblem(MISSING_ID, `/api/todos/${MISSING_ID}/title`),
      );
      await expectUnchanged(milk);
    });

    // 指す値の形（uuid）を内容より先に確かめる（rename-todo.api.ts の handle）: 存在しえない Todo への要求は、内容を直しても
    //   成功しないので 400 ではなく 404。
    // WHY 形の正しくない値だけ: uuid の形で存在しない Todo は、内容を読んだ後に command が探すので、内容の誤りが先に 400 になる
    //   （2026-09-30 に、uuid の形の値で書いたこの step が 400 で失敗して確かめた）。
    And(
      "Todo を指す値の形が正しくないときは、送った内容に誤りがあっても、存在しないと伝えられる",
      async () => {
        // given: beforeEach で Todo を空にしてある
        // when
        const response = await handler(
          rawRequest("PUT", "/api/todos/missing/title", "{title:"),
          context("missing"),
        );

        // then
        await expectProblem(
          response,
          notFoundProblem("missing", "/api/todos/missing/title"),
        );
      },
    );

    And(
      "タイトルが空だと、空という理由で拒否され、タイトルは変わらない",
      async () => {
        // given
        const milk = await aTodo(database.db).title("牛乳を買う").build();

        // when
        const response = await putTitle(milk.id, { title: " " });

        // then
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
        await expectUnchanged(milk);
      },
    );

    And(
      "101 文字のタイトルは、長すぎるという理由で拒否され、タイトルは変わらない",
      async () => {
        // given
        const milk = await aTodo(database.db).title("牛乳を買う").build();

        // when
        const response = await putTitle(milk.id, { title: "🍎".repeat(101) });

        // then
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
        await expectUnchanged(milk);
      },
    );

    // 完了かどうかの変更は別の API（/completion）。黙って捨てずに拒否し、名前も変えない（json-body.ts の RequestBody.schema）。
    And("完了かどうかを一緒に送ると、拒否され、何も変わらない", async () => {
      // given
      const milk = await aTodo(database.db).title("牛乳を買う").build();

      // when
      const response = await putTitle(milk.id, {
        title: "豆乳を買う",
        completed: true,
      });

      // then
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
      await expectUnchanged(milk);
    });
  });
});
