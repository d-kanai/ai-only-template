// @vitest-environment node
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, type TestContext } from "vitest";
import { ChangeTodoCompletionCommand } from "../../features/todo/internal/application/change-todo-completion.command";
import { CreateTodoCommand } from "../../features/todo/internal/application/create-todo.command";
import { DeleteTodoCommand } from "../../features/todo/internal/application/delete-todo.command";
import { GetTodoQuery } from "../../features/todo/internal/application/get-todo.query";
import { ListTodosQuery } from "../../features/todo/internal/application/list-todos.query";
import { RenameTodoCommand } from "../../features/todo/internal/application/rename-todo.command";
import {
  todoStatusChanges,
  todos,
} from "../../features/todo/internal/infra/schema";
import { PostgresTodoRepository } from "../../features/todo/internal/infra/todo-repository.postgres";
import {
  ChangeTodoCompletionApi,
  type ChangeTodoCompletionResponse,
} from "../../features/todo/internal/presentation/change-todo-completion.api";
import {
  CreateTodoApi,
  type CreateTodoResponse,
} from "../../features/todo/internal/presentation/create-todo.api";
import { DeleteTodoApi } from "../../features/todo/internal/presentation/delete-todo.api";
import {
  GetTodoApi,
  type GetTodoResponse,
} from "../../features/todo/internal/presentation/get-todo.api";
import {
  ListTodosApi,
  type ListTodosResponse,
} from "../../features/todo/internal/presentation/list-todos.api";
import {
  RenameTodoApi,
  type RenameTodoResponse,
} from "../../features/todo/internal/presentation/rename-todo.api";
import type { ChangeEntry } from "../../shared/infra/change-log";
import { changeLogs } from "../../shared/infra/schema";
import { PostgresTransactionRunner } from "../../shared/infra/transaction.postgres";
import type { Problem } from "../../shared/presentation/problem";
import { ApiCoverage } from "../../test-support/api-coverage";
import { TestDatabase } from "../../test-support/database";

