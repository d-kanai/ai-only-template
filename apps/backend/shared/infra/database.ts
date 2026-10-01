import { env } from "@repo/shared/env";
import { logger } from "@repo/shared/logger";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

// Postgres への接続（node-postgres のプール）と、それを使う Drizzle の db を作る。
// 設定は env.ts の env（.env / 環境変数を検証した値）から取る。ここには既定値を置かない（WHY は env.ts）。
// 開発・CI・E2E 用の値は .env.example にあり、本番用の最終的な値（接続数・タイムアウト・TLS など）は Issue #58 で決める。

// Drizzle の db（プール全体）。Repository の実装がコンストラクタで受け取り、読み書きに使う。
// WHY トランザクションの型（以前の Transaction と、db との和の型）を置かない: Issue #123 で「command を一律にトランザクションで包む」
//   仕組みを廃止し、Repository は db だけを受け取る。複数の書き込みが要る command が出たら、そのときに型を足す
//   （.claude/rules/backend.md の「永続化（Drizzle + Postgres）」）。
export type Database = NodePgDatabase;

export type DatabaseConfig = {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
};

export type DatabaseHandle = { db: Database; pool: Pool };

// WHY プールを自分で作って drizzle に渡す（drizzle({ connection }) に任せない）: プールの設定と error ハンドラの登録、
//   終了（pool.end）をこのファイルで扱うため。
// WHY createPool を引数で受け取る: テストで pg.Pool を差し替え、渡した設定と error ハンドラの登録を確かめるため。
export function createDatabase(
  config: DatabaseConfig,
  createPool: (config: PoolConfig) => Pool = (poolConfig) =>
    new Pool(poolConfig),
): DatabaseHandle {
  const pool = createPool(config);
  // WHY error を受ける: プールに置いてあるアイドル中の接続が切れる（DB の再起動・ネットワーク断）と、Pool が
  //   'error' イベントを出す。リスナーが無いと Node の EventEmitter の規則で例外になり、プロセスが落ちる
  //   （node-postgres の Pool のドキュメント）。切れた接続はプールから捨てられ、次のクエリは新しい接続を作るので、
  //   ログに残して続ける。
  // WHY 英語の文言: ログは開発者が読むもので、apps/backend の非テストコードには自然言語の日本語を置かない（Issue #116）。
  pool.on("error", (error) => {
    // WHY event.name を db_pool_error にする（Issue #209）: 書き込みの失敗（db_write）と違い、どのリクエストにも属さない
    //   プールの接続の異常（DB の再起動・ネットワークの切断）で、頻発したら DB 側を見る合図になる。
    logger.emit({
      message: "idle Postgres connection error",
      event: { name: "db_pool_error" },
      error,
    });
  });
  return { db: drizzle({ client: pool }), pool };
}

// プロセスで 1 つだけ持つプールの置き場所。
// WHY globalThis に置く: next dev はファイルの変更でモジュールを読み込み直す（HMR）。モジュールの変数に置くと、
//   読み込み直すたびに新しいプールができ、古いプールの接続が閉じられずに残って max_connections を食いつぶす。
//   globalThis はモジュールの読み込み直しでは消えないので、同じプールを使い続けられる。
const holder = globalThis as typeof globalThis & {
  __appDatabase?: DatabaseHandle;
};

export function getDatabase(): DatabaseHandle {
  holder.__appDatabase ??= createDatabase({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
  });
  return holder.__appDatabase;
}

// プールを閉じる（接続をすべて切る）。テストの後始末や、プロセスを終える前に使う。
export async function closeDatabase(): Promise<void> {
  const database = holder.__appDatabase;
  if (database === undefined) {
    return;
  }
  holder.__appDatabase = undefined;
  await database.pool.end();
}
