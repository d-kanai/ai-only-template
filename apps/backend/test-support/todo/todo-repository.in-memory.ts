import { Todo } from "../../features/todo/internal/domain/todo";
import {
  RequiredTodo,
  type TodoRepository,
} from "../../features/todo/internal/domain/todo-repository";
import type { Transaction } from "../../shared/application/transaction";
import { ChangedProps } from "../../shared/infra/changed-props";

// TodoRepository の InMemory 実装。プロセスが終わるとデータは消える。
// テスト専用（本番の永続化は Postgres。features/todo/internal/infra/todo-repository.postgres.ts を api ファイルが組み立てる）。テストでは
// query / command のコンストラクタに渡し、DB に接続せずに application・presentation の振る舞いを確かめる（Issue #123）。
// WHY 本番のコード（presentation）から参照させない: 環境変数などで InMemory に切り替えると、設定漏れでもデータが保存されない
//   まま動いてしまう（Issue #59）。test-support に置くので本番のコードから参照できない（rule-tests/test-support.test.ts の
//   production-imports-test-support）。イメージにも入らない（.dockerignore の **/test-support）。
// WHY test-support/<feature>/ に置く（Issue #191）: テストだけが使うコードで、features/todo/internal/infra/ に置くと本番のコードと
//   見分けが付かない。*.in-memory.ts は test-support の下だけに置く（rule-tests/test-support.test.ts の in-memory-placement）。
// WHY Map を使う: id での取得・上書き・削除がそのまま書け、挿入順も保つ（作成日時が同じ Todo の並びが安定する）。
// WHY Todo をそのまま保持してよい: Todo は不変（apps/backend/features/todo/internal/domain/todo.ts）なので、
//   呼び出し側が取り出した Todo を通して保持中のデータが書き換わることはない。
// WHY 取り出すときは保持中の値から Todo.reconstruct で作り直す（保持中のインスタンスを返さない。Issue #165）:
//   Postgres の実装と同じく「読み込んだ Todo」（origin を持つ）を返すため。保持中の Todo が create したもの（origin が
//   undefined）のまま返ると、update が差分を取れず（Error になる）、Postgres と結果が変わる。
// WHY テストで直接 new できる形にする: テストごとに空のリポジトリを作り、テスト同士がデータを共有しないようにするため。
// WHY tx を受け取るが使わない: interface（Postgres と同じ形）に合わせる。InMemory の runner（test-support/transaction-runner.in-memory.ts）は
//   rollback を再現しない。
// WHY 変更履歴（change_logs）を積まない（Issue #215。以前は Postgres と同じ記録を積んでいた。Issue #189）: 変更履歴とログは永続化の
//   関心で、Postgres では Writer（shared/infra/writer.ts）が文ごとに書く。Repository の実装ごとに組み立てることをやめたので、
//   InMemory には記録が無い。変更履歴の契約は Postgres のテスト（todo-repository.postgres.test.ts・writer.test.ts）が固定する。
// WHY 失敗は書き換える前に投げる: 失敗した insert / update（新規の 2 回目・履歴の競合・行が無い）で保持中の値を変えない
//   （Postgres はトランザクションで戻る）。
export class InMemoryTodoRepository implements TodoRepository {
  private readonly todos = new Map<string, Todo>();

