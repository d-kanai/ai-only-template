import { now } from "@repo/shared/now";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import type { ChangeOperation } from "../domain/change-operation";
import type { Database } from "./database";
import { type Changes, type ChangeValue, changeLogs } from "./schema";

// 変更履歴（change_logs。Issue #189）の記録の組み立てと書き込み。Repository（*.postgres.ts）は記録を組み立てて返すだけで、
//   書き込みの唯一の入口 writeInTransaction（write.ts。Issue #205）が本体の書き込みと同じトランザクションの中で recordChange を
//   呼ぶ（*.postgres.ts が recordChange を直接呼ぶことは rule-tests/persistence.test.ts の no-direct-record-change が止める）。
//   InMemory の Repository（テスト用）も同じ組み立て（insertEntry など）で記録を作り、同じ形で積む。
// WHY Repository が書く（DB のトリガーにしない）: 記録の組み立てが TypeScript にあり、InMemory でも同じ記録を確かめられる。
//   トリガーは手書きの SQL の変更も拾えるが、ロジックが SQL に隠れる（ADR docs/adr/architecture/20260930-change-logs-written-by-repository.md）。

// 1 件の記録（change_logs の 1 行から id と occurred_at を除いたもの）。
export type ChangeEntry = {
  // 変わった行の表の名前（DB の表名）。
  tableName: string;
  // 変わった行の id。
  rowId: string;
  operation: ChangeOperation;
  changes: Changes;
  // 変更した利用者の id。ログインが無い今は null。
  actorId: string | null;
};

// change_logs の 1 行（InMemory の Repository が積む形も同じ）。
export type ChangeLog = typeof changeLogs.$inferSelect;

// 行（Drizzle のプロパティ名 → 値）。id は記録の row_id になる。値は unknown で受け、toChangeValue が実行時に確かめる
//   （Drizzle の行の型 $inferSelect をそのまま渡せるように）。
type Row = { readonly id: string } & Readonly<Record<string, unknown>>;

// 書き込みに使う接続（writeInTransaction（write.ts）が張ったトランザクションの tx。テストは db そのものも渡す）。
// WHY insert だけ: 記録は insert のみ（change_logs を UPDATE / DELETE しない）。
type Writer = Pick<Database, "insert">;

// 新しい行の記録: 行の全列を after に持つ。
export function insertEntry(
  table: Table,
  row: Row,
  actorId: string | null,
): ChangeEntry {
  return {
    tableName: getTableName(table),
    rowId: row.id,
    operation: "insert",
    changes: columnChanges(table, row, (value) => ({ after: value })),
    actorId,
  };
}

// 消した行の記録: 消す前の行の全列を before に持つ。
// WHY 全列: 消した後は行が無いので、何が消えたかは記録にしか残らない。
export function deleteEntry(
  table: Table,
  row: Row,
  actorId: string | null,
): ChangeEntry {
  return {
    tableName: getTableName(table),
    rowId: row.id,
    operation: "delete",
    changes: columnChanges(table, row, (value) => ({ before: value })),
    actorId,
  };
}

// 変えた行の記録: changed（changedProps の差分。変わった列の今の値）の列ごとに、origin（読み込んだときの値）を before、
//   差分の値を after に持つ。変わった列が無ければ記録しない（空配列。差分の無い save は何も書かないので）。
// WHY 配列で返す: 呼び出し側（save）が、差分の有無で分岐せずに履歴の insert の記録と 1 つの配列にまとめられる。
// before は読み込んだときの値で、DB が UPDATE の直前に持っていた値ではない。別の要求が同じ列を同時に変えた（後勝ち）ときは、
//   その要求が書いた値ではなく、この要求が読んだ値が before になる（UPDATE の前の値を返させる書き方は drizzle-orm 0.45.3 に
//   無い）。どちらの要求の記録も残るので、順番（occurred_at）で追える。
// WHY origin の型を changed から決める（NoInfer）: origin は Entity の読み込んだときの値（statusChanges など表の列でない
//   項目も持つ）で、比べるのは changed の key だけ。origin の key まで K に入れると、表の列でない項目の型も求めてしまう。
export function updateEntries<K extends string>(
  table: Table,
  rowId: string,
  origin: Readonly<Record<NoInfer<K>, unknown>>,
  changed: Readonly<Partial<Record<K, unknown>>>,
  actorId: string | null,
): ChangeEntry[] {
  const keys = Object.keys(changed) as K[];
  if (keys.length === 0) {
    return [];
  }
  const columns = columnNames(table);
  const changes: Record<string, { before: ChangeValue; after: ChangeValue }> =
    {};
  for (const key of keys) {
    changes[columnName(table, columns, key)] = {
      before: toChangeValue(table, key, origin[key]),
      after: toChangeValue(table, key, changed[key]),
    };
  }
  return [
    {
      tableName: getTableName(table),
      rowId,
      operation: "update",
      changes,
      actorId,
    },
  ];
}

