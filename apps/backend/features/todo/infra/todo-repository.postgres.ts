import { asc, eq } from "drizzle-orm";
import { changedProps } from "../../../shared/infra/changed-props";
import type { Database } from "../../../shared/infra/database";
import { Todo } from "../domain/todo";
import { requireTodo, type TodoRepository } from "../domain/todo-repository";
import { todos } from "./schema";

type TodoRow = typeof todos.$inferSelect;

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
function toTodo(row: TodoRow): Todo {
  try {
    return Todo.reconstruct({
      id: row.id,
      title: row.title,
      completed: row.completed,
      createdAt: row.createdAt,
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

// TodoRepository の Postgres 実装（Drizzle）。
// WHY db（Database）をコンストラクタで受け取る: プールは getDatabase が globalThis に 1 つだけ持ち、api ファイルが
//   `new PostgresTodoRepository(getDatabase().db)` と組み立てる（Issue #123）。テストはテスト用のスキーマの db を渡す。
// WHY トランザクションを張らない: 今の command は書き込みが 1 文（save の INSERT ... ON CONFLICT か UPDATE、または delete）だけで、
//   Postgres は 1 文を原子的に実行する。複数の書き込みが要る command が出たら、その command にトランザクションを扱う依存を
//   注入する（.claude/rules/backend.md の「永続化（Drizzle + Postgres）」。ADR architecture/20260929-constructor-injection-without-container.md）。
export class PostgresTodoRepository implements TodoRepository {
  constructor(private readonly db: Database) {}

  // WHY 作成日時の昇順で返す: TodoRepository は順序を約束しない（並べ替えは ListTodosQuery が行う）が、
  //   DB は ORDER BY が無いと返す順が決まらない。毎回同じ順で返すため、並び順をここで決める。
  // WHY id を第 2 キーにする: 作成日時が同じ時刻の行が複数あると、作成日時だけでは Postgres が返す順が決まらない
  //   （行の物理的な位置や実行計画で変わりうる）。一意な id で並べれば、同じ時刻の行どうしの順序も毎回固定される
  //   （ListTodosQuery の並べ替えは安定ソートなので、この順が一覧の順になる）。
  async findAll(): Promise<Todo[]> {
    const rows = await this.db
      .select()
      .from(todos)
      .orderBy(asc(todos.createdAt), asc(todos.id));
    return rows.map(toTodo);
  }

  async findById(id: string): Promise<Todo | undefined> {
    // WHY id の形（uuid）をここで検査しない: 利用者の入力は presentation の parseUuidParam（z.uuid() → 404）が唯一の
    //   検査で、ここに uuid の形でない id が来るのは呼び出し側の実装ミスだけ。「無い」（undefined）として黙って通すと
    //   誤りが隠れるので、Postgres の uuid 型のエラー（invalid input syntax）をそのまま投げ、API は 500 でログに残す。
    const rows = await this.db.select().from(todos).where(eq(todos.id, id));
    const row = rows[0];
    return row === undefined ? undefined : toTodo(row);
  }

  // WHY findById を通す: 行の変換（toTodo）を 1 か所に保つ。本番の api のテストは prototype の findById を spy して
  //   Postgres の実装が呼ばれることを確かめているので、ここで findById を呼ぶ形はそのテストとも合う。
  async findByIdOrThrow(id: string): Promise<Todo> {
    return requireTodo(await this.findById(id), id);
  }

  // 新規（origin が undefined）は全列を INSERT、読み込み済みは読み込んだときから変わった列だけを UPDATE する（Issue #165）。
  // WHY 読み込み済みは変わった列だけ: 全列を書くと、同じ Todo を同時に別の列で更新したとき（片方は完了、片方は名前の
  //   変更）に、後から save した方が先の変更を読み込んだときの値に巻き戻す（lost update）。変わった列だけなら両方残る。
  //   同じ列を同時に変えたときは後勝ち。ただし読み込んだときと同じ値に戻す変更は差分が無いので書かれず、他方の更新が
  //   残る（楽観ロックの version 列は入れない。ユーザー判断）。
  // WHY 差分は origin と今の値の比較（changedProps）で取る: Entity の遷移メソッドは何も記録しない（todo.ts の origin）。
  async save(todo: Todo): Promise<void> {
    if (todo.origin === undefined) {
      await this.insert(todo);
      return;
    }
    // WHY 比べる列は title と completed だけ: Todo を変える操作（rename・changeCompletion）が変えるのはこの 2 つで、
    //   id と作成日時は作った後で変わらない。
    const changed = changedProps(todo.origin, {
      title: todo.title,
      completed: todo.completed,
    });
    // WHY 変わった列が無ければ SQL を発行しない: 空の SET は SQL にならず、書く必要も無い。そのため、読み込んだ後に
    //   消された Todo でも、変えずに save したときは何もせず気づかない（戻しもしない）。
    if (Object.keys(changed).length === 0) {
      return;
    }
    // WHY .returning で更新した行を受け取る: 0 行（読み込んだ後に消された）を not_found にするため。drizzle-orm 0.45.3 の
    //   node-postgres は、returning が無いと pg の QueryResult（rowCount は number | null）を、あると行の配列を返す
    //   （node-postgres/session.js の execute）。配列なら null の場合を考えずに済む。
    const [updated] = await this.db
      .update(todos)
      .set(changed)
      .where(eq(todos.id, todo.id))
      .returning({ id: todos.id });
    // WHY 0 行なら not_found: 読み込んだ後に別のリクエストが消した Todo。以前の upsert は INSERT で消した Todo を
    //   戻していた（PUT と DELETE の競合）。API は 404 を返す。
    // WHY requireTodo を通す（DomainError をここで作らない）: findByIdOrThrow と同じ例外（code・key・params）を
    //   1 か所（domain の requireTodo）で決める（.claude/rules/backend.md の「永続化」）。
    requireTodo(updated === undefined ? undefined : todo, todo.id);
  }

  // WHY 新規も upsert（INSERT ... ON CONFLICT DO UPDATE）にする: 同じ新規のインスタンス（origin が undefined のまま）を
  //   2 回 save すると、INSERT だけでは主キー違反で失敗する。2 回目は同じ値の上書きになるだけで、既存の行を
  //   巻き戻す心配は無い（新規の id は randomUUID で、他のリクエストはまだ知らない）。
  // WHY 上書きするのは title と completed だけ: 作成日時は作った後で変わらない（Todo に変える操作が無い）。
  private async insert(todo: Todo): Promise<void> {
    await this.db
      .insert(todos)
      .values({
        id: todo.id,
        title: todo.title,
        completed: todo.completed,
        createdAt: todo.createdAt,
      })
      .onConflictDoUpdate({
        target: todos.id,
        set: { title: todo.title, completed: todo.completed },
      });
  }

  async delete(id: string): Promise<void> {
    // WHY id の形を検査しない: findById と同じ。「無い」として黙って何もしないと、消したつもりで消えていない実装ミスが隠れる。
    await this.db.delete(todos).where(eq(todos.id, id));
  }
}
