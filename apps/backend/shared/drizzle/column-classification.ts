import { getTableColumns, type Table } from "drizzle-orm";

// 表の列の分類（public / sensitive）と、ログに出す行の値のマスク（Issue #216）。
// 分類は各 schema.ts で表の隣に `export const <表>Columns = ColumnClassifier.classify(<表>, { ... })` と書く（rule-tests/schema.test.ts の
//   column-classification が、pgTable ごとにこの形があることを検査する）。使うのは Writer（writer.ts）の db_write のログで、
//   changes の before / after を ColumnClassifier.maskRow でマスクしてから logger に渡す。change_logs の表には生の値を残す（監査。マスクはログだけ）。
// WHY 列ごとに分類を書かせる（ログに値を一切出さない形にしない）: 書き込みのログから「何がどう変わったか」を追えないと、
//   障害の調査で change_logs（本番の DB）を直接読むことになる。値を出してよい列（id・完了状態・日時）は出し、利用者が書く
//   自由文（todos.title）だけを *** にする。
// WHY 分類を表の隣（schema.ts）に置く: 列を足す人がその場で分類を決められ、書き忘れは型（下の ColumnClassification）が止める。
//   Writer やログの側に表ごとの一覧を置くと、列を足したときに別のファイルの更新を忘れる。

// 列の分類。public = 値をログに出してよい、sensitive = 値を *** にする（個人情報・利用者の自由文など）。
export type ColumnClass = "public" | "sensitive";

// 表の全列（Drizzle のプロパティ名）→ 分類。
// WHY キーを Drizzle のプロパティ名（createdAt）にする（DB の列名 created_at にしない）: 全列の網羅を `keyof $inferSelect` で
//   型に強制できるのはプロパティ名だけ（Drizzle の列の型は DB の列名を型として持たない）。ログの before / after のキーは
//   変更履歴（change-log.ts）と同じ DB の列名なので、ColumnClassifier.maskRow が getTableColumns で列名 → プロパティ名に引き直す。
export type ColumnClassification<T extends Table> = {
  readonly [K in keyof T["$inferSelect"] & string]: ColumnClass;
};

// 表 → 分類。ColumnClassifier.classify が登録し、ColumnClassifier.maskRow が引く。
// WHY 表のオブジェクトをキーにした WeakMap（Writer のコンストラクタに表の一覧を注入しない）: 分類は schema.ts の表の定義と同じ
//   モジュールで登録するので、Writer に表が渡った時点で（表を import した時点で）必ず登録済みになる。注入にすると、組み立て
//   （api ファイル・テスト）ごとに一覧を渡す必要があり、渡し忘れた表は黙って全列 *** になる。WeakMap は表を参照し続けない。
const classifications = new WeakMap<Table, Readonly<Record<string, unknown>>>();

// 分類の登録（classify）と、分類による行のマスク（maskRow）。
// WHY クラスの static メソッドにする: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。分類はモジュールの WeakMap（上の classifications）に置き、
//   schema.ts のモジュールの読み込みで登録するので、インスタンスを渡し回さない static にする。
export class ColumnClassifier {
  // 表の分類を登録し、そのまま返す（schema.ts で <表>Columns として export する）。
  // WHY 引数の型で全列の網羅を強制する: 列を足して分類を書き忘れると tsc が落ちる（表に無い列名・public / sensitive 以外も落ちる）。
  // WHY NoInfer: T は第 1 引数の表だけから決める。分類のオブジェクトから T を推論させない。
  static classify<T extends Table>(
    table: T,
    columns: ColumnClassification<NoInfer<T>>,
  ): ColumnClassification<T> {
    classifications.set(table, columns);
    return columns;
  }

  // 行（DB の列名 → 値）の値を、表の分類でマスクした写しを返す（キーはそのまま）。public の列は値のまま、それ以外は *** にする。
  //   null は null のまま（値が無いことは個人情報ではない。apps/shared/log-event.ts の sensitive と同じ Issue #216 の既定の判断）。
  // WHY public でなければ *** にする（fail closed）: 分類を登録していない表（全列）、分類に無い列（型を cast で外したとき）、
  //   表に無い列名は、個人情報かどうか分からない。出さないほうに倒す。
  static maskRow(
    table: Table,
    row: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    const isPublic = ColumnClassifier.publicColumnNames(table);
    return Object.fromEntries(
      Object.entries(row).map(([name, value]) => [
        name,
        value === null || isPublic.has(name)
          ? value
          : ColumnClassifier.maskedValue(),
      ]),
    );
  }

  // 表の public の列の DB の列名の集合（分類が無い表は空）。
  // WHY 表の列（getTableColumns）から集める（行のキーで分類を引かない）: 行のキーは DB の列名で、分類のキーはプロパティ名。
  //   表の列から「プロパティ名 → DB の列名」を引けば、表に無い列名・プロパティ名のキー・Object.prototype の名前（toString）は
  //   集合に入らず、*** になる。値は "public" と完全一致で比べるので、継承したプロパティ（関数）を public と取り違えることも無い。
  private static publicColumnNames(table: Table): Set<string> {
    const columns = classifications.get(table) ?? {};
    return new Set(
      Object.entries(getTableColumns(table))
        .filter(([key]) => columns[key] === "public")
        .map(([, column]) => column.name),
    );
  }

  // マスクした値。apps/shared/free-text-mask.ts の MASK と同じ "***"。
  // WHY ここに書く（MASK を import しない）: @repo/shared の exports は env・logger・now だけで、log-event を backend に公開すると
  //   ログのスキーマを logger を通さずに使える口が増える（rule-tests/architecture.test.ts の SHARED_MODULES_BY_LAYER も広げることになる）。
  // WHY メソッドにする（最上位の定数・static フィールドにしない）: 最上位の値と static フィールドの初期化は読み込み時に 1 回だけ
  //   評価される Stryker の static な変異になり、ignoreStatic で検査から外れる。
  private static maskedValue(): string {
    return "***";
  }
}
