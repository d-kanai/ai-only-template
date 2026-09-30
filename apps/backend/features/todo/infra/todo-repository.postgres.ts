import { asc, eq, type SQL } from "drizzle-orm";
import { changedProps } from "../../../shared/infra/changed-props";
import type { Database } from "../../../shared/infra/database";
import { Todo, type TodoStatusChange } from "../domain/todo";
import { requireTodo, type TodoRepository } from "../domain/todo-repository";
import { todoStatusChanges, todos } from "./schema";

type TodoRow = typeof todos.$inferSelect;

// save が書き込みに使う接続（db そのものか、db.transaction の tx）。select は読み込み済みの save が todos の行の有無を
//   確かめる（updateOrLock）のに使う。
type Writer = Pick<Database, "insert" | "update" | "select">;

// 行 → Entity の変換。
// WHY Repository で zod の parse をしない: 行の型（uuid・text・boolean・timestamptz の NOT NULL）は Drizzle のスキーマ
//   （schema.ts）と DB の列の定義が保証し、TodoRow の型として届く。値の規則（タイトルの長さ・id の形など）は
//   Todo.reconstruct（完全コンストラクタ）が検証する（Issue #94）。
// WHY 不変条件を満たさない行を DomainError ではない Error にする（API は 500 internal_error。Issue #94 で決めた）:
//   DomainError(validation_error) のまま投げると presentation の toProblemResponse が 400 にし、「リクエストを直せば
//   通る」とクライアントに伝えてしまう。保存済みのデータの不整合（規則を変えたのに移行していない、手で入れた行）は
//   クライアントには直せないサーバ側の誤りで、直すのは運用（データの移行。スキル db-migration）。500 なら
//   toProblemResponse が logger.error で 1 行残すので、どの行が何に違反したかをログで追える。
// WHY message に id と違反の理由を入れる: logger は Error を { name, message } にし、cause は出さない。
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

// TodoRepository の Postgres 実装（Drizzle）。
// WHY db（Database）をコンストラクタで受け取る: プールは getDatabase が globalThis に 1 つだけ持ち、api ファイルが
//   `new PostgresTodoRepository(getDatabase().db)` と組み立てる（Issue #123）。テストはテスト用のスキーマの db を渡す。
// WHY save はトランザクションを張る（Issue #188）: Todo（集約）は todos の行と完了の履歴（todo_status_changes の行）の 2 つの表に
//   またがり、1 つの Todo の保存が 2 文になる。片方だけ書かれると、履歴の最後の completed と todos.completed がずれた読めない
//   Todo が残る。集約を 1 単位で保存するのは Repository の責務なので、command ではなく save の中で張る。
//   findAll / findById / delete は 1 文の読み取り（下の select）・削除（cascade）なので張らない。command をまたぐトランザクションが
//   要るようになったら、その command にトランザクションを扱う依存を注入する（.claude/rules/backend.md の「永続化（Drizzle + Postgres）」。
//   ADR architecture/20260929-constructor-injection-without-container.md）。
export class PostgresTodoRepository implements TodoRepository {
  constructor(private readonly db: Database) {}

  // WHY 作成日時の昇順で返す: TodoRepository は順序を約束しない（並べ替えは ListTodosQuery が行う）が、
  //   DB は ORDER BY が無いと返す順が決まらない。毎回同じ順で返すため、並び順をここで決める（select の ORDER BY）。
  async findAll(): Promise<Todo[]> {
    return this.select();
  }

  async findById(id: string): Promise<Todo | undefined> {
    // WHY id の形（uuid）をここで検査しない: 利用者の入力は presentation の parseUuidParam（z.uuid() → 404）が唯一の
    //   検査で、ここに uuid の形でない id が来るのは呼び出し側の実装ミスだけ。「無い」（undefined）として黙って通すと
    //   誤りが隠れるので、Postgres の uuid 型のエラー（invalid input syntax）をそのまま投げ、API は 500 でログに残す。
    // 引数の id は大文字の uuid でもよい（Postgres の uuid 型は同じ値と見る）。履歴を Todo ごとにまとめるキーは、DB が返す
    //   正規の形（小文字）の todos.id（toTodos）なので、大文字で探しても 1 件にまとまる。
    const [todo] = await this.select(eq(todos.id, id));
    return todo;
  }

