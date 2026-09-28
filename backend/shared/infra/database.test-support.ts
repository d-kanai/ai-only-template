import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import type { Database } from "@/backend/shared/infra/database";

// 実 Postgres を使う単体テスト（*.postgres.test.ts など）のための、テスト専用の DB を用意する部品。
// 本番のコードからは使わない（ファイル名の .test-support が目印）。
//
// WHY テストファイルごとに別のスキーマを作る: Vitest はテストファイルを並列に実行する（Stryker はさらに複数の
//   プロセスで同じテストを並行して実行する）。全員が public.todos を使うと、あるファイルの TRUNCATE が別のファイルの
//   途中のデータを消し、結果が実行のタイミングで変わる。スキーマを分ければ、同じ DB の中でも表が別になる。
//   あわせて、pnpm dev・E2E が使う public の表をテストが消すこともなくなる。
// WHY search_path でスキーマを切り替える: アプリのコード（Drizzle のスキーマ・生成した SQL）は表名をスキーマなしで
//   書いている（"todos"）。接続ごとに search_path をテスト用のスキーマにすれば、コードを変えずにその中の表を使う。
// WHY スキーマ名に UUID を入れる: 同じテストファイルが同時に複数動いても（Stryker）名前が重ならないようにする。
//   後始末（close）で消す。プロセスが afterAll の前に止まったとき（Stryker が worker を止める、Ctrl-C など）は残るので、
//   Vitest の実行の最初に globalSetup（vitest.global-setup.ts）が cleanupTestSchemas で消す。

// createTestDatabase が作るスキーマの名前の接頭辞。cleanupTestSchemas はこれで始まるスキーマを消す。
export const TEST_SCHEMA_PREFIX = "test_";

// DATABASE_URL が無いときの接続先。compose.yaml の開発用 DB（.env.example と同じ値。開発用で秘密ではない）。
// WHY 既定値を持つ: `pnpm db:up` しておけば、環境変数を渡さずに pnpm test を実行できるようにする。
export const LOCAL_DATABASE_URL = "postgresql://app:app@localhost:5432/app";

export type TestDatabase = {
  // テスト用のスキーマを search_path にした接続の db。
  db: Database;
  // 接続先の URL（search_path の指定は含まない）。
  url: string;
  // drizzle/ のマイグレーションをテスト用のスキーマに当てる。
  migrate(): Promise<void>;
  // テスト用のスキーマを消し、接続を閉じる。
  close(): Promise<void>;
};

// 未設定・空文字なら LOCAL_DATABASE_URL。
export function testDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  return env.DATABASE_URL || LOCAL_DATABASE_URL;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const url = testDatabaseUrl(process.env);
  const schema = `${TEST_SCHEMA_PREFIX}${randomUUID().replaceAll("-", "")}`;
  // max 4: DrizzleTransactionRunner のテストが「トランザクションの中」と「外」の 2 本を同時に使うため、2 以上にする。
  // options: 接続の開始時に Postgres に渡す設定（node-postgres の options）。search_path をテスト用のスキーマだけにする。
  const pool = new Pool({
    connectionString: url,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  await pool.query(`create schema ${schema}`);
  const db = drizzle({ client: pool });
  return {
    db,
    url,
    // migrationsSchema: 当てた記録の表（__drizzle_migrations）もテスト用のスキーマに置く。既定の drizzle スキーマに置くと、
    //   pnpm db:migrate の記録と混ざり、「当て済み」と判断されてテスト用のスキーマに表が作られない。
    migrate: () =>
      migrate(db, { migrationsFolder: "drizzle", migrationsSchema: schema }),
    close: async () => {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    },
  };
}

// prefix で始まるスキーマを中の表ごとすべて消し、消した名前を返す。Postgres に接続できなければ、起動を促すエラーにする。
// vitest.global-setup.ts が Vitest の実行の最初（テストファイルを動かす前）に TEST_SCHEMA_PREFIX で呼ぶ。
// WHY LIKE ではなく starts_with で探す: LIKE の "_" は任意の 1 文字に一致するので、'test_%' は "testX..." のような
//   テスト用でないスキーマにも一致してしまう。
// WHY Stryker の worker の中（STRYKER_MUTATOR_WORKER。Stryker が子プロセスに渡す環境変数。@stryker-mutator/core 10.0.0 の
//   child-process-proxy.js で確認）では消さない: Stryker は複数の worker（それぞれ 1 つの Vitest）を並行して動かし、
//   worker を途中で作り直すこともある。後から始まった worker の globalSetup が、他の worker が使っている途中の
//   スキーマを消すと、そのテストが変異と関係なく失敗する。Stryker の後に残ったものは、次の pnpm test で消える
//   （GitHub Actions の日次実行はランナーごと捨てるので残っても害がない）。
// WHY 接続できないときに専用のエラーにする: pnpm test は Postgres が起動している前提（rules/code/test.md）。
//   各テストファイルの ECONNREFUSED が並ぶより、最初に「起動していない」と分かる方が早く直せる。
export async function cleanupTestSchemas(
  env: Record<string, string | undefined>,
  prefix: string,
): Promise<string[]> {
  const url = testDatabaseUrl(env);
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end();
    throw new Error(
      `Postgres（${url}）に接続できません。単体テストは Postgres が必要です。pnpm db:up で起動してから実行してください`,
      { cause: error },
    );
  }
  try {
    if (env.STRYKER_MUTATOR_WORKER) {
      return [];
    }
    const result = await client.query<{ name: string }>(
      "select schema_name as name from information_schema.schemata where starts_with(schema_name, $1)",
      [prefix],
    );
    const names = result.rows.map((row) => row.name);
    for (const name of names) {
      // escapeIdentifier: 識別子として引用する（名前に記号が入っていても 1 つのスキーマ名として扱う）。
      await client.query(
        `drop schema ${client.escapeIdentifier(name)} cascade`,
      );
    }
    return names;
  } finally {
    await client.end();
  }
}