// API ジャーニーテスト（Issue #187 / #200。.claude/rules/testing.md の「API ジャーニーテスト」、ADR
//   docs/adr/quality/20260930-backend-journey-tests.md と docs/adr/quality/20260930-gherkin-journeys-with-vitest-cucumber.md）:
//   Todo のライフサイクルという業務ユースケースに沿って、複数の API の handler（XxxApi.handle）を実 Postgres の上で順に呼ぶ。
//   業務の流れは todo-lifecycle.feature（Gherkin の日本語の step）に書き、step の実装をこのファイルに書く（対の名前
//   <name>.feature ⇔ <name>.api-journey.test.ts。rule-tests/api-journey.test.ts の api-journey-feature-pair）。
// WHY「API ジャーニー」と呼ぶ: 画面を通さず API の流れを確かめる層（一般にはテストピラミッドの「サービステスト」・「Subcutaneous
//   test」・「API テスト」）で、画面込みの E2E（apps/e2e/。Playwright）と名前で区別する（Issue #200 のユーザー判断）。
// WHY 層ごとの単体テスト（InMemory）と E2E の間に置く: 単体テストは層ごとに InMemory で組むので、Postgres の Repository を通した
//   API 同士のつながり（作った Todo が一覧・詳細・改名・削除で同じものとして扱われるか）は確かめない。E2E は画面とビルドを
//   通すので遅く、失敗の原因が画面か API か DB かを切り分けにくい。ここは本番と同じ組み立て（Postgres の Repository → command /
//   query → Api）で、画面を通さずに API の流れだけを見る。
// WHY 本番の export（GET / POST など）を使わず、ここで組み立てる: 本番の handler は AppDatabase.get()（.env の DATABASE_URL の public
//   スキーマ）を使い、テストファイルごとの別スキーマ（TestDatabase.create）に向けられない。組み立ての形は各 *.api.ts の最下部と同じ。
// WHY テストダブルを使わない（vitest から vi を import しない・InMemory も無し。rule-tests/api-journey.test.ts が止める）: 本番と同じ
//   部品の組み合わせで動くことを確かめるのが目的で、差し替えるとその部分のつながりを確かめなくなる。
// WHY 変更系の API（POST / PUT / DELETE）の後は、応答に加えて DB の行も見る（読み取り系の GET の後は見ない。ユーザー判断、
//   Issue #187）: 応答が正しくても永続化がずれる誤り（差分 UPDATE の漏れ・where の欠落・削除の取り違え）は、次の API の応答だけでは
//   見逃しうる。行は `database.db.select().from(todos)` で読み、期待の行全体と toStrictEqual で比べる（無いはずの行・変わっては
//   いけない列も確かめる）。`db.select(` を step ごとに書く（補助の関数にまとめない）のは、rule-tests/api-journey.test.ts がソースの
//   `db.select(` の位置で検査するため。
// WHY 変更系の step（When）と DB を読む step（Then / And）をソースの順に並べる: rule-tests/api-journey.test.ts は、変更系の呼び出し
//   から次の変更系の呼び出しまでの間に `db.select(` があるかをソースの順で見る。step を .feature と同じ順に書けば、変更系の後の
//   DB の step がその間に入る。
// WHY step 間の値（作った Todo・応答・改名した名前・変更履歴の期待値）をシナリオの関数の中の変数で渡す: vitest-cucumber 8.0.0 は
//   step 1 つを Vitest の test 1 つとして、シナリオの中で .feature の順に実行する（node_modules/@amiceli/vitest-cucumber の
//   describe-feature の test.for）。シナリオの関数の変数は、そのシナリオの step だけが共有する。
// WHY .feature に書いた値（Todo の名前）を step の実装に固定値で書かない: 値は When / Given の step の引数（{string}）で受け取り、
//   変数に入れて後続の step が使う（reviewer の指摘、Issue #200）。.feature の値を書き換えても、step の実装を直さずに通る。
// WHY 状態コード・応答の本文・DB の行の検証をこのファイルに閉じ、.feature には業務の言葉だけを書く（Issue #217）: .feature は
//   業務の仕様として開発者でない人も読むので、「状態 201」「DB の todos」のような技術の言葉を書かない（rule-tests/api-journey.test.ts
//   の api-journey-business-language）。そのため状態コード（201 / 200 / 204 / 400 / 404）は .feature の値（{int}）で受け取らず、
//   各 step の中に書く（その step が何を確かめるかの技術の中身で、.feature の読者が変える値ではない）。
// WHY Stryker では実行しない（vitest.stryker.config.mts が除く）: step が別々の test なので、Stryker が変異を通る test だけに
//   絞って実行すると、前の step（作成など）を飛ばして後の step だけが動き、前提の値が無いことで失敗して killed と数えられうる。

// 実 Postgres（compose.yaml。`pnpm db:up` で起動）に対して実行する。テスト用のスキーマにマイグレーションを当てる。表を空にするのは
//   Background の step（シナリオごと）。
// WHY 共通の補助にしない: API ジャーニーは今 1 ファイルだけ。ファイルが増えて同じ準備が重なったら test-support/ に切り出す。
let database: TestDatabase;
let handlers: ReturnType<typeof api>;
// 完了の通知の口に渡されたメッセージ（呼ばれた順）。
// WHY 本番の Notifier（notification の expose）ではなく記録するオブジェクトを渡す: Notifier はログに出すだけで、ジャーニーから結果を
//   読めない（vi は使えないので console も見られない）。記録すれば「完了の step で通知が 1 件」を Then で確かめられる。
//   Notifier につながっていることは change-todo-completion.api.test.ts の「本番の PUT」のテストが見る。
// WHY 変数を空にし直さない: シナリオ「作成から完了・削除まで」だけが完了にする。ほかのシナリオは完了にせず、通知を見ない。
const notifications: string[] = [];

