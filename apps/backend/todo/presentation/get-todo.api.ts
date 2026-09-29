import { z } from "zod";
import { DomainError } from "../../shared/domain/domain-error";
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

// 動的セグメントの id が Todo の id の形（uuid）でなければ、無い Todo として 404 にする。
// WHY 404 にする（400 にしない）: /api/todos/abc は「その id の Todo は無い」と同じ意味で、以前（Repository が
//   uuid の形でない id を「無い」として扱っていた）と同じ契約を保つ。message も query / command の not_found と同じ文言にそろえる。
// WHY presentation で確かめる: id は URL から来るリクエストの「形」で、Todo の id は常に randomUUID（v4）で作る。
//   形の違う id を query / command に渡さない。Postgres の Repository の isUuid は防御として残している
//   （todo-repository.postgres.ts のコメント）。
// WHY z.uuid()（RFC 9562 の形）: Todo の id は randomUUID で作るのでこの形に必ず合う。Postgres の uuid 型はより広い形
//   （版の桁が 0 など）も受け付けるが、そうした id の Todo はこのアプリでは作られない。
// WHY 関数の中で z.uuid() を作る: 最上位の定数は static な変異になり mutation testing で数えない（json-body.ts のコメント）。
// 同じ関数を update-todo.api.ts・delete-todo.api.ts にも書いている（1 API = 1 ファイル。.claude/rules/backend.md の「presentation」）。
function parseTodoId(id: string): string {
  if (!z.uuid().safeParse(id).success) {
    throw new DomainError("not_found", `Todo（id: ${id}）が見つかりません`);
  }
  return id;
}

// コンテナを受け取って Route Handler を返す（WHY は list-todos.api.ts の listTodosApi のコメント）。
export function getTodoApi(container: Pick<TodoContainer, "getTodo">) {
  return async (_request: Request, ctx: Context): Promise<Response> => {
    try {
      const id = parseTodoId((await ctx.params).id);
      const todo = await container.getTodo.execute(id);
      const body: GetTodoResponse = toTodoDto(todo);
      return Response.json(body);
    } catch (error) {
      // 無い id は GetTodoQuery が、uuid の形でない id は parseTodoId が DomainError(not_found) を投げ、ここで 404 に変換される。
      return toErrorResponse(error);
    }
  };
}

// app/api/todos/[id]/route.ts が re-export する Route Handler。
export const GET = getTodoApi(todoContainer);
