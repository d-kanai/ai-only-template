import { logger } from "@repo/shared/logger";
import { DrizzleQueryError, getTableName, type Table } from "drizzle-orm";
import type { ChangeEntry } from "../change-log/change-log";
import type { Changes } from "../change-log/change-log.schema";
import type { ChangeOperation } from "../change-log/change-operation";
import { ColumnClassifier } from "./column-classification";

// Writer（writer.ts）の 1 回の書き込み（1 文）のログ（event.name は db_write。Issue #205・#209・#216）。Writer の logged が
//   書き込みの前に DbWriteLog.start で前のログを出し、失敗なら failed、成功なら done で後のログを出す。
// WHY writer.ts と分ける（Issue #384。Biome の style/noExcessiveLinesPerFile）: writer.ts が 300 行を超えた。ログの形・値のマスク・
//   DB のエラーの読み替えは、書き込み（insert / update / delete と変更履歴）と独立した 1 つの関心で、まとめて移せる。
// ログの形（Issue #209。ADR docs/adr/architecture/20260930-log-format-cloud-logging-otel.md。どれも event.name は db_write で、
//   db.collection.name（表名）・db.operation.name（操作）・行の id（1 行なら row_id、複数なら row_ids）を持つ）:
//   - 前: "db write start"（event.phase は start。INFO）
//   - 後: "db write done"（event.phase は done。INFO）。event.duration_ms（所要時間）と changes（記録の table・row_id・operation と、
//     列の分類表でマスクした before / after。下の loggedChanges）
//   - 失敗: "db write failed"（event.phase は failed。WARNING）。event.duration_ms と error（logger が { type, message } にする）。
//     DB のエラーなら error は pg のエラーの { type, message }（message は引用符の部分を *** にしたもの）で、
//     db.response.status_code（SQLSTATE）・constraint（制約の名前）・params（SQL に渡した値。logger が値をすべて *** にする）を
//     出す（下の failureFields）
// WHY db.* の名前: OTel semconv の DB の属性（db.collection.name・db.operation.name・db.response.status_code。
//   https://opentelemetry.io/docs/specs/semconv/registry/attributes/db/ ）にそろえ、入れ子のオブジェクトにする（Logs Explorer で
//   jsonPayload.db.collection.name と書ける）。操作の名前は OTel の例（SELECT など）と違い、変更履歴と同じ insert / update / delete。
// WHY 段階を event.phase に入れる（event.name を db_write_start などに分けない）: 1 回の書き込みの前後を event.name="db_write" の
//   1 つの条件で引け、種類の一覧（apps/shared/log-event.ts）を段階の数だけ増やさずに済む。
// WHY changes に値（before / after）を出し、列の分類でマスクする（Issue #216。以前（Issue #205〜#215）は値を出さなかった）:
//   ログだけで「何がどう変わったか」を追えるようにし、障害の調査で本番の change_logs を読む回数を減らす。個人情報を含みうる
//   列（todos.title など）は schema.ts の分類表で sensitive にし、*** にする。change_logs の表には生の値を残す（監査）。
// 重大度（INFO / WARNING）は logger が event.name と phase で決める（apps/shared/log-severity.ts の LogSeverity.of。Issue #216）。失敗が
//   ERROR でなく WARNING なのは、500 になる想定外の例外は presentation の ProblemResponse.from が server_error（ERROR）で別に残すため。
// 限界: 後のログは文と記録を書き終えた時点で出す（COMMIT の前）。後から COMMIT が失敗した（遅延制約など）ときは、このログは
//   done のまま残り、失敗は ProblemResponse.from の 500 のログで分かる（トランザクションを張るのは runner で、Writer は COMMIT を
//   見ない）。

// ログの db（OTel の db.* の属性。表名と操作）。
type DbAttributes = {
  readonly collection: { readonly name: string };
  readonly operation: { readonly name: ChangeOperation };
};

// ログの行の id（1 行なら row_id、複数なら row_ids）。
type RowIdsField =
  | { readonly row_id: string }
  | { readonly row_ids: readonly string[] };

export class DbWriteLog {
  private constructor(
    private readonly table: Table,
    private readonly db: DbAttributes,
    private readonly rows: RowIdsField,
    private readonly startedAt: number,
  ) {}