beforeAll(async () => {
  database = await TestDatabase.create();
  await database.migrate();
  handlers = api();
});

afterAll(async () => {
  await database.close();
});

// 本番の api ファイルの最下部と同じ組み立てで、テスト用のスキーマの db を使う handler をそろえる。
// WHY 名前を HTTP メソッドで始める（postTodo・putTitle・deleteTodo、読み取りは getTodo・listTodos）: rule-tests/api-journey.test.ts
//   が呼び出しの名前で変更系（post / put / patch / delete）を見分け、その後に DB の読み取りがあるかを検査する（.claude/rules/testing.md
//   の「API ジャーニーテスト」）。
// 書き込みの command には、本番と同じくトランザクションを張る PostgresTransactionRunner を同じ db で渡す（Issue #215）。
// 各 Api を ApiCoverage.track で包む（API 網羅率。Issue #281）。呼ばれた Api のクラス名が step の meta に残り、全 API が
//   どこかのジャーニーで呼ばれたかを reporter（test-support/api-coverage-reporter.ts）が判定する。
// WHY 包み忘れても通らない: 包まずに呼んだ API は記録されず、網羅率が下がって落ちる（見逃す方向には働かない）。
function api() {
  const repository = new PostgresTodoRepository(database.db);
  const transactions = new PostgresTransactionRunner(database.db);
  return {
    postTodo: ApiCoverage.track(
      new CreateTodoApi(new CreateTodoCommand(repository, transactions)),
    ),
    listTodos: ApiCoverage.track(
      new ListTodosApi(new ListTodosQuery(repository)),
    ),
    getTodo: ApiCoverage.track(new GetTodoApi(new GetTodoQuery(repository))),
    putTitle: ApiCoverage.track(
      new RenameTodoApi(new RenameTodoCommand(repository, transactions)),
    ),
    putCompletion: ApiCoverage.track(
      new ChangeTodoCompletionApi(
        new ChangeTodoCompletionCommand(repository, transactions, {
          notify(message) {
            notifications.push(message);
          },
        }),
      ),
    ),
    deleteTodo: ApiCoverage.track(
      new DeleteTodoApi(new DeleteTodoCommand(repository, transactions)),
    ),
  };
}

// API の応答の Todo を、todos の行の期待値にする。作成日時は応答では ISO 文字列、行では Date（schema.ts の mode "date"）。
// WHY 応答から作る: 行の id・作成日時は API が決めるので、応答の値と同じ行が保存されていることを確かめる。
function rowOf(todo: CreateTodoResponse): typeof todos.$inferSelect {
  return { ...todo, createdAt: new Date(todo.createdAt) };
}

// 完了の履歴の行（todo_status_changes）のうち、比べる列。行の id（uuid）は DB が乱数で作るので除く。
const STATUS_CHANGE_COLUMNS = {
  todoId: todoStatusChanges.todoId,
  position: todoStatusChanges.position,
  completed: todoStatusChanges.completed,
  changedAt: todoStatusChanges.changedAt,
};

// 完了の履歴の行を Todo の id・position の順に並べる（select の結果と期待値の両方に使う）。
// WHY SQL の ORDER BY ではなく JS で並べる: 期待値の Todo の id（uuid）の大小は実行ごとに変わるので、同じ規則で両方を並べる。
function byTodoAndPosition(
  a: { todoId: string; position: number },
  b: { todoId: string; position: number },
): number {
  return a.todoId.localeCompare(b.todoId) || a.position - b.position;
}

// 作成したときの完了の履歴の行（作成日時に未完了。Todo.create）。
function createdStatusRow(todo: CreateTodoResponse) {
  return {
    todoId: todo.id,
    position: 0,
    completed: false,
    changedAt: new Date(todo.createdAt),
  };
}

