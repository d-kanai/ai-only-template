import { z } from "zod";
import { toErrorResponse } from "../../shared/presentation/http-error";
import {
  parseJsonBody,
  requestBodySchema,
} from "../../shared/presentation/json-body";
import { parseUuidParam } from "../../shared/presentation/resource-id";
import type { Todo } from "../domain/todo";
import { type TodoContainer, todoContainer } from "../infra/container";

// PUT /api/todos/:id: Todo の title / completed を更新する。無ければ 404。

// リクエスト本文の「形」（項目の型。未知の項目は拒否）。
// 部分更新: 送った項目だけを更新する（PUT だが PATCH 相当の意味にしている。CRUD の雛形として動詞を減らすため）。
// WHY title の空・長さは見ない: 不変条件は domain（Todo#rename）が持つ（create-todo.api.ts の createTodoRequestSchema のコメント）。
// WHY どちらも無い本文（{}）を弾かない: 部分更新で「何も変えない」は矛盾しない要求で、契約（HTTP 契約）でも
//   400 の条件にしていないため、そのまま 200 で現在の Todo を返す。
// WHY 未知の項目を拒否する: 項目名の打ち間違い（{ complete: true }）が「何も変えない」200 に化けるのを防ぐ（json-body.ts の requestBodySchema）。
function updateTodoRequestSchema() {
  return requestBodySchema({
    title: z.string({ error: "title は文字列で指定してください" }).optional(),
    completed: z
      .boolean({ error: "completed は true か false で指定してください" })
      .optional(),
  });
}

export type UpdateTodoRequest = z.infer<
  ReturnType<typeof updateTodoRequestSchema>
>;

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
      // WHY id を本文より先に確かめる: URL が指す Todo が存在しえないなら、本文の誤りを直しても成功しない。
      //   直しても意味の無い 400 ではなく 404 を返す。
      const { id: rawId } = await ctx.params;
      // uuid の形でない id の message は、query / command が無い id に投げる not_found と同じ文言にそろえる。
      const id = parseUuidParam(rawId, `Todo（id: ${rawId}）が見つかりません`);
      const input = await parseJsonBody(request, updateTodoRequestSchema());
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
