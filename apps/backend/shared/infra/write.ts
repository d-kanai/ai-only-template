import { logger } from "@repo/shared/logger";
import { DrizzleQueryError, getTableName, type Table } from "drizzle-orm";
import type { ChangeOperation } from "../domain/change-operation";
import { type ChangeEntry, recordChange } from "./change-log";
import type { Database } from "./database";

// Repository（*.postgres.ts）の書き込み（insert / update / delete）の唯一の入口（Issue #205。ADR
//   docs/adr/architecture/20260930-repository-write-log.md）。トランザクションを張り、本体の書き込みと変更履歴（change_logs。
//   Issue #189）を同じトランザクションで書き、その前後に 1 行ずつログを出す。
// WHY 入口を 1 つにする: Repository が個別に logger を呼ぶと、書き込みを足すたびに書き忘れうる。ここを通れば必ず前後のログと
//   変更履歴が残る。*.postgres.ts が transaction / recordChange を直接呼ぶことは rule-tests/persistence.test.ts の
//   no-direct-transaction / no-direct-record-change が止め、書き込みのある *.postgres.ts がこのファイルを値で import することは
//   writes-through-write-in-transaction が見る。
// WHY change-log.ts と別のファイルにする: change-log.ts は記録の組み立て（InMemory の Repository も使う）で、ここはトランザクションと
//   ログ（Postgres の Repository だけが使う）。規則 writes-through-write-in-transaction が import で見分けられるよう、入口を別の
//   モジュールにする（change-log の import は InMemory 用の組み立てだけでも満たせてしまう）。

// 書き込みの対象（ログに出す、呼び出しの単位）。Repository の 1 回の save / delete が何をするか。
// WHY 表は Drizzle の表で受け取る（文字列にしない）: 名前を getTableName で DB の表名にし、Repository が表名を手書きしてずれない
//   ようにする。
// 集約の書き込みでは、根の表（todos）と根の id と操作を渡す。実際に書いた行（子表の行を含む）は、後のログの changes に出る。
export type WriteTarget = {
  table: Table;
  rowId: string;
  operation: ChangeOperation;
};

// db.transaction のコールバックが受け取る tx の型（drizzle-orm の NodePgTransaction）。
// WHY Database（NodePgDatabase）の型から取る: drizzle の型引数（スキーマ・リレーション）を手で書かず、db と必ず一致させる。
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// write（本体の書き込み）を db のトランザクションの中で実行し、write が返した記録を同じトランザクションの最後に
//   recordChange で change_logs に書く。前後に 1 行ずつ logger でログを出し、失敗なら warn を出して同じ例外を投げ直す。
// ログの形（Issue #209。ADR docs/adr/architecture/20260930-log-format-cloud-logging-otel.md。どれも event.name は db_write で、
//   db.collection.name（表名）・db.operation.name（操作）・row_id を持つ）:
//   - 前: info "db write start"（event.phase は start）
//   - 後: info "db write done"（event.phase は done）。event.duration_ms（所要時間）と changes（記録の table・row_id・operation）
//   - 失敗: warn "db write failed"（event.phase は failed）。event.duration_ms と error（logger が { type, message } にする）。
//     DB のエラーなら error は pg のエラーの name だけの { type } で、db.response.status_code（SQLSTATE）と constraint（制約の名前）を
//     出す（下の failureFields）
// WHY db.* の名前: OTel semconv の DB の属性（db.collection.name・db.operation.name・db.response.status_code。
//   https://opentelemetry.io/docs/specs/semconv/registry/attributes/db/ ）にそろえ、入れ子のオブジェクトにする（Logs Explorer で
//   jsonPayload.db.collection.name と書ける）。操作の名前は OTel の例（SELECT など）と違い、変更履歴と同じ insert / update / delete。
// WHY 段階を event.phase に入れる（event.name を db_write_start などに分けない）: 1 回の書き込みの前後を event.name="db_write" の
//   1 つの条件で引け、種類の一覧（apps/shared/log-event.ts）を段階の数だけ増やさずに済む。
// WHY duration_ms を event に入れる: その出来事（書き込み）の所要時間で、event の属性として種類と一緒に読む。
// WHY changes に値（before / after）を出さない: 個人情報を含みうる。値は change_logs に残る（リクエストログがクエリの値を
//   出さないのと同じ方針。ADR docs/adr/architecture/20260929-request-log-in-proxy.md）。
// WHY 失敗を warn にする（error にしない）: not_found（読み込んだ後に消された Todo の save）などの DomainError は 404 の正常な結果。
//   500 になる想定外の例外は presentation の toProblemResponse が logger.error で別に残す。
// WHY 記録をトランザクションの中で書く: 本体だけ・記録だけが残らない（記録の失敗で本体も戻り、COMMIT の失敗で記録も残らない。
//   write.test.ts と todo-repository.postgres.test.ts が固定する）。
export async function writeInTransaction(
  db: Database,
  target: WriteTarget,
  write: (tx: Transaction) => Promise<readonly ChangeEntry[]>,
): Promise<void> {
  const collection = { name: getTableName(target.table) };
  const operation = { name: target.operation };
  logger.info({
    message: "db write start",
    event: { name: "db_write", phase: "start" },
    db: { collection, operation },
    row_id: target.rowId,
  });
  const startedAt = performance.now();
  let entries: readonly ChangeEntry[];
  // WHY try は transaction だけを囲む: 失敗のログの対象は書き込み（本体・記録・COMMIT）の失敗だけ。後のログは外に置く。
  try {
    entries = await db.transaction(async (tx) => {
      const written = await write(tx);
      await recordChange(tx, written);
      return written;
    });
  } catch (error) {
    const failure = failureFields(error);
    logger.warn({
      message: "db write failed",
      event: {
        name: "db_write",
        phase: "failed",
        duration_ms: elapsedMs(startedAt),
      },
      db: {
        collection,
        operation,
        // WHY SQLSTATE が無ければ undefined（JSON.stringify がキーごと落とす）: DB のエラーでないとき・code が文字列でない
        //   ときに、空の response: {} を出さない。
        response:
          failure.statusCode === undefined
            ? undefined
            : { status_code: failure.statusCode },
      },
      row_id: target.rowId,
      constraint: failure.constraint,
      error: failure.error,
    });
    throw error;
  }
  logger.info({
    message: "db write done",
    event: {
      name: "db_write",
      phase: "done",
      duration_ms: elapsedMs(startedAt),
    },
    db: { collection, operation },
    row_id: target.rowId,
    // WHY snake_case の { table, row_id, operation } にする（ChangeEntry の tableName・rowId をそのまま出さない）: ログのキーは
    //   OTel の名前にそろえた snake_case で、行の中で表記を混ぜない。
    changes: entries.map(({ tableName, rowId, operation }) => ({
      table: tableName,
      row_id: rowId,
      operation,
    })),
  });
}