// 変更履歴（change_logs）の行を、id と occurred_at を除いた記録にして並べる。
// WHY id と occurred_at を除く: id は DB が乱数で作り、occurred_at は要求を処理した時刻（shared/infra/change-log.test.ts が固定する）。
// WHY 表・行・操作・変わった列の名前で並べる: 同じ要求の記録は同じ occurred_at で、DB が返す順は決まらない。期待値も同じ規則で並べる
//   （changes のキーの順は jsonb が並べ替えるので、並べる鍵には値ではなく列の名前の集合を使う）。
function logEntries(rows: readonly ChangeEntry[]): ChangeEntry[] {
  return rows
    .map(({ tableName, rowId, operation, changes, actorId }) => ({
      tableName,
      rowId,
      operation,
      changes,
      actorId,
    }))
    .sort((a, b) => logKey(a).localeCompare(logKey(b)));
}

function logKey(entry: ChangeEntry): string {
  return [
    entry.tableName,
    entry.rowId,
    entry.operation,
    Object.keys(entry.changes).sort().join(","),
  ].join("|");
}

// 作った Todo の todos の insert の記録（全列。日時は ISO 8601 の文字列。ログインが無いので actorId は null）。
function todoInsertLog(todo: CreateTodoResponse): ChangeEntry {
  return {
    tableName: "todos",
    rowId: todo.id,
    operation: "insert",
    changes: {
      id: { after: todo.id },
      title: { after: todo.title },
      completed: { after: todo.completed },
      created_at: { after: todo.createdAt },
    },
    actorId: null,
  };
}

// 完了の履歴の行の insert の記録（全列）。行の id は DB が作るので、select した行から作る。
function statusInsertLog(
  row: typeof todoStatusChanges.$inferSelect,
): ChangeEntry {
  return {
    tableName: "todo_status_changes",
    rowId: row.id,
    operation: "insert",
    changes: {
      id: { after: row.id },
      todo_id: { after: row.todoId },
      position: { after: row.position },
      completed: { after: row.completed },
      changed_at: { after: row.changedAt.toISOString() },
    },
    actorId: null,
  };
}

// 完了の履歴の行のうち、Todo と位置で 1 行を選ぶ（変更履歴の期待値を作るため）。
function statusRowOf(
  rows: readonly (typeof todoStatusChanges.$inferSelect)[],
  todoId: string,
  position: number,
): typeof todoStatusChanges.$inferSelect {
  const row = rows.find(
    (candidate) =>
      candidate.todoId === todoId && candidate.position === position,
  );
  expect(row).toBeDefined();
  return row as typeof todoStatusChanges.$inferSelect;
}

const BASE_URL = "http://localhost";

function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bodylessRequest(method: string, path: string): Request {
  return new Request(`${BASE_URL}${path}`, { method });
}

// 動的ルート（/api/todos/:id...）の第 2 引数。Next 16 では params が Promise で渡される（get-todo.api.ts の Context）。
function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

// 作成日時が前の Todo より後のミリ秒になるまで待つ。
// WHY: 一覧は作成日時の昇順（同じ時刻なら id の昇順。todo-repository.postgres.ts の findAll）。作成日時は now()（ミリ秒）で入り、
//   id は uuid（ランダム）なので、2 件が同じミリ秒に作られると並びが作成順にならないことがある。時計は差し替えない方針
//   （テストダブル無し）なので、実時計がミリ秒を進めるのを待つ。
async function waitUntilAfter(createdAt: string): Promise<void> {
  while (Date.now() <= Date.parse(createdAt)) {
    await sleep(1);
  }
}

// 失敗の応答は Problem Details（RFC 9457。problem.ts）。Content-Type（application/problem+json）と本文全体を確かめる。
// WHY toStrictEqual: 無いはずのキー（params・errors）が出ていないことも確かめる（create-todo.api.test.ts の 400 のテストと同じ）。
async function expectProblem(
  response: Response,
  expected: Problem,
): Promise<void> {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  await expect(response.json()).resolves.toStrictEqual(expected);
}

