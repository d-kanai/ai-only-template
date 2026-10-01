import { asc, sql } from "drizzle-orm";
import { expect } from "vitest";
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
import { ChangeTodoCompletionApi } from "../../features/todo/internal/presentation/change-todo-completion.api";
import {
  CreateTodoApi,
  type CreateTodoResponse,
} from "../../features/todo/internal/presentation/create-todo.api";
import { DeleteTodoApi } from "../../features/todo/internal/presentation/delete-todo.api";
import { GetTodoApi } from "../../features/todo/internal/presentation/get-todo.api";
import { ListTodosApi } from "../../features/todo/internal/presentation/list-todos.api";
import { RenameTodoApi } from "../../features/todo/internal/presentation/rename-todo.api";
import type { ChangeEntry } from "../../shared/infra/change-log";
import type { Database } from "../../shared/infra/database";
import { changeLogs } from "../../shared/infra/schema";
import { PostgresTransactionRunner } from "../../shared/infra/transaction.postgres";
import type { Problem } from "../../shared/presentation/problem";

// Todo の API 仕様（api-specs/todo/*.api-spec.test.ts。Issue #219）が共有する補助: 組み立て・前提の用意・要求の作り方・DB の読み出し・
//   失敗の本文。
// WHY api-specs の中に置く（test-support/ に置かない）: API 仕様のためだけの補助で、test-support/ はテストダブルと DB の基盤
//   （createTestDatabase）を置く場所。
// WHY 6 つの API 仕様で 1 つにまとめる: 組み立て（本番と同じ部品の並び）・要求の形・DB の行の読み方は API ごとに変わらず、
//   ファイルごとに書くと、本番の組み立てが変わったときに直し漏れる。
// 既知の重複: api-journeys/todo-lifecycle.api-journey.test.ts にも同じ種類の関数（api・jsonRequest・logEntries など）がある。
//   ジャーニーはこの Issue では触らない（担当外）ので、今は重複を許す。

// 本番の api ファイルの最下部と同じ組み立てで、渡した db（テスト用のスキーマ）を使う handler をそろえる。
// WHY 本番の export（GET / POST など）を使わない: 本番は getDatabase()（.env の public スキーマ）を使い、テストファイルごとの
//   スキーマ（createTestDatabase）に向けられない。
// WHY 名前を HTTP メソッドで始める（postTodo・putTitle など）: API ジャーニーと同じ名前にそろえ、変更系（post / put / delete）と
//   読み取り系（get / list）が名前で分かるようにする。
// WHY 通知は関数を受け取る: 本番の notify（notification の expose）はログに出すだけで、仕様から結果を読めない（vi は使わない）。
//   記録する関数を渡せば「完了の通知が 1 件」を確かめられる。
export function todoApis(db: Database, notify: (message: string) => void) {
  const repository = new PostgresTodoRepository(db);
  const transactions = new PostgresTransactionRunner(db);
  return {
    postTodo: new CreateTodoApi(new CreateTodoCommand(repository, transactions))
      .handle,
    listTodos: new ListTodosApi(new ListTodosQuery(repository)).handle,
    getTodo: new GetTodoApi(new GetTodoQuery(repository)).handle,
    putTitle: new RenameTodoApi(new RenameTodoCommand(repository, transactions))
      .handle,
    putCompletion: new ChangeTodoCompletionApi(
      new ChangeTodoCompletionCommand(repository, transactions, notify),
    ).handle,
    deleteTodo: new DeleteTodoApi(
      new DeleteTodoCommand(repository, transactions),
    ).handle,
  };
}

export type TodoApis = ReturnType<typeof todoApis>;

// Todo・完了の履歴・変更の記録を空にする。
// WHY 各 step の前（beforeEach）に呼ぶ: .feature の `*` の 1 行は前の行に依存しない（step ごとに空の状態から用意する）。
// WHY 3 つの表を 1 文で truncate する: todo_status_changes は todos を外部キーで参照するので、同じ文で消す
//   （todo-repository.postgres.test.ts・API ジャーニーと同じ形）。
export async function emptyTodos(db: Database): Promise<void> {
  await db.execute(sql`truncate change_logs, todo_status_changes, todos`);
}

