import { z } from "zod";
import { keyedIssue, keyedRefine } from "../../../shared/domain/keyed-issue";
import { getDatabase } from "../../../shared/infra/database";
import {
  parseJsonBody,
  requestBodySchema,
} from "../../../shared/presentation/json-body";
import { withProblemResponse } from "../../../shared/presentation/problem";
import { parseUuidParam } from "../../../shared/presentation/resource-id";
import { RenameTodoCommand } from "../application/rename-todo.command";
import { TODO_TITLE_MAX_LENGTH, type Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// PUT /api/todos/:id/title: Todo の名前（title）を変える。無ければ 404。
// WHY 完了（PUT /api/todos/:id/completion。change-todo-completion.api.ts）と別の API にする: 1 ユースケース = 1 API = 1 command
//   （.claude/rules/backend.md の presentation。ADR docs/adr/architecture/20260930-one-api-per-use-case.md）。
//   名前の変更と完了は業務プロセスが別で、1 つの API に任意の項目として混ぜると command の中で分岐が増える。
// WHY PUT: URL（/title）が指す 1 つの値を本文の値で置き換える。同じ要求を何度送っても結果が同じ（冪等）。

// リクエスト本文の「形」（項目の有無と型。未知の項目は拒否）に、title の必須・長さを domain と同じ規則で重ねる（Issue #144）。
// WHY title を必須にする: この API は名前を変えるためだけにあり、title の無い本文は誤り（「何も変えない」200 にしない）。
// WHY 空・長さも見る・domain と同じキーと定数にする: create-todo.api.ts の createTodoRequestSchema のコメント。
//   不変条件の正は domain（Todo#rename が常に完全に検証する）。
// WHY 未知の項目を拒否する: completed をこの API に送る誤り（完了は /completion）を黙って捨てずに 400 で知らせる（json-body.ts の requestBodySchema）。
function renameTodoRequestSchema() {
  return requestBodySchema({
    // 型が違う・無いときのキー（request.field.notString）は json-body.ts の toProblemError が決める（z.string に error は書かない）。
    // trim してからコードポイント数（Array.from）で数える: todo.ts の todoPropsSchema の title と同じ（WHY はそちら）。
    title: z
      .string()
      .trim()
      .refine(
        (title) => Array.from(title).length >= 1,
        keyedIssue("todo.title.empty"),
      )
      .refine(
        (title) => Array.from(title).length <= TODO_TITLE_MAX_LENGTH,
        keyedRefine("todo.title.tooLong", { max: TODO_TITLE_MAX_LENGTH }),
      ),
  });
}

// WHY 型をスキーマから導出する: 検査する形と型を 1 か所で宣言し、ずれを無くす（画面側も import type でこの型を使う）。
export type RenameTodoRequest = z.infer<
  ReturnType<typeof renameTodoRequestSchema>
>;

// 同じ形の Response を各 *.api.ts に書く。
//   WHY: 1 API = 1 ファイルで契約をそのファイルだけで読めるようにする。共通の dto.ts を作らない（ユーザー判断）。
//   Issue #139 で共通の DTO 型の別名もやめ、domain の Todo を各 API の Response に直接写す。
export type RenameTodoResponse = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。JSON にそのまま載せられるよう Date ではなく string にしている。
  createdAt: string;
};

// Next 16 では動的セグメントの params が Promise で渡される（get-todo.api.ts の Context のコメント）。
type Context = { params: Promise<{ id: string }> };

function toResponse(todo: Todo): RenameTodoResponse {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// PUT /api/todos/:id/title の Route Handler を持つクラス。コンストラクタで command を受け取り、handle を Route Handler として export する
//   （WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにする・withProblemResponse で包むは
//   list-todos.api.ts の ListTodosApi のコメント）。
export class RenameTodoApi {
  constructor(
    private readonly renameTodo: Pick<RenameTodoCommand, "execute">,
  ) {}

  readonly handle = withProblemResponse(
    async (request: Request, ctx: Context): Promise<Response> => {
      // WHY id を本文より先に確かめる: URL が指す Todo が存在しえないなら、本文の誤りを直しても成功しない。
      //   直しても意味の無い 400 ではなく 404 を返す。
      const { id: rawId } = await ctx.params;
      // uuid の形でない id のキーと params は、command が無い id に投げる not_found と同じにそろえる
      //   （画面から見て「無い Todo」と同じ契約）。
      const id = parseUuidParam(rawId, "todo.notFound", { id: rawId });
      const { title } = await parseJsonBody(request, renameTodoRequestSchema());
      const todo = await this.renameTodo.execute({ id, title });
      const body: RenameTodoResponse = toResponse(todo);
      return Response.json(body);
    },
  );
}

// app/api/todos/[id]/title/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// 組み立ての WHY（ここで組み立てる・Repository を api ファイルごとに作ってよい・InMemory に切り替えない）は list-todos.api.ts の GET のコメント。
export const PUT = new RenameTodoApi(
  new RenameTodoCommand(new PostgresTodoRepository(getDatabase().db)),
).handle;
