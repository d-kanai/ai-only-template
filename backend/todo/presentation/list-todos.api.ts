import { toErrorResponse } from "@/backend/shared/presentation/http-error";
import type { Todo } from "@/backend/todo/domain/todo";
import {
  type TodoContainer,
  todoContainer,
} from "@/backend/todo/infra/container";

// GET /api/todos: Todo の一覧を作成日時の昇順で返す。

// WHY DTO をこのファイルで定義する: 1 API = 1 ファイルで、その API の契約（リクエスト / レスポンスの形）を
//   同じファイルで読めるようにするため。画面側は `import type` でこの型を参照し、形のずれを型チェックで検出する。
//   TodoDto は他の *.api.ts にも同じ形で書いている（共通の dto.ts を作らないのはユーザー判断）。
export type TodoDto = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。JSON にそのまま載せられるよう Date ではなく string にしている。
  createdAt: string;
};

export type ListTodosResponse = {
  todos: TodoDto[];
};

function toTodoDto(todo: Todo): TodoDto {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// WHY コンテナを受け取って Route Handler を返す関数にする: テストでは空のリポジトリで組み立てたコンテナを渡し、
//   本番（下の GET）ではプロセス共有のコンテナを渡す。handler の中身は同じものをテストする。
// WHY Pick で必要な query だけを受け取る: この API が何に依存しているかを型で読めるようにするため。
export function listTodosApi(container: Pick<TodoContainer, "listTodos">) {
  return async (_request: Request): Promise<Response> => {
    try {
      const todos = await container.listTodos.execute();
      const body: ListTodosResponse = { todos: todos.map(toTodoDto) };
      return Response.json(body);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

// app/api/todos/route.ts が re-export する Route Handler。
export const GET = listTodosApi(todoContainer);
