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
  // DB 側のタイムアウト（ミリ秒。0 は送らず DB 側の既定に従う）。値の意味と WHY は .env.example の DATABASE_*_TIMEOUT_MS。
  statementTimeoutMillis: number;
  lockTimeoutMillis: number;
  idleInTransactionSessionTimeoutMillis: number;
};

export type DatabaseHandle = { db: Database; pool: Pool };

// プロセスで 1 つだけ持つプールの置き場所。
// WHY globalThis に置く: next dev はファイルの変更でモジュールを読み込み直す（HMR）。モジュールの変数に置くと、
//   読み込み直すたびに新しいプールができ、古いプールの接続が閉じられずに残って max_connections を食いつぶす。
//   globalThis はモジュールの読み込み直しでは消えないので、同じプールを使い続けられる。
const holder = globalThis as typeof globalThis & {
  __appDatabase?: DatabaseHandle;
};

// プール（と Drizzle の db）の作成と、プロセスで 1 つだけ持つプールの取得・終了。
// WHY クラスの static メソッドにする（インスタンスにしない）: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。状態（プール）は上の holder（globalThis）に置き、モジュールの
//   読み直し（next dev の HMR）でも同じプールを返す。インスタンスに持たせると、読み直しのたびに別のインスタンスができ、
//   状態を globalThis に置くことに変わりはないので、static にして api ファイルの組み立て（AppDatabase.get().db）を短く保つ。
export class AppDatabase {
  // WHY プールを自分で作って drizzle に渡す（drizzle({ connection }) に任せない）: プールの設定と error ハンドラの登録、
  //   終了（pool.end）をこのファイルで扱うため。
  // WHY createPool を引数で受け取る: テストで pg.Pool を差し替え、渡した設定と error ハンドラの登録を確かめるため。
  static create(
    config: DatabaseConfig,
    createPool: (config: PoolConfig) => Pool = (poolConfig) =>
      new Pool(poolConfig),
  ): DatabaseHandle {
    // WHY DB 側のタイムアウトを Pool の設定（接続パラメータ）で渡す（クエリごとに SET しない）: node-postgres は接続を作るときに
    //   起動メッセージで statement_timeout などを送り、その接続のセッションの既定値になる（pg 8.23.0 の client.js の
    //   getStartupConf）。往復が増えず、トランザクションの中の文（SET LOCAL で上書きしない限り）にも効く。
    // WHY 3 つとも置く（Issue #58。2026-10-01 の調査）: プールは 1 インスタンス数本（infra/modules/app/run.tf）しかなく、DB 側に
    //   上限が無いと、遅い文・ロック待ち（findByIdForUpdate の FOR UPDATE）・COMMIT し忘れたトランザクションが接続を握り続け、
    //   残りのリクエストが接続待ち（DATABASE_CONNECTION_TIMEOUT_MS）で一斉に失敗する。DB が打ち切れば接続はプールに戻る。
    const pool = createPool({
      connectionString: config.connectionString,
      max: config.max,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      statement_timeout: config.statementTimeoutMillis,
      lock_timeout: config.lockTimeoutMillis,
      idle_in_transaction_session_timeout:
        config.idleInTransactionSessionTimeoutMillis,
    });
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

  // プロセスで 1 つだけのプール（と db）を返す。無ければ env の設定で作る。api ファイルの組み立て（AppDatabase.get().db）が使う。
  static get(): DatabaseHandle {
    holder.__appDatabase ??= AppDatabase.create({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
      statementTimeoutMillis: env.DATABASE_STATEMENT_TIMEOUT_MS,
      lockTimeoutMillis: env.DATABASE_LOCK_TIMEOUT_MS,
      idleInTransactionSessionTimeoutMillis:
        env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
    return holder.__appDatabase;
  }

  // プールを閉じる（接続をすべて切る）。テストの後始末や、プロセスを終える前に使う。
  static async close(): Promise<void> {
    const database = holder.__appDatabase;
    if (database === undefined) {
      return;
    }
    holder.__appDatabase = undefined;
    await database.pool.end();
  }
}
