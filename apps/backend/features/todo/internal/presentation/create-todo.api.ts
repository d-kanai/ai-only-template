import { z } from "zod";
import { KeyedIssue } from "../../../../shared/domain/keyed-issue";
import { AppDatabase } from "../../../../shared/infra/database";
import { PostgresTransactionRunner } from "../../../../shared/infra/transaction.postgres";
import { RequestBody } from "../../../../shared/presentation/json-body";
import { ProblemResponse } from "../../../../shared/presentation/problem";
import { CreateTodoCommand } from "../application/create-todo.command";
import { TODO_TITLE_MAX_LENGTH, type Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// POST /api/todos: Todo を作る。201 と作った Todo を返す。

// WHY 型をスキーマから導出する: 検査する形と型を 1 か所で宣言し、ずれを無くす（画面側も import type でこの型を使う）。
export type CreateTodoRequest = z.infer<
  ReturnType<(typeof CreateTodoApi)["createTodoRequestSchema"]>
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

// POST /api/todos の Route Handler を持つクラス。コンストラクタで command を受け取り、handle を Route Handler として export する
//   （WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにする・ProblemResponse.wrap で包む・
//   補助（リクエストのスキーマ・toResponse）を private static メソッドにするは
//   list-todos.api.ts の ListTodosApi のコメント）。
export class CreateTodoApi {
  constructor(
    private readonly createTodo: Pick<CreateTodoCommand, "execute">,
  ) {}

  readonly handle = ProblemResponse.wrap(
    async (request: Request): Promise<Response> => {
      const input = await RequestBody.parse(
        request,
        CreateTodoApi.createTodoRequestSchema(),
      );
      const todo = await this.createTodo.execute(input);
      const body: CreateTodoResponse = CreateTodoApi.toResponse(todo);
      return Response.json(body, { status: 201 });
    },
  );

  // リクエスト本文の「形」（項目の有無と型。未知の項目は拒否）に、title の必須・長さを domain と同じ規則で重ねる（Issue #144）。
  // WHY 必須・長さも見る: 形の誤りと一緒に、項目ごとの誤り（Problem の errors。pointer が #/title）として 1 回の応答で
  //   まとめて返すため。domain の DomainError(validation_error) は key 1 つで、どの項目の誤りかを持たない。
  // WHY domain と同じキー・同じ数え方・同じ上限（TODO_TITLE_MAX_LENGTH）にする: presentation は domain より厳しくしない
  //   （domain が通す値を弾かない）。上限の数値は domain の定数を参照し、2 か所に書かない。規則の正は domain で、domain は
  //   ここを通った値も含めて常に完全に検証する（todo.ts の todoPropsSchema。.claude/rules/backend.md の presentation）。
  // WHY メソッドにする（スキーマを最上位の定数・static フィールドにしない）: 読み込み時にだけ評価される static な変異になり
  //   mutation testing で数えない（json-body.ts の RequestBody.schema。stryker.config.mjs の ignoreStatic）。呼び出しのたびに作る。
  private static createTodoRequestSchema() {
    return RequestBody.schema({
      // 型が違う・無いときのキー（request.field.notString）は json-body.ts の toProblemError が決める（z.string に error は書かない）。
      // trim してからコードポイント数（Array.from）で数える: todo.ts の todoPropsSchema の title と同じ（WHY はそちら）。
      title: z
        .string()
        .trim()
        .refine(
          (title) => Array.from(title).length >= 1,
          KeyedIssue.of("todo.title.empty"),
        )
        .refine(
          (title) => Array.from(title).length <= TODO_TITLE_MAX_LENGTH,
          KeyedIssue.refine("todo.title.tooLong", {
            max: TODO_TITLE_MAX_LENGTH,
          }),
        ),
    });
  }

  private static toResponse(todo: Todo): CreateTodoResponse {
    return {
      id: todo.id,
      title: todo.title,
      completed: todo.completed,
      createdAt: todo.createdAt.toISOString(),
    };
  }
}

// app/api/todos/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// 組み立ての WHY（ここで組み立てる・Repository を api ファイルごとに作ってよい・InMemory に切り替えない）は list-todos.api.ts の GET のコメント。
// 書き込みの command には、トランザクションを張る PostgresTransactionRunner を Repository と同じ db で渡す（Issue #215）。
//   WHY 同じ AppDatabase.get().db: command の読み込み（findByIdForUpdate）と書き込みは runner の tx で、Repository の query（findAll /
//   findById）は Repository の db で行う。どちらも同じプールを使う。
export const POST = new CreateTodoApi(
  new CreateTodoCommand(
    new PostgresTodoRepository(AppDatabase.get().db),
    new PostgresTransactionRunner(AppDatabase.get().db),
  ),
).handle;
