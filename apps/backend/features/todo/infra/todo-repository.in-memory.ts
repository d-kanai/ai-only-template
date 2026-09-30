import { randomUUID } from "node:crypto";
import { now } from "@repo/shared/now";
import {
  type ChangeEntry,
  type ChangeLog,
  deleteEntry,
  insertEntry,
  updateEntries,
} from "../../../shared/infra/change-log";
import { changedProps } from "../../../shared/infra/changed-props";
import { Todo, type TodoStatusChange } from "../domain/todo";
import { requireTodo, type TodoRepository } from "../domain/todo-repository";
import { todoStatusChanges, todos } from "./schema";

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
// 変更履歴（Issue #189）も Postgres と同じ契約: 書いた行ごとに同じ組み立て（shared/infra/change-log.ts の insertEntry など）で
//   記録を作り、change_logs の行と同じ形（id は randomUUID、occurredAt は now()）で changeLogs に積む。テストが読む。
// WHY 本体を書き換えた後に積む: 失敗した save（新規の 2 回目・履歴の競合・not_found）は本体を書き換える前に投げるので、
//   記録も残らない（Postgres はトランザクションで戻る）。
// WHY actorId をコンストラクタで受け取る（既定は null）: Postgres の実装と同じ（変更した利用者の id。ログインが無い今は null）。
export class InMemoryTodoRepository implements TodoRepository {
  private readonly todos = new Map<string, Todo>();
  private readonly logs: ChangeLog[] = [];

  constructor(private readonly actorId: string | null = null) {}

  // 積んだ変更履歴（古い順）。新しい配列を返す（呼び出し側が書き換えても積んだ記録に影響させない）。
  get changeLogs(): readonly ChangeLog[] {
    return [...this.logs];
  }

  async findAll(): Promise<Todo[]> {
    // 新しい配列を返す: 呼び出し側が配列を並べ替え・削除しても保持中のデータに影響させないため。
    // 並び順は Repository の契約（todo-repository.ts）: 作成日時の昇順、同じなら id の昇順。Postgres の
    //   ORDER BY created_at, id と同じ規則で並べる（Map の挿入順には頼らない）。
    return Array.from(this.todos.values(), load).sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        // id は Map のキーなので同じ値は無く、等しい場合は起きない。
        // Stryker disable next-line EqualityOperator: id は一意なので、< を <= にしても同じ順になる（等価な変異）。
        (a.id < b.id ? -1 : 1),
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
  //   （title・completed）だけを保持中の値に反映する。変わった項目も増えた履歴も無ければ何もしない。保持していなければ not_found
  //   （変わった項目が無く履歴だけが増えたときも。Postgres は todos の行をロックして読み、無ければ not_found にする）。
  // WHY 変わった項目も増えた履歴も無いときは保持中かを確かめない: Postgres は SQL を発行しないので、消されたことに気づかない。
  //   ここで先に not_found にすると、テスト（InMemory）と本番（Postgres）で結果が変わる。
  // 完了の履歴（Issue #188）も Postgres と同じく、読み込んだときの件数より後ろに増えた分だけを保持中の履歴に足す
  //   （読み込んだ Todo の履歴で置き換えない。別の save が足した履歴を消さない）。
  // WHY 保持中の履歴が読み込んだときより増えていたら、増分を足さずに Error を投げる: Postgres の (todo_id, position) の
  //   一意制約違反（同じ位置に 2 つの save が足そうとした）と同じ契約。名前の変更など同じ save の他の変更も反映しない
  //   （Postgres ではトランザクションで戻る）。
  // WHY Todo.reconstruct で置く: 保持中の値と差分を合わせた値で作り直す（origin はその値になるが、取り出すときに
  //   load で作り直すので使われない）。
  async save(todo: Todo): Promise<void> {
    if (todo.origin === undefined) {
      // WHY 同じ id があればエラー: Postgres の INSERT の一意制約違反と同じ契約（新規を 2 回 save するのは実装ミス）。
      if (this.todos.has(todo.id)) {
        throw new Error(`todo already exists: ${todo.id}`);
      }
      this.todos.set(todo.id, todo);
      this.record([
        insertEntry(todos, todoRow(todo), this.actorId),
        ...this.statusChangeEntries(todo.id, todo.statusChanges, 0),
      ]);
      return;
    }
    const changed = changedProps(todo.origin, {
      title: todo.title,
      completed: todo.completed,
    });
    const appended = todo.statusChanges.slice(todo.origin.statusChanges.length);
    if (Object.keys(changed).length === 0 && appended.length === 0) {
      return;
    }
    const stored = requireTodo(this.todos.get(todo.id), todo.id);
    if (
      appended.length > 0 &&
      stored.statusChanges.length !== todo.origin.statusChanges.length
    ) {
      throw new Error(
        `todo status changes were appended by another save: ${todo.id}`,
      );
    }
    this.todos.set(
      todo.id,
      Todo.reconstruct({
        ...values(stored),
        ...changed,
        statusChanges: [...stored.statusChanges, ...appended],
      }),
    );
    this.record([
      ...updateEntries(todos, todo.id, todo.origin, changed, this.actorId),
      ...this.statusChangeEntries(
        todo.id,
        appended,
        todo.origin.statusChanges.length,
      ),
    ]);
  }

  // 無い id なら何もせず、何も記録しない（Postgres は消した行が 0 件）。完了の履歴の行は記録しない（Postgres の cascade と同じ）。
  async delete(id: string): Promise<void> {
    const stored = this.todos.get(id);
    if (stored === undefined) {
      return;
    }
    this.todos.delete(id);
    this.record([deleteEntry(todos, todoRow(stored), this.actorId)]);
  }

  // 完了の履歴のうち from 番目（position）から後ろの insert の記録。行の id は Postgres では DB が作るので、ここで作る。
  private statusChangeEntries(
    todoId: string,
    appended: readonly TodoStatusChange[],
    from: number,
  ): ChangeEntry[] {
    return appended.map(({ completed, changedAt }, index) =>
      insertEntry(
        todoStatusChanges,
        {
          id: randomUUID(),
          todoId,
          position: from + index,
          completed,
          changedAt,
        } satisfies typeof todoStatusChanges.$inferSelect,
        this.actorId,
      ),
    );
  }

  // 記録を change_logs の行と同じ形にして積む（同じ呼び出しの記録は同じ時刻。Postgres の recordChange と同じ）。
  private record(entries: readonly ChangeEntry[]): void {
    const occurredAt = now();
    this.logs.push(
      ...entries.map((entry) => ({ id: randomUUID(), ...entry, occurredAt })),
    );
  }
}

// todos の行と同じ項目（変更履歴の insert / delete の記録に使う）。
function todoRow(todo: Todo): typeof todos.$inferSelect {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt,
  };
}

// 保持中の Todo から「読み込んだ Todo」（今の値を origin に持つ）を作る。
function load(stored: Todo): Todo {
  return Todo.reconstruct(values(stored));
}

// Todo.reconstruct に渡す値（Postgres の行と同じ項目）。
function values(todo: Todo) {
  return {
    id: todo.id,
    title: todo.title,
    completed: todo.completed,
    createdAt: todo.createdAt,
    statusChanges: todo.statusChanges,
  };
}
