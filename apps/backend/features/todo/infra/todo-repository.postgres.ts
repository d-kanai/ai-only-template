import { asc, eq } from "drizzle-orm";
import type { Database } from "../../../shared/infra/database";
import { Todo } from "../domain/todo";
import { requireTodo, type TodoRepository } from "../domain/todo-repository";
import { todos } from "./schema";

// id が uuid の形か（8-4-4-4-12 の 16 進。大文字も Postgres は受け付ける）。
// WHY 関数の中に置く（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる。
function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

type TodoRow = typeof todos.$inferSelect;

// WHY Repository で zod の parse をしない: 行の型（uuid・text・boolean・timestamptz の NOT NULL）は Drizzle のスキーマ
//   （schema.ts）と DB の列の定義が保証し、TodoRow の型として届く。値の規則（タイトルの長さ・id の形など）は
//   Todo.reconstruct（完全コンストラクタ）が検証する。
// WHY 不変条件を満たさない行を DomainError ではない Error にする（API は 500 internal_error）:
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
    //   apps/backend の非テストコードには自然言語の日本語を置かない（画面の文言は画面の辞書だけが持つ）。
    throw new Error(
      `stored Todo (id: ${row.id}) violates the invariants: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

// WHY db（Database）をコンストラクタで受け取る: プールは getDatabase が globalThis に 1 つだけ持ち、api ファイルが
//   `new PostgresTodoRepository(getDatabase().db)` と組み立てる。テストはテスト用のスキーマの db を渡す。
// WHY トランザクションを張らない: 今の command は書き込みが 1 文（save の INSERT ... ON CONFLICT か delete）だけで、
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
    // WHY uuid の形でない id は問い合わせずに「無い」とする: id 列は uuid 型で、形の違う値（URL の /api/todos/abc など）を
    //   渡すと Postgres が invalid input syntax のエラーを返し、API が 404 ではなく 500 になる。
    //   InMemory と同じく「その id の Todo は無い」として扱う。
    // WHY presentation も id を z.uuid() で確かめるのに残す: TodoRepository は「無い id なら undefined」を
    //   どの文字列にも約束している（InMemory も同じ）。呼び出し元（今は presentation の api だけ）の検査に頼ると、
    //   検査しない呼び出し元を足したときに 500 になる。Repository の実装が自分の約束を自分で守る防御として残す。
    if (!isUuid(id)) {
      return undefined;
    }
    const rows = await this.db.select().from(todos).where(eq(todos.id, id));
    const row = rows[0];
    return row === undefined ? undefined : toTodo(row);
  }

  // WHY findById を通す: uuid の形の検査（isUuid）と行の変換（toTodo）を 1 か所に保ち、形の違う id も「無い」
  //   = not_found（API で 404）にする。本番の api のテストは prototype の findById を spy して Postgres の実装が
  //   呼ばれることを確かめているので、ここで findById を呼ぶ形はそのテストとも合う。
  async findByIdOrThrow(id: string): Promise<Todo> {
    return requireTodo(await this.findById(id), id);
  }

  // WHY upsert（INSERT ... ON CONFLICT DO UPDATE）: TodoRepository の save は「同じ id があれば上書き」を約束している。
  //   先に存在を確かめてから INSERT / UPDATE を分けると、問い合わせが 2 回になり、間に別の保存が入る余地もできる。
  // WHY 上書きするのは title と completed だけ: 作成日時は作った後で変わらない（Todo に変える操作が無い）。
  async save(todo: Todo): Promise<void> {
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
    // findById と同じ理由で、uuid の形でない id は DB に渡さない（その id の Todo は無いので、何もしない）。
    if (!isUuid(id)) {
      return;
    }
    await this.db.delete(todos).where(eq(todos.id, id));
  }
}
