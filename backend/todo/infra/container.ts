import { CreateTodoCommand } from "@/backend/todo/application/create-todo.command";
import { DeleteTodoCommand } from "@/backend/todo/application/delete-todo.command";
import { GetTodoQuery } from "@/backend/todo/application/get-todo.query";
import { ListTodosQuery } from "@/backend/todo/application/list-todos.query";
import { UpdateTodoCommand } from "@/backend/todo/application/update-todo.command";
import type { TodoRepository } from "@/backend/todo/domain/todo-repository";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";

// Todo の query / command をリポジトリの実装と組み立てる（DI）。presentation 層はここからだけ受け取る。
// WHY 組み立てをここ 1 か所に集める: presentation 層が Repository の実装を直接 new しないようにし、
//   InMemory → DB の差し替えをこのファイルの変更だけで済ませるため。
export type TodoContainer = {
  listTodos: ListTodosQuery;
  getTodo: GetTodoQuery;
  createTodo: CreateTodoCommand;
  updateTodo: UpdateTodoCommand;
  deleteTodo: DeleteTodoCommand;
};

// WHY リポジトリを引数で受け取る関数にする: テストで空の InMemory リポジトリを渡して、アプリ共有のコンテナとは
//   別に組み立てるため。共有のコンテナをテストで使うと、前のテストが作った Todo が残って結果が実行順に依存する。
export function createTodoContainer(repository: TodoRepository): TodoContainer {
  return {
    listTodos: new ListTodosQuery(repository),
    getTodo: new GetTodoQuery(repository),
    createTodo: new CreateTodoCommand(repository),
    updateTodo: new UpdateTodoCommand(repository),
    deleteTodo: new DeleteTodoCommand(repository),
  };
}

// アプリ（Route Handler）が使う、プロセス内で共有するコンテナ。
// WHY 共有する: InMemory リポジトリはインスタンスごとにデータを持つ。/api/todos と /api/todos/[id] で
//   別のインスタンスを使うと、作った Todo が 1 件取得で見つからなくなる。
// WHY モジュールの変数で足りる（globalThis に置かない）: 2 つの route.ts がこのモジュールを別々に読み込むと
//   インスタンスが分かれるおそれがあったが、Next.js 16.3.6 の `next build` + `next start` と `next dev` の両方で、
//   POST /api/todos で作った Todo を GET /api/todos/[id] で取得できた（2026-09-28 に curl で確認）。
//   `next dev` でファイルを編集して再読み込みされたときにデータが消えるかは未確認（InMemory なので消えても実害は小さい）。
export const todoContainer: TodoContainer = createTodoContainer(
  new InMemoryTodoRepository(),
);
