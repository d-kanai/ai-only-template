// @vitest-environment node
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { env } from "@repo/shared/env";
import { Client } from "pg";
import { afterEach, describe, expect, test } from "vitest";
import { AppDatabase, type DatabaseHandle } from "./database";
import { DatabaseMigration } from "./migration";

// 実 Postgres（compose.yaml）に対して実行する。
// WHY テスト用のスキーマ（TestDatabase）ではなく、使い捨ての DB を作るか: 本番の migrate ジョブと同じく、当てた記録を
//   既定の drizzle スキーマ（drizzle.__drizzle_migrations）に置き、表を public に作るところまで確かめたい。共有の DB で既定の
//   スキーマに当てると、pnpm db:migrate の記録と混ざって「当て済み」になり、何も確かめられない。
const MIGRATIONS_FOLDER = join(import.meta.dirname, "migrations");
const createdDatabases: string[] = [];

class ScratchDatabase {
  // DATABASE_URL と同じサーバに空の DB を作り、その DB を指すアプリのプールを返す（後始末は afterEach）。
  static async create(): Promise<{ handle: DatabaseHandle; url: string }> {
    const name = `migration_test_${randomUUID().replaceAll("-", "")}`;
    await ScratchDatabase.admin(`create database ${name}`);
    createdDatabases.push(name);
    const url = new URL(env.DATABASE_URL);
    url.pathname = `/${name}`;
    const handle = AppDatabase.create({
      connectionString: url.toString(),
      max: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 5_000,
      statementTimeoutMillis: 0,
      lockTimeoutMillis: 0,
      idleInTransactionSessionTimeoutMillis: 0,
    });
    return { handle, url: url.toString() };
  }

  static async admin(statement: string): Promise<void> {
    const client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }

  // 別の接続で、表の一覧（public）と当てた記録の件数（drizzle.__drizzle_migrations）を読む。
  static async inspect(
    url: string,
  ): Promise<{ tables: string[]; applied: number }> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const tables = await client.query<{ name: string }>(
        "select table_name as name from information_schema.tables where table_schema = 'public' order by table_name",
      );
      const applied = await client.query<{ count: string }>(
        "select count(*) as count from drizzle.__drizzle_migrations",
      );
      return {
        tables: tables.rows.map((row) => row.name),
        applied: Number(applied.rows[0]?.count),
      };
    } finally {
      await client.end();
    }
  }
}

afterEach(async () => {
  for (const name of createdDatabases.splice(0)) {
    await ScratchDatabase.admin(`drop database if exists ${name} with (force)`);
  }
});

describe("DatabaseMigration.run", () => {
  test("空の DB に migrations/ の SQL をすべて当て、記録を drizzle.__drizzle_migrations に残し、プールを閉じる", async () => {
    // given
    const { handle, url } = await ScratchDatabase.create();

    // when
    await DatabaseMigration.run(handle, MIGRATIONS_FOLDER);

    // then
    await expect(ScratchDatabase.inspect(url)).resolves.toStrictEqual({
      tables: ["change_logs", "todo_status_changes", "todos"],
      applied: 4,
    });
    expect(handle.pool.ended).toBe(true);
  });

  test("当て済みの DB にもう一度実行しても何もしない（記録は増えない）", async () => {
    // given
    const first = await ScratchDatabase.create();
    await DatabaseMigration.run(first.handle, MIGRATIONS_FOLDER);
    const second = AppDatabase.create({
      connectionString: first.url,
      max: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 5_000,
      statementTimeoutMillis: 0,
      lockTimeoutMillis: 0,
      idleInTransactionSessionTimeoutMillis: 0,
    });

    // when
    await DatabaseMigration.run(second, MIGRATIONS_FOLDER);

    // then
    await expect(ScratchDatabase.inspect(first.url)).resolves.toStrictEqual({
      tables: ["change_logs", "todo_status_changes", "todos"],
      applied: 4,
    });
    expect(second.pool.ended).toBe(true);
  });

  test("マイグレーションが失敗しても、プールを閉じてから同じ例外で reject する（ジョブのプロセスが接続を残して止まらない）", async () => {
    // given
    const { handle } = await ScratchDatabase.create();
    const missingFolder = join(import.meta.dirname, "no-such-migrations");

    // when
    const promise = DatabaseMigration.run(handle, missingFolder);

    // then
    await expect(promise).rejects.toEqual(
      new Error("Can't find meta/_journal.json file"),
    );
    expect(handle.pool.ended).toBe(true);
  });
});
