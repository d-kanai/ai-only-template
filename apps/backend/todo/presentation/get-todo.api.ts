import { toErrorResponse } from "../../shared/presentation/http-error";
import type { Todo } from "../domain/todo";
import { type TodoContainer, todoContainer } from "../infra/container";

// GET /api/todos/:id: Todo を 1 件返す。無ければ 404。

// 同じ形の TodoDto を各 *.api.ts に書いている（WHY は list-todos.api.ts の TodoDto のコメント）。
export type TodoDto = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。
  createdAt: string;
};

export type GetTodoResponse = TodoDto;

// Route Handler の第 2 引数。Next 16 では動的セグメントの params が Promise で渡される
// （node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md の「Route Context Helper」）。
type Context = { params: Promise<{ id: string }> };

function toTodoDto(todo: Todo): TodoDto {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// コンテナを受け取って Route Handler を返す（WHY は list-todos.api.ts の listTodosApi のコメント）。
export function getTodoApi(container: Pick<TodoContainer, "getTodo">) {
  return async (_request: Request, ctx: Context): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      const todo = await container.getTodo.execute(id);
      const body: GetTodoResponse = toTodoDto(todo);
      return Response.json(body);
    } catch (error) {
      // 無い id は GetTodoQuery が DomainError(not_found) を投げ、ここで 404 に変換される。
      return toErrorResponse(error);
    }
  };
}

// app/api/todos/[id]/route.ts が re-export する Route Handler。
export const GET = getTodoApi(todoContainer);