// 記録を change_logs に入れる（1 回の INSERT。記録が無ければ何もしない）。occurred_at は now()（同じ呼び出しの記録は同じ時刻）。
// WHY writer（tx）を受け取る: 本体の書き込みと同じトランザクションで書き、片方だけが残らないようにする（本体が失敗したら
//   記録も戻り、記録が失敗したら本体も戻る。todo-repository.postgres.test.ts が一時的な CHECK 制約と、COMMIT で失敗させる
//   遅延制約で固定する）。
// WHY 記録が無ければ SQL を発行しない: drizzle-orm の insert は空の values を受け付けない。無い id の delete は記録が 0 件。
export async function recordChange(
  writer: Writer,
  entries: readonly ChangeEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const occurredAt = now();
  await writer
    .insert(changeLogs)
    .values(entries.map((entry) => ({ ...entry, occurredAt })));
}

// 行の全列を、DB の列名 → toChange(値) にする。
// WHY キーを DB の列名にする（Drizzle のプロパティ名にしない）: change_logs は SQL・BI で読む記録で、table_name と同じく
//   DB の名前で書けば、元の表の列とそのまま突き合わせられる。
function columnChanges(
  table: Table,
  row: Row,
  toChange: (value: ChangeValue) => {
    before?: ChangeValue;
    after?: ChangeValue;
  },
): Changes {
  const columns = columnNames(table);
  const changes: Record<string, { before?: ChangeValue; after?: ChangeValue }> =
    {};
  for (const [key, value] of Object.entries(row)) {
    changes[columnName(table, columns, key)] = toChange(
      toChangeValue(table, key, value),
    );
  }
  return changes;
}

// 表のプロパティ名 → DB の列名。
// WHY Map にする（getTableColumns の結果をそのまま引かない）: オブジェクトを key で引くと、toString のような
//   Object.prototype の名前も「列がある」になる。
function columnNames(table: Table): Map<string, string> {
  return new Map(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      column.name,
    ]),
  );
}

// WHY 表に無い key を Error にする（記録から黙って落とさない）: Entity の項目名の取り違えなど、呼び出し側の実装ミスで、
//   落とすと記録が欠けたことに気づけない。
// WHY 英語の文言: 開発者向けのエラーで、apps/backend の非テストコードには自然言語の日本語を置かない（Issue #116）。
function columnName(
  table: Table,
  columns: Map<string, string>,
  key: string,
): string {
  const name = columns.get(key);
  if (name === undefined) {
    throw new Error(`${getTableName(table)} has no column: ${key}`);
  }
  return name;
}

// 列の値を JSON にできる値にする。Date は ISO 8601 の文字列（UTC、ミリ秒まで）にする。
// WHY Date を文字列にしてから記録する: jsonb は Date を持てず、JSON.stringify で文字列になる。InMemory の記録（テスト用）でも
//   同じ値になるよう、組み立ての時点でそろえる。
// WHY それ以外の値（配列・オブジェクト・undefined・bigint）を Error にする: undefined は JSON で消え、bigint は JSON に
//   できない。今の表の列の型（text・uuid・boolean・integer・timestamptz）には現れず、現れたら呼び出し側の実装ミス。
function toChangeValue(table: Table, key: string, value: unknown): ChangeValue {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error(
    `${getTableName(table)}.${key} has a value that cannot be recorded`,
  );
}
