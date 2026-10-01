import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@repo/shared/logger";
import { DatabaseError, type Pool, type QueryResult } from "pg";
import { closeDatabase, getDatabase } from "./database";

// データの移行（backfill。Issue #194）を流す。pnpm db:backfill（apps/backend/package.json）が main を呼ぶ。
// 決まり（置き場所・冪等・デプロイの切替の後に流す）は .claude/rules/backend.md の「永続化」、決定は
//   ADR docs/adr/workflow/20261001-backfill-after-traffic-switch.md。
// WHY スキーマの変更（drizzle のマイグレーション）と分けるか: マイグレーションはデプロイの切替の前に当てる（新しいコードが使う表・列を
//   先に作る）。データの移行を同じ所で流すと、切替までの間に旧アプリが書いた行（新しいコードの前提を満たさない行）が漏れる。
//   backfill は切替の後に流し、その行も補う（.github/workflows/deploy.yml の Run backfill）。
// WHY drizzle-kit migrate を使わず自前で流すか: drizzle の migrator は 1 回当てたファイルを二度と流さない（適用済みの記録表）。
//   backfill は切替の後に毎回流して、その回の切替までに旧アプリが書いた行も補う必要がある。
// WHY 適用の記録表を持たないか: SQL は冪等に書く（rule-tests/migration.test.ts が INSERT ... SELECT に WHERE NOT EXISTS か
//   ON CONFLICT DO NOTHING があることを確かめる）ので、毎回すべてを流してよい。記録表があると「1 回当てたら終わり」になり、上の
//   漏れを補えない。
// 限界: デプロイのたびにすべてのファイルを流すので、ファイルと行が増えるとデプロイが長くなり、流している間は対象の行をロックする
//   （0001_todo_status_changes.sql の FOR UPDATE）。全環境で流し終えて不要になったファイルは消す（消してよい時期は、すべての環境の
//   デプロイが 1 回以上成功した後）。

// backfill の SQL の置き場所（apps/backend/shared/drizzle/backfill/）。ファイル名は NNNN_<内容>.sql（rule-tests/migration.test.ts）。
export function backfillDirectory(): string {
  return join(import.meta.dirname, "..", "drizzle", "backfill");
}

// directory の .sql を名前順に返す。
// WHY 名前順: 後のファイルが前のファイルの結果を前提にできるよう、NNNN_ の番号で順を決める。
// WHY ディレクトリが無ければ投げる（空として扱わない）: イメージに SQL が入っていないのに、何も流さずに成功するのを防ぐ。
export function backfillFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

// directory の SQL ファイルを名前順に 1 つずつ流す。失敗したファイルで止め、例外を投げる（後のファイルは流さない）。
export async function runBackfills(
  pool: Pool,
  directory: string,
): Promise<void> {
  for (const name of backfillFiles(directory)) {
    await runFile(pool, name, readFileSync(join(directory, name), "utf8"));
  }
}

// 1 つのファイルを流し、前後と失敗を db_backfill のログに出す。
async function runFile(pool: Pool, name: string, sql: string): Promise<void> {
  logger.emit({
    message: "backfill start",
    event: { name: "db_backfill", phase: "start" },
    file: { name },
  });
  const startedAt = performance.now();
  try {
    const affectedRows = await inTransaction(pool, sql);
    logger.emit({
      message: "backfill done",
      event: {
        name: "db_backfill",
        phase: "done",
        duration_ms: elapsedMs(startedAt),
      },
      file: { name },
      affected_rows: affectedRows,
    });
  } catch (error) {
    logger.emit({
      message: "backfill failed",
      event: {
        name: "db_backfill",
        phase: "failed",
        duration_ms: elapsedMs(startedAt),
      },
      file: { name },
      // WHY DatabaseError のときだけ SQLSTATE を出す: 接続の失敗（ECONNREFUSED など）の code は SQLSTATE ではない。
      ...(error instanceof DatabaseError && error.code !== undefined
        ? { db: { response: { status_code: error.code } } }
        : {}),
      error,
    });
    throw error;
  }
}

// ファイルの SQL を 1 つのトランザクション（BEGIN〜COMMIT）で流し、足した・変えた行の数の合計を返す。失敗したら ROLLBACK して投げ直す。
// WHY 1 つのトランザクションにする: 途中の文で失敗したとき、前の文の結果だけが残る半端な状態にしない。直して流し直せば最初から当たる。
// WHY pool から 1 つの接続を取る（pool.query にしない）: BEGIN・SQL・COMMIT を同じ接続で送る必要がある。
// WHY 文字列のまま 1 回で送る（文に分けない）: pg はパラメータの無い query を simple query で送り、; で区切った複数の文を
//   そのまま実行して、文ごとの結果を配列で返す。SQL の中の ; を自前で区切ると、文字列やコメントの中の ; で壊れる。
async function inTransaction(pool: Pool, sql: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result: QueryResult | QueryResult[] = await client.query(sql);
    await client.query("COMMIT");
    return [result]
      .flat()
      .reduce((sum, statement) => sum + (statement.rowCount ?? 0), 0);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// startedAt（performance.now()）からの経過時間（ミリ秒の整数）。WHY performance.now: writer.ts の elapsedMs と同じ（時刻ではなく
//   経過時間なので now() の規則の対象外）。
function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

// pnpm db:backfill の本体。接続先は .env / 環境変数の DATABASE_URL（getDatabase が @repo/shared/env から読む）。
// 成功したら 0、ファイルが失敗したら 1 を返す（呼び出し側の package.json の script が process.exitCode にする）。
// WHY 失敗を握りつぶして 1 にする: 失敗は runFile が db_backfill の failed のログに出している。投げ直すと Node が同じ例外を
//   stderr にもう一度出す（stack 付きで、ログの形でない行）。
// ディレクトリが無い・読めない（backfillFiles の失敗）も runBackfills の中で投げられ、1 になる。db_backfill のログは出ない
//   （ファイルの名前が無い）が、終了コードでジョブは失敗する。
// WHY 最後にプールを閉じる: 閉じないと node のプロセスがアイドルの接続を持ったまま終わらない。
export async function main(
  directory: string = backfillDirectory(),
): Promise<number> {
  try {
    await runBackfills(getDatabase().pool, directory);
    return 0;
  } catch {
    return 1;
  } finally {
    await closeDatabase();
  }
}
