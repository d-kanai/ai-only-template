// @vitest-environment node

import { env } from "@repo/shared/env";
import { sql } from "drizzle-orm";
import type { Pool, PoolConfig } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TestDatabase } from "../../test-support/database";
import { AppDatabase, type DatabaseConfig } from "./database";

// AppDatabase.create に渡す設定の例。接続先は架空（プールは作るだけなら接続しない）。
const CONFIG: DatabaseConfig = {
  connectionString: "postgresql://u:p@db.example:5432/x",
  max: 3,
  idleTimeoutMillis: 1_000,
  connectionTimeoutMillis: 1_500,
  statementTimeoutMillis: 2_000,
  lockTimeoutMillis: 500,
  idleInTransactionSessionTimeoutMillis: 4_000,
};

// pg.Pool の代わり。受け取った設定と、登録されたイベントハンドラ・end の呼び出しを記録する。
// WHY 差し替える: プールの設定値や error ハンドラの登録は、本物の Pool では外から確かめにくい（接続もしてしまう）。
function fakePool() {
  const handlers = new Map<string, (error: Error) => void>();
  const configs: PoolConfig[] = [];
  const end = vi.fn(async () => undefined);
  const create = (config: PoolConfig) => {
    configs.push(config);
    return {
      on: (event: string, handler: (error: Error) => void) => {
        handlers.set(event, handler);
      },
      end,
    } as unknown as Pool;
  };
  return { create, configs, handlers, end };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await AppDatabase.close();
});

describe("AppDatabase.create", () => {
  test("設定をプールに渡す（DB 側のタイムアウトは node-postgres の接続パラメータの名前にする）", () => {
    const pool = fakePool();
    AppDatabase.create(CONFIG, pool.create);

    expect(pool.configs).toEqual([
      {
        connectionString: "postgresql://u:p@db.example:5432/x",
        max: 3,
        idleTimeoutMillis: 1_000,
        connectionTimeoutMillis: 1_500,
        statement_timeout: 2_000,
        lock_timeout: 500,
        idle_in_transaction_session_timeout: 4_000,
      },
    ]);
  });

  test("アイドル中の接続のエラーはログに出すだけで、プロセスを落とさない（error ハンドラを登録する）", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const pool = fakePool();
    AppDatabase.create(CONFIG, pool.create);
    const error = new Error(
      "terminating connection due to administrator command",
    );

    const handler = pool.handlers.get("error");
    expect(handler).toBeDefined();
    expect(() => handler?.(error)).not.toThrow();
    // logger.emit（db_pool_error は ERROR なので中で console.error）が、文言・event.name（db_pool_error）と例外の type・message を 1 行の JSON で出す。
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR",
      time: expect.any(String),
      message: "idle Postgres connection error",
      event: { name: "db_pool_error" },
      error: {
        type: "Error",
        message: "terminating connection due to administrator command",
      },
    });
  });

  test("プールを省略すると node-postgres の Pool を作る（作るだけでは接続しない）", async () => {
    const { pool } = AppDatabase.create(CONFIG);

    expect(pool.options.max).toBe(3);
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });

  // WHY 実 Postgres で確かめる: node-postgres は 0 などの偽の値を接続パラメータに載せない（pg 8.23.0 の client.js の
  //   getStartupConf）。名前の取り違えや値の落ちは、DB のセッションの設定（SHOW）を見ないと分からない。
  test("DB 側のタイムアウトが接続ごとのセッションの設定になる", async () => {
    const database = await TestDatabase.create();
    try {
      const { pool } = AppDatabase.create({
        ...CONFIG,
        connectionString: database.url,
      });
      const shown = await pool.query(
        "select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock, current_setting('idle_in_transaction_session_timeout') as idle",
      );
      expect(shown.rows).toEqual([
        { statement: "2s", lock: "500ms", idle: "4s" },
      ]);
      await pool.end();
    } finally {
      await database.close();
    }
  });

  test("statement_timeout を超えたクエリは DB が打ち切る（SQLSTATE 57014 query_canceled）", async () => {
    const database = await TestDatabase.create();
    try {
      const { pool } = AppDatabase.create({
        ...CONFIG,
        connectionString: database.url,
        statementTimeoutMillis: 100,
      });
      await expect(pool.query("select pg_sleep(2)")).rejects.toMatchObject({
        code: "57014",
      });
      await pool.end();
    } finally {
      await database.close();
    }
  });

  test("作った db で実際にクエリを実行できる", async () => {
    const database = await TestDatabase.create();
    try {
      const { db, pool } = AppDatabase.create({
        ...CONFIG,
        connectionString: database.url,
      });
      const result = await db.execute(sql`select 1 as one`);
      expect(result.rows).toEqual([{ one: 1 }]);
      await pool.end();
    } finally {
      await database.close();
    }
  });
});

describe("AppDatabase.get / AppDatabase.close", () => {
  test("何度呼んでも同じプールを返す（next dev の再読み込みでプールを増やさない）", () => {
    const first = AppDatabase.get();
    const second = AppDatabase.get();

    expect(second).toBe(first);
    expect(second.pool).toBe(first.pool);
  });

  test("プロセス全体（globalThis）で 1 つだけ保持する", () => {
    const database = AppDatabase.get();

    expect((globalThis as { __appDatabase?: unknown }).__appDatabase).toBe(
      database,
    );
  });

  // WHY モジュールを読み直して確かめる: next dev の HMR はモジュールを評価し直すので、上の「何度呼んでも同じ」だけでは
  //   「モジュールの変数に置く実装」（読み直すたびに新しいプールができる）を見分けられない。vi.resetModules() で
  //   database.ts を別のモジュール実体として読み込み、それでも globalThis の同じプールが返ることを固定する（Issue #132）。
  test("モジュールを読み直しても（next dev の HMR 相当）、globalThis に置いた同じプールを返す", async () => {
    const before = AppDatabase.get();

    vi.resetModules();
    const reloaded = await import("./database");

    // 別のモジュール実体であること（読み直しが起きていないなら、この検査に意味がない）。
    expect(reloaded.AppDatabase.get).not.toBe(AppDatabase.get);
    expect(reloaded.AppDatabase.get()).toBe(before);
    expect(reloaded.AppDatabase.get().pool).toBe(before.pool);
  });

  test("AppDatabase.close でプールを閉じ、次の AppDatabase.get は新しいプールを作る", async () => {
    const first = AppDatabase.get();
    const end = vi.spyOn(first.pool, "end");

    await AppDatabase.close();
    const second = AppDatabase.get();

    expect(end).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
  });

  test("プールが無いときの AppDatabase.close は何もしない", async () => {
    await expect(AppDatabase.close()).resolves.toBeUndefined();
    expect(
      (globalThis as { __appDatabase?: unknown }).__appDatabase,
    ).toBeUndefined();
  });

  test("プールの設定は env（.env / 環境変数を env.ts で検証した値）から取る", () => {
    const { pool } = AppDatabase.get();

    expect(pool.options).toMatchObject({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      lock_timeout: env.DATABASE_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout:
        env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
  });
});
