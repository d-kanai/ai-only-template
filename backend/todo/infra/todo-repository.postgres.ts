import { asc, eq } from "drizzle-orm";
import type { Executor } from "@/backend/shared/infra/database";
import { Todo } from "@/backend/todo/domain/todo";
import type { TodoRepository } from "@/backend/todo/domain/todo-repository";
import { todos } from "@/backend/todo/infra/schema";

// id が uuid の形か（8-4-4-4-12 の 16 進。大文字も Postgres は受け付ける）。
// WHY 関数の中に置く（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる（Issue #55）。
function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}

type TodoRow = typeof todos.$inferSelect;

function toTodo(row: TodoRow): Todo {
  return Todo.restore({
    id: row.id,
    title: row.title,
    completed: row.completed,
    createdAt: row.createdAt,
  });
}

// TodoRepository の Postgres 実装（Drizzle）。
// WHY executor を受け取る: 同じ実装を、query ではトランザクションの外（db）で、command ではトランザクションの中（tx）で
//   使うため。どちらを渡すかは infra/container.ts が決める（リポジトリはトランザクションを始めない）。
export class PostgresTodoRepository implements TodoRepository {
  constructor(private readonly executor: Executor) {}

  // WHY 作成日時の昇順で返す: TodoRepository は順序を約束しない（並べ替えは ListTodosQuery が行う）が、
  //   DB は ORDER BY が無いと返す順が決まらない。毎回同じ順で返すため、並び順をここで決める。
  // WHY id を第 2 キーにする: 作成日時が同じ時刻の行が複数あると、作成日時だけでは Postgres が返す順が決まらない
  //   （行の物理的な位置や実行計画で変わりうる）。一意な id で並べれば、同じ時刻の行どうしの順序も毎回固定される
  //   （ListTodosQuery の並べ替えは安定ソートなので、この順が一覧の順になる）。
  async findAll(): Promise<Todo[]> {
    const rows = await this.executor
      .select()
      .from(todos)
      .orderBy(asc(todos.createdAt), asc(todos.id));
    return rows.map(toTodo);
  }

  async findById(id: string): Promise<Todo | undefined> {
    // WHY uuid の形でない id は問い合わせずに「無い」とする: id 列は uuid 型で、形の違う値（URL の /api/todos/abc など）を
    //   渡すと Postgres が invalid input syntax のエラーを返し、API が 404 ではなく 500 になる。
    //   InMemory と同じく「その id の Todo は無い」として扱う。
    if (!isUuid(id)) {
      return undefined;
    }
    const rows = await this.executor
      .select()
      .from(todos)
      .where(eq(todos.id, id));
    const row = rows[0];
    return row === undefined ? undefined : toTodo(row);
  }

  // WHY upsert（INSERT ... ON CONFLICT DO UPDATE）: TodoRepository の save は「同じ id があれば上書き」を約束している。
  //   先に存在を確かめてから INSERT / UPDATE を分けると、問い合わせが 2 回になり、間に別の保存が入る余地もできる。
  // WHY 上書きするのは title と completed だけ: 作成日時は作った後で変わらない（Todo に変える操作が無い）。
  async save(todo: Todo): Promise<void> {
    await this.executor
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
    await this.executor.delete(todos).where(eq(todos.id, id));
  }
}
