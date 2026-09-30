// @vitest-environment node
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ChangeTodoCompletionCommand } from "../features/todo/application/change-todo-completion.command";
import { CreateTodoCommand } from "../features/todo/application/create-todo.command";
import { DeleteTodoCommand } from "../features/todo/application/delete-todo.command";
import { GetTodoQuery } from "../features/todo/application/get-todo.query";
import { ListTodosQuery } from "../features/todo/application/list-todos.query";
import { RenameTodoCommand } from "../features/todo/application/rename-todo.command";
import { todoStatusChanges, todos } from "../features/todo/infra/schema";
import { PostgresTodoRepository } from "../features/todo/infra/todo-repository.postgres";
import {
  ChangeTodoCompletionApi,
  type ChangeTodoCompletionResponse,
} from "../features/todo/presentation/change-todo-completion.api";
import {
  CreateTodoApi,
  type CreateTodoResponse,
} from "../features/todo/presentation/create-todo.api";
import { DeleteTodoApi } from "../features/todo/presentation/delete-todo.api";
import {
  GetTodoApi,
  type GetTodoResponse,
} from "../features/todo/presentation/get-todo.api";
import {
  ListTodosApi,
  type ListTodosResponse,
} from "../features/todo/presentation/list-todos.api";
import {
  RenameTodoApi,
  type RenameTodoResponse,
} from "../features/todo/presentation/rename-todo.api";
import type { ChangeEntry } from "../shared/infra/change-log";
import { changeLogs } from "../shared/infra/schema";
import type { Problem } from "../shared/presentation/problem";
import {
  createTestDatabase,
  type TestDatabase,
} from "../test-support/database";

// ジャーニーテスト（Issue #187。.claude/rules/testing.md の「ジャーニーテスト」）: Todo のライフサイクルという業務ユースケースに沿って、
//   複数の API の handler（XxxApi.handle）を実 Postgres の上で順に呼ぶ。
// WHY 層ごとの単体テスト（InMemory）と E2E の間に置く: 単体テストは層ごとに InMemory で組むので、Postgres の Repository を通した
//   API 同士のつながり（作った Todo が一覧・詳細・改名・削除で同じものとして扱われるか）は確かめない。E2E は画面とビルドを
//   通すので遅く、失敗の原因が画面か API か DB かを切り分けにくい。ここは本番と同じ組み立て（Postgres の Repository → command /
//   query → Api）で、画面を通さずに API の流れだけを見る。
// WHY 本番の export（GET / POST など）を使わず、ここで組み立てる: 本番の handler は getDatabase()（.env の DATABASE_URL の public
//   スキーマ）を使い、テストファイルごとの別スキーマ（createTestDatabase）に向けられない。組み立ての形は各 *.api.ts の最下部と同じ。
// WHY テストダブルを使わない（vitest から vi を import しない・InMemory も無し。rule-tests/journey.test.ts が止める）: 本番と同じ
//   部品の組み合わせで動くことを確かめるのが目的で、差し替えるとその部分のつながりを確かめなくなる。
// WHY 変更系の API（POST / PUT / DELETE）の後は、応答に加えて DB の行も見る（読み取り系の GET の後は見ない。ユーザー判断、
//   Issue #187）: 応答が正しくても永続化がずれる誤り（差分 UPDATE の漏れ・where の欠落・削除の取り違え）は、次の API の応答だけでは
//   見逃しうる。ジャーニーは実 DB を使う唯一の複数 API のテストなので、ここで行を見る。行は `database.db.select().from(todos)` で
//   読み、期待の行全体と toStrictEqual で比べる（無いはずの行・変わってはいけない列も確かめる）。
//   `db.select(` を呼び出しごとに書く（補助の関数にまとめない）のは、rule-tests/journey.test.ts がソースの `db.select(` の位置で検査するため。
// WHY 1 テスト = 1 つの流れ（E2E と同じ）: 順序で状態を担保する。ステップごとにテストを分けると、前のテストの結果に依存する。

// 実 Postgres（compose.yaml。`pnpm db:up` で起動）に対して実行する。テスト用のスキーマにマイグレーションを当て、
//   各テストの前に todos と完了の履歴（todo_status_changes）と変更履歴（change_logs。Issue #189）を空にする
//   （todo-repository.postgres.test.ts と同じ形。todo_status_changes は todos を外部キーで参照するので、同じ文で truncate する）。
// WHY 共通の補助にしない: ジャーニーは今 1 ファイルだけ。ファイルが増えて同じ準備が重なったら test-support/ に切り出す。
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(
    sql`truncate change_logs, todo_status_changes, todos`,
  );
});

