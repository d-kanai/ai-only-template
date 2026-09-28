import { DomainError } from "@/backend/shared/domain/domain-error";
import type { Todo } from "@/backend/todo/domain/todo";
import type { TodoRepository } from "@/backend/todo/domain/todo-repository";

// id で Todo を 1 件返す（query: 読むだけで状態を変えない）。
export class GetTodoQuery {
  constructor(private readonly repository: TodoRepository) {}

  async execute(id: string): Promise<Todo> {
    const todo = await this.repository.findById(id);
    // WHY undefined を返さず例外にする: 「無い」ことを API で 404 にするのはこのユースケースの仕様。
    //   呼び出し側（presentation）に undefined の判定を書かせず、DomainError の変換 1 か所で 404 にそろえる。
    if (todo === undefined) {
      throw new DomainError("not_found", `Todo（id: ${id}）が見つかりません`);
    }
    return todo;
  }
}
