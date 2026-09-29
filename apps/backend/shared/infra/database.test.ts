// @vitest-environment node

import { env } from "@repo/shared/env";
import { sql } from "drizzle-orm";
import type { Pool, PoolConfig } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  closeDatabase,
  createDatabase,
  type DatabaseConfig,
  getDatabase,
} from "./database";
import { createTestDatabase } from "./database.test-support";

// createDatabase に渡す設定の例。接続先は架空（プールは作るだけなら接続しない）。
const CONFIG: DatabaseConfig = {
  connectionString: "postgresql://u:p@db.example:5432/x",
  max: 3,
  idleTimeoutMillis: 1_000,
  connectionTimeoutMillis: 1_500,
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
  await closeDatabase();
});

describe("createDatabase", () => {
  test("設定をそのままプールに渡す", () => {
    const pool = fakePool();
    createDatabase(CONFIG, pool.create);

    expect(pool.configs).toEqual([CONFIG]);
  });

  test("アイドル中の接続のエラーはログに出すだけで、プロセスを落とさない（error ハンドラを登録する）", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const pool = fakePool();
    createDatabase(CONFIG, pool.create);
    const error = new Error(
      "terminating connection due to administrator command",
    );

    const handler = pool.handlers.get("error");
    expect(handler).toBeDefined();
    expect(() => handler?.(error)).not.toThrow();
    // logger.error（中で console.error）が、文言と例外の name・message を 1 行の JSON で出す。
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toEqual({
      level: "error",
      timestamp: expect.any(String),
      message: "Postgres のアイドル中の接続でエラーが発生しました",
      error: {
        name: "Error",
        message: "terminating connection due to administrator command",
      },
    });
  });

  test("プールを省略すると node-postgres の Pool を作る（作るだけでは接続しない）", async () => {
    const { pool } = createDatabase(CONFIG);

    expect(pool.options.max).toBe(3);
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });

  test("作った db で実際にクエリを実行できる", async () => {
    const database = await createTestDatabase();
    try {
      const { db, pool } = createDatabase({
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

describe("getDatabase / closeDatabase", () => {
  test("何度呼んでも同じプールを返す（next dev の再読み込みでプールを増やさない）", () => {
    const first = getDatabase();
    const second = getDatabase();

    expect(second).toBe(first);
    expect(second.pool).toBe(first.pool);
  });

  test("プロセス全体（globalThis）で 1 つだけ保持する", () => {
    const database = getDatabase();

    expect((globalThis as { __appDatabase?: unknown }).__appDatabase).toBe(
      database,
    );
  });

  test("closeDatabase でプールを閉じ、次の getDatabase は新しいプールを作る", async () => {
    const first = getDatabase();
    const end = vi.spyOn(first.pool, "end");

    await closeDatabase();
    const second = getDatabase();

    expect(end).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
  });

  test("プールが無いときの closeDatabase は何もしない", async () => {
    await expect(closeDatabase()).resolves.toBeUndefined();
    expect(
      (globalThis as { __appDatabase?: unknown }).__appDatabase,
    ).toBeUndefined();
  });

  test("プールの設定は env（.env / 環境変数を env.ts で検証した値）から取る", () => {
    const { pool } = getDatabase();

    expect(pool.options).toMatchObject({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
    });
  });
});