// 本番の api ファイルの最下部と同じ組み立てで、テスト用のスキーマの db を使う handler をそろえる。
// WHY 名前を HTTP メソッドで始める（postTodo・putTitle・deleteTodo、読み取りは getTodo・listTodos）: rule-tests/journey.test.ts が
//   呼び出しの名前で変更系（post / put / patch / delete）を見分け、その後に DB の読み取りがあるかを検査する（.claude/rules/testing.md の
//   「ジャーニーテスト」）。
function api() {
  const repository = new PostgresTodoRepository(database.db);
  return {
    postTodo: new CreateTodoApi(new CreateTodoCommand(repository)).handle,
    listTodos: new ListTodosApi(new ListTodosQuery(repository)).handle,
    getTodo: new GetTodoApi(new GetTodoQuery(repository)).handle,
    putTitle: new RenameTodoApi(new RenameTodoCommand(repository)).handle,
    putCompletion: new ChangeTodoCompletionApi(
      new ChangeTodoCompletionCommand(repository),
    ).handle,
    deleteTodo: new DeleteTodoApi(new DeleteTodoCommand(repository)).handle,
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

test("Todo を 2 件作り、一覧で作成順に見え、1 件を改名して完了にすると詳細に反映され、削除すると一覧から消えて詳細は 404 になる", async () => {
  const { postTodo, listTodos, getTodo, putTitle, putCompletion, deleteTodo } =
    api();

  // 1. 2 件作る（作るたびに行が 1 件ずつ増える）。
  const createdMilk = await postTodo(
    jsonRequest("POST", "/api/todos", { title: "牛乳を買う" }),
  );
  expect(createdMilk.status).toBe(201);
  const milk = (await createdMilk.json()) as CreateTodoResponse;
  expect(milk).toMatchObject({ title: "牛乳を買う", completed: false });
  await expect(database.db.select().from(todos)).resolves.toStrictEqual([
    rowOf(milk),
  ]);
  // 完了の履歴は「作成日時に未完了」の 1 行（Issue #188）。
  await expect(
    database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges),
  ).resolves.toStrictEqual([createdStatusRow(milk)]);
  // 変更履歴（Issue #189）は、todos の行と完了の履歴の行の insert の 2 件（どちらも全列）。以降のステップで記録を足していく。
  const milkStatusRows = await database.db.select().from(todoStatusChanges);
  const expectedLogs = [
    todoInsertLog(milk),
    statusInsertLog(statusRowOf(milkStatusRows, milk.id, 0)),
  ];
  expect(logEntries(await database.db.select().from(changeLogs))).toStrictEqual(
    logEntries(expectedLogs),
  );

  await waitUntilAfter(milk.createdAt);
  const createdBread = await postTodo(
    jsonRequest("POST", "/api/todos", { title: "パンを買う" }),
  );
  expect(createdBread.status).toBe(201);
  const bread = (await createdBread.json()) as CreateTodoResponse;
  expect(bread).toMatchObject({ title: "パンを買う", completed: false });
  // WHY 作成日時で並べる: select の並び順は SQL で決めないと決まらない。2 件は waitUntilAfter で作成日時が違う。
  await expect(
    database.db.select().from(todos).orderBy(todos.createdAt),
  ).resolves.toStrictEqual([rowOf(milk), rowOf(bread)]);
  const createdStatusRows = [createdStatusRow(milk), createdStatusRow(bread)];
  expect(
    (
      await database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges)
    ).sort(byTodoAndPosition),
  ).toStrictEqual([...createdStatusRows].sort(byTodoAndPosition));
  // 2 件目の作成で、変更履歴に 2 件目の todos と完了の履歴の insert が足される（1 件目の記録は変わらない）。
  const breadStatusRows = await database.db.select().from(todoStatusChanges);
  expectedLogs.push(
    todoInsertLog(bread),
    statusInsertLog(statusRowOf(breadStatusRows, bread.id, 0)),
  );
  expect(logEntries(await database.db.select().from(changeLogs))).toStrictEqual(
    logEntries(expectedLogs),
  );

  // 2. 一覧に作成順で並ぶ（作成の応答と同じ値）。
  const listed = await listTodos(bodylessRequest("GET", "/api/todos"));
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toStrictEqual({
    todos: [milk, bread],
  } satisfies ListTodosResponse);

  // 3. 1 件目を改名する（行はその 1 件の title だけが変わり、2 件目は変わらない）。
  const renamed = await putTitle(
    jsonRequest("PUT", `/api/todos/${milk.id}/title`, {
      title: "豆乳を買う",
    }),
    context(milk.id),
  );
  expect(renamed.status).toBe(200);
  await expect(renamed.json()).resolves.toStrictEqual({
    ...milk,
    title: "豆乳を買う",
  } satisfies RenameTodoResponse);
  await expect(
    database.db.select().from(todos).orderBy(todos.createdAt),
  ).resolves.toStrictEqual([
    rowOf({ ...milk, title: "豆乳を買う" }),
    rowOf(bread),
  ]);
  // 改名は完了の履歴を変えない。
  expect(
    (
      await database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges)
    ).sort(byTodoAndPosition),
  ).toStrictEqual([...createdStatusRows].sort(byTodoAndPosition));
  // 変更履歴に、その Todo の todos の update（変わった title の前後だけ）が 1 件足される。
  expectedLogs.push({
    tableName: "todos",
    rowId: milk.id,
    operation: "update",
    changes: { title: { before: "牛乳を買う", after: "豆乳を買う" } },
    actorId: null,
  });
  expect(logEntries(await database.db.select().from(changeLogs))).toStrictEqual(
    logEntries(expectedLogs),
  );

  // 4. 同じ Todo を完了にする（改名が保存されていれば、完了の応答にも新しい名前が出る）。
  const completed = await putCompletion(
    jsonRequest("PUT", `/api/todos/${milk.id}/completion`, {
      completed: true,
    }),
    context(milk.id),
  );
  expect(completed.status).toBe(200);
  await expect(completed.json()).resolves.toStrictEqual({
    ...milk,
    title: "豆乳を買う",
    completed: true,
  } satisfies ChangeTodoCompletionResponse);
  await expect(
    database.db.select().from(todos).orderBy(todos.createdAt),
  ).resolves.toStrictEqual([
    rowOf({ ...milk, title: "豆乳を買う", completed: true }),
    rowOf(bread),
  ]);
  // 完了にすると、その Todo の履歴に「完了」の 1 行が足される（既存の行は変わらない）。完了の日時は API が now() で決めるので、
  //   値は作成日時以上であることだけを見る。
  const completedStatusRows = (
    await database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges)
  ).sort(byTodoAndPosition);
  const completion = completedStatusRows.find(
    (row) => row.todoId === milk.id && row.position === 1,
  );
  expect(completedStatusRows).toStrictEqual(
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
  // 変更履歴に、todos の update（completed の前後）と、足された完了の履歴の行の insert の 2 件が足される。
  const completedStatusRowsWithId = await database.db
    .select()
    .from(todoStatusChanges);
  expectedLogs.push(
    {
      tableName: "todos",
      rowId: milk.id,
      operation: "update",
      changes: { completed: { before: false, after: true } },
      actorId: null,
    },
    statusInsertLog(statusRowOf(completedStatusRowsWithId, milk.id, 1)),
  );
  expect(logEntries(await database.db.select().from(changeLogs))).toStrictEqual(
    logEntries(expectedLogs),
  );

  // 5. 詳細に改名と完了が反映されている。
  const detail = await getTodo(
    bodylessRequest("GET", `/api/todos/${milk.id}`),
    context(milk.id),
  );
  expect(detail.status).toBe(200);
  await expect(detail.json()).resolves.toStrictEqual({
    ...milk,
    title: "豆乳を買う",
    completed: true,
  } satisfies GetTodoResponse);

  // 6. 削除する（消えるのはその 1 件の行だけ）。
  const deleted = await deleteTodo(
    bodylessRequest("DELETE", `/api/todos/${milk.id}`),
    context(milk.id),
  );
  expect(deleted.status).toBe(204);
  await expect(deleted.text()).resolves.toBe("");
  await expect(database.db.select().from(todos)).resolves.toStrictEqual([
    rowOf(bread),
  ]);
  // 削除した Todo の完了の履歴も消える（外部キーの on delete cascade）。
  await expect(
    database.db.select(STATUS_CHANGE_COLUMNS).from(todoStatusChanges),
  ).resolves.toStrictEqual([createdStatusRow(bread)]);
  // 変更履歴に、todos の delete（消す前の全列。改名と完了の後の値）が 1 件だけ足される。cascade で消えた完了の履歴の行は
  //   記録しない。これまでの記録（消した Todo の insert・update も）は消えずに残る。
  expectedLogs.push({
    tableName: "todos",
    rowId: milk.id,
    operation: "delete",
    changes: {
      id: { before: milk.id },
      title: { before: "豆乳を買う" },
      completed: { before: true },
      created_at: { before: milk.createdAt },
    },
    actorId: null,
  });
  expect(logEntries(await database.db.select().from(changeLogs))).toStrictEqual(
    logEntries(expectedLogs),
  );

  // 7. 一覧には残りの 1 件だけ（手を付けていない 2 件目はそのまま）。
  const listedAfterDelete = await listTodos(
    bodylessRequest("GET", "/api/todos"),
  );
  expect(listedAfterDelete.status).toBe(200);
  await expect(listedAfterDelete.json()).resolves.toStrictEqual({
    todos: [bread],
  } satisfies ListTodosResponse);

  // 8. 削除した Todo の詳細は 404。
  await expectProblem(
    await getTodo(
      bodylessRequest("GET", `/api/todos/${milk.id}`),
      context(milk.id),
    ),
    notFoundProblem(milk.id, `/api/todos/${milk.id}`),
  );
});

