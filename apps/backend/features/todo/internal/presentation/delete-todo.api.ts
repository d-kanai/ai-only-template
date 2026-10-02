import { AppDatabase } from "../../../../shared/infra/database";
import { PostgresTransactionRunner } from "../../../../shared/infra/transaction.postgres";
import { ProblemResponse } from "../../../../shared/presentation/problem";
import { ResourceId } from "../../../../shared/presentation/resource-id";
import { DeleteTodoCommand } from "../application/delete-todo.command";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// DELETE /api/todos/:id: Todo を削除する。204（本文なし）。無ければ 404。
// リクエスト本文もレスポンス本文も無いため、この API には DTO の型が無い。

// Next 16 では動的セグメントの params が Promise で渡される（get-todo.api.ts の Context のコメント）。
type Context = { params: Promise<{ id: string }> };

// DELETE /api/todos/:id の Route Handler を持つクラス。コンストラクタで command を受け取り、handle を Route Handler として export する
//   （WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにする・ProblemResponse.wrap で包むは
//   list-todos.api.ts の ListTodosApi のコメント）。
export class DeleteTodoApi {
  constructor(
    private readonly deleteTodo: Pick<DeleteTodoCommand, "execute">,
  ) {}

  readonly handle = ProblemResponse.wrap(
    async (_request: Request, ctx: Context): Promise<Response> => {
      const { id: rawId } = await ctx.params;
      // uuid の形でない id のキーと params は、query / command が無い id に投げる not_found と同じにそろえる
      //   （画面から見て「無い Todo」と同じ契約）。
      const id = ResourceId.parseUuid(rawId, "todo.notFound", { id: rawId });
      await this.deleteTodo.execute(id);
      // WHY 204 で本文なし: 削除後に返す内容が無いため。Response.json は本文を持つので使わない。
      return new Response(null, { status: 204 });
    },
  );
}

// app/api/todos/[id]/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// 組み立ての WHY（ここで組み立てる・Repository を api ファイルごとに作ってよい・InMemory に切り替えない）は list-todos.api.ts の GET のコメント。
// 書き込みの command には、トランザクションを張る PostgresTransactionRunner を Repository と同じ db で渡す（Issue #215）。
//   WHY 同じ AppDatabase.get().db: command の読み込み（findByIdForUpdate）と書き込みは runner の tx で、Repository の query（findAll /
//   findById）は Repository の db で行う。どちらも同じプールを使う。
export const DELETE = new DeleteTodoApi(
  new DeleteTodoCommand(
    new PostgresTodoRepository(AppDatabase.get().db),
    new PostgresTransactionRunner(AppDatabase.get().db),
  ),
).handle;
