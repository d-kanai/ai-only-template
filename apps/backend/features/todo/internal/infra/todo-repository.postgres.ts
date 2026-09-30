import { asc, eq, type SQL } from "drizzle-orm";
import type { Transaction } from "../../../../shared/domain/transaction";
import { changedProps } from "../../../../shared/infra/changed-props";
import type { Database } from "../../../../shared/infra/database";
import { writerOf } from "../../../../shared/infra/writer";
import { Todo, type TodoStatusChange } from "../domain/todo";
import { requireTodo, type TodoRepository } from "../domain/todo-repository";
import { todoStatusChanges, todos } from "./schema";

type TodoRow = typeof todos.$inferSelect;

// 読み取りに使う接続（query は db、command の findByIdOrThrow は Writer の select。同じ SELECT を組み立てる）。
type Reader = Pick<Database, "select">;

// 行 → Entity の変換。
// WHY Repository で zod の parse をしない: 行の型（uuid・text・boolean・timestamptz の NOT NULL）は Drizzle のスキーマ
//   （schema.ts）と DB の列の定義が保証し、TodoRow の型として届く。値の規則（タイトルの長さ・id の形など）は
//   Todo.reconstruct（完全コンストラクタ）が検証する（Issue #94）。
// WHY 不変条件を満たさない行を DomainError ではない Error にする（API は 500 internal_error。Issue #94 で決めた）:
//   DomainError(validation_error) のまま投げると presentation の toProblemResponse が 400 にし、「リクエストを直せば
//   通る」とクライアントに伝えてしまう。保存済みのデータの不整合（規則を変えたのに移行していない、手で入れた行）は
//   クライアントには直せないサーバ側の誤りで、直すのは運用（データの移行。スキル db-migration）。500 なら
//   toProblemResponse が logger.error で 1 行残すので、どの行が何に違反したかをログで追える。
// WHY message に id と違反の理由を入れる: logger は Error を { type, message } にし、cause は出さない。
//   クライアントへの本文は固定のキー（server.internalError と固定の英語の detail。toProblemResponse）なので、ここに書いた内容は外に出ない。
// WHY 行を読み飛ばさない（一覧から黙って外さない）: データが消えたように見え、不整合に気づけない。
// WHY cause に元の DomainError を持たせる: 例外を調べるとき（テスト・デバッガ）に元の例外をたどれるようにする。
// statusChanges: その Todo の完了の履歴（足した順）。履歴の行が無ければ空配列で、不変条件の違反（1 件以上）として扱う。
function toTodo(
  row: TodoRow,
  statusChanges: readonly TodoStatusChange[],
): Todo {
  try {
    return Todo.reconstruct({
      id: row.id,
      title: row.title,
      completed: row.completed,
      createdAt: row.createdAt,
      statusChanges,
    });
  } catch (error) {
    // reconstruct が投げるのは不変条件の違反（DomainError）だけ（todo.ts の validate）。その message はキーと params
    //   （例: todo.title.tooLong {"max":100}）で、どの規則に違反したかがログで分かる。
    // WHY 英語の文言: ログ（toProblemResponse の logger.error）に出る開発者向けの文字列で、クライアントには返さない。
    //   apps/backend の非テストコードには自然言語の日本語を置かない（Issue #116。画面の文言は画面の辞書だけが持つ）。
    throw new Error(
      `stored Todo (id: ${row.id}) violates the invariants: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

// todos と完了の履歴を LEFT JOIN した行（Todo 1 件につき履歴の件数の行。履歴の無い Todo は change が null の 1 行）を、
//   Todo ごとにまとめて Todo にする。返す順は、各 Todo が最初に現れた順（= SELECT の ORDER BY の順）。
// WHY Map でまとめる: 同じ Todo の行は ORDER BY（todos の列が先、position が後）で連続し、Map は最初に入れた順を保つので、
//   一覧の順（作成日時・id）と履歴の順（position）の両方を SELECT の並びのまま保てる。
// change が null（LEFT JOIN で履歴が 1 件も無い）なら履歴は空配列で、toTodo が不変条件の違反（1 件以上）の Error にする。
function toTodos(
  rows: readonly {
    todo: TodoRow;
    change: TodoStatusChange | null;
  }[],
): Todo[] {
  const grouped = new Map<
    string,
    { row: TodoRow; statusChanges: TodoStatusChange[] }
  >();
  for (const { todo, change } of rows) {
    const entry = grouped.get(todo.id) ?? { row: todo, statusChanges: [] };
    grouped.set(todo.id, entry);
    if (change !== null) {
      entry.statusChanges.push(change);
    }
  }
  return Array.from(grouped.values(), ({ row, statusChanges }) =>
    toTodo(row, statusChanges),
  );
}

// Todo（todos の行と完了の履歴）を読む SELECT（todos LEFT JOIN todo_status_changes）。where が無ければ全件。
// WHY 1 文で読む（todos と履歴を別の文にしない）: 既定の READ COMMITTED では、文ごとに別のスナップショットを見る。2 文に
//   分けると、その間に別の要求がコミットした DELETE（cascade で履歴も消える）や完了の変更が片方の文だけに見え、履歴の
//   無い Todo や、履歴の最後と todos.completed がずれた Todo として読んで不変条件の違反（500）になる（read skew）。
//   1 文なら 1 つのスナップショットなので、分離レベルに頼らずに済む（.claude/rules/backend.md の「永続化」）。
//   todo-repository.postgres.test.ts が Pool の query の回数（1 回）で固定する。
// WHY LEFT JOIN（INNER JOIN にしない）: 履歴の無い行（移行していない・手で入れた行）を一覧から黙って外さず、不変条件の
//   違反として見つける（toTodo）。
// WHY ORDER BY は作成日時・id・position の順: 作成日時が同じ行が複数あると作成日時だけでは Postgres が返す順が決まらない
//   （行の物理的な位置や実行計画で変わりうる）ので、一意な id を第 2 キーにして毎回同じ順にする（ListTodosQuery の並べ替えは
//   安定ソートなので、この順が一覧の順になる）。todos の列を先に並べると同じ Todo の行が連続する（toTodos がまとめる）。
//   position は履歴の中の添字で、日時は同じ値を許すので日時では足した順が決まらない（schema.ts の position）。
// WHY 履歴を Todo ごとの問い合わせにしない: 一覧で Todo の数だけクエリが増える（N+1）。
// WHY 関数にして query と command で共有する: 読み方（JOIN・並び順）を 1 か所にし、command の読み込み（行ロック）だけが .for を足す。
function selectTodos(reader: Reader, where?: SQL) {
  return reader
    .select({
      todo: todos,
      change: {
        completed: todoStatusChanges.completed,
        changedAt: todoStatusChanges.changedAt,
      },
    })
    .from(todos)
    .leftJoin(todoStatusChanges, eq(todoStatusChanges.todoId, todos.id))
    .where(where)
    .orderBy(
      asc(todos.createdAt),
      asc(todos.id),
      asc(todoStatusChanges.position),
    );
}

// 完了の履歴のうち from 番目（0 始まり）から後ろの行（todo_status_changes に入れる値）。position は Todo.statusChanges の添字。
// 行の id は Writer が作る（前のログと変更履歴に、INSERT の前に id が要る。shared/infra/writer.ts）。
function statusChangeRows(todo: Todo, from: number) {
  return todo.statusChanges
    .slice(from)
    .map(({ completed, changedAt }, index) => ({
      todoId: todo.id,
      position: from + index,
      completed,
      changedAt,
    }));
}

// TodoRepository の Postgres 実装（Drizzle）。行と Entity の変換だけを書く（Issue #215）。
// WHY db（Database）をコンストラクタで受け取る: query（findAll / findById）はトランザクションの外で db から読む。プールは
//   getDatabase が globalThis に 1 つだけ持ち、api ファイルが `new PostgresTodoRepository(getDatabase().db)` と組み立てる
//   （Issue #123）。テストはテスト用のスキーマの db を渡す。
// WHY トランザクションを張らない（Issue #188・#189 では save / delete が張っていた）: 範囲は command が runner の run で決め、
//   Repository は受け取った tx の中で読み書きする（ADR docs/adr/architecture/20260930-transaction-from-application.md）。
//   Todo（集約）は todos の行と完了の履歴の 2 つの表にまたがるが、command の 1 つのトランザクションの中なので片方だけは残らない。
// WHY 書き込みは Writer（writerOf(tx)）に渡すだけ: 変更履歴（change_logs）と書き込みのログは Writer が文ごとに横断的に書く
//   （shared/infra/writer.ts）。Repository は change-log を import せず、db.transaction・recordChange・db の insert / update / delete を
//   直接呼ばない（rule-tests/persistence.test.ts の no-change-log-in-repository・no-direct-transaction・no-direct-record-change・
//   no-direct-db-write・writes-through-writer）。
export class PostgresTodoRepository implements TodoRepository {
  constructor(private readonly db: Database) {}

  async findAll(): Promise<Todo[]> {
    return toTodos(await selectTodos(this.db));
  }

  async findById(id: string): Promise<Todo | undefined> {
    // WHY id の形（uuid）をここで検査しない: 利用者の入力は presentation の parseUuidParam（z.uuid() → 404）が唯一の
    //   検査で、ここに uuid の形でない id が来るのは呼び出し側の実装ミスだけ。「無い」（undefined）として黙って通すと
    //   誤りが隠れるので、Postgres の uuid 型のエラー（invalid input syntax）をそのまま投げ、API は 500 でログに残す。
    // 引数の id は大文字の uuid でもよい（Postgres の uuid 型は同じ値と見る）。履歴を Todo ごとにまとめるキーは、DB が返す
    //   正規の形（小文字）の todos.id（toTodos）なので、大文字で探しても 1 件にまとまる。
    const [todo] = toTodos(await selectTodos(this.db, eq(todos.id, id)));
    return todo;
  }

  // command 用: tx の中で、根の行（todos）を FOR UPDATE でロックしてから（1 文目）、findById と同じ SELECT で集約を読む（2 文目）。
  //   ロックは tx の終わりまで続き、同じ Todo を変える別の command の findByIdOrThrow と DELETE は、この tx が終わるまで待つ。
  // WHY ロックと読み込みを別の文にする（読み込みの SELECT に FOR UPDATE OF todos を付けない）: READ COMMITTED で 1 文の
  //   SELECT ... LEFT JOIN ... FOR UPDATE がロックを待つと、ロックが取れた後に todos の行だけを最新の版で読み直し（EvalPlanQual）、
  //   JOIN した履歴の行は文の始めのスナップショットのままになる（https://www.postgresql.org/docs/current/transaction-iso.html の
  //   Read Committed の節）。先の command が完了にした Todo を、completed = true と古い履歴（最後が未完了）の組で読み、不変条件の
  //   違反（500）になった（Issue #215 の実測。todo-repository.postgres.test.ts の「同時に動かすと」のテスト）。ロックを取った後の
  //   別の文なら、先の command の COMMIT の後の新しいスナップショットで、根と履歴をそろって読める。
  // WHY ロックの文は列を選ばない（全列）: 見るのは行のロックだけ。select({ id }) と列を選ぶと、Stryker の select({})（列の無い
  //   SELECT。Postgres は受け付け、ロックも同じ）が結果を変えない変異として残る（.claude/rules/testing.md の「等価な変異を生む書き方を
  //   しない」）。1 行だけなので全列を読んでも負担にならない。
  // WHY 行の有無はロックの文で見ない（2 文目の結果で not_found にする）: 分岐を 1 つにする。無い id でも 2 文目は空を返すだけ。
  // WHY FOR UPDATE（FOR SHARE / FOR KEY SHARE にしない）: 同じ Todo の 2 つの command が互いに待つ（直列化）。共有ロックだと 2 つとも
  //   読めてしまい、読んだ値を前提にした書き込み（完了の履歴の位置・通知の条件）がずれる。todo-repository.postgres.test.ts が、
  //   DELETE と別の findByIdOrThrow が待つことで固定する。
  // WHY 根の行だけをロックする（履歴の行はロックしない）: 同じ Todo を変える command は必ず根の行をロックして読むので、根の行だけで
  //   直列化できる。履歴を足す書き込みも command（findByIdOrThrow の後）だけ。
  async findByIdOrThrow(id: string, tx: Transaction): Promise<Todo> {
    const writer = writerOf(tx);
    await writer.select().from(todos).where(eq(todos.id, id)).for("update");
    const [todo] = toTodos(await selectTodos(writer, eq(todos.id, id)));
    return requireTodo(todo, id);
  }

  // 根（todos の全列）と完了の履歴の全件を INSERT する（2 文。どちらも Writer が変更履歴とログを書く）。
  // WHY 素の INSERT（ON CONFLICT DO UPDATE で上書きしない）: 同じ新規の Todo を 2 回 insert する呼び出しは無く（create の command は
  //   1 回だけ）、あれば実装ミス。upsert はそれを黙って通し、id が衝突した別の行も上書きする。INSERT なら Postgres の一意制約違反
  //   （SQLSTATE 23505）→ 500 で気づける。
  // WHY origin があれば Error: 読み込み済みの Todo を新規として全列を書くと、別の要求の変更を巻き戻す。呼び出し側の取り違え（update を
  //   呼ぶべき）で、英語の開発者向けのエラー（Issue #116）にする。
  async insert(todo: Todo, tx: Transaction): Promise<void> {
    if (todo.origin !== undefined) {
      throw new Error(
        `insert takes a new Todo (Todo.create), but got a loaded one: ${todo.id}`,
      );
    }
    const writer = writerOf(tx);
    await writer.insert(todos, [
      {
        id: todo.id,
        title: todo.title,
        completed: todo.completed,
        createdAt: todo.createdAt,
      },
    ]);
    await writer.insert(todoStatusChanges, statusChangeRows(todo, 0));
  }

  // 読み込んだときから変わった列だけを UPDATE し、読み込んだときより後ろに増えた完了の履歴だけを INSERT する（Issue #165・#188）。
  //   どちらも無ければ Writer は SQL を発行しない（変わった列が空・増えた履歴が空）。
  // WHY 変わった列だけ: 全列を書くと、ロックせずに読んだ Todo（query の値など）で書いたときに、別の列の変更を読み込んだときの値に
  //   巻き戻す（lost update）。command は findByIdOrThrow で行をロックしてから書くので同時には読まないが、書く列を最小にしておけば
  //   ロックを外したときにも lost update が戻らない。同じ列は後勝ち（楽観ロックの version 列は入れない。ユーザー判断）。
  // WHY 差分は origin と今の値の比較（changedProps）で取る: Entity の遷移メソッドは何も記録しない（todo.ts の origin）。
  // WHY 比べる列は title と completed だけ: Todo を変える操作（rename・changeCompletion）が変えるのはこの 2 つで、id と作成日時は
  //   作った後で変わらない。完了の履歴は todos の列ではないので、件数で見る（下）。
  // WHY 履歴の増分を件数で見る（changedProps で配列を比べない）: 履歴は末尾に足すだけ（Todo.changeCompletion）なので、読み込んだ
  //   ときの件数より後ろが増えた分。changedProps は配列を参照で比べるが、Todo のコンストラクタが検証するたびに zod が新しい配列を
  //   作る（zod 4.6.5 の parse は配列をコピーする）ので、rename だけでも「変わった」と判定されてしまう。
  // 同じ position の履歴が既にあれば (todo_id, position) の一意制約違反（23505）で失敗し、同じ tx の UPDATE も戻る（schema.ts）。
  // 行が無ければ（ロックせずに読んだ後に消された）、Writer の update が Error、履歴だけなら外部キー違反（23503）で失敗する。
  //   command は行をロックして読むので起きない（not_found にはしない。呼び出し側の誤り）。
  async update(todo: Todo, tx: Transaction): Promise<void> {
    const { origin } = todo;
    if (origin === undefined) {
      throw new Error(
        `update takes a loaded Todo (findByIdOrThrow), but got a new one: ${todo.id}`,
      );
    }
    const writer = writerOf(tx);
    await writer.update(
      todos,
      todo.id,
      changedProps(origin, { title: todo.title, completed: todo.completed }),
    );
    await writer.insert(
      todoStatusChanges,
      statusChangeRows(todo, origin.statusChanges.length),
    );
  }

  // 無い id なら何も消さない（Writer が前後のログだけを出し、記録は書かない）。完了の履歴（todo_status_changes）は外部キーの
  //   on delete cascade で消える（履歴の表に DELETE を書かない）。
  // WHY id の形を検査しない: findById と同じ。「無い」として黙って何もしないと、消したつもりで消えていない実装ミスが隠れる。
  async delete(id: string, tx: Transaction): Promise<void> {
    await writerOf(tx).delete(todos, id);
  }
}
