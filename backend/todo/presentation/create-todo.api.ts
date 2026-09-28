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

// POST /api/todos: Todo を作る。201 と作った Todo を返す。

export type CreateTodoRequest = {
  title: string;
};

// 同じ形の TodoDto を各 *.api.ts に書いている（WHY は list-todos.api.ts の TodoDto のコメント）。
export type TodoDto = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。
  createdAt: string;
};

export type CreateTodoResponse = TodoDto;

// リクエスト本文の「形」（項目の有無と型）を確かめる。
// WHY 形だけを見て、空・長さは見ない: タイトルの中身の規則（trim 後 1〜100 文字）は Todo の不変条件として
//   domain（Todo.create）が持つ。ここにも書くと規則が 2 か所になり、片方だけ直してずれる。
//   domain の DomainError(validation_error) も toErrorResponse で同じ 400 になるので、クライアントから見た結果は同じ。
function parseCreateTodoRequest(
  body: Record<string, unknown>,
): CreateTodoRequest {
  if (typeof body.title !== "string") {
    throw new InvalidRequestError("title は文字列で指定してください");
  }
  return { title: body.title };
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
export function createTodoApi(container: Pick<TodoContainer, "createTodo">) {
  return async (request: Request): Promise<Response> => {
    try {
      const input = parseCreateTodoRequest(await readJsonObject(request));
      const todo = await container.createTodo.execute(input);
      const body: CreateTodoResponse = toTodoDto(todo);
      return Response.json(body, { status: 201 });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

// app/api/todos/route.ts が re-export する Route Handler。
export const POST = createTodoApi(todoContainer);