  // 前のログを出し、所要時間の計測を始める。
  // WHY static のファクトリにする: 前のログを出してから計測を始める順番（performance.now の 1 回目が開始）を 1 か所に閉じ、
  //   start を呼ばずに failed / done を出す書き方をできなくする。
  static start(
    table: Table,
    operation: ChangeOperation,
    rowIds: readonly string[],
  ): DbWriteLog {
    const db = {
      collection: { name: getTableName(table) },
      operation: { name: operation },
    };
    // WHY 1 行なら row_id（複数なら row_ids）: 1 行の書き込み（update / delete と、根の insert）は以前（Issue #205）の形のまま
    //   row_id で引ける。複数行の insert（完了の履歴）は 1 文で書いた行をすべて並べる。
    const rows: RowIdsField =
      rowIds.length === 1 ? { row_id: rowIds[0] } : { row_ids: rowIds };
    logger.emit({
      message: "db write start",
      event: { name: "db_write", phase: "start" },
      db,
      ...rows,
    });
    return new DbWriteLog(table, db, rows, performance.now());
  }

  // 失敗のログ（"db write failed"）を出す。例外を投げ直すのは呼び出し側（Writer の logged）。
  failed(error: unknown): void {
    const failure = this.failureFields(error);
    logger.emit({
      message: "db write failed",
      event: {
        name: "db_write",
        phase: "failed",
        duration_ms: this.elapsedMs(),
      },
      db: {
        ...this.db,
        // WHY SQLSTATE が無ければ undefined（JSON.stringify がキーごと落とす）: DB のエラーでないとき・code が文字列でない
        //   ときに、空の response: {} を出さない。
        response:
          failure.statusCode === undefined
            ? undefined
            : { status_code: failure.statusCode },
      },
      ...this.rows,
      constraint: failure.constraint,
      params: failure.params,
      error: failure.error,
    });
  }

  // 後のログ（"db write done"）を出す。entries は書いた行の記録（変更履歴と同じもの）。
  done(entries: readonly ChangeEntry[]): void {
    logger.emit({
      message: "db write done",
      event: {
        name: "db_write",
        phase: "done",
        duration_ms: this.elapsedMs(),
      },
      db: this.db,
      ...this.rows,
      changes: this.loggedChanges(entries),
    });
  }

  // 後のログの changes: 記録（ChangeEntry）ごとの { table, row_id, operation, before, after }。before / after は記録の changes
  //   （DB の列名 → { before?, after? }）を側ごとの「DB の列名 → 値」に分け、列の分類表（column-classification.ts）でマスクする。
  //   側の値が 1 列も無ければ null（insert の before・delete の after）。
  // WHY snake_case の { table, row_id, operation } にする（ChangeEntry の tableName・rowId をそのまま出さない）: ログのキーは
  //   OTel の名前にそろえた snake_case で、行の中で表記を混ぜない。
  // WHY 側ごとの「列 → 値」にする（記録の「列 → { before, after }」のまま出さない）: マスクを行（列 → 値）の 1 つの関数（ColumnClassifier.maskRow）で
  //   済ませ、Logs Explorer で jsonPayload.changes.after.completed のように側と列で引ける。
  // WHY table（Writer が書いた表）でマスクする: 記録はすべてこの表の行（1 文 = 1 つの表）。分類は表のオブジェクトで引く。
  private loggedChanges(entries: readonly ChangeEntry[]) {
    return entries.map(({ tableName, rowId, operation, changes }) => ({
      table: tableName,
      row_id: rowId,
      operation,
      before: this.maskedSide(changes, "before"),
      after: this.maskedSide(changes, "after"),
    }));
  }

  private maskedSide(
    changes: Changes,
    side: "before" | "after",
  ): Record<string, unknown> | null {
    const values = Object.entries(changes).filter(
      ([, change]) => side in change,
    );
    if (values.length === 0) {
      return null;
    }
    return ColumnClassifier.maskRow(
      this.table,
      Object.fromEntries(values.map(([name, change]) => [name, change[side]])),
    );
  }

