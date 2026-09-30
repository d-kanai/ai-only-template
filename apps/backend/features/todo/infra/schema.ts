import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
