import type { Todo } from "../domain/todo";
import { RequiredTodo, type TodoRepository } from "../domain/todo-repository";

// id で Todo を 1 件返す（query: 読むだけで状態を変えない）。
export class GetTodoQuery {
  constructor(private readonly repository: TodoRepository) {}

  async execute(id: string): Promise<Todo> {
    // WHY 無ければ not_found（undefined を返さず例外にする）: 「無い」ことを API で 404 にするのはこのユースケースの仕様。
    //   呼び出し側（presentation）に undefined の判定を書かせず、DomainError の変換 1 か所で 404 にそろえる。
    //   not_found の DomainError の作り方は domain の RequiredTodo.of が 1 か所で持つ（findByIdForUpdate と同じ例外）。
    // WHY findByIdForUpdate ではなく findById（Issue #215）: findByIdForUpdate は command 用で、トランザクションの中で行をロックして読む。
    //   query はトランザクションを張らず、ロックも取らない（command がロックしている間も待たずに読める）。
    return RequiredTodo.of(await this.repository.findById(id), id);
  }
}
