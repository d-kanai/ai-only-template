import type { ErrorResponse } from "@repo/backend/shared/presentation/http-error";
import type {
  CreateTodoRequest,
  CreateTodoResponse,
} from "@repo/backend/todo/presentation/create-todo.api";
import type { GetTodoResponse } from "@repo/backend/todo/presentation/get-todo.api";
import type {
  ListTodosResponse,
  TodoDto,
} from "@repo/backend/todo/presentation/list-todos.api";
import type {
  UpdateTodoRequest,
  UpdateTodoResponse,
} from "@repo/backend/todo/presentation/update-todo.api";

// /api/todos を呼ぶ薄いラッパー。画面側のデータ取得は必ず「hook → ここ → Route Handler」を通す（SSR を前提にしない構成）。
// リクエスト / レスポンスの型は backend の presentation 層の型を import type で参照するだけにする。
// 実装を import しないことでサーバ専用のコードが画面のバンドルに入らず、型を共有することで契約のずれを型チェックで検出できる。

// 画面側で backend を参照してよいのはこのファイル（features/<feature>/api/）だけにする。
// WHY: 画面とサーバの境界（契約の型）を 1 ファイルに集約し、契約が変わったときの影響をここ 1 か所で追えるようにする。
//   hook や components は、ここで re-export した型を使い、backend のパスを直接書かない。
export type {
  CreateTodoRequest,
  CreateTodoResponse,
  GetTodoResponse,
  ListTodosResponse,
  TodoDto,
  UpdateTodoRequest,
  UpdateTodoResponse,
};

// 一覧・作成の URL。
// WHY 関数の中に置く（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる（Issue #55）。
function todosPath(): string {
  return "/api/todos";
}

// id はユーザー入力由来の URL（/todo/[id]）から来るため、"/" や "?" を含んでも別のパスやクエリにならないようエンコードする。
function todoPath(id: string): string {
  return `${todosPath()}/${encodeURIComponent(id)}`;
}

// 本文を送るときだけ Content-Type を付ける。GET / DELETE には本文がないため不要。
function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// null を除くオブジェクトか（配列も含む）。プロパティを読んでも例外にならないことだけを確かめる。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// WHY `"error" in value` で絞り込まない: 無いプロパティは undefined として読めるので、in の検査は判定の結果を変えない。
//   結果を変えない検査は mutation testing で消しても落ちない（等価な変異）ため、Record として読んで型だけで判定する（Issue #55）。
function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.message === "string"
  );
}

// backend は失敗時に ErrorResponse を返す契約なので、その message を画面に出せるよう Error に載せる。
// ただしプロキシや Next 自体のエラーページなど、backend を通らないエラーは JSON でないことがある。
// その場合も「失敗した」ことは伝わるよう、HTTP ステータスを message にする。
async function toError(response: Response): Promise<Error> {
  // 本文が JSON として読めない場合は ErrorResponse ではないので、undefined（形の判定で必ず外れる値）として扱う。
  // WHY 例外を握りつぶすのを response.json() だけにする: 以前は isErrorResponse の判定まで try の中に入れていたため、
  //   判定の書き間違い（null のプロパティを読むなど）で投げた TypeError も「JSON でない」扱いになり、
  //   ステータスの表示に化けて気づけなかった（Issue #55 の mutation testing で、判定の変異が生き残って判明）。
  const body: unknown = await response.json().catch(() => undefined);
  return isErrorResponse(body)
    ? new Error(body.error.message)
    : new Error(`HTTP ${response.status}`);
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw await toError(response);
  }
  return (await response.json()) as T;
}

export function listTodos(): Promise<ListTodosResponse> {
  return requestJson(todosPath(), { method: "GET" });
}

export function getTodo(id: string): Promise<GetTodoResponse> {
  return requestJson(todoPath(id), { method: "GET" });
}

export function createTodo(
  request: CreateTodoRequest,
): Promise<CreateTodoResponse> {
  return requestJson(todosPath(), jsonInit("POST", request));
}

export function updateTodo(
  id: string,
  request: UpdateTodoRequest,
): Promise<UpdateTodoResponse> {
  return requestJson(todoPath(id), jsonInit("PUT", request));
}

// DELETE は 204（本文なし）を返す契約なので、requestJson で本文を読むと JSON の解析に失敗する。本文は読まない。
export async function deleteTodo(id: string): Promise<void> {
  const response = await fetch(todoPath(id), { method: "DELETE" });
  if (!response.ok) {
    throw await toError(response);
  }
}
