import { z } from "zod";
import { getDatabase } from "../../../shared/infra/database";
import {
  parseJsonBody,
  requestBodySchema,
} from "../../../shared/presentation/json-body";
import { toProblemResponse } from "../../../shared/presentation/problem";
import { parseUuidParam } from "../../../shared/presentation/resource-id";
import { UpdateTodoCommand } from "../application/update-todo.command";
import type { Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// PUT /api/todos/:id: Todo の title / completed を更新する。無ければ 404。

// リクエスト本文の「形」（項目の型。未知の項目は拒否）。
// 部分更新: 送った項目だけを更新する（PUT だが PATCH 相当の意味にしている。CRUD の雛形として動詞を減らすため）。
// WHY title の空・長さは見ない: 不変条件は domain（Todo#rename）が持つ（create-todo.api.ts の createTodoRequestSchema のコメント）。
// WHY どちらも無い本文（{}）を弾かない: 部分更新で「何も変えない」は矛盾しない要求で、契約（HTTP 契約）でも
//   400 の条件にしていないため、そのまま 200 で現在の Todo を返す。
// WHY 未知の項目を拒否する: 項目名の打ち間違い（{ complete: true }）が「何も変えない」200 に化けるのを防ぐ（json-body.ts の requestBodySchema）。
function updateTodoRequestSchema() {
  return requestBodySchema({
    // 型が違うときのキー（request.field.notString / notBoolean）は json-body.ts の toProblemError が決める（ここに error は書かない）。
    title: z.string().optional(),
    completed: z.boolean().optional(),
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

// PUT /api/todos/:id の Route Handler を持つクラス。コンストラクタで command を受け取り、handle を Route Handler として export する
//   （WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにするは list-todos.api.ts の ListTodosApi のコメント）。
export class UpdateTodoApi {
  constructor(
    private readonly updateTodo: Pick<UpdateTodoCommand, "execute">,
  ) {}

  readonly handle = async (
    request: Request,
    ctx: Context,
  ): Promise<Response> => {
    try {
      // WHY id を本文より先に確かめる: URL が指す Todo が存在しえないなら、本文の誤りを直しても成功しない。
      //   直しても意味の無い 400 ではなく 404 を返す。
      const { id: rawId } = await ctx.params;
      // uuid の形でない id のキーと params は、query / command が無い id に投げる not_found と同じにそろえる
      //   （画面から見て「無い Todo」と同じ契約）。
      const id = parseUuidParam(rawId, "todo.notFound", { id: rawId });
      const input = await parseJsonBody(request, updateTodoRequestSchema());
      const todo = await this.updateTodo.execute({ id, ...input });
      const body: UpdateTodoResponse = toTodoDto(todo);
      return Response.json(body);
    } catch (error) {
      return toProblemResponse(error, request);
    }
  };
}

// app/api/todos/[id]/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// 組み立ての WHY（ここで組み立てる・Repository を api ファイルごとに作ってよい・InMemory に切り替えない）は list-todos.api.ts の GET のコメント。
export const PUT = new UpdateTodoApi(
  new UpdateTodoCommand(new PostgresTodoRepository(getDatabase().db)),
).handle;