// 404 の本文。無い id を指す要求は、どの API でも同じ key・params で返る（instance だけが要求のパス）。
function notFoundProblem(id: string, instance: string): Problem {
  return {
    type: "/problems/not-found",
    title: "Not found",
    status: 404,
    detail: `Todo ${id} was not found.`,
    instance,
    key: "todo.notFound",
    params: { id },
  };
}

// WHY step の引数（{string} / {int}）に型を注釈する: vitest-cucumber の step の関数の型は (ctx, ...params: any[]) で、
//   注釈しないと any のまま使える。.feature の値が何の型で届くか（{int} は number、{string} は引用符を外した string）を明示する。
const feature = await loadFeature("./todo-lifecycle.feature");

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    // WHY Background で表を空にする: vitest-cucumber は Background の step を各シナリオの前に実行する。シナリオごとに
    //   空の状態から始める。todos と完了の履歴（todo_status_changes）と変更履歴（change_logs。Issue #189）を空にする
    //   （todo-repository.postgres.test.ts と同じ形。todo_status_changes は todos を外部キーで参照するので、同じ文で truncate する）。
    Given("Todo が 1 件も無い", async () => {
      await database.db.execute(
        sql`truncate change_logs, todo_status_changes, todos`,
      );
    });
  });

  Scenario("作成から完了・削除まで", ({ When, Then, And }) => {
    let response: Response;
    let milk: CreateTodoResponse;
    let bread: CreateTodoResponse;
    let createdStatusRows: ReturnType<typeof createdStatusRow>[];
    // 改名の step（When）で受け取った新しい名前。後続の step は .feature の値を固定値で持たず、これを使う。
    let renamedTitle: string;
    // 変更履歴の期待値。変更系の step のたびに記録を足していく。
    const expectedLogs: ChangeEntry[] = [];

    When("Todo {string} を作る", async (_ctx: TestContext, title: string) => {
      response = await handlers.postTodo(
        jsonRequest("POST", "/api/todos", { title }),
      );
    });

    Then(
      "未完了の Todo {string} が作られる",
      async (_ctx: TestContext, title: string) => {
        expect(response.status).toBe(201);
        milk = (await response.json()) as CreateTodoResponse;
        expect(milk).toMatchObject({ title, completed: false });
      },
    );

    And(
      "Todo は {string} の 1 件だけになる",
      async (_ctx: TestContext, title: string) => {
        await expect(database.db.select().from(todos)).resolves.toStrictEqual([
          rowOf({ ...milk, title }),
        ]);
      },
    );

    // WHY 名前を受け取って 1 件目と照らす: .feature の値を固定値で持たず、どの Todo の履歴を見ているかを .feature の名前に合わせる。
    // 変更の記録は、Todo と完了の履歴の作成（insert）の 2 件になる（冒頭の WHY のとおり .feature には書かない）。
    And(
      "{string} の完了の履歴は作成時の未完了の 1 件になる",
      async (_ctx: TestContext, title: string) => {
        expect(milk.title).toBe(title);
        await expect(
          database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges),
        ).resolves.toStrictEqual([createdStatusRow(milk)]);
        const statusRows = await database.db.select().from(todoStatusChanges);
        expectedLogs.push(
          todoInsertLog(milk),
          statusInsertLog(statusRowOf(statusRows, milk.id, 0)),
        );
        expect(
          logEntries(await database.db.select().from(changeLogs)),
        ).toStrictEqual(logEntries(expectedLogs));
      },
    );

    When(
      "作成日時が進むのを待って Todo {string} を作る",
      async (_ctx: TestContext, title: string) => {
        await waitUntilAfter(milk.createdAt);
        response = await handlers.postTodo(
          jsonRequest("POST", "/api/todos", { title }),
        );
      },
    );

    Then(
      "2 件目も未完了の Todo {string} として作られる",
      async (_ctx: TestContext, title: string) => {
        expect(response.status).toBe(201);
        bread = (await response.json()) as CreateTodoResponse;
        expect(bread).toMatchObject({ title, completed: false });
      },
    );

    // WHY 作成日時で並べる: select の並び順は SQL で決めないと決まらない。2 件は waitUntilAfter で作成日時が違う。
    And("Todo は作成順の 2 件になる", async () => {
      await expect(
        database.db.select().from(todos).orderBy(todos.createdAt),
      ).resolves.toStrictEqual([rowOf(milk), rowOf(bread)]);
    });

    // 変更の記録に、2 件目の Todo と完了の履歴の作成（insert）が足される。
    And("完了の履歴は 2 件とも作成時の未完了になる", async () => {
      createdStatusRows = [createdStatusRow(milk), createdStatusRow(bread)];
      expect(
        (
          await database.db
            .select(STATUS_CHANGE_COLUMNS)
            .from(todoStatusChanges)
        ).sort(byTodoAndPosition),
      ).toStrictEqual([...createdStatusRows].sort(byTodoAndPosition));
      const statusRows = await database.db.select().from(todoStatusChanges);
      expectedLogs.push(
        todoInsertLog(bread),
        statusInsertLog(statusRowOf(statusRows, bread.id, 0)),
      );
      expect(
        logEntries(await database.db.select().from(changeLogs)),
      ).toStrictEqual(logEntries(expectedLogs));
    });

    When("Todo の一覧を見る", async () => {
      response = await handlers.listTodos(bodylessRequest("GET", "/api/todos"));
    });

    Then("一覧に 2 件が作成順に並ぶ", async () => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [milk, bread],
      } satisfies ListTodosResponse);
    });

    When(
      "1 件目を {string} に改名する",
      async (_ctx: TestContext, title: string) => {
        renamedTitle = title;
        response = await handlers.putTitle(
          jsonRequest("PUT", `/api/todos/${milk.id}/title`, { title }),
          context(milk.id),
        );
      },
    );

    Then(
      "1 件目のタイトルが {string} に変わる",
      async (_ctx: TestContext, title: string) => {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
          ...milk,
          title,
        } satisfies RenameTodoResponse);
      },
    );

    And("Todo は 1 件目のタイトルだけが変わる", async () => {
      await expect(
        database.db.select().from(todos).orderBy(todos.createdAt),
      ).resolves.toStrictEqual([
        rowOf({ ...milk, title: renamedTitle }),
        rowOf(bread),
      ]);
    });

    // 変更の記録に、1 件目のタイトルの変更（変わった列 title だけの update）が 1 件足される。
    And("完了の履歴は改名では変わらない", async () => {
      expect(
        (
          await database.db
            .select(STATUS_CHANGE_COLUMNS)
            .from(todoStatusChanges)
        ).sort(byTodoAndPosition),
      ).toStrictEqual([...createdStatusRows].sort(byTodoAndPosition));
      expectedLogs.push({
        tableName: "todos",
        rowId: milk.id,
        operation: "update",
        changes: { title: { before: milk.title, after: renamedTitle } },
        actorId: null,
      });
      expect(
        logEntries(await database.db.select().from(changeLogs)),
      ).toStrictEqual(logEntries(expectedLogs));
    });

    When("1 件目を完了にする", async () => {
      response = await handlers.putCompletion(
        jsonRequest("PUT", `/api/todos/${milk.id}/completion`, {
          completed: true,
        }),
        context(milk.id),
      );
    });

    // 改名が保存されていれば、完了の応答にも新しい名前が出る。
    Then("1 件目が完了になる", async () => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...milk,
        title: renamedTitle,
        completed: true,
      } satisfies ChangeTodoCompletionResponse);
    });

    And("Todo は 1 件目だけが完了になる", async () => {
      await expect(
        database.db.select().from(todos).orderBy(todos.createdAt),
      ).resolves.toStrictEqual([
        rowOf({ ...milk, title: renamedTitle, completed: true }),
        rowOf(bread),
      ]);
    });

    // 完了の日時は API が now() で決めるので、値は作成日時以上であることだけを見る。
    // 変更の記録に、1 件目の completed の update と完了の履歴の insert が足される。
    And("完了の履歴に 1 件目の完了が 1 件足される", async () => {
      const rows = (
        await database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges)
      ).sort(byTodoAndPosition);
      const completion = rows.find(
        (row) => row.todoId === milk.id && row.position === 1,
      );
      expect(rows).toStrictEqual(
        [
          ...createdStatusRows,
          {
            todoId: milk.id,
            position: 1,
            completed: true,
            changedAt: completion?.changedAt,
          },
        ].sort(byTodoAndPosition),
      );
      expect(completion?.changedAt.getTime()).toBeGreaterThanOrEqual(
        Date.parse(milk.createdAt),
      );
      const statusRows = await database.db.select().from(todoStatusChanges);
      expectedLogs.push(
        {
          tableName: "todos",
          rowId: milk.id,
          operation: "update",
          changes: { completed: { before: false, after: true } },
          actorId: null,
        },
        statusInsertLog(statusRowOf(statusRows, milk.id, 1)),
      );
      expect(
        logEntries(await database.db.select().from(changeLogs)),
      ).toStrictEqual(logEntries(expectedLogs));
    });

    // 作成・改名では通知せず、未完了 → 完了に変わった 1 件目の分だけ（id だけの英語。Issue #208）。
    And("1 件目の完了の通知が 1 件だけ送られる", () => {
      expect(notifications).toStrictEqual([`Todo completed: ${milk.id}`]);
    });

    When("1 件目の詳細を見る", async () => {
      response = await handlers.getTodo(
        bodylessRequest("GET", `/api/todos/${milk.id}`),
        context(milk.id),
      );
    });

    Then("改名と完了が反映された詳細が見える", async () => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        ...milk,
        title: renamedTitle,
        completed: true,
      } satisfies GetTodoResponse);
    });

    When("1 件目を削除する", async () => {
      response = await handlers.deleteTodo(
        bodylessRequest("DELETE", `/api/todos/${milk.id}`),
        context(milk.id),
      );
    });

    // 削除の応答は 204 で本文が空。
    Then("1 件目が削除される", async () => {
      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");
    });

    And("Todo は 2 件目の 1 件だけになる", async () => {
      await expect(database.db.select().from(todos)).resolves.toStrictEqual([
        rowOf(bread),
      ]);
    });

    // 削除した Todo の完了の履歴も消える（外部キーの on delete cascade）。
    // 変更の記録には 1 件目の削除（delete）が 1 件だけ足される。cascade で消えた完了の履歴の行は記録しない。これまでの記録
    //   （消した Todo の insert・update も）は消えずに残る。
    And("完了の履歴は 2 件目の作成時の 1 件だけになる", async () => {
      await expect(
        database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges),
      ).resolves.toStrictEqual([createdStatusRow(bread)]);
      expectedLogs.push({
        tableName: "todos",
        rowId: milk.id,
        operation: "delete",
        changes: {
          id: { before: milk.id },
          title: { before: renamedTitle },
          completed: { before: true },
          created_at: { before: milk.createdAt },
        },
        actorId: null,
      });
      expect(
        logEntries(await database.db.select().from(changeLogs)),
      ).toStrictEqual(logEntries(expectedLogs));
    });

    When("削除の後に Todo の一覧を見る", async () => {
      response = await handlers.listTodos(bodylessRequest("GET", "/api/todos"));
    });

    Then("一覧に 2 件目だけが並ぶ", async () => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [bread],
      } satisfies ListTodosResponse);
    });

    When("削除した 1 件目の詳細を見る", async () => {
      response = await handlers.getTodo(
        bodylessRequest("GET", `/api/todos/${milk.id}`),
        context(milk.id),
      );
    });

    // 存在しないことは 404 の Problem Details（not found）で伝わる。
    Then("削除した 1 件目は存在しないと伝えられる", async () => {
      await expectProblem(
        response,
        notFoundProblem(milk.id, `/api/todos/${milk.id}`),
      );
    });
  });

  Scenario("不正な入力は保存されない", ({ Given, When, Then, And }) => {
    let response: Response;
    let milk: CreateTodoResponse;
    let createdLogs: ChangeEntry[];
    let missingId: string;

    // WHY 先に 1 件作る: 空の一覧のままだと「増えない」「変わらない」が、何も保存しない実装でも通ってしまう。
    Given(
      "Todo {string} が作られている",
      async (_ctx: TestContext, title: string) => {
        const created = await handlers.postTodo(
          jsonRequest("POST", "/api/todos", { title }),
        );
        expect(created.status).toBe(201);
        milk = (await created.json()) as CreateTodoResponse;
        await expect(database.db.select().from(todos)).resolves.toStrictEqual([
          rowOf(milk),
        ]);
        // 変更履歴は作成の 2 件（todos と完了の履歴の insert）。失敗した要求はこれを増やさない。
        createdLogs = logEntries(await database.db.select().from(changeLogs));
        expect(
          createdLogs.map(({ tableName, operation }) => [tableName, operation]),
        ).toStrictEqual([
          ["todo_status_changes", "insert"],
          ["todos", "insert"],
        ]);
      },
    );

    When("タイトルが空の Todo を作る", async () => {
      response = await handlers.postTodo(
        jsonRequest("POST", "/api/todos", { title: "" }),
      );
    });

    // 拒否は 400 の Problem Details（validation error。title が空のキー）で伝わる。
    Then("タイトルが空という理由で拒否される", async () => {
      await expectProblem(response, {
        type: "/problems/validation-error",
        title: "Validation error",
        status: 400,
        detail: "Title must not be empty.",
        instance: "/api/todos",
        key: "todo.title.empty",
        errors: [
          {
            pointer: "#/title",
            key: "todo.title.empty",
            detail: "Title must not be empty.",
          },
        ],
      });
    });

    // 変更の記録も作成の 2 件のまま増えない。
    And("Todo は作られていた 1 件のまま変わらない", async () => {
      await expect(database.db.select().from(todos)).resolves.toStrictEqual([
        rowOf(milk),
      ]);
      expect(
        logEntries(await database.db.select().from(changeLogs)),
      ).toStrictEqual(createdLogs);
    });

    When("拒否の後に Todo の一覧を見る", async () => {
      response = await handlers.listTodos(bodylessRequest("GET", "/api/todos"));
    });

    Then("一覧に作られていた 1 件だけが並ぶ", async () => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [milk],
      } satisfies ListTodosResponse);
    });

    When(
      "存在しない Todo を {string} に改名する",
      async (_ctx: TestContext, title: string) => {
        missingId = randomUUID();
        response = await handlers.putTitle(
          jsonRequest("PUT", `/api/todos/${missingId}/title`, { title }),
          context(missingId),
        );
      },
    );

    // 存在しないことは 404 の Problem Details（not found。要求した id）で伝わる。
    Then("改名しようとした Todo は存在しないと伝えられる", async () => {
      await expectProblem(
        response,
        notFoundProblem(missingId, `/api/todos/${missingId}/title`),
      );
    });

    // 変更の記録も作成の 2 件のまま増えない。
    And(
      "Todo は改名の失敗の後も作られていた 1 件のまま変わらない",
      async () => {
        await expect(database.db.select().from(todos)).resolves.toStrictEqual([
          rowOf(milk),
        ]);
        expect(
          logEntries(await database.db.select().from(changeLogs)),
        ).toStrictEqual(createdLogs);
      },
    );

    When("改名の失敗の後に Todo の一覧を見る", async () => {
      response = await handlers.listTodos(bodylessRequest("GET", "/api/todos"));
    });

    Then("一覧に元の名前のまま 1 件だけが並ぶ", async () => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        todos: [milk],
      } satisfies ListTodosResponse);
    });
  });
});
