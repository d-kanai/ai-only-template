import type { ErrorResponse } from "@/backend/shared/presentation/http-error";
import type {
  CreateTodoRequest,
  CreateTodoResponse,
} from "@/backend/todo/presentation/create-todo.api";
import type { GetTodoResponse } from "@/backend/todo/presentation/get-todo.api";
import type {
  ListTodosResponse,
  TodoDto,
} from "@/backend/todo/presentation/list-todos.api";
import type {
  UpdateTodoRequest,
  UpdateTodoResponse,
} from "@/backend/todo/presentation/update-todo.api";

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

const BASE_PATH = "/api/todos";

// id はユーザー入力由来の URL（/todo/[id]）から来るため、"/" や "?" を含んでも別のパスやクエリにならないようエンコードする。
function todoPath(id: string): string {
  return `${BASE_PATH}/${encodeURIComponent(id)}`;
}

// 本文を送るときだけ Content-Type を付ける。GET / DELETE には本文がないため不要。
function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  );
}

// backend は失敗時に ErrorResponse を返す契約なので、その message を画面に出せるよう Error に載せる。
// ただしプロキシや Next 自体のエラーページなど、backend を通らないエラーは JSON でないことがある。
// その場合も「失敗した」ことは伝わるよう、HTTP ステータスを message にする。
async function toError(response: Response): Promise<Error> {
  const fallback = new Error(`HTTP ${response.status}`);
  try {
    const body: unknown = await response.json();
    return isErrorResponse(body) ? new Error(body.error.message) : fallback;
  } catch {
    // 本文が JSON として読めない場合は ErrorResponse ではないので、ステータスだけを伝える。
    return fallback;
  }
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw await toError(response);
  }
  return (await response.json()) as T;
}

export function listTodos(): Promise<ListTodosResponse> {
  return requestJson(BASE_PATH, { method: "GET" });
}

export function getTodo(id: string): Promise<GetTodoResponse> {
  return requestJson(todoPath(id), { method: "GET" });
}

export function createTodo(
  request: CreateTodoRequest,
): Promise<CreateTodoResponse> {
  return requestJson(BASE_PATH, jsonInit("POST", request));
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