  // Todo（todos の行と完了の履歴）を 1 つの SELECT（todos LEFT JOIN todo_status_changes）で読む。where が無ければ全件。
  // WHY 1 文で読む（todos と履歴を別の文にしない）: 既定の READ COMMITTED では、文ごとに別のスナップショットを見る。2 文に
  //   分けると、その間に別の要求がコミットした DELETE（cascade で履歴も消える）や完了の変更が片方の文だけに見え、履歴の
  //   無い Todo や、履歴の最後と todos.completed がずれた Todo として読んで不変条件の違反（500）になる（read skew）。
  //   1 文なら 1 つのスナップショットなので、分離レベルやトランザクションに頼らずに済む（.claude/rules/backend.md の「永続化」）。
  //   todo-repository.postgres.test.ts が Pool の query の回数（1 回）で固定する。
  // WHY LEFT JOIN（INNER JOIN にしない）: 履歴の無い行（移行していない・手で入れた行）を一覧から黙って外さず、不変条件の
  //   違反として見つける（toTodo）。
  // WHY ORDER BY は作成日時・id・position の順: 作成日時が同じ行が複数あると作成日時だけでは Postgres が返す順が決まらない
  //   （行の物理的な位置や実行計画で変わりうる）ので、一意な id を第 2 キーにして毎回同じ順にする（ListTodosQuery の並べ替えは
  //   安定ソートなので、この順が一覧の順になる）。todos の列を先に並べると同じ Todo の行が連続する（toTodos がまとめる）。
  //   position は履歴の中の添字で、日時は同じ値を許すので日時では足した順が決まらない（schema.ts の position）。
  // WHY 履歴を Todo ごとの問い合わせにしない: 一覧で Todo の数だけクエリが増える（N+1）。
  private async select(where?: SQL): Promise<Todo[]> {
    const rows = await this.db
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
    return toTodos(rows);
  }

  // WHY findById を通す: 行の変換（toTodo）を 1 か所に保つ。本番の api のテストは prototype の findById を spy して
  //   Postgres の実装が呼ばれることを確かめているので、ここで findById を呼ぶ形はそのテストとも合う。
  async findByIdOrThrow(id: string): Promise<Todo> {
    return requireTodo(await this.findById(id), id);
  }

  // 新規（origin が undefined）は全列を INSERT（2 回目は一意制約違反）、読み込み済みは読み込んだときから変わった列だけを UPDATE する（Issue #165）。
  // WHY 読み込み済みは変わった列だけ: 全列を書くと、同じ Todo を同時に別の列で更新したとき（片方は完了、片方は名前の
  //   変更）に、後から save した方が先の変更を読み込んだときの値に巻き戻す（lost update）。変わった列だけなら両方残る。
  //   同じ列を同時に変えたときは後勝ち。ただし読み込んだときと同じ値に戻す変更は差分が無いので書かれず、他方の更新が
  //   残る（楽観ロックの version 列は入れない。ユーザー判断）。
  // WHY 差分は origin と今の値の比較（changedProps）で取る: Entity の遷移メソッドは何も記録しない（todo.ts の origin）。
  // 完了の履歴（Issue #188）は insert のみ: 新規は全件を、読み込み済みは読み込んだときより後ろに増えた分だけを INSERT する
  //   （既存の履歴の行は UPDATE / DELETE しない）。todos の行と同じトランザクションで書く（クラスのコメント）。
  async save(todo: Todo): Promise<void> {
    const { origin } = todo;
    if (origin === undefined) {
      // 原子性（履歴の INSERT が失敗したら todos の INSERT も戻る）は、テスト用のスキーマに一時的な CHECK 制約を張って
      //   履歴の INSERT を失敗させるテスト（todo-repository.postgres.test.ts）が固定する。
      await this.db.transaction(async (tx) => {
        await this.insert(tx, todo);
        await this.appendStatusChanges(tx, todo, 0);
      });
      return;
    }
    // WHY 比べる列は title と completed だけ: Todo を変える操作（rename・changeCompletion）が変えるのはこの 2 つで、
    //   id と作成日時は作った後で変わらない。完了の履歴は todos の列ではないので、ここでは比べない（下の件数で見る）。
    const changed = changedProps(origin, {
      title: todo.title,
      completed: todo.completed,
    });
    // WHY 履歴の増分を件数で見る（changedProps で配列を比べない）: 履歴は末尾に足すだけ（Todo.changeCompletion）なので、
    //   読み込んだときの件数より後ろが増えた分。changedProps は配列を参照で比べるが、Todo のコンストラクタが検証するたびに
    //   zod が新しい配列を作る（zod 4.6.5 の parse は配列をコピーする）ので、rename だけでも「変わった」と判定されてしまう。
    const appendedFrom = origin.statusChanges.length;
    // WHY 変わった列も増えた履歴も無ければ SQL を発行しない（トランザクションも張らない）: 空の SET は SQL にならず、
    //   書く必要も無い。そのため、読み込んだ後に消された Todo でも、変えずに save したときは何もせず気づかない（戻しもしない）。
    // 変わった列が無く履歴だけが増えた（完了にして未完了に戻した）ときも、updateOrLock が todos の行の有無を確かめる。
    if (
      Object.keys(changed).length === 0 &&
      todo.statusChanges.length === appendedFrom
    ) {
      return;
    }
    await this.db.transaction(async (tx) => {
      await this.updateOrLock(tx, todo, changed);
      await this.appendStatusChanges(tx, todo, appendedFrom);
    });
  }

