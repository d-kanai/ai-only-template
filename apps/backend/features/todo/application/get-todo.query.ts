import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

export class GetTodoQuery {
  constructor(private readonly repository: TodoRepository) {}

  async execute(id: string): Promise<Todo> {
    // WHY findByIdOrThrow（undefined を返さず例外にする）: 「無い」ことを API で 404 にするのはこのユースケースの仕様。
    //   呼び出し側（presentation）に undefined の判定を書かせず、DomainError の変換 1 か所で 404 にそろえる。
    //   not_found の DomainError の作り方は TodoRepository（requireTodo）が 1 か所で持つ。
    return this.repository.findByIdOrThrow(id);
  }
}
