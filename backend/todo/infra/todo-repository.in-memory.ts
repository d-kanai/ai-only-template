import type { Todo } from "@/backend/todo/domain/todo";
import type { TodoRepository } from "@/backend/todo/domain/todo-repository";

// TodoRepository の InMemory 実装。DB が決まるまでの仮の永続化で、プロセスが終わるとデータは消える。
// WHY Map を使う: id での取得・上書き・削除がそのまま書け、挿入順も保つ（作成日時が同じ Todo の並びが安定する）。
// WHY Todo をそのまま保持してよい: Todo は不変（backend/todo/domain/todo.ts）なので、
//   呼び出し側が取り出した Todo を通して保持中のデータが書き換わることはない。
// WHY テストで直接 new できる形にする: テストごとに空のリポジトリを作り、テスト同士がデータを共有しないようにするため。
//   アプリ全体で共有する 1 インスタンスは infra/container.ts が持つ。
export class InMemoryTodoRepository implements TodoRepository {
  private readonly todos = new Map<string, Todo>();

  async findAll(): Promise<Todo[]> {
    // 新しい配列を返す: 呼び出し側が配列を並べ替え・削除しても保持中のデータに影響させないため。
    return Array.from(this.todos.values());
  }

  async findById(id: string): Promise<Todo | undefined> {
    return this.todos.get(id);
  }

  async save(todo: Todo): Promise<void> {
    this.todos.set(todo.id, todo);
  }

  async delete(id: string): Promise<void> {
    this.todos.delete(id);
  }
}