  // 変わった列だけを UPDATE する。変わった列が無ければ（完了の履歴だけが増えた save）、UPDATE の代わりに todos の行を
  //   ロックして読み、行があることだけを確かめる。どちらも行が無ければ not_found。
  // WHY 変わった列が無くても行を確かめる: 読み込んだ後に消された Todo を完了にして未完了に戻すと、changed は空で履歴だけが
  //   2 件増える。確かめずに履歴を INSERT すると外部キー違反（SQLSTATE 23503）→ 500 になり、InMemory（not_found）ともずれる。
  // WHY for key share（外部キーの検査と同じ強さのロック）: 確かめてから履歴を INSERT するまでの間に、別の要求がその Todo を
  //   消せないようにする（DELETE はこのロックと衝突して、このトランザクションの終わりまで待つ）。UPDATE（名前の変更・完了）
  //   とは衝突しないので、別の列の同時更新を待たせない。ロックの効果は同時実行のテストが無く、テストで固定できていない。
  private async updateOrLock(
    writer: Writer,
    todo: Todo,
    changed: Partial<Pick<TodoRow, "title" | "completed">>,
  ): Promise<void> {
    // WHY select() は列を選ばない（全列）: 見るのは行の有無だけ。select({ id }) と列を選ぶと、Stryker の select({})（列の無い
    //   SELECT。Postgres は受け付け、行の数は同じ）が結果を変えない変異として残る（.claude/rules/testing.md の「等価な変異を
    //   生む書き方をしない」）。1 行だけなので全列を読んでも負担にならない。
    // WHY .returning で更新した行を受け取る: 0 行（読み込んだ後に消された）を not_found にするため。drizzle-orm 0.45.3 の
    //   node-postgres は、returning が無いと pg の QueryResult（rowCount は number | null）を、あると行の配列を返す
    //   （node-postgres/session.js の execute）。配列なら null の場合を考えずに済む。
    const [updated] =
      Object.keys(changed).length === 0
        ? await writer
            .select()
            .from(todos)
            .where(eq(todos.id, todo.id))
            .for("key share")
        : await writer
            .update(todos)
            .set(changed)
            .where(eq(todos.id, todo.id))
            .returning({ id: todos.id });
    // WHY 0 行なら not_found: 読み込んだ後に別のリクエストが消した Todo。以前の upsert は INSERT で消した Todo を
    //   戻していた（PUT と DELETE の競合）。API は 404 を返す。例外でトランザクションは戻り、履歴も足さない。
    // WHY requireTodo を通す（DomainError をここで作らない）: findByIdOrThrow と同じ例外（code・key・params）を
    //   1 か所（domain の requireTodo）で決める（.claude/rules/backend.md の「永続化」）。
    requireTodo(updated === undefined ? undefined : todo, todo.id);
  }

  // WHY 素の INSERT（ON CONFLICT DO UPDATE で上書きしない）: 同じ新規のインスタンス（origin が undefined のまま）を
  //   2 回 save する呼び出しは無く（create の command は 1 回だけ save する）、あれば実装ミス。upsert はそれを黙って通し、
  //   id が衝突した別の行も上書きする。INSERT なら Postgres の一意制約違反（SQLSTATE 23505）→ 500 で気づける。
  private async insert(writer: Writer, todo: Todo): Promise<void> {
    await writer.insert(todos).values({
      id: todo.id,
      title: todo.title,
      completed: todo.completed,
      createdAt: todo.createdAt,
    });
  }

  // 完了の履歴のうち from 番目（0 始まり）から後ろを INSERT する。position は Todo.statusChanges の添字。
  // WHY 同じ position の行があれば失敗させる（(todo_id, position) の一意制約違反。SQLSTATE 23505 → 500）: 同じ Todo を 2 か所で
  //   読み込んで両方が完了状態を変えると、どちらも同じ position に足そうとする。後の save を失敗させ、同じトランザクションの
  //   todos の UPDATE も戻す（schema.ts の一意制約のコメント）。
  // 増えた履歴が無ければ何もしない（drizzle-orm の insert は空の values を受け付けない）。
  private async appendStatusChanges(
    writer: Writer,
    todo: Todo,
    from: number,
  ): Promise<void> {
    const appended = todo.statusChanges.slice(from);
    if (appended.length === 0) {
      return;
    }
    await writer.insert(todoStatusChanges).values(
      appended.map(({ completed, changedAt }, index) => ({
        todoId: todo.id,
        position: from + index,
        completed,
        changedAt,
      })),
    );
  }

  async delete(id: string): Promise<void> {
    // WHY id の形を検査しない: findById と同じ。「無い」として黙って何もしないと、消したつもりで消えていない実装ミスが隠れる。
    // 完了の履歴（todo_status_changes）は外部キーの on delete cascade で消える（履歴の表に DELETE を書かない）。
    await this.db.delete(todos).where(eq(todos.id, id));
  }
}