// 前提の Todo を作成の API で作る（本番と同じ経路。変更の記録も残る）。
export async function createTodo(
  apis: TodoApis,
  title: string,
): Promise<CreateTodoResponse> {
  const response = await apis.postTodo(
    jsonRequest("POST", "/api/todos", { title }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as CreateTodoResponse;
}

// 前提の Todo を完了にする・未完了に戻す（本番と同じ経路）。
export async function changeCompletion(
  apis: TodoApis,
  id: string,
  completed: boolean,
): Promise<void> {
  const response = await apis.putCompletion(
    jsonRequest("PUT", `/api/todos/${id}/completion`, { completed }),
    context(id),
  );
  expect(response.status).toBe(200);
}

export type StoredTodo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  // 完了の履歴（足した順。1 件以上）。最後の completed を completed と違う値にすると、履歴のずれた「壊れた Todo」になる。
  statusChanges: readonly { completed: boolean; changedAt: Date }[];
};

// 前提の Todo を表に直接入れる。
// WHY API を通さない: 作成日時は API が now() で決めるので、「同じ日時に作られた」「作成日時の古い順」を作れない（時計は
//   差し替えない。vi は使わない）。不変条件を満たさない行（完了の履歴がずれた Todo）も API では作れない。
// 変更の記録（change_logs）は書かない（Writer を通らない）。記録を見る step はこの関数で前提を作らない。
export async function storeTodo(db: Database, todo: StoredTodo): Promise<void> {
  await db.insert(todos).values({
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt,
  });
  await db.insert(todoStatusChanges).values(
    todo.statusChanges.map((change, position) => ({
      todoId: todo.id,
      position,
      ...change,
    })),
  );
}

const BASE_URL = "http://localhost";

export function jsonRequest(
  method: string,
  path: string,
  body: unknown,
): Request {
  return rawRequest(method, path, JSON.stringify(body));
}

// 本文をそのまま送る要求（JSON として読めない本文を送るため）。
export function rawRequest(
  method: string,
  path: string,
  body: string,
): Request {
  return new Request(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
}

export function bodylessRequest(method: string, path: string): Request {
  return new Request(`${BASE_URL}${path}`, { method });
}

// 動的ルート（/api/todos/:id...）の第 2 引数。Next 16 では params が Promise で渡される（get-todo.api.ts の Context）。
export function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

// todos の行（作成日時・id の順。一覧と同じ並び）。
export function todoRows(db: Database) {
  return db.select().from(todos).orderBy(asc(todos.createdAt), asc(todos.id));
}

// 完了の履歴の行のうち、比べる列（Todo の id・位置・完了かどうか・日時）を Todo の id・位置の順に並べる。
// WHY 行の id を除く: Writer が乱数で作るので、期待値に書けない。
export function statusRows(db: Database) {
  return db
    .select({
      todoId: todoStatusChanges.todoId,
      position: todoStatusChanges.position,
      completed: todoStatusChanges.completed,
      changedAt: todoStatusChanges.changedAt,
    })
    .from(todoStatusChanges)
    .orderBy(asc(todoStatusChanges.todoId), asc(todoStatusChanges.position));
}

// 変更の記録（change_logs）を、id と occurred_at を除いた形にして並べる。
// WHY id と occurred_at を除く: id は DB が乱数で作り、occurred_at は要求を処理した時刻（shared/infra/change-log.test.ts が固定する）。
// WHY 表・行・操作・変わった列の名前で並べる: 同じ要求の記録は同じ occurred_at で、DB が返す順は決まらない。期待値も
//   sortedLogs で同じ規則で並べて比べる（changes のキーの順は jsonb が並べ替えるので、鍵には列の名前の集合を使う）。
export async function logEntries(db: Database): Promise<ChangeEntry[]> {
  const rows = await db.select().from(changeLogs);
  return sortedLogs(
    rows.map(({ tableName, rowId, operation, changes, actorId }) => ({
      tableName,
      rowId,
      operation,
      changes,
      actorId,
    })),
  );
}

export function sortedLogs(entries: readonly ChangeEntry[]): ChangeEntry[] {
  return [...entries].sort((a, b) => logKey(a).localeCompare(logKey(b)));
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
export function todoInsertLog(todo: CreateTodoResponse): ChangeEntry {
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

// 完了の履歴の insert の記録（全列）。行の id は Writer が乱数で作るので、statusRowOf で読んだ行から作る。
export function statusInsertLog(
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

// 完了の履歴の行のうち、Todo と位置で 1 行を選ぶ（行の id と日時を記録の期待値に使うため。全列）。
export async function statusRowOf(
  db: Database,
  todoId: string,
  position: number,
): Promise<typeof todoStatusChanges.$inferSelect> {
  const rows = await db.select().from(todoStatusChanges);
  const row = rows.find(
    (candidate) =>
      candidate.todoId === todoId && candidate.position === position,
  );
  expect(row).toBeDefined();
  return row as typeof todoStatusChanges.$inferSelect;
}

// 失敗の応答は Problem Details（RFC 9457。problem.ts）。Content-Type（application/problem+json）と本文全体を確かめる。
// WHY toStrictEqual: 無いはずのキー（params・errors）が出ていないことも確かめる（presentation の UT と同じ）。
export async function expectProblem(
  response: Response,
  expected: Problem,
): Promise<void> {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  await expect(response.json()).resolves.toStrictEqual(expected);
}

// 404 の本文。無い Todo を指す要求は、どの API でも同じ key・params で返る（instance だけが要求のパス）。
export function notFoundProblem(id: string, instance: string): Problem {
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

// 400 の本文。誤りごとに変わる部分（detail・key・params・errors）に、固定の type・title・status と instance を足す。
export function validationProblem(
  instance: string,
  body: Pick<Problem, "detail" | "key" | "params" | "errors">,
): Problem {
  return {
    type: "/problems/validation-error",
    title: "Validation error",
    status: 400,
    instance,
    ...body,
  };
}

// 500 の本文。detail は固定の英語で、例外の message（内部の情報）を含めない。
export function internalErrorProblem(instance: string): Problem {
  return {
    type: "/problems/internal-error",
    title: "Internal error",
    status: 500,
    detail: "Internal server error.",
    instance,
    key: "server.internalError",
  };
}
