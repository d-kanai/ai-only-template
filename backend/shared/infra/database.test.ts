// @vitest-environment node
import { sql } from "drizzle-orm";
import type { Pool, PoolConfig } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  closeDatabase,
  createDatabase,
  getDatabase,
  readDatabaseConfig,
} from "@/backend/shared/infra/database";
import { createTestDatabase } from "@/backend/shared/infra/database.test-support";

const URL = "postgresql://app:app@localhost:5432/app";

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

describe("readDatabaseConfig", () => {
  test("DATABASE_URL だけなら、プールの設定は既定値（最大 10 接続・アイドル 10 秒・接続待ち 5 秒）", () => {
    expect(readDatabaseConfig({ DATABASE_URL: URL })).toEqual({
      connectionString: URL,
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  test("DATABASE_POOL_MAX / DATABASE_POOL_IDLE_TIMEOUT_MS / DATABASE_CONNECTION_TIMEOUT_MS で上書きできる", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: URL,
        DATABASE_POOL_MAX: "3",
        DATABASE_POOL_IDLE_TIMEOUT_MS: "0",
        DATABASE_CONNECTION_TIMEOUT_MS: "1500",
      }),
    ).toEqual({
      connectionString: URL,
      max: 3,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 1_500,
    });
  });

  test("空文字の上書きは未設定と同じに扱い、既定値を使う", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: URL,
        DATABASE_POOL_MAX: "",
        DATABASE_POOL_IDLE_TIMEOUT_MS: "",
        DATABASE_CONNECTION_TIMEOUT_MS: "",
      }),
    ).toMatchObject({
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  test.each([
    ["未設定", {}],
    ["空文字", { DATABASE_URL: "" }],
  ])("DATABASE_URL が%sならエラーにする", (_label, env) => {
    expect(() => readDatabaseConfig(env)).toThrow("DATABASE_URL");
  });

  test.each([
    ["DATABASE_POOL_MAX", "abc"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "1.5"],
    ["DATABASE_POOL_IDLE_TIMEOUT_MS", "-1"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "10s"],
  ])("%s=%s のように数として使えない値はエラーにする", (name, value) => {
    expect(() =>
      readDatabaseConfig({ DATABASE_URL: URL, [name]: value }),
    ).toThrow(name);
  });

  test("DATABASE_CONNECTION_TIMEOUT_MS=0（無制限）は明示すれば受け付ける", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: URL,
        DATABASE_CONNECTION_TIMEOUT_MS: "0",
      }).connectionTimeoutMillis,
    ).toBe(0);
  });
});

describe("createDatabase", () => {
  test("設定をそのままプールに渡す", () => {
    const pool = fakePool();
    const config = readDatabaseConfig({ DATABASE_URL: URL });

    createDatabase(config, pool.create);

    expect(pool.configs).toEqual([config]);
  });

  test("アイドル中の接続のエラーはログに出すだけで、プロセスを落とさない（error ハンドラを登録する）", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const pool = fakePool();
    createDatabase(readDatabaseConfig({ DATABASE_URL: URL }), pool.create);
    const error = new Error(
      "terminating connection due to administrator command",
    );

    const handler = pool.handlers.get("error");
    expect(handler).toBeDefined();
    expect(() => handler?.(error)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("アイドル中の接続"),
      error,
    );
  });

  test("プールを省略すると node-postgres の Pool を作る（作るだけでは接続しない）", async () => {
    const { pool } = createDatabase(readDatabaseConfig({ DATABASE_URL: URL }));

    expect(pool.options.max).toBe(10);
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });

  test("作った db で実際にクエリを実行できる", async () => {
    const database = await createTestDatabase();
    try {
      const { db, pool } = createDatabase(
        readDatabaseConfig({ DATABASE_URL: database.url }),
      );
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
    const first = getDatabase({ DATABASE_URL: URL });
    const second = getDatabase({ DATABASE_URL: URL });

    expect(second).toBe(first);
    expect(second.pool).toBe(first.pool);
  });

  test("プロセス全体（globalThis）で 1 つだけ保持する", () => {
    const database = getDatabase({ DATABASE_URL: URL });

    expect((globalThis as { __appDatabase?: unknown }).__appDatabase).toBe(
      database,
    );
  });

  test("closeDatabase でプールを閉じ、次の getDatabase は新しいプールを作る", async () => {
    const first = getDatabase({ DATABASE_URL: URL });
    const end = vi.spyOn(first.pool, "end");

    await closeDatabase();
    const second = getDatabase({ DATABASE_URL: URL });

    expect(end).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
  });

  test("プールが無いときの closeDatabase は何もしない", async () => {
    await expect(closeDatabase()).resolves.toBeUndefined();
    expect(
      (globalThis as { __appDatabase?: unknown }).__appDatabase,
    ).toBeUndefined();
  });

  test("DATABASE_URL が無ければエラーにし、プールを作らない", () => {
    expect(() => getDatabase({})).toThrow("DATABASE_URL");
    expect(
      (globalThis as { __appDatabase?: unknown }).__appDatabase,
    ).toBeUndefined();
  });
});
