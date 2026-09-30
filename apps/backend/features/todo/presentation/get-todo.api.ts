import { getDatabase } from "../../../shared/infra/database";
import { withProblemResponse } from "../../../shared/presentation/problem";
import { parseUuidParam } from "../../../shared/presentation/resource-id";
import { GetTodoQuery } from "../application/get-todo.query";
import type { Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// GET /api/todos/:id: Todo を 1 件返す。無ければ 404。

// 同じ形の Response を各 *.api.ts に書く。
//   WHY: 1 API = 1 ファイルで契約をそのファイルだけで読めるようにする。共通の dto.ts を作らない（ユーザー判断）。
//   Issue #139 で共通の DTO 型の別名もやめ、domain の Todo を各 API の Response に直接写す。
export type GetTodoResponse = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。JSON にそのまま載せられるよう Date ではなく string にしている。
  createdAt: string;
};

// Route Handler の第 2 引数。Next 16 では動的セグメントの params が Promise で渡される
// （node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md の「Route Context Helper」）。
type Context = { params: Promise<{ id: string }> };

function toResponse(todo: Todo): GetTodoResponse {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// GET /api/todos/:id の Route Handler を持つクラス。コンストラクタで query を受け取り、handle を Route Handler として export する
//   （WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにする・withProblemResponse で包むは
//   list-todos.api.ts の ListTodosApi のコメント）。
export class GetTodoApi {
  constructor(private readonly getTodo: Pick<GetTodoQuery, "execute">) {}

  readonly handle = withProblemResponse(
    async (_request: Request, ctx: Context): Promise<Response> => {
      const { id: rawId } = await ctx.params;
      // uuid の形でない id のキーと params は、query / command が無い id に投げる not_found と同じにそろえる
      //   （画面から見て「無い Todo」と同じ契約）。
      const id = parseUuidParam(rawId, "todo.notFound", { id: rawId });
      // 無い id は GetTodoQuery が、uuid の形でない id は parseUuidParam が DomainError(not_found) を投げ、withProblemResponse が
      //   404 に変換する。
      const todo = await this.getTodo.execute(id);
      const body: GetTodoResponse = toResponse(todo);
      return Response.json(body);
    },
  );
}

// app/api/todos/[id]/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// 組み立ての WHY（ここで組み立てる・Repository を api ファイルごとに作ってよい・InMemory に切り替えない）は list-todos.api.ts の GET のコメント。
export const GET = new GetTodoApi(
  new GetTodoQuery(new PostgresTodoRepository(getDatabase().db)),
).handle;
