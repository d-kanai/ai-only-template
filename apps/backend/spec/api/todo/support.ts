import { asc, eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { Notifier } from "../../../features/notification/expose/notifier";
import { ChangeTodoCompletionCommand } from "../../../features/todo/internal/application/change-todo-completion.command";
import { CreateTodoCommand } from "../../../features/todo/internal/application/create-todo.command";
import { DeleteTodoCommand } from "../../../features/todo/internal/application/delete-todo.command";
import { GetTodoQuery } from "../../../features/todo/internal/application/get-todo.query";
import { ListTodosQuery } from "../../../features/todo/internal/application/list-todos.query";
import { RenameTodoCommand } from "../../../features/todo/internal/application/rename-todo.command";
import {
  todoStatusChanges,
  todos,
} from "../../../features/todo/internal/infra/schema";
import { PostgresTodoRepository } from "../../../features/todo/internal/infra/todo-repository.postgres";
import { ChangeTodoCompletionApi } from "../../../features/todo/internal/presentation/change-todo-completion.api";
import {
  CreateTodoApi,
  type CreateTodoResponse,
} from "../../../features/todo/internal/presentation/create-todo.api";
import { DeleteTodoApi } from "../../../features/todo/internal/presentation/delete-todo.api";
import { GetTodoApi } from "../../../features/todo/internal/presentation/get-todo.api";
import { ListTodosApi } from "../../../features/todo/internal/presentation/list-todos.api";
import { RenameTodoApi } from "../../../features/todo/internal/presentation/rename-todo.api";
import type { ChangeEntry } from "../../../shared/infra/change-log";
import type { Database } from "../../../shared/infra/database";
import { changeLogs } from "../../../shared/infra/schema";
import { PostgresTransactionRunner } from "../../../shared/infra/transaction.postgres";
import type { Problem } from "../../../shared/presentation/problem";

// Todo の API 仕様（spec/api/todo/*.api-spec.test.ts。Issue #219）が共有する補助: API ごとの組み立て・要求の作り方・DB の読み出し・
//   期待値の作り方・失敗の本文。
// WHY spec/api の中に置く（test-support/ に置かない）: API 仕様のためだけの補助。test-support/ はテストダブル・DB の基盤・テストデータ
//   ビルダー（前提の行を入れる aTodo。test-support/todo/todo-builder.ts）を置く場所で、ほかのテストからも使う。
// WHY 6 つの API 仕様で 1 つにまとめる: 組み立て（本番と同じ部品の並び）・要求の形・DB の行の読み方は API ごとに変わらず、
//   ファイルごとに書くと、本番の組み立てが変わったときに直し漏れる。
// WHY 前提の Todo は API で作らずビルダー（aTodo）で表に直接入れる（ユーザー判断 2026-10-01、Issue #240）: step が呼ぶ API を自分の仕様の
//   対象の 1 つだけにし、前提の用意を対象でない API の組み合わせに依存させない（理由の詳細は todo-builder.ts の冒頭）。そのため
//   ここには前提を API で作る関数を置かない。step も support.ts も対象でない API の handler を呼ばないことは
//   rule-tests/api-spec.test.ts（api-spec-own-api-only・api-spec-support-no-api-call・api-spec-support-assembler-per-api）が止める。
// 既知の重複: spec/journey/todo-lifecycle.api-journey.test.ts にも同じ種類の関数（組み立て・jsonRequest・logEntries など）がある。
//   ジャーニーは Issue #219・#240 では触らない（担当外）ので、今は重複を許す。

// API ごとの組み立て。本番の api ファイルの最下部と同じ組み立てで、渡した db（テスト用のスキーマ）を使う handler を返す。
// WHY 本番の export（GET / POST など）を使わない: 本番は AppDatabase.get()（.env の public スキーマ）を使い、テストファイルごとの
//   スキーマ（createTestDatabase）に向けられない。
// WHY API ごとに 1 つの関数にする（すべての handler をまとめて返さない）: step は自分の仕様の対象の組み立て（<api> の camelCase + Api。
//   rename-todo なら renameTodoApi）だけを import し、ほかの API の handler を手に入れない（rule-tests/api-spec.test.ts の
//   api-spec-own-api-only が import の名前で、api-spec-support-assembler-per-api が 1 つの関数に Api を 1 つだけ new する形で止める）。
// WHY 名前を Api のクラス名の先頭を小文字にしたものにする: 規則が api ファイルの名前（kebab-case）とクラス名の両方から同じ名前を導いて
//   照合できる（.claude/rules/backend.md の「命名」で両者は対になる）。
export function createTodoApi(db: Database) {
  return new CreateTodoApi(
    new CreateTodoCommand(
      new PostgresTodoRepository(db),
      new PostgresTransactionRunner(db),
    ),
  ).handle;
}

export function listTodosApi(db: Database) {
  return new ListTodosApi(new ListTodosQuery(new PostgresTodoRepository(db)))
    .handle;
}

export function getTodoApi(db: Database) {
  return new GetTodoApi(new GetTodoQuery(new PostgresTodoRepository(db)))
    .handle;
}

export function renameTodoApi(db: Database) {
  return new RenameTodoApi(
    new RenameTodoCommand(
      new PostgresTodoRepository(db),
      new PostgresTransactionRunner(db),
    ),
  ).handle;
}

// 完了の通知は本番と同じ notification モジュールの入口（expose/notifier.ts の Notifier）を渡す（Issue #256）。
// WHY 本物の Notifier を渡す（記録するオブジェクトにしない）: 仕様の実行で notification モジュール（command・ログの sender）まで通す（daiki の判断
//   2026-10-02）。送った通知は、step がログの行（console.log の差し替え。Issue #258）で確かめる。
export function changeTodoCompletionApi(db: Database) {
  return new ChangeTodoCompletionApi(
    new ChangeTodoCompletionCommand(
      new PostgresTodoRepository(db),
      new PostgresTransactionRunner(db),
      new Notifier(),
    ),
  ).handle;
}

export function deleteTodoApi(db: Database) {
  return new DeleteTodoApi(
    new DeleteTodoCommand(
      new PostgresTodoRepository(db),
      new PostgresTransactionRunner(db),
    ),
  ).handle;
}

// Todo・完了の履歴・変更の記録を空にする。
// WHY 各 step の前（beforeEach）に呼ぶ: .feature の `*` の 1 行は前の行に依存しない（step ごとに空の状態から用意する）。
// WHY 3 つの表を 1 文で truncate する: todo_status_changes は todos を外部キーで参照するので、同じ文で消す
//   （todo-repository.postgres.test.ts・API ジャーニーと同じ形）。
export async function emptyTodos(db: Database): Promise<void> {
  await db.execute(sql`truncate change_logs, todo_status_changes, todos`);
}

// 削除された後の状態（todos の行が無く、完了の履歴も外部キーの cascade で無い）を作る。「削除した Todo」の前提に使う。
// WHY 削除の API を通さない: 前提を対象でない API で作らない（冒頭）。削除の後に残るものは行が無いことだけなので、行を消せば同じ状態。
export async function removeTodoRow(db: Database, id: string): Promise<void> {
  await db.delete(todos).where(eq(todos.id, id));
}

// 前提の Todo の値（test-support/todo/todo-builder.ts の build() が返す BuiltTodo と同じ形）。
// WHY BuiltTodo を import しない: support.ts はテストでない名前のソースなので、rule-tests/test-support.test.ts の
//   production-imports-test-support が test-support の import を（型だけでも）止める。形が同じなので、step は build() の返り値を
//   そのまま渡せる（構造的な型）。
type TodoValues = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  statusChanges: readonly { completed: boolean; changedAt: Date }[];
};

// 前提の Todo を API の応答の Todo の形にする（作成日時は ISO 8601 の文字列。6 つの API の応答の Todo は同じ形）。
// WHY 期待値をこの 1 つの関数で作る: 応答の形（日時を文字列にする）を step ごとに書くと、形が変わったときに直し漏れる。step は
//   `satisfies <対の api の応答の型>` で対の api の型と合うことを確かめる。
export function todoResponseOf(todo: TodoValues) {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// 前提の Todo の todos の行（todoRows で読む形。作成日時は Date）。
export function todoRowOf(todo: TodoValues) {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt,
  };
}

// 前提の Todo の完了の履歴の行（statusRows で読む形。position は履歴の添字）。
export function statusRowsOf(todo: TodoValues) {
  return todo.statusChanges.map((change, position) => ({
    todoId: todo.id,
    position,
    completed: change.completed,
    changedAt: change.changedAt,
  }));
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
