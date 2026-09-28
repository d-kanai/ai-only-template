// @vitest-environment node

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { describe, expect, test } from "vitest";
import {
  cleanupTestSchemas,
  createTestDatabase,
  LOCAL_DATABASE_URL,
  TEST_SCHEMA_PREFIX,
  testDatabaseUrl,
} from "@/backend/shared/infra/database.test-support";

describe("testDatabaseUrl", () => {
  test("DATABASE_URL があればそれを使う", () => {
    expect(
      testDatabaseUrl({ DATABASE_URL: "postgresql://u:p@db.example:5432/x" }),
    ).toBe("postgresql://u:p@db.example:5432/x");
  });

  test.each([
    ["未設定", {}],
    ["空文字", { DATABASE_URL: "" }],
  ])("DATABASE_URL が%sなら compose.yaml の開発用 DB を使う", (_label, env) => {
    expect(testDatabaseUrl(env)).toBe(
      "postgresql://app:app@localhost:5432/app",
    );
    expect(testDatabaseUrl(env)).toBe(LOCAL_DATABASE_URL);
  });
});

// 実 Postgres（compose.yaml）に対して実行する。
describe("createTestDatabase", () => {
  async function schemaExists(name: string): Promise<boolean> {
    const other = await createTestDatabase();
    try {
      const result = await other.db.execute<{ found: boolean }>(
        sql`select exists (select 1 from information_schema.schemata where schema_name = ${name}) as found`,
      );
      return result.rows[0]?.found === true;
    } finally {
      await other.close();
    }
  }

  test("テスト用のスキーマを作って search_path にし、close でスキーマごと消す", async () => {
    const database = await createTestDatabase();
    const current = await database.db.execute<{ schema: string }>(
      sql`select current_schema() as schema`,
    );
    const schema = current.rows[0]?.schema ?? "";

    expect(schema).toMatch(/^test_[0-9a-f]{32}$/);
    await expect(schemaExists(schema)).resolves.toBe(true);

    await database.close();

    await expect(schemaExists(schema)).resolves.toBe(false);
  });

  test("作るたびに別のスキーマになる（並行して動くテストの表が重ならない）", async () => {
    const first = await createTestDatabase();
    const second = await createTestDatabase();
    try {
      await first.db.execute(sql`create table items (name text)`);
      await first.db.execute(sql`insert into items values ('a')`);
      // 同じ名前の表を second にも作れる（別のスキーマ）。
      await second.db.execute(sql`create table items (name text)`);
      const rows = await second.db.execute(sql`select * from items`);
      expect(rows.rows).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("migrate で drizzle/ のマイグレーションをテスト用のスキーマに当てる（todos 表ができる）", async () => {
    const database = await createTestDatabase();
    try {
      await database.migrate();
      const tables = await database.db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = current_schema() order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "__drizzle_migrations",
        "todos",
      ]);
    } finally {
      await database.close();
    }
  });
});

// 実 Postgres（compose.yaml）に対して実行する。
// WHY 接頭辞を "test_" にせずテストごとに変える: cleanupTestSchemas("test_") をここで呼ぶと、並列に動いている
//   他のテストファイルのスキーマまで消してしまう。このテストだけが作るスキーマの接頭辞で確かめる。
describe("cleanupTestSchemas", () => {
  const env = { DATABASE_URL: LOCAL_DATABASE_URL };

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: testDatabaseUrl(env) });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function schemasStartingWith(prefix: string): Promise<string[]> {
    return withClient(async (client) => {
      const result = await client.query<{ name: string }>(
        "select schema_name as name from information_schema.schemata where starts_with(schema_name, $1) order by schema_name",
        [prefix],
      );
      return result.rows.map((row) => row.name);
    });
  }

  // test_ で始めておく: テストが途中で失敗して残っても、次の実行の globalSetup が消す。
  //   "test_cleanup_" の "l" は 16 進に無い文字なので、createTestDatabase のスキーマ（test_<16 進 32 桁>）とは重ならない。
  function uniquePrefix(): string {
    return `${TEST_SCHEMA_PREFIX}cleanup_${randomUUID().replaceAll("-", "")}_`;
  }

  test("createTestDatabase が作るスキーマの接頭辞は test_", () => {
    expect(TEST_SCHEMA_PREFIX).toBe("test_");
  });

  test("接頭辞で始まるスキーマを、中の表ごとすべて消し、消した名前を返す", async () => {
    const prefix = uniquePrefix();
    await withClient(async (client) => {
      await client.query(`create schema ${prefix}a`);
      await client.query(`create table ${prefix}a.items (name text)`);
      await client.query(`create schema ${prefix}b`);
    });

    const dropped = await cleanupTestSchemas(env, prefix);

    expect([...dropped].sort()).toEqual([`${prefix}a`, `${prefix}b`]);
    await expect(schemasStartingWith(prefix)).resolves.toEqual([]);
  });

  test("接頭辞の _ は 1 文字の任意の文字（LIKE のワイルドカード）として扱わない", async () => {
    const prefix = uniquePrefix();
    // 接頭辞の最後の "_" の位置が別の文字のスキーマ。LIKE 'prefix%' だと "_" が任意の 1 文字に一致して消える。
    const lookalike = `${prefix.slice(0, -1)}x_keep`;
    await withClient((client) => client.query(`create schema ${lookalike}`));
    try {
      await expect(cleanupTestSchemas(env, prefix)).resolves.toEqual([]);
      await expect(schemasStartingWith(prefix.slice(0, -1))).resolves.toEqual([
        lookalike,
      ]);
    } finally {
      await withClient((client) =>
        client.query(`drop schema ${lookalike} cascade`),
      );
    }
  });

  test("Stryker の worker の中（STRYKER_MUTATOR_WORKER がある）では消さない（並行して動く他の worker のスキーマを消さないため）", async () => {
    const prefix = uniquePrefix();
    await withClient((client) => client.query(`create schema ${prefix}a`));
    try {
      await expect(
        cleanupTestSchemas({ ...env, STRYKER_MUTATOR_WORKER: "1" }, prefix),
      ).resolves.toEqual([]);
      await expect(schemasStartingWith(prefix)).resolves.toEqual([
        `${prefix}a`,
      ]);
    } finally {
      await cleanupTestSchemas(env, prefix);
    }
  });

  test("Postgres に接続できなければ、起動を促すエラーで失敗する", async () => {
    await expect(
      cleanupTestSchemas(
        { DATABASE_URL: "postgresql://app:app@127.0.0.1:1/app" },
        uniquePrefix(),
      ),
    ).rejects.toThrow("pnpm db:up");
  });
});
