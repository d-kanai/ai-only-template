import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// TodoRepository の InMemory 実装。プロセスが終わるとデータは消える。
// DATABASE_URL が無いとき（DB を起動せずに画面を触るとき）と、単体テストで使う（本番の永続化は Postgres。
// todo-repository.postgres.ts と container.ts）。
// WHY Map を使う: id での取得・上書き・削除がそのまま書け、挿入順も保つ（作成日時が同じ Todo の並びが安定する）。
// WHY Todo をそのまま保持してよい: Todo は不変（apps/backend/features/todo/domain/todo.ts）なので、
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

  // 今の中身の写しを返す。InMemoryTransactionRunner が、command の失敗時に元へ戻すために使う（rollback の代わり）。
  // WHY Map を複製する: 同じ Map を返すと、その後の save / delete で写しまで変わり、戻せなくなる。
  //   Todo は不変なので、Map（id → Todo の対応）だけを複製すれば足りる。
  snapshot(): ReadonlyMap<string, Todo> {
    return new Map(this.todos);
  }

  // snapshot の時点の中身に戻す。
  // WHY 写しの Map を自分の中身として使わず、中身を移し替える: 写しをそのまま使うと、戻した後の save で写しが
  //   書き換わり、同じ写しで 2 回目に戻したときに元の時点に戻らない。
  restore(snapshot: ReadonlyMap<string, Todo>): void {
    this.todos.clear();
    for (const [id, todo] of snapshot) {
      this.todos.set(id, todo);
    }
  }
}
