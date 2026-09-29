import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { env } from "./env";
import { logger } from "./logger";

// Postgres への接続（node-postgres のプール）と、それを使う Drizzle の db を作る。
// 設定は env.ts の env（.env / 環境変数を検証した値）から取る。ここには既定値を置かない（WHY は env.ts）。
// 開発・CI・E2E 用の値は .env.example にあり、本番用の最終的な値（接続数・タイムアウト・TLS など）は Issue #58 で決める。

// Drizzle の db（プール全体）。query の読み取りや、トランザクションを始めるのに使う。
export type Database = NodePgDatabase;

// db.transaction が fn に渡すトランザクション。
// WHY 型を db.transaction から取り出す: drizzle-orm の NodePgTransaction はスキーマの型引数を 2 つ取り、
//   db（NodePgDatabase の既定の型引数）と一致させて書くのは drizzle の内部の型に依存する。
//   db.transaction の引数から取れば、drizzle の版を上げても db と必ず一致する。
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Repository が読み書きに使う相手。db（トランザクションの外）かトランザクションのどちらか。
// WHY 両方を受け取れるようにする: 同じ Repository の実装を、query ではトランザクションの外（db）で、
//   command ではトランザクションの中（tx）で使うため。どちらを渡すかは infra/container.ts が決める。
export type Executor = Database | Transaction;

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
  pool.on("error", (error) => {
    logger.error({
      message: "Postgres のアイドル中の接続でエラーが発生しました",
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
