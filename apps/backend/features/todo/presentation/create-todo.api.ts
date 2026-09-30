import { z } from "zod";
import { getDatabase } from "../../../shared/infra/database";
import {
  parseJsonBody,
  requestBodySchema,
} from "../../../shared/presentation/json-body";
import { toProblemResponse } from "../../../shared/presentation/problem";
import { CreateTodoCommand } from "../application/create-todo.command";
import type { Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// POST /api/todos: Todo を作る。201 と作った Todo を返す。

// リクエスト本文の「形」（項目の有無と型。未知の項目は拒否）。
// WHY 形だけを見て、空・長さは見ない: タイトルの中身の規則（trim 後 1〜100 文字）は Todo の不変条件として
//   domain（Todo.create の zod スキーマ）が持つ。ここにも書くと規則が 2 か所になり、片方だけ直してずれる。
//   domain の DomainError(validation_error) も toProblemResponse で同じ 400 になるので、クライアントから見た結果は同じ。
// WHY 関数にする: スキーマを最上位の定数にすると static な変異になり mutation testing で数えない（json-body.ts の requestBodySchema）。
function createTodoRequestSchema() {
  return requestBodySchema({
    // 型が違う・無いときのキー（request.field.notString）は json-body.ts の toProblemError が決める（ここに error は書かない）。
    title: z.string(),
  });
}

// WHY 型をスキーマから導出する: 検査する形と型を 1 か所で宣言し、ずれを無くす（画面側も import type でこの型を使う）。
export type CreateTodoRequest = z.infer<
  ReturnType<typeof createTodoRequestSchema>
>;

// 同じ形の Response を各 *.api.ts に書く。
//   WHY: 1 API = 1 ファイルで契約をそのファイルだけで読めるようにする。共通の dto.ts を作らない（ユーザー判断）。
//   Issue #139 で共通の DTO 型の別名もやめ、domain の Todo を各 API の Response に直接写す。
export type CreateTodoResponse = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。JSON にそのまま載せられるよう Date ではなく string にしている。
  createdAt: string;
};

function toResponse(todo: Todo): CreateTodoResponse {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// POST /api/todos の Route Handler を持つクラス。コンストラクタで command を受け取り、handle を Route Handler として export する
//   （WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにするは list-todos.api.ts の ListTodosApi のコメント）。
export class CreateTodoApi {
  constructor(
    private readonly createTodo: Pick<CreateTodoCommand, "execute">,
  ) {}

  readonly handle = async (request: Request): Promise<Response> => {
    try {
      const input = await parseJsonBody(request, createTodoRequestSchema());
      const todo = await this.createTodo.execute(input);
      const body: CreateTodoResponse = toResponse(todo);
      return Response.json(body, { status: 201 });
    } catch (error) {
      return toProblemResponse(error, request);
    }
  };
}

// app/api/todos/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// 組み立ての WHY（ここで組み立てる・Repository を api ファイルごとに作ってよい・InMemory に切り替えない）は list-todos.api.ts の GET のコメント。
export const POST = new CreateTodoApi(
  new CreateTodoCommand(new PostgresTodoRepository(getDatabase().db)),
).handle;
