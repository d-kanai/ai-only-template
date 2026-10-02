import { now } from "@repo/shared/now";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import type { ChangeOperation } from "../domain/change-operation";
import type { Database } from "./database";
import { type Changes, type ChangeValue, changeLogs } from "./schema";

// 変更履歴（change_logs。Issue #189）の記録の組み立てと書き込み。使うのは書き込みの唯一の口 Writer（writer.ts。Issue #215）だけで、
//   Writer が文ごとに記録を組み立て（ChangeRecords.insertEntry など）、同じトランザクションの中で ChangeRecords.recordChange を呼ぶ。Repository（*.postgres.ts）は
//   このファイルを import しない（rule-tests/persistence.test.ts の no-change-log-in-repository・no-direct-record-change が止める）。
// WHY TypeScript で書く（DB のトリガーにしない）: 記録の組み立てがコードにあり、テストで確かめられる。トリガーは手書きの SQL の
//   変更も拾えるが、ロジックが SQL に隠れる（ADR docs/adr/architecture/20260930-change-logs-written-by-repository.md。Repository が
//   組み立てる形は Issue #215 で Writer が組み立てる形に置き換えた。ADR docs/adr/architecture/20260930-transaction-from-application.md）。

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

// 書き込みに使う接続（Writer（writer.ts）が持つトランザクションの tx。テストは db そのものも渡す）。
// WHY insert だけ: 記録は insert のみ（change_logs を UPDATE / DELETE しない）。
type Writer = Pick<Database, "insert">;

// 変更履歴の記録の組み立て（insertEntry / updateEntries / deleteEntry）と書き込み（recordChange）。
// WHY クラスの static メソッドにする: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。状態を持たない組み立てと、受け取った writer への書き込みだけなので static にする。
// WHY 書き込みのメソッド名を recordChange のままにする: Repository（*.postgres.ts）がこの名前を使うことを rule-tests/persistence.test.ts の
//   no-direct-record-change が名前で止める（ChangeRecords.recordChange も同じ名前で拾う）。
export class ChangeRecords {
  // 新しい行の記録: 行の全列を after に持つ。
  static insertEntry(
    table: Table,
    row: Row,
    actorId: string | null,
  ): ChangeEntry {
    return {
      tableName: getTableName(table),
      rowId: row.id,
      operation: "insert",
      changes: ChangeRecords.columnChanges(table, row, (value) => ({
        after: value,
      })),
      actorId,
    };
  }

  // 消した行の記録: 消す前の行の全列を before に持つ。
  // WHY 全列: 消した後は行が無いので、何が消えたかは記録にしか残らない。
  static deleteEntry(
    table: Table,
    row: Row,
    actorId: string | null,
  ): ChangeEntry {
    return {
      tableName: getTableName(table),
      rowId: row.id,
      operation: "delete",
      changes: ChangeRecords.columnChanges(table, row, (value) => ({
        before: value,
      })),
      actorId,
    };
  }

  // 変えた行の記録: changed（書き込む列と値）の列ごとに、origin（変える前の値）を before、changed の値を after に持つ。
  //   changed が空なら記録しない（空配列。差分の無い update は何も書かないので）。
  // Writer（writer.ts）は origin に、同じトランザクションで UPDATE の直前に FOR UPDATE で読んだ行を渡す（Issue #215）。そのため
  //   before は DB が UPDATE の直前に持っていた値になる（Issue #189〜#205 は Repository が渡す読み込んだときの値だった）。
  // WHY 配列で返す: 呼び出し側が、差分の有無で分岐せずに記録の配列にまとめられる。
  // WHY origin の型を changed から決める（NoInfer）: origin は変える前の行（changed に無い列も持つ）で、比べるのは changed の key
  //   だけ。origin の key まで K に入れると、changed に無い列の型も求めてしまう。
  static updateEntries<K extends string>(
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
    const columns = ChangeRecords.columnNames(table);
    const changes: Record<string, { before: ChangeValue; after: ChangeValue }> =
      {};
    for (const key of keys) {
      changes[ChangeRecords.columnName(table, columns, key)] = {
        before: ChangeRecords.toChangeValue(table, key, origin[key]),
        after: ChangeRecords.toChangeValue(table, key, changed[key]),
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
  // WHY 本体と同じトランザクション: Writer が文ごとに、同じ tx で本体の後に呼ぶ（writer.test.ts・todo-repository.postgres.test.ts が固定する）。
  static async recordChange(
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
  private static columnChanges(
    table: Table,
    row: Row,
    toChange: (value: ChangeValue) => {
      before?: ChangeValue;
      after?: ChangeValue;
    },
  ): Changes {
    const columns = ChangeRecords.columnNames(table);
    const changes: Record<
      string,
      { before?: ChangeValue; after?: ChangeValue }
    > = {};
    for (const [key, value] of Object.entries(row)) {
      changes[ChangeRecords.columnName(table, columns, key)] = toChange(
        ChangeRecords.toChangeValue(table, key, value),
      );
    }
    return changes;
  }

  // 表のプロパティ名 → DB の列名。
  // WHY Map にする（getTableColumns の結果をそのまま引かない）: オブジェクトを key で引くと、toString のような
  //   Object.prototype の名前も「列がある」になる。
  private static columnNames(table: Table): Map<string, string> {
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
  private static columnName(
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
  private static toChangeValue(
    table: Table,
    key: string,
    value: unknown,
  ): ChangeValue {
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
}
