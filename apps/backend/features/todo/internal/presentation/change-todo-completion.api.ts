import { z } from "zod";
import { getDatabase } from "../../../../shared/infra/database";
import { PostgresTransactionRunner } from "../../../../shared/infra/transaction.postgres";
import {
  parseJsonBody,
  requestBodySchema,
} from "../../../../shared/presentation/json-body";
import { withProblemResponse } from "../../../../shared/presentation/problem";
import { parseUuidParam } from "../../../../shared/presentation/resource-id";
import { notify } from "../../../notification/expose/notify";
import { ChangeTodoCompletionCommand } from "../application/change-todo-completion.command";
import type { Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// PUT /api/todos/:id/completion: Todo を完了にする / 未完了に戻す。無ければ 404。
// WHY 名前の変更（PUT /api/todos/:id/title。rename-todo.api.ts）と別の API にする: rename-todo.api.ts の冒頭のコメント。
// WHY PUT で completed の値を受け取る（POST /complete と /reopen のようなアクションにしない）: 同じ要求を何度送っても結果が
//   同じ（冪等）で、画面のチェックボックスのトグルは次の値をそのまま送れる（ADR docs/adr/architecture/20260930-one-api-per-use-case.md）。

// リクエスト本文の「形」（項目の有無と型。未知の項目は拒否）。
// WHY completed を必須にする: この API は完了を変えるためだけにあり、completed の無い本文は誤り（「何も変えない」200 にしない）。
// WHY 未知の項目を拒否する: title をこの API に送る誤り（名前の変更は /title）を黙って捨てずに 400 で知らせる（json-body.ts の requestBodySchema）。
function changeTodoCompletionRequestSchema() {
  return requestBodySchema({
    // 型が違う・無いときのキー（request.field.notBoolean）は json-body.ts の toProblemError が決める（z.boolean に error は書かない）。
    completed: z.boolean(),
  });
}

// WHY 型をスキーマから導出する: 検査する形と型を 1 か所で宣言し、ずれを無くす（画面側も import type でこの型を使う）。
export type ChangeTodoCompletionRequest = z.infer<
  ReturnType<typeof changeTodoCompletionRequestSchema>
>;

// 同じ形の Response を各 *.api.ts に書く。
//   WHY: 1 API = 1 ファイルで契約をそのファイルだけで読めるようにする。共通の dto.ts を作らない（ユーザー判断）。
//   Issue #139 で共通の DTO 型の別名もやめ、domain の Todo を各 API の Response に直接写す。
export type ChangeTodoCompletionResponse = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。JSON にそのまま載せられるよう Date ではなく string にしている。
  createdAt: string;
};

// Next 16 では動的セグメントの params が Promise で渡される（get-todo.api.ts の Context のコメント）。
type Context = { params: Promise<{ id: string }> };

function toResponse(todo: Todo): ChangeTodoCompletionResponse {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// PUT /api/todos/:id/completion の Route Handler を持つクラス。コンストラクタで command を受け取り、handle を Route Handler として export する
//   （WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにする・withProblemResponse で包むは
//   list-todos.api.ts の ListTodosApi のコメント）。
export class ChangeTodoCompletionApi {
  constructor(
    private readonly changeTodoCompletion: Pick<
      ChangeTodoCompletionCommand,
      "execute"
    >,
  ) {}

  readonly handle = withProblemResponse(
    async (request: Request, ctx: Context): Promise<Response> => {
      // WHY id を本文より先に確かめる: rename-todo.api.ts の RenameTodoApi の handle のコメント（存在しえない Todo への
      //   要求は、本文を直しても成功しないので 400 ではなく 404）。
      const { id: rawId } = await ctx.params;
      // uuid の形でない id のキーと params は、command が無い id に投げる not_found と同じにそろえる
      //   （画面から見て「無い Todo」と同じ契約）。
      const id = parseUuidParam(rawId, "todo.notFound", { id: rawId });
      const { completed } = await parseJsonBody(
        request,
        changeTodoCompletionRequestSchema(),
      );
      const todo = await this.changeTodoCompletion.execute({ id, completed });
      const body: ChangeTodoCompletionResponse = toResponse(todo);
      return Response.json(body);
    },
  );
}

// app/api/todos/[id]/completion/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// 組み立ての WHY（ここで組み立てる・Repository を api ファイルごとに作ってよい・InMemory に切り替えない）は list-todos.api.ts の GET のコメント。
// 完了の通知は notification モジュールの公開の入口（expose/notify.ts）を渡す（Issue #208）。
// WHY ここで import して渡す（command が直接 import しない）: 他のモジュールの expose を import してよいのは組み立ての場所
//   （presentation）だけ（rule-tests/architecture.test.ts の module-expose-only-from-presentation）。command は関数を受け取るだけで、
//   notification モジュールを知らない。
// 書き込みの command には、トランザクションを張る PostgresTransactionRunner を Repository と同じ db で渡す（Issue #215）。
//   WHY 同じ getDatabase().db: command の読み込み（findByIdForUpdate）と書き込みは runner の tx で、Repository の query（findAll /
//   findById）は Repository の db で行う。どちらも同じプールを使う。
export const PUT = new ChangeTodoCompletionApi(
  new ChangeTodoCompletionCommand(
    new PostgresTodoRepository(getDatabase().db),
    new PostgresTransactionRunner(getDatabase().db),
    notify,
  ),
).handle;