// 失敗のログに載せる例外。DB のエラー（drizzle-orm の DrizzleQueryError）は、元の pg のエラー（cause）の name（error.type）と、
//   SQLSTATE（statusCode → db.response.status_code）・制約の名前（constraint。pg の DatabaseError のプロパティ）だけにし、message は
//   出さない。それ以外（DomainError など）はそのまま（logger が { type, message } にする）。
// WHY DB のエラーの message を出さない: DrizzleQueryError の message は「Failed query: <SQL>\nparams: <値>」（drizzle-orm 0.45.3 の
//   errors.js）で、行の値（個人情報を含みうる）がログに出る。元の pg のエラーの message も、データ例外（SQLSTATE 22 系）は入力値を
//   含む（22P02 の invalid input syntax for type uuid: "<入力>"、22003 の value "<入力>" is out of range。Issue #205 の reviewer の
//   実測）。changes に値を出さないのと同じ方針。
// WHY SQLSTATE と constraint を出す: message が無くても、何の失敗か（23505 の一意制約違反・23503 の外部キー違反など）と、どの制約かを
//   引ける。どちらも DB が決める名前・コードで、入力値を含まない。文字列でないとき（想定外）は出さない。
// WHY cause が Error でなければ元の例外を出す: drizzle は pg の例外を cause に入れるが、想定外の形で何も出さないよりは
//   元の例外を残す（値が出うるのは、この想定外のときだけ）。
function failureFields(error: unknown): {
  error: unknown;
  statusCode?: string;
  constraint?: string;
} {
  if (!(error instanceof DrizzleQueryError && error.cause instanceof Error)) {
    return { error };
  }
  const { name, code, constraint } = error.cause as Error & {
    code?: unknown;
    constraint?: unknown;
  };
  return {
    error: { type: name },
    statusCode: typeof code === "string" ? code : undefined,
    constraint: typeof constraint === "string" ? constraint : undefined,
  };
}

// startedAt（performance.now()）からの経過時間（ミリ秒の整数に四捨五入）。
// WHY performance.now（now() にしない）: 経過時間の計測で、時刻ではない（単調に増え、時計の補正で戻らない）。現在時刻の
//   唯一の出口 now() の規則 now-single-source の対象外（rule-tests/architecture.test.ts）。
// WHY 整数に丸める: ミリ秒未満は書き込みの遅さの判断に要らず、浮動小数の桁（12.300000000000182 のような）で行が読みにくくなる。
function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