test("空の title で作ろうとすると 400 で一覧は増えず、存在しない Todo を改名しようとすると 404 で一覧は変わらない", async () => {
  const { postTodo, listTodos, putTitle } = api();

  // WHY 先に 1 件作る: 空の一覧のままだと「増えない」「変わらない」が、何も保存しない実装でも通ってしまう。
  //   1 件ある状態から、失敗した要求がそれを増やさず・変えないことを確かめる。
  const created = await postTodo(
    jsonRequest("POST", "/api/todos", { title: "牛乳を買う" }),
  );
  expect(created.status).toBe(201);
  const milk = (await created.json()) as CreateTodoResponse;
  await expect(database.db.select().from(todos)).resolves.toStrictEqual([
    rowOf(milk),
  ]);
  // 変更履歴は作成の 2 件（todos と完了の履歴の insert）。失敗した要求はこれを増やさない。
  const createdLogs = logEntries(await database.db.select().from(changeLogs));
  expect(
    createdLogs.map(({ tableName, operation }) => [tableName, operation]),
  ).toStrictEqual([
    ["todo_status_changes", "insert"],
    ["todos", "insert"],
  ]);

  // 1. 空の title は 400（Problem Details。項目ごとの誤りの errors 付き）で、行は増えない。
  await expectProblem(
    await postTodo(jsonRequest("POST", "/api/todos", { title: "" })),
    {
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
    },
  );
  await expect(database.db.select().from(todos)).resolves.toStrictEqual([
    rowOf(milk),
  ]);
  expect(logEntries(await database.db.select().from(changeLogs))).toStrictEqual(
    createdLogs,
  );

  // 2. 一覧は増えていない。
  const listed = await listTodos(bodylessRequest("GET", "/api/todos"));
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toStrictEqual({
    todos: [milk],
  } satisfies ListTodosResponse);

  // 3. 存在しない id の改名は 404 で、既存の行は変わらない（行も増えない）。
  const missingId = randomUUID();
  await expectProblem(
    await putTitle(
      jsonRequest("PUT", `/api/todos/${missingId}/title`, {
        title: "豆乳を買う",
      }),
      context(missingId),
    ),
    notFoundProblem(missingId, `/api/todos/${missingId}/title`),
  );
  await expect(database.db.select().from(todos)).resolves.toStrictEqual([
    rowOf(milk),
  ]);
  expect(logEntries(await database.db.select().from(changeLogs))).toStrictEqual(
    createdLogs,
  );

  // 4. 一覧は変わっていない（既存の Todo の名前も元のまま）。
  const listedAfterRename = await listTodos(
    bodylessRequest("GET", "/api/todos"),
  );
  expect(listedAfterRename.status).toBe(200);
  await expect(listedAfterRename.json()).resolves.toStrictEqual({
    todos: [milk],
  } satisfies ListTodosResponse);
});
