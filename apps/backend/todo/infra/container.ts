import type { TransactionRunner } from "../../shared/domain/transaction-runner";
import {
  type Database,
  type Executor,
  getDatabase,
} from "../../shared/infra/database";
import { DrizzleTransactionRunner } from "../../shared/infra/drizzle-transaction-runner";
import {
  CreateTodoCommand,
  type CreateTodoInput,
} from "../application/create-todo.command";
import { DeleteTodoCommand } from "../application/delete-todo.command";
import { GetTodoQuery } from "../application/get-todo.query";
import { ListTodosQuery } from "../application/list-todos.query";
import {
  UpdateTodoCommand,
  type UpdateTodoInput,
} from "../application/update-todo.command";
import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";
import { InMemoryTransactionRunner } from "./in-memory-transaction-runner";
import { InMemoryTodoRepository } from "./todo-repository.in-memory";
import { PostgresTodoRepository } from "./todo-repository.postgres";

// Todo の query / command をリポジトリの実装と組み立てる（DI）。presentation 層はここからだけ受け取る。
// WHY 組み立てをここ 1 か所に集める: presentation 層が Repository の実装を直接 new しないようにし、
//   InMemory / Postgres の切り替えとトランザクションの張り方をこのファイルだけで決めるため。
// WHY 型を execute だけにする: command はトランザクションで包んだ関数に差し替えるため、クラスそのものではなくなる。
//   presentation が使うのは execute だけなので、その形だけを約束する。
export type TodoContainer = {
  listTodos: Pick<ListTodosQuery, "execute">;
  getTodo: Pick<GetTodoQuery, "execute">;
  createTodo: { execute(input: CreateTodoInput): Promise<Todo> };
  updateTodo: { execute(input: UpdateTodoInput): Promise<Todo> };
  deleteTodo: { execute(id: string): Promise<void> };
};

export type TodoContainerDeps<Tx> = {
  // command を 1 つのトランザクションで実行する。
  runner: TransactionRunner<Tx>;
  // executor（トランザクションの中の tx か、読み取り用の readExecutor）から、それを使うリポジトリを作る。
  repositoryFor: (executor: Tx) => TodoRepository;
  // query（トランザクションの外）で使う executor。Postgres では db（プール）、InMemory ではリポジトリそのもの。
  // WHY runner とは別に受け取る: query は runner.run を通さないので、runner からは executor を受け取れない。
  //   runner に「トランザクションの外の executor」を持たせると、TransactionRunner（domain の interface）に
  //   読み取りの都合が混ざるため、組み立ての引数として並べる。
  readExecutor: Tx;
};

// WHY command は一律に runner.run で包む: command は「全部成功するか、何も変えないか」にする（Issue #57 の方針）。
//   今の command は save / delete を 1 回しか呼ばないが、将来 command が複数の書き込みをするようになっても、
//   途中までの変更を残さない形を先に決めておく。なお分離レベルは既定の READ COMMITTED なので、読んでから書くまでの間に
//   別のリクエストが同じ Todo を変える（lost update）ことは防がない（rules/code/architecture.md の「永続化」）。
//   包むのはこの 1 か所だけで、command の本体（application 層）は Repository を受け取るだけのまま、トランザクションを知らない。
// WHY command を呼び出しのたびに作る: トランザクションごとに executor（tx）が違うので、その tx で作ったリポジトリを
//   持つ command が要る。command は Repository を持つだけの軽いオブジェクトなので、毎回作っても負担は小さい。
// WHY query は包まない: 読むだけで変更を残さないので rollback の必要がない。トランザクションを張ると、
//   BEGIN / COMMIT の往復と、その間の接続の占有が増えるだけになる。
export function createTodoContainer<Tx>({
  runner,
  repositoryFor,
  readExecutor,
}: TodoContainerDeps<Tx>): TodoContainer {
  const readRepository = repositoryFor(readExecutor);
  return {
    listTodos: new ListTodosQuery(readRepository),
    getTodo: new GetTodoQuery(readRepository),
    createTodo: {
      execute: (input) =>
        runner.run((tx) =>
          new CreateTodoCommand(repositoryFor(tx)).execute(input),
        ),
    },
    updateTodo: {
      execute: (input) =>
        runner.run((tx) =>
          new UpdateTodoCommand(repositoryFor(tx)).execute(input),
        ),
    },
    deleteTodo: {
      execute: (id) =>
        runner.run((tx) =>
          new DeleteTodoCommand(repositoryFor(tx)).execute(id),
        ),
    },
  };
}

