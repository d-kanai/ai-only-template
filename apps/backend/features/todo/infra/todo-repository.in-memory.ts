import { changedProps } from "../../../shared/infra/changed-props";
import { Todo } from "../domain/todo";
import { requireTodo, type TodoRepository } from "../domain/todo-repository";

// TodoRepository の InMemory 実装。プロセスが終わるとデータは消える。
// テスト専用（本番の永続化は Postgres。todo-repository.postgres.ts を api ファイルが組み立てる）。テストでは
// query / command のコンストラクタに渡し、DB に接続せずに application・presentation の振る舞いを確かめる（Issue #123）。
// WHY 本番のコード（presentation）から参照させない: 環境変数などで InMemory に切り替えると、設定漏れでもデータが保存されない
//   まま動いてしまう（Issue #59）。規則 presentation（rule-tests/architecture.test.ts）が、本番の api ファイルからの参照を止める。
// WHY Map を使う: id での取得・上書き・削除がそのまま書け、挿入順も保つ（作成日時が同じ Todo の並びが安定する）。
// WHY Todo をそのまま保持してよい: Todo は不変（apps/backend/features/todo/domain/todo.ts）なので、
//   呼び出し側が取り出した Todo を通して保持中のデータが書き換わることはない。
// WHY 取り出すときは保持中の値から Todo.reconstruct で作り直す（保持中のインスタンスを返さない。Issue #165）:
//   Postgres の実装と同じく「読み込んだ Todo」（origin を持つ）を返すため。保持中の Todo が create したもの（origin が
//   undefined）のまま返ると、save が新規として全体を上書きし、Postgres と結果が変わる（別の列の同時更新を巻き戻す）。
// WHY テストで直接 new できる形にする: テストごとに空のリポジトリを作り、テスト同士がデータを共有しないようにするため。
export class InMemoryTodoRepository implements TodoRepository {
  private readonly todos = new Map<string, Todo>();

  async findAll(): Promise<Todo[]> {
    // 新しい配列を返す: 呼び出し側が配列を並べ替え・削除しても保持中のデータに影響させないため。
    // 並び順は Repository の契約（todo-repository.ts）: 作成日時の昇順、同じなら id の昇順。Postgres の
    //   ORDER BY created_at, id と同じ規則で並べる（Map の挿入順には頼らない）。
    return Array.from(this.todos.values(), load).sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  async findById(id: string): Promise<Todo | undefined> {
    const stored = this.todos.get(id);
    return stored === undefined ? undefined : load(stored);
  }

  // WHY findById を通す（Map を直接読まない）: Postgres の実装と同じ形にし、テストが findById を spy したときにも
  //   findByIdOrThrow 経由の問い合わせが記録されるようにする（presentation のテストの「Repository が呼ばれない」）。
  async findByIdOrThrow(id: string): Promise<Todo> {
    return requireTodo(await this.findById(id), id);
  }

  // Postgres の実装（todo-repository.postgres.ts の save）と同じ意味にする（Issue #165）:
  //   新規（origin が undefined）は置く（同じ id があればエラー。Postgres の一意制約違反と同じ）。読み込み済みは、読み込んだときから変わった項目
  //   （title・completed）だけを保持中の値に反映する。変わった項目が無ければ何もしない。保持していなければ not_found。
  // WHY 変わった項目が無いときは保持中かを確かめない: Postgres は SQL を発行しないので、消されたことに気づかない。
  //   ここで先に not_found にすると、テスト（InMemory）と本番（Postgres）で結果が変わる。
  // WHY Todo.reconstruct で置く: 保持中の値と差分を合わせた値で作り直す（origin はその値になるが、取り出すときに
  //   load で作り直すので使われない）。
  async save(todo: Todo): Promise<void> {
    if (todo.origin === undefined) {
      // WHY 同じ id があればエラー: Postgres の INSERT の一意制約違反と同じ契約（新規を 2 回 save するのは実装ミス）。
      if (this.todos.has(todo.id)) {
        throw new Error(`todo already exists: ${todo.id}`);
      }
      this.todos.set(todo.id, todo);
      return;
    }
    const changed = changedProps(todo.origin, {
      title: todo.title,
      completed: todo.completed,
    });
    if (Object.keys(changed).length === 0) {
      return;
    }
    const stored = requireTodo(this.todos.get(todo.id), todo.id);
    this.todos.set(
      todo.id,
      Todo.reconstruct({
        id: stored.id,
        title: stored.title,
        completed: stored.completed,
        createdAt: stored.createdAt,
        ...changed,
      }),
    );
  }

  async delete(id: string): Promise<void> {
    this.todos.delete(id);
  }
}

// 保持中の Todo から「読み込んだ Todo」（今の値を origin に持つ）を作る。
function load(stored: Todo): Todo {
  return Todo.reconstruct({
    id: stored.id,
    title: stored.title,
    completed: stored.completed,
    createdAt: stored.createdAt,
  });
}
