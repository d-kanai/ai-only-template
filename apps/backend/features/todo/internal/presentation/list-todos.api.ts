import { AppDatabase } from "../../../../shared/drizzle/database";
import { ProblemResponse } from "../../../../shared/http/problem";
import { ListTodosQuery } from "../application/list-todos.query";
import type { Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";

// GET /api/todos: Todo の一覧を作成日時の昇順で返す。

// WHY DTO をこのファイルで定義する: 1 API = 1 ファイルで、その API の契約（リクエスト / レスポンスの形）を
//   同じファイルで読めるようにするため。画面側は `import type` でこの型を参照し、形のずれを型チェックで検出する。
//   同じ形の Response を他の *.api.ts にも書く（共通の dto.ts を作らないのはユーザー判断。Issue #139 で共通の DTO 型の別名もやめ、
//   domain の Todo を各 API の Response に直接写す）。
export type ListTodosResponse = {
  todos: {
    id: string;
    title: string;
    completed: boolean;
    // ISO 8601 文字列。JSON にそのまま載せられるよう Date ではなく string にしている。
    createdAt: string;
  }[];
};

// GET /api/todos の Route Handler を持つクラス。コンストラクタで query を受け取り、handle を Route Handler として export する。
// WHY クラスにする（Issue #123。ユーザー判断）: application の query / command と同じ「コンストラクタで依存を受け取る」形に
//   そろえる。テストでは空の InMemory のリポジトリで組み立てた query を渡し
//   （`new ListTodosApi(new ListTodosQuery(new InMemoryTodoRepository())).handle`）、本番（下の GET）では Postgres で組み立てた
//   query を渡す。handler の中身は同じものをテストする。差し替えはコンストラクタ injection だけで行い、vi.mock は使わない
//   （差し替えたものが型で縛られ、query の形が変わればテストがコンパイルエラーになる）。
// WHY 型を Pick<ListTodosQuery, "execute"> にする: handler が使うのは execute だけなので、その形だけを約束する
//   （テストで execute だけを持つ偽物も渡せる）。
export class ListTodosApi {
  constructor(private readonly listTodos: Pick<ListTodosQuery, "execute">) {}

  // WHY アロー関数のプロパティにする: Route Handler として `export const GET = new ListTodosApi(...).handle` のように
  //   インスタンスから取り出して渡すと、メソッドでは this が外れて this.listTodos を読めない。アロー関数は作ったときの
  //   this（インスタンス）を持ち続ける（ProblemResponse.wrap で包んでも、中のアロー関数の this は変わらない）。
  // WHY ProblemResponse.wrap で包む（Issue #141）: handler が投げた例外（DomainError・InvalidRequestError・想定外の例外）を
  //   Problem Details の Response に変換する。Next の Route Handler には共通の catch が無く、包み忘れると Next の素の 500 が
  //   漏れるので、規則 presentation-with-problem-response（rule-tests/architecture.test.ts）が包み忘れを止める。
  //   以前は各 api が try / catch で ProblemResponse.from を手書きしていた（problem.ts の ProblemResponse.wrap のコメント）。
  readonly handle = ProblemResponse.wrap(
    // WHY 使わない request を引数に書く: ProblemResponse.wrap が第 1 引数の request を Problem の instance に使うので、handler の
    //   形（(request) => Promise<Response>）を Route Handler と同じにそろえる。
    async (_request: Request): Promise<Response> => {
      const todos = await this.listTodos.execute();
      const body: ListTodosResponse = {
        todos: todos.map((todo) => this.toResponseItem(todo)),
      };
      return Response.json(body);
    },
  );

  // WHY 補助（toResponseItem、ほかの api ファイルのリクエストのスキーマ・toResponse）を private メソッドにする
  //   （モジュールの最上位の関数にしない。Issue #262）: backend の本番コードはクラスを基本にし、補助の関数も使うクラスの
  //   メソッドにする（ADR docs/adr/architecture/20261002-class-based-backend.md）。この Api だけが使うので private。
  //   インスタンスの状態（コンストラクタで受け取った query / command）は使わないが static にしない: インスタンスで使うクラスに static を置かない（規則 no-static-in-instance-class。Issue #300）。
  private toResponseItem(todo: Todo): ListTodosResponse["todos"][number] {
    return {
      id: todo.id,
      title: todo.title,
      completed: todo.completed,
      createdAt: todo.createdAt.toISOString(),
    };
  }
}

// app/api/todos/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// WHY ここ（api ファイルの最下部）で組み立てる: Issue #123 で DI コンテナ（infra/container.ts）を廃止し、組み立てを使う場所に
//   置いた。この API が何（query と Repository の実装）で動くかを、このファイルだけで読める。
// WHY api ファイルごとに new PostgresTodoRepository(AppDatabase.get().db) してよい: プールは AppDatabase.get が globalThis に 1 つだけ
//   持つので（database.ts）、Repository を 5 つ作っても接続のプールは 1 つのまま。Repository は db を持つだけで状態を持たない。
// WHY DATABASE_URL が無いときに InMemory へ切り替えない（Issue #59）: 設定漏れでも黙って InMemory で動き、データが保存されない
//   まま気づけなかった。環境変数はすべて必須にし（apps/shared/env.ts）、InMemory はテストだけで使う（規則 presentation が
//   本番の api ファイルからの参照を止める）。
// WHY 読み込んだ時点で組み立ててよい: プールを作るだけで、接続は最初のクエリまで張らない（node-postgres の Pool）。
//   `next build` がこのモジュールを読み込んでも DB には接続しない。必須の環境変数が欠けていれば、env.ts の読み込みで止まる。
export const GET = new ListTodosApi(
  new ListTodosQuery(new PostgresTodoRepository(AppDatabase.get().db)),
).handle;
