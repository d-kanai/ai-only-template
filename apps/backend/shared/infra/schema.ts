import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { CHANGE_OPERATIONS } from "../domain/change-operation";

// feature をまたぐ表の定義（Drizzle のスキーマ）。feature の表は features/<feature>/infra/schema.ts に置く。
// WHY shared/infra に置く: change_logs はすべての feature の表の変更を 1 か所に積む横断の表で、どの feature にも属さない。
//   drizzle-kit の設定（shared/drizzle/drizzle.config.ts の schema）はこのファイルも読む。

// 変更履歴の 1 列（changes の各列）の値。JSON にできる値だけ（日時は ISO 8601 の文字列にする。shared/infra/change-log.ts）。
export type ChangeValue = string | number | boolean | null;

// changes 列（jsonb）の形: DB の列名 → 変わる前（before）と後（after）。insert は after だけ、delete は before だけ、
//   update は変わった列だけの両方。
export type Changes = Readonly<
  Record<
    string,
    { readonly before?: ChangeValue; readonly after?: ChangeValue }
  >
>;

// すべての表の行の変更履歴（監査。Issue #189。ADR docs/adr/architecture/20260930-change-logs-written-by-repository.md）。
// 書くのは書き込みの唯一の入口 writeInTransaction（shared/infra/write.ts。Issue #205）で、Repository のコールバックが返した記録を
//   本体の書き込みと同じトランザクションの中で shared/infra/change-log.ts の recordChange が入れる。
// WHY insert のみ（UPDATE / DELETE しない。rule-tests/persistence.test.ts の no-update-delete-on-append-only-tables が
//   *Logs の表への update / delete を止める）: 変更の記録は後から書き換えないことに意味がある。
// WHY 外部キーを張らない: 消した行（delete の記録）も指し続ける。表をまたぐので、指す先の表も 1 つに決まらない。
export const changeLogs = pgTable(
  "change_logs",
  {
    // 記録の id。DB が作る（defaultRandom = gen_random_uuid()）。
    id: uuid("id").primaryKey().defaultRandom(),
    // 変わった行の表の名前（DB の表名。例: todos）。
    tableName: text("table_name").notNull(),
    // 変わった行の id。WHY uuid: 表の id 列はすべて uuid（.claude/rules/backend.md の「列の型」）。
    rowId: uuid("row_id").notNull(),
    // 操作（insert / update / delete）。WHY text の enum（Postgres の enum 型にしない）: 値の一覧は
    //   shared/domain/change-operation.ts が持ち、Drizzle の型だけを絞る。enum 型は値を足すたびに ALTER TYPE が要る。
    operation: text("operation", { enum: CHANGE_OPERATIONS }).notNull(),
    // 変わった列の変わる前と後（上の Changes）。WHY jsonb: 表ごとに列が違うので、1 つの表で持つには列名をキーにした
    //   JSON にする。jsonb は分解して保持し、中の値で検索・インデックスもできる（「列の型」）。
    changes: jsonb("changes").$type<Changes>().notNull(),
    // 変更した利用者の id。ログインが無い今は常に null（PostgresTodoRepository の actorId）。
    actorId: uuid("actor_id"),
    // 変更した日時（now()）。同じ save で書いた記録は同じ時刻になる。todos.created_at と同じく timestamptz・mode "date"。
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    // WHY (table_name, row_id) の index: 変更履歴は「ある行の履歴」を引く使い方（監査・問い合わせの調査）が主で、
    //   表の名前と行の id で絞る。一意ではない（1 つの行に何度でも変更がある）。
    index("change_logs_table_name_row_id_index").on(
      table.tableName,
      table.rowId,
    ),
  ],
);