// InMemory のリポジトリで組み立てる。テスト専用（アプリは常に Postgres。下の todoContainer）。
// WHY 本番では使わないのに残す: presentation のテストなどで、DB に接続せずに handler の振る舞いを確かめるため
//   （rules/code/architecture.md の「テストの置き方」）。InMemoryTransactionRunner で rollback もそろえている。
// WHY リポジトリを引数で受け取れる: テストで空のリポジトリを渡し（省略時も空）、アプリ共有のコンテナとは別に組み立てるため。
//   共有のコンテナをテストで使うと、前のテストが作った Todo が残って結果が実行順に依存する。
export function createInMemoryTodoContainer(
  repository: InMemoryTodoRepository = new InMemoryTodoRepository(),
): TodoContainer {
  return createTodoContainer({
    runner: new InMemoryTransactionRunner(repository),
    repositoryFor: (executor) => executor,
    readExecutor: repository,
  });
}

// Postgres（Drizzle）で組み立てる。command は db.transaction の中の tx で、query は db で読み書きする。
export function createPostgresTodoContainer(db: Database): TodoContainer {
  return createTodoContainer<Executor>({
    runner: new DrizzleTransactionRunner(db),
    repositoryFor: (executor) => new PostgresTodoRepository(executor),
    readExecutor: db,
  });
}

// アプリ（Route Handler）が使う、プロセス内で共有するコンテナ。常に Postgres で組み立てる。
// WHY DATABASE_URL が無いときに InMemory へ切り替えない（Issue #59）: 以前は DB を起動していなくても pnpm dev で画面を
//   触れるよう InMemory に落としていたが、設定漏れ（.env の書き忘れ、CI での渡し忘れ）でも黙って InMemory で動き、
//   データが保存されないまま気づけなかった。環境変数はすべて必須にし（apps/backend/shared/infra/env.ts）、欠けていれば起動時に止める。
//   pnpm dev の前に pnpm db:up と pnpm db:migrate が要る（README.md の手順）。
// WHY 共有する: プールは getDatabase が globalThis に 1 つだけ持つので、/api/todos と /api/todos/[id] で同じプールを使う。
// WHY モジュールの変数で足りる（globalThis に置かない）: 2 つの route.ts がこのモジュールを別々に読み込んでも、
//   Next.js 16.3.6 の `next build` + `next start` と `next dev` の両方で、POST /api/todos で作った Todo を
//   GET /api/todos/[id] で取得できた（2026-09-28 に curl で確認。当時は InMemory で、インスタンスの共有を確かめた）。
//   Postgres ではデータが DB にあるので、コンテナが分かれても結果は変わらない。
// WHY 読み込んだ時点で組み立ててよい: プールを作るだけで、接続は最初のクエリまで張らない（node-postgres の Pool）。
//   `next build` がこのモジュールを読み込んでも DB には接続しない。環境変数の検証（env.ts）は読み込み時に行われるので、
//   必須の変数が欠けていれば `next build` はここで止まる。`next start` / `next dev` は、このモジュールを読む前に
//   apps/frontend/instrumentation.ts が起動時に env.ts を読み込んで止まる。
export const todoContainer: TodoContainer = createPostgresTodoContainer(
  getDatabase().db,
);
