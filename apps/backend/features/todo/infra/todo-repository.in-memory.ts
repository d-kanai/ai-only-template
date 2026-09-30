import type { Todo } from "../domain/todo";
import { requireTodo, type TodoRepository } from "../domain/todo-repository";

// テスト専用（本番の永続化は Postgres。todo-repository.postgres.ts を api ファイルが組み立てる）。テストでは
// query / command のコンストラクタに渡し、DB に接続せずに application・presentation の振る舞いを確かめる。
// WHY 本番のコード（presentation）から参照させない: 環境変数などで InMemory に切り替えると、設定漏れでもデータが保存されない
//   まま動いてしまう。規則 presentation（rule-tests/architecture.test.ts）が、本番の api ファイルからの参照を止める。
// WHY Map を使う: id での取得・上書き・削除がそのまま書け、挿入順も保つ（作成日時が同じ Todo の並びが安定する）。
// WHY Todo をそのまま保持してよい: Todo は不変（apps/backend/features/todo/domain/todo.ts）なので、
//   呼び出し側が取り出した Todo を通して保持中のデータが書き換わることはない。
// WHY テストで直接 new できる形にする: テストごとに空のリポジトリを作り、テスト同士がデータを共有しないようにするため。
export class InMemoryTodoRepository implements TodoRepository {
  private readonly todos = new Map<string, Todo>();

  async findAll(): Promise<Todo[]> {
    // 新しい配列を返す: 呼び出し側が配列を並べ替え・削除しても保持中のデータに影響させないため。
    return Array.from(this.todos.values());
  }

  async findById(id: string): Promise<Todo | undefined> {
    return this.todos.get(id);
  }

  // WHY findById を通す（Map を直接読まない）: Postgres の実装と同じ形にし、テストが findById を spy したときにも
  //   findByIdOrThrow 経由の問い合わせが記録されるようにする（presentation のテストの「Repository が呼ばれない」）。
  async findByIdOrThrow(id: string): Promise<Todo> {
    return requireTodo(await this.findById(id), id);
  }

  async save(todo: Todo): Promise<void> {
    this.todos.set(todo.id, todo);
  }

  async delete(id: string): Promise<void> {
    this.todos.delete(id);
  }
}
