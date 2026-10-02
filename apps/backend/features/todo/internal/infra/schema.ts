import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { ColumnClassifier } from "../../../../shared/drizzle/column-classification";

// todos テーブルの定義（Drizzle のスキーマ）。
// WHY スキーマを TypeScript で宣言し、SQL はここから生成する（codebase-first）: テーブルの形の正をこのファイルに置き、
//   `pnpm db:generate`（drizzle-kit generate）が前回との差分からマイグレーションの SQL（drizzle/）を作る。
//   手で SQL を書くと、このファイルと DB の形がずれても気づけない。変え方は .claude/rules/backend.md の「永続化（Drizzle + Postgres）」。
// WHY infra に置く: テーブルの形は永続化の都合で、domain（Todo）は知らない。Todo との変換は
//   todo-repository.postgres.ts が行う。
export const todos = pgTable("todos", {
  // Todo.create が randomUUID で作る id。uuid 型にして、形の違う値が入らないようにする（16 バイトで保持）。
  id: uuid("id").primaryKey(),
  // WHY text（長さ無し）: 文字列の列は text を既定にし、長さの上限（100 文字）は domain の不変条件（Todo.create / rename）が持つ
  //   （.claude/rules/backend.md の「列の型」。rule-tests/schema.test.ts が varchar を止める）。
  title: text("title").notNull(),
  // 既定値はアプリが必ず値を渡すので使われないが、手で行を足したときに Todo.create と同じ未完了になるようにする。
  completed: boolean("completed").notNull().default(false),
  // WHY timestamptz（withTimezone）: タイムゾーン付きで保持し、サーバや DB のタイムゾーン設定で時刻がずれないようにする。
  //   mode "date" で JS の Date として読み書きする（Todo.createdAt と同じ型）。精度は Postgres がマイクロ秒、
  //   Date がミリ秒なので、Date から保存した値は欠けずに戻る。
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

// todos の列の分類（Issue #216。書き込みのログの before / after のマスクに使う。shared/drizzle/column-classification.ts）。
// WHY title だけ sensitive: 利用者が自由に書く文で、名前・連絡先などの個人情報が入りうる。id（Todo.create が作る uuid）・
//   完了状態・作成日時はアプリが決める値で、利用者の値を含まない（障害の調査でログから追えるよう値のまま出す）。
export const todosColumns = ColumnClassifier.classify(todos, {
  id: "public",
  title: "sensitive",
  completed: "public",
  createdAt: "public",
});

// Todo の完了の履歴（Todo.statusChanges）の子表（Issue #188。ADR docs/adr/architecture/20260930-status-transitions-as-append-only-child-table.md）。
// WHY insert のみ（UPDATE / DELETE しない。rule-tests/persistence.test.ts の no-update-delete-on-append-only-tables が止める）:
//   遷移の日時は後から書き換えない記録。消えるのは親の Todo を消したときだけ（外部キーの on delete cascade）。
export const todoStatusChanges = pgTable(
  "todo_status_changes",
  {
    // 行の id。domain（TodoStatusChange）は持たない（履歴は Todo の中の値で、1 件を外から指すことは無い）。アプリの書き込みでは
    //   Writer（shared/drizzle/writer.ts）が randomUUID で作る（前のログと変更履歴に INSERT の前の id が要る。Issue #215）。DB の既定値
    //   （defaultRandom = gen_random_uuid()）は、手で行を足すときとマイグレーション（既存の Todo の履歴の補完）のために残す。
    id: uuid("id").primaryKey().defaultRandom(),
    // 親の Todo の id。外部キー（references todos(id) on delete cascade）は、ここで .references() と書かず、手書きの
    //   マイグレーション（shared/drizzle/migrations/0002_todo_status_changes_foreign_key_and_backfill.sql）で張る。
    // WHY on delete cascade: Todo を消したら履歴も消す（delete は todos の 1 文のまま。履歴の DELETE は書かない）。
    // WHY .references() を使わない: drizzle-kit 0.31.11 の generate は、スキーマを指定しない表への外部キーを必ず
    //   REFERENCES "public"."todos" と書く（drizzle-kit の bin.cjs の PgSquasher.squashFK が schemaTo || "public"）。
    //   テストは表をテストファイルごとの別スキーマ（search_path。test-support/database.ts）に作るので、その外部キーは
    //   public の todos を指し、テストのスキーマの Todo に履歴を足せない（外部キー違反）。手書きの SQL でスキーマを書かずに
    //   REFERENCES "todos" と張れば、マイグレーションを当てたスキーマ（search_path）の todos を指す。
    todoId: uuid("todo_id").notNull(),
    // 履歴の中の位置（0 始まり。Todo.statusChanges の添字）。
    // WHY 日時とは別に持つ: 日時は同じ値を許す（作成と完了が同じミリ秒になりうる）ので、日時だけでは足した順が決まらず、
    //   読み出した順が変わると「最後の completed が今の completed と同じ」の不変条件を満たさなくなる。
    // WHY integer: 1 つの Todo の遷移の回数で、21 億を超えない。
    position: integer("position").notNull(),
    // 変わった後の完了状態。
    completed: boolean("completed").notNull(),
    // 変わった日時。todos.created_at と同じく timestamptz・mode "date"。
    changedAt: timestamp("changed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    // WHY (todo_id, position) の一意制約: 同じ Todo を 2 か所で（ロックせずに）読み込み、両方で完了状態を変えて update すると、どちらも
    //   「読み込んだときの履歴の次」に足そうとする。両方を足すと、足した順と今の completed がずれうる（読めない Todo になる）。
    //   一意制約なら 2 回目の update は一意制約違反（SQLSTATE 23505）で失敗し、同じトランザクションの todos の UPDATE も戻る。
    // この index は todo_id で始まるので、Repository が todo_id で履歴を読む検索（where todo_id in (...)）にも使われる。
    uniqueIndex("todo_status_changes_todo_id_position_index").on(
      table.todoId,
      table.position,
    ),
  ],
);

// todo_status_changes の列の分類（Issue #216）。
// WHY すべて public: id・親の id・位置・完了状態・日時はどれもアプリが決める値で、利用者が書く値を含まない。
export const todoStatusChangesColumns = ColumnClassifier.classify(
  todoStatusChanges,
  {
    id: "public",
    todoId: "public",
    position: "public",
    completed: "public",
    changedAt: "public",
  },
);
