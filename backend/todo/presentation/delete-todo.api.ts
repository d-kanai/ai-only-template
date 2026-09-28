import { toErrorResponse } from "@/backend/shared/presentation/http-error";
import {
  type TodoContainer,
  todoContainer,
} from "@/backend/todo/infra/container";

// DELETE /api/todos/:id: Todo を削除する。204（本文なし）。無ければ 404。
// リクエスト本文もレスポンス本文も無いため、この API には DTO の型が無い。

// Next 16 では動的セグメントの params が Promise で渡される（get-todo.api.ts の Context のコメント）。
type Context = { params: Promise<{ id: string }> };

// コンテナを受け取って Route Handler を返す（WHY は list-todos.api.ts の listTodosApi のコメント）。
export function deleteTodoApi(container: Pick<TodoContainer, "deleteTodo">) {
  return async (_request: Request, ctx: Context): Promise<Response> => {
    try {
      const { id } = await ctx.params;
      await container.deleteTodo.execute(id);
      // WHY 204 で本文なし: 削除後に返す内容が無いため。Response.json は本文を持つので使わない。
      return new Response(null, { status: 204 });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

// app/api/todos/[id]/route.ts が re-export する Route Handler。
export const DELETE = deleteTodoApi(todoContainer);
