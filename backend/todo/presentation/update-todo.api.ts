import {
  InvalidRequestError,
  toErrorResponse,
} from "@/backend/shared/presentation/http-error";
import { readJsonObject } from "@/backend/shared/presentation/json-body";
import type { Todo } from "@/backend/todo/domain/todo";
import {
  type TodoContainer,
  todoContainer,
} from "@/backend/todo/infra/container";

// PUT /api/todos/:id: Todo の title / completed を更新する。無ければ 404。

// 部分更新: 送った項目だけを更新する（PUT だが PATCH 相当の意味にしている。CRUD の雛形として動詞を減らすため）。
export type UpdateTodoRequest = {
  title?: string;
  completed?: boolean;
};

// 同じ形の TodoDto を各 *.api.ts に書いている（WHY は list-todos.api.ts の TodoDto のコメント）。
export type TodoDto = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。
  createdAt: string;
};

export type UpdateTodoResponse = TodoDto;

// Next 16 では動的セグメントの params が Promise で渡される（get-todo.api.ts の Context のコメント）。
type Context = { params: Promise<{ id: string }> };

// リクエスト本文の「形」（項目の型）を確かめる。
// WHY title の空・長さは見ない: 不変条件は domain（Todo#rename）が持つ（create-todo.api.ts の parseCreateTodoRequest のコメント）。
// WHY どちらも無い本文（{}）を弾かない: 部分更新で「何も変えない」は矛盾しない要求で、契約（HTTP 契約）でも
//   400 の条件にしていないため、そのまま 200 で現在の Todo を返す。
function parseUpdateTodoRequest(
  body: Record<string, unknown>,
): UpdateTodoRequest {
  const { title, completed } = body;
  if (title !== undefined && typeof title !== "string") {
    throw new InvalidRequestError("title は文字列で指定してください");
  }
  if (completed !== undefined && typeof completed !== "boolean") {
    throw new InvalidRequestError(
      "completed は true か false で指定してください",
    );
  }
  return { title, completed };
}

function toTodoDto(todo: Todo): TodoDto {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// コンテナを受け取って Route Handler を返す（WHY は list-todos.api.ts の listTodosApi のコメント）。
export function updateTodoApi(container: Pick<TodoContainer, "updateTodo">) {
  return async (request: Request, ctx: Context): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      const input = parseUpdateTodoRequest(await readJsonObject(request));
      const todo = await container.updateTodo.execute({ id, ...input });
      const body: UpdateTodoResponse = toTodoDto(todo);
      return Response.json(body);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

// app/api/todos/[id]/route.ts が re-export する Route Handler。
export const PUT = updateTodoApi(todoContainer);
