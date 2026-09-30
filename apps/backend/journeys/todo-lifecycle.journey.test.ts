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
// WHY テストダブルを使わない（vi.mock も InMemory も無し。rule-tests/journey.test.ts が止める）: 本番と同じ部品の組み合わせで
//   動くことを確かめるのが目的で、差し替えるとその部分のつながりを確かめなくなる。
// WHY DB の中身を SQL で覗かない: 利用者が見るのは API の応答だけ。保存されたことは、次の API の応答（一覧・詳細）で確かめる。
// WHY 1 テスト = 1 つの流れ（E2E と同じ）: 順序で状態を担保する。ステップごとにテストを分けると、前のテストの結果に依存する。

// 実 Postgres（compose.yaml。`pnpm db:up` で起動）に対して実行する。テスト用のスキーマにマイグレーションを当て、
//   各テストの前に todos を空にする（todo-repository.postgres.test.ts と同じ形）。
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
  await database.db.execute(sql`truncate todos`);
});

// 本番の api ファイルの最下部と同じ組み立てで、テスト用のスキーマの db を使う handler をそろえる。
function api() {
  const repository = new PostgresTodoRepository(database.db);
  return {
    createTodo: new CreateTodoApi(new CreateTodoCommand(repository)).handle,
    listTodos: new ListTodosApi(new ListTodosQuery(repository)).handle,
    getTodo: new GetTodoApi(new GetTodoQuery(repository)).handle,
    renameTodo: new RenameTodoApi(new RenameTodoCommand(repository)).handle,
    changeTodoCompletion: new ChangeTodoCompletionApi(
      new ChangeTodoCompletionCommand(repository),
    ).handle,
    deleteTodo: new DeleteTodoApi(new DeleteTodoCommand(repository)).handle,
  };
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
  const {
    createTodo,
    listTodos,
    getTodo,
    renameTodo,
    changeTodoCompletion,
    deleteTodo,
  } = api();

  // 1. 2 件作る。
  const createdMilk = await createTodo(
    jsonRequest("POST", "/api/todos", { title: "牛乳を買う" }),
  );
  expect(createdMilk.status).toBe(201);
  const milk = (await createdMilk.json()) as CreateTodoResponse;
  expect(milk).toMatchObject({ title: "牛乳を買う", completed: false });

  await waitUntilAfter(milk.createdAt);
  const createdBread = await createTodo(
    jsonRequest("POST", "/api/todos", { title: "パンを買う" }),
  );
  expect(createdBread.status).toBe(201);
  const bread = (await createdBread.json()) as CreateTodoResponse;
  expect(bread).toMatchObject({ title: "パンを買う", completed: false });

  // 2. 一覧に作成順で並ぶ（作成の応答と同じ値）。
  const listed = await listTodos(bodylessRequest("GET", "/api/todos"));
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toStrictEqual({
    todos: [milk, bread],
  } satisfies ListTodosResponse);

  // 3. 1 件目を改名する。
  const renamed = await renameTodo(
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

  // 4. 同じ Todo を完了にする（改名が保存されていれば、完了の応答にも新しい名前が出る）。
  const completed = await changeTodoCompletion(
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

  // 6. 削除する。
  const deleted = await deleteTodo(
    bodylessRequest("DELETE", `/api/todos/${milk.id}`),
    context(milk.id),
  );
  expect(deleted.status).toBe(204);
  await expect(deleted.text()).resolves.toBe("");

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
  const { createTodo, listTodos, renameTodo } = api();

  // WHY 先に 1 件作る: 空の一覧のままだと「増えない」「変わらない」が、何も保存しない実装でも通ってしまう。
  //   1 件ある状態から、失敗した要求がそれを増やさず・変えないことを確かめる。
  const created = await createTodo(
    jsonRequest("POST", "/api/todos", { title: "牛乳を買う" }),
  );
  expect(created.status).toBe(201);
  const milk = (await created.json()) as CreateTodoResponse;

  // 1. 空の title は 400（Problem Details。項目ごとの誤りの errors 付き）。
  await expectProblem(
    await createTodo(jsonRequest("POST", "/api/todos", { title: "" })),
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

  // 2. 一覧は増えていない。
  const listed = await listTodos(bodylessRequest("GET", "/api/todos"));
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toStrictEqual({
    todos: [milk],
  } satisfies ListTodosResponse);

  // 3. 存在しない id の改名は 404。
  const missingId = randomUUID();
  await expectProblem(
    await renameTodo(
      jsonRequest("PUT", `/api/todos/${missingId}/title`, {
        title: "豆乳を買う",
      }),
      context(missingId),
    ),
    notFoundProblem(missingId, `/api/todos/${missingId}/title`),
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