  // 失敗のログに載せる例外。DB のエラー（drizzle-orm の DrizzleQueryError）は、元の pg のエラー（cause）の name（error.type）と
  //   引用符の部分を *** にした message（maskQuoted）、SQLSTATE（statusCode → db.response.status_code）・制約の名前（constraint。
  //   pg の DatabaseError のプロパティ）、SQL に渡した値（params。logger のスキーマが値をすべて *** にする）にする。それ以外
  //   （Error など）はそのまま（logger が { type, message } にする）。
  // WHY DrizzleQueryError の message を出さない: 「Failed query: <SQL>\nparams: <値>」（drizzle-orm 0.45.3 の errors.js）で、行の値
  //   （個人情報を含みうる）がそのまま入る。値は params として構造で渡し、logger に *** にさせる（Issue #216）。
  // WHY pg の message は引用符の部分を *** にして出す（Issue #216。以前（Issue #205）は message を出さなかった）: 何が起きたかの文
  //   （duplicate key value violates unique constraint・invalid input syntax for type uuid など）は調査に要る。一方でデータ例外
  //   （SQLSTATE 22 系）の message は入力値を "..." で囲んで含む（22P02 の invalid input syntax for type uuid: "<入力>"、22003 の
  //   value "<入力>" is out of range for type integer。2026-10-01 に実 Postgres で実測）。logger の freeText（メール・トークンなど
  //   既知の形だけを *** にする）では任意の入力値は消えないので、Writer が先に引用符の部分を消す。
  // WHY SQLSTATE と constraint を出す: message の制約の名前（引用符の中）は *** になるので、何の失敗か（23505・23503 など）とどの
  //   制約かはこの 2 つで引く。どちらも DB が決める名前・コードで、入力値を含まない。文字列でないとき（想定外）は出さない。
  // WHY cause が Error でなければ DrizzleQueryError の name（type）と params だけを出す: drizzle は pg の例外を cause に入れるが、
  //   想定外の形のときに DrizzleQueryError の message（SQL と値）を出さない（fail closed）。
  private failureFields(error: unknown): {
    error: unknown;
    statusCode?: string;
    constraint?: string;
    params?: readonly unknown[];
  } {
    if (!(error instanceof DrizzleQueryError)) {
      return { error };
    }
    if (!(error.cause instanceof Error)) {
      return { error: { type: error.name }, params: error.params };
    }
    const { name, message, code, constraint } = error.cause as Error & {
      code?: unknown;
      constraint?: unknown;
    };
    return {
      error: { type: name, message: this.maskQuoted(message) },
      statusCode: typeof code === "string" ? code : undefined,
      constraint: typeof constraint === "string" ? constraint : undefined,
      params: error.params,
    };
  }

  // message の最初の " から最後の " までを "***" にする（" が 1 つだけならその後ろをすべて *** にする。" が無ければそのまま）。
  // WHY 最初から最後までを 1 つにまとめる（"..." の組ごとに置き換えない）: pg は入力値の中の " を逃がさずに "<入力>" と書く
  //   （入力 ab"cd x → invalid input syntax for type uuid: "ab"cd x"。2026-10-01 実測）。組ごとに置き換えると "ab" だけが消え、
  //   cd x が残る。入力値はどれも " で囲まれるので、最初と最後の " の間に必ず収まる。
  // 限界: 引用符の中の識別子（列名・制約名・表名）も消える（not-null 違反の列名など）。制約名は constraint、表名は db.collection.name に
  //   別に出る。引用符で囲まない形の入力値は消えない（実測した 22003 の numeric field overflow などは値を含まない。logger の freeText が
  //   最後の網）。
  private maskQuoted(message: string): string {
    const first = message.indexOf('"');
    if (first === -1) {
      return message;
    }
    const last = message.lastIndexOf('"');
    return last === first
      ? `${message.slice(0, first)}"***`
      : `${message.slice(0, first)}"***"${message.slice(last + 1)}`;
  }

  // start の時点（performance.now()）からの経過時間（ミリ秒の整数に四捨五入）。
  // WHY performance.now（Clock.now() にしない）: 経過時間の計測で、時刻ではない（単調に増え、時計の補正で戻らない）。現在時刻の
  //   唯一の出口 Clock.now() の規則 now-single-source の対象外（rule-tests/architecture.test.ts）。
  // WHY 整数に丸める: ミリ秒未満は書き込みの遅さの判断に要らず、浮動小数の桁（12.300000000000182 のような）で行が読みにくくなる。
  private elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }
}