  async findAll(): Promise<Todo[]> {
    // 新しい配列を返す: 呼び出し側が配列を並べ替え・削除しても保持中のデータに影響させないため。
    // 並び順は Repository の契約（todo-repository.ts）: 作成日時の昇順、同じなら id の昇順。Postgres の
    //   ORDER BY created_at, id と同じ規則で並べる（Map の挿入順には頼らない）。
    return Array.from(this.todos.values(), (stored) => this.load(stored)).sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        // id は Map のキーなので同じ値は無く、等しい場合は起きない。
        // Stryker disable next-line EqualityOperator: id は一意なので、< を <= にしても同じ順になる（等価な変異）。
        (a.id < b.id ? -1 : 1),
    );
  }

  async findById(id: string): Promise<Todo | undefined> {
    const stored = this.todos.get(id);
    return stored === undefined ? undefined : this.load(stored);
  }

  // WHY findById を通す（Map を直接読まない）: テストが findById を spy したときにも findByIdForUpdate 経由の問い合わせが記録される
  //   ようにする（presentation のテストの「Repository が呼ばれない」）。行ロックは無い（InMemory の呼び出しは直列に動く）。
  async findByIdForUpdate(id: string, _tx: Transaction): Promise<Todo> {
    return RequiredTodo.of(await this.findById(id), id);
  }

  // Postgres の実装（todo-repository.postgres.ts の insert）と同じ意味: 新規（origin が undefined）だけを受け付け、同じ id があれば
  //   エラー（Postgres の一意制約違反と同じ。新規を 2 回書くのは実装ミス）。
  async insert(todo: Todo, _tx: Transaction): Promise<void> {
    if (todo.origin !== undefined) {
      throw new Error(
        `insert takes a new Todo (Todo.create), but got a loaded one: ${todo.id}`,
      );
    }
    if (this.todos.has(todo.id)) {
      throw new Error(`todo already exists: ${todo.id}`);
    }
    this.todos.set(todo.id, todo);
  }

  // Postgres の実装（update）と同じ意味にする（Issue #165・#188・#215）: 読み込んだときから変わった項目（title・completed）だけを
  //   保持中の値に反映し、完了の履歴は読み込んだときの件数より後ろに増えた分だけを足す（読み込んだ Todo の履歴で置き換えない。
  //   別の update が足した履歴を消さない）。変わった項目も増えた履歴も無ければ何もしない。
  // WHY 変わった項目も増えた履歴も無いときは保持中かを確かめない: Postgres は SQL を発行しないので、消されたことに気づかない。
  //   ここで先にエラーにすると、テスト（InMemory）と本番（Postgres）で結果が変わる。
  // WHY 保持していなければ Postgres の Writer と同じ message の Error: Postgres は UPDATE の前に行を読み、無ければ
  //   「todos has no row to update」（履歴だけが増えたときは外部キー違反）。どちらも呼び出し側の誤り（500）。
  // WHY 保持中の履歴が読み込んだときより増えていたら、増分を足さずに Error を投げる: Postgres の (todo_id, position) の
  //   一意制約違反（同じ位置に 2 つの update が足そうとした）と同じ契約。名前の変更など同じ update の他の変更も反映しない
  //   （Postgres ではトランザクションで戻る）。
  // WHY Todo.reconstruct で置く: 保持中の値と差分を合わせた値で作り直す（origin はその値になるが、取り出すときに
  //   load で作り直すので使われない）。
  async update(todo: Todo, _tx: Transaction): Promise<void> {
    const { origin } = todo;
    if (origin === undefined) {
      throw new Error(
        `update takes a loaded Todo (findByIdForUpdate), but got a new one: ${todo.id}`,
      );
    }
    const changed = ChangedProps.of(origin, {
      title: todo.title,
      completed: todo.completed,
    });
    const appended = todo.statusChanges.slice(origin.statusChanges.length);
    if (Object.keys(changed).length === 0 && appended.length === 0) {
      return;
    }
    const stored = this.todos.get(todo.id);
    if (stored === undefined) {
      throw new Error(`todos has no row to update: ${todo.id}`);
    }
    if (
      appended.length > 0 &&
      stored.statusChanges.length !== origin.statusChanges.length
    ) {
      throw new Error(
        `todo status changes were appended by another update: ${todo.id}`,
      );
    }
    this.todos.set(
      todo.id,
      Todo.reconstruct({
        ...this.values(stored),
        ...changed,
        statusChanges: [...stored.statusChanges, ...appended],
      }),
    );
  }

  // 無い id なら何もしない（Postgres は消した行が 0 件）。
  async delete(id: string, _tx: Transaction): Promise<void> {
    this.todos.delete(id);
  }
  // 保持中の Todo から「読み込んだ Todo」（今の値を origin に持つ）を作る。
  // WHY private メソッド（Issue #262。以前はファイルの最上位の関数）: テストの補助も最上位に関数を置かない（ADR
  //   docs/adr/architecture/20261002-class-based-shared-and-test-support.md）。状態は使わないが static にしない: インスタンスで使うクラスに static を置かない（規則 no-static-in-instance-class。Issue #300）。
  private load(stored: Todo): Todo {
    return Todo.reconstruct(this.values(stored));
  }

  // Todo.reconstruct に渡す値（Postgres の行と同じ項目）。
  private values(todo: Todo) {
    return {
      id: todo.id,
      title: todo.title,
      completed: todo.completed,
      createdAt: todo.createdAt,
      statusChanges: todo.statusChanges,
    };
  }
}
