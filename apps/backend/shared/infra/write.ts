import { logger } from "@repo/shared/logger";
import { getTableName, type Table } from "drizzle-orm";
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
// ログの形（どれも table・rowId・operation を持つ）:
//   - 前: info "repository write start"
//   - 後: info "repository write done"。durationMs（所要時間）と changes（記録の tableName・rowId・operation）
//   - 失敗: warn "repository write failed"。durationMs と error（logger が { name, message } にする）
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
  const fields = {
    table: getTableName(target.table),
    rowId: target.rowId,
    operation: target.operation,
  };
  logger.info({ message: "repository write start", ...fields });
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
    logger.warn({
      message: "repository write failed",
      ...fields,
      durationMs: elapsedMs(startedAt),
      error,
    });
    throw error;
  }
  logger.info({
    message: "repository write done",
    ...fields,
    durationMs: elapsedMs(startedAt),
    changes: entries.map(({ tableName, rowId, operation }) => ({
      tableName,
      rowId,
      operation,
    })),
  });
}

// startedAt（performance.now()）からの経過時間（ミリ秒の整数に四捨五入）。
// WHY performance.now（now() にしない）: 経過時間の計測で、時刻ではない（単調に増え、時計の補正で戻らない）。現在時刻の
//   唯一の出口 now() の規則 now-single-source の対象外（rule-tests/architecture.test.ts）。
// WHY 整数に丸める: ミリ秒未満は書き込みの遅さの判断に要らず、浮動小数の桁（12.300000000000182 のような）で行が読みにくくなる。
function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
