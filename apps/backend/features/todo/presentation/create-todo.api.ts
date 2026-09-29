import { z } from "zod";
import { toErrorResponse } from "../../../shared/presentation/http-error";
import {
  parseJsonBody,
  requestBodySchema,
} from "../../../shared/presentation/json-body";
import type { Todo } from "../domain/todo";
import { type TodoContainer, todoContainer } from "../infra/container";

// POST /api/todos: Todo を作る。201 と作った Todo を返す。

// リクエスト本文の「形」（項目の有無と型。未知の項目は拒否）。
// WHY 形だけを見て、空・長さは見ない: タイトルの中身の規則（trim 後 1〜100 文字）は Todo の不変条件として
//   domain（Todo.create の zod スキーマ）が持つ。ここにも書くと規則が 2 か所になり、片方だけ直してずれる。
//   domain の DomainError(validation_error) も toErrorResponse で同じ 400 になるので、クライアントから見た結果は同じ。
// WHY 関数にする: スキーマを最上位の定数にすると static な変異になり mutation testing で数えない（json-body.ts の requestBodySchema）。
function createTodoRequestSchema() {
  return requestBodySchema({
    title: z.string({ error: "title は文字列で指定してください" }),
  });
}

// WHY 型をスキーマから導出する: 検査する形と型を 1 か所で宣言し、ずれを無くす（画面側も import type でこの型を使う）。
export type CreateTodoRequest = z.infer<
  ReturnType<typeof createTodoRequestSchema>
>;

// 同じ形の TodoDto を各 *.api.ts に書いている（WHY は list-todos.api.ts の TodoDto のコメント）。
export type TodoDto = {
  id: string;
  title: string;
  completed: boolean;
  // ISO 8601 文字列。
  createdAt: string;
};

export type CreateTodoResponse = TodoDto;

function toTodoDto(todo: Todo): TodoDto {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt.toISOString(),
  };
}

// コンテナを受け取って Route Handler を返す（WHY は list-todos.api.ts の listTodosApi のコメント）。
export function createTodoApi(container: Pick<TodoContainer, "createTodo">) {
  return async (request: Request): Promise<Response> => {
    try {
      const input = await parseJsonBody(request, createTodoRequestSchema());
      const todo = await container.createTodo.execute(input);
      const body: CreateTodoResponse = toTodoDto(todo);
      return Response.json(body, { status: 201 });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

// app/api/todos/route.ts が re-export する Route Handler。
export const POST = createTodoApi(todoContainer);
