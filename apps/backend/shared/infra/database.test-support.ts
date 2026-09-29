import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { env } from "@repo/shared/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import type { Database } from "./database";

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
// WHY 関数の中に置く（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる（Issue #55）。
export function testSchemaPrefix(): string {
  return "test_";
}

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

// 接続先は env の DATABASE_URL（アプリと同じ。.env / 環境変数から env.ts が読んで検証した値で、既定値は無い）。
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = env.DATABASE_URL;
  const schema = `${testSchemaPrefix()}${randomUUID().replaceAll("-", "")}`;
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
    // migrationsFolder: apps/backend/shared/drizzle/（このファイルから ../drizzle。Issue #98 で apps/backend 直下の drizzle/ から移した）。
    //   WHY このファイルの場所から決める: カレントディレクトリからのパス（"drizzle"）だと、ディレクトリを apps/backend に
    //   移したとき（Issue #68）や、テストをリポジトリ直下以外から動かしたときに見つからない。このファイルは Vitest だけが
    //   読み込み（Next のバンドルには入らない）、import.meta.dirname は元のファイルの場所を指す。
    // migrationsSchema: 当てた記録の表（__drizzle_migrations）もテスト用のスキーマに置く。既定の drizzle スキーマに置くと、
    //   pnpm db:migrate の記録と混ざり、「当て済み」と判断されてテスト用のスキーマに表が作られない。
    migrate: () =>
      migrate(db, {
        migrationsFolder: join(import.meta.dirname, "..", "drizzle"),
        migrationsSchema: schema,
      }),
    close: async () => {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    },
  };
}

// cleanupTestSchemas の設定。vitest.global-setup.ts が env / toolEnv（env.ts）から渡す。
// WHY 引数で受け取る（ここで env / toolEnv を読まない）: 接続できないときと Stryker の worker の中のときの分岐を、
//   テストで値を変えて確かめるため。
export type CleanupOptions = {
  // 接続先（env.DATABASE_URL）。
  databaseUrl: string;
  // Stryker の worker の中で動いているか（toolEnv.STRYKER_MUTATOR_WORKER）。
  insideStrykerWorker: boolean;
};

// prefix で始まるスキーマを中の表ごとすべて消し、消した名前を返す。Postgres に接続できなければ、起動を促すエラーにする。
// vitest.global-setup.ts が Vitest の実行の最初（テストファイルを動かす前）に testSchemaPrefix() で呼ぶ。
// WHY LIKE ではなく starts_with で探す: LIKE の "_" は任意の 1 文字に一致するので、'test_%' は "testX..." のような
//   テスト用でないスキーマにも一致してしまう。
// WHY Stryker の worker の中（STRYKER_MUTATOR_WORKER。Stryker が子プロセスに渡す環境変数。@stryker-mutator/core 10.0.0 の
//   child-process-proxy.js で確認）では消さない: Stryker は複数の worker（それぞれ 1 つの Vitest）を並行して動かし、
//   worker を途中で作り直すこともある。後から始まった worker の globalSetup が、他の worker が使っている途中の
//   スキーマを消すと、そのテストが変異と関係なく失敗する。Stryker の後に残ったものは、次の pnpm test で消える
//   （GitHub Actions の日次実行はランナーごと捨てるので残っても害がない）。
// WHY 接続できないときに専用のエラーにする: pnpm test は Postgres が起動している前提（.claude/rules/testing.md）。
//   各テストファイルの ECONNREFUSED が並ぶより、最初に「起動していない」と分かる方が早く直せる。
export async function cleanupTestSchemas(
  { databaseUrl: url, insideStrykerWorker }: CleanupOptions,
  prefix: string,
): Promise<string[]> {
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
    if (insideStrykerWorker) {
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
