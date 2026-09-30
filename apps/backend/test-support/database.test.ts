// @vitest-environment node

import { randomUUID } from "node:crypto";
import { env } from "@repo/shared/env";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { describe, expect, test, vi } from "vitest";
import {
  cleanupTestSchemas,
  createTestDatabase,
  testSchemaPrefix,
} from "./database";

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

  test("接続先は env の DATABASE_URL（.env / 環境変数。既定値は持たない）", async () => {
    const database = await createTestDatabase();
    try {
      expect(database.url).toBe(env.DATABASE_URL);
    } finally {
      await database.close();
    }
  });

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

  test("migrate で drizzle/ のマイグレーションをテスト用のスキーマに当てる（todos・完了の履歴・変更履歴の表ができる）", async () => {
    const database = await createTestDatabase();
    try {
      await database.migrate();
      const tables = await database.db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = current_schema() order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "__drizzle_migrations",
        "change_logs",
        "todo_status_changes",
        "todos",
      ]);
    } finally {
      await database.close();
    }
  });

  // WHY: drizzle-kit 0.31.11 の generate は外部キーを REFERENCES "public"."todos" と書くので、todo_status_changes の外部キーは
  //   手書きのマイグレーション（shared/drizzle/0002_*.sql）でスキーマを書かずに張る（Issue #188。features/todo/internal/infra/schema.ts）。
  //   public を指すと、テスト用のスキーマの Todo に履歴を足せず、テストのスキーマを消しても public の todos に参照が残る。
  test("migrate した外部キー（todo_status_changes → todos）は、テスト用のスキーマの todos を指す（public を指さない）", async () => {
    const database = await createTestDatabase();
    try {
      await database.migrate();
      const references = await database.db.execute<{
        referenced: string;
      }>(
        sql`select confrelid::regclass::text as referenced from pg_constraint where contype = 'f' and connamespace = current_schema()::regnamespace`,
      );
      // regclass の文字列は、search_path（テスト用のスキーマ）にある表ならスキーマを付けずに表の名前だけになる。
      expect(references.rows).toEqual([{ referenced: "todos" }]);
    } finally {
      await database.close();
    }
  });
});

// 実 Postgres（compose.yaml）に対して実行する。
// WHY 接頭辞を "test_" にせずテストごとに変える: cleanupTestSchemas("test_") をここで呼ぶと、並列に動いている
//   他のテストファイルのスキーマまで消してしまう。このテストだけが作るスキーマの接頭辞で確かめる。
describe("cleanupTestSchemas", () => {
  // 後始末する側の設定。接続先は単体テストと同じ DB で、Stryker の worker の外として動かす。
  const options = { databaseUrl: env.DATABASE_URL, insideStrykerWorker: false };

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: env.DATABASE_URL });
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
    return `${testSchemaPrefix()}cleanup_${randomUUID().replaceAll("-", "")}_`;
  }

  test("createTestDatabase が作るスキーマの接頭辞は test_", () => {
    expect(testSchemaPrefix()).toBe("test_");
  });

  test("接頭辞で始まるスキーマを、中の表ごとすべて消し、消した名前を返す", async () => {
    const prefix = uniquePrefix();
    await withClient(async (client) => {
      await client.query(`create schema ${prefix}a`);
      await client.query(`create table ${prefix}a.items (name text)`);
      await client.query(`create schema ${prefix}b`);
    });

    const dropped = await cleanupTestSchemas(options, prefix);

    expect([...dropped].sort()).toEqual([`${prefix}a`, `${prefix}b`]);
    await expect(schemasStartingWith(prefix)).resolves.toEqual([]);
  });

  test("接頭辞の _ は 1 文字の任意の文字（LIKE のワイルドカード）として扱わない", async () => {
    const prefix = uniquePrefix();
    // 接頭辞の最後の "_" の位置が別の文字のスキーマ。LIKE 'prefix%' だと "_" が任意の 1 文字に一致して消える。
    const lookalike = `${prefix.slice(0, -1)}x_keep`;
    await withClient((client) => client.query(`create schema ${lookalike}`));
    try {
      await expect(cleanupTestSchemas(options, prefix)).resolves.toEqual([]);
      await expect(schemasStartingWith(prefix.slice(0, -1))).resolves.toEqual([
        lookalike,
      ]);
    } finally {
      await withClient((client) =>
        client.query(`drop schema ${lookalike} cascade`),
      );
    }
  });

  test("Stryker の worker の中（toolEnv.STRYKER_MUTATOR_WORKER が true）では消さない（並行して動く他の worker のスキーマを消さないため）", async () => {
    const prefix = uniquePrefix();
    await withClient((client) => client.query(`create schema ${prefix}a`));
    try {
      await expect(
        cleanupTestSchemas({ ...options, insideStrykerWorker: true }, prefix),
      ).resolves.toEqual([]);
      await expect(schemasStartingWith(prefix)).resolves.toEqual([
        `${prefix}a`,
      ]);
    } finally {
      await cleanupTestSchemas(options, prefix);
    }
  });

  // 接続を閉じ忘れると、globalSetup の後も Postgres の接続が残る（テストの結果には出ないので、end の呼び出しで確かめる）。
  // spyOn は本物の end を呼んだうえで回数を数えるだけ（差し替えない）。
  test("終わったら接続を閉じる（Stryker の worker の中で何も消さないときも閉じる）", async () => {
    const end = vi.spyOn(Client.prototype, "end");
    try {
      await cleanupTestSchemas(options, uniquePrefix());
      expect(end).toHaveBeenCalledTimes(1);

      await cleanupTestSchemas(
        { ...options, insideStrykerWorker: true },
        uniquePrefix(),
      );
      expect(end).toHaveBeenCalledTimes(2);
    } finally {
      end.mockRestore();
    }
  });

  test("Postgres に接続できなければ、起動を促すエラーで失敗し、元の接続エラーを cause に残す", async () => {
    await expect(
      cleanupTestSchemas(
        {
          databaseUrl: "postgresql://u:p@127.0.0.1:1/x",
          insideStrykerWorker: false,
        },
        uniquePrefix(),
      ),
    ).rejects.toMatchObject({
      message:
        "cannot connect to Postgres (postgresql://u:p@127.0.0.1:1/x). Unit tests need Postgres: start it with pnpm db:up and run again",
      cause: expect.objectContaining({ code: "ECONNREFUSED" }),
    });
  });
});
