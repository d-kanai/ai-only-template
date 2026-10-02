import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { env } from "@repo/shared/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import type { Database } from "../shared/infra/database";

// 実 Postgres を使う単体テスト（*.postgres.test.ts など）のための、テスト専用の DB を用意する部品。
// 本番のコードからは使わない。test-support/ に置くのが目印で、本番のコードからの import は rule-tests/test-support.test.ts が止め、
// Docker のイメージには入らない（.dockerignore の **/test-support。deploy.yml が push したイメージで確かめる）。
//
// WHY テストファイルごとに別のスキーマを作る: Vitest はテストファイルを並列に実行する（Stryker はさらに複数の
//   プロセスで同じテストを並行して実行する）。全員が public.todos を使うと、あるファイルの TRUNCATE が別のファイルの
//   途中のデータを消し、結果が実行のタイミングで変わる。スキーマを分ければ、同じ DB の中でも表が別になる。
//   あわせて、pnpm dev・E2E が使う public の表をテストが消すこともなくなる。
// WHY search_path でスキーマを切り替える: アプリのコード（Drizzle のスキーマ・生成した SQL）は表名をスキーマなしで
//   書いている（"todos"）。接続ごとに search_path をテスト用のスキーマにすれば、コードを変えずにその中の表を使う。
// WHY スキーマ名に UUID を入れる: 同じテストファイルが同時に複数動いても（Stryker）名前が重ならないようにする。
//   後始末（close）で消す。プロセスが afterAll の前に止まったとき（Stryker が worker を止める、Ctrl-C など）は残るので、
//   Vitest の実行の最初に globalSetup（vitest.global-setup.ts）が TestDatabase.cleanupSchemas で消す。
// WHY クラスにする（Issue #262。以前は関数 createTestDatabase・cleanupTestSchemas・testSchemaPrefix）: テストの補助も最上位に関数を
//   置かない（ADR docs/adr/architecture/20261002-class-based-shared-and-test-support.md。rule-tests/architecture.test.ts の
//   class-based）。作ったものは TestDatabase のインスタンス（db・pool・url と migrate・close）で、作り方と後始末は static メソッド。
//   以前の戻り値の型の名前 TestDatabase をクラスの名前にし、テストの `let database: TestDatabase` をそのまま使えるようにした。

// cleanupSchemas の設定。vitest.global-setup.ts が env / toolEnv（env.ts）から渡す。
// WHY 引数で受け取る（ここで env / toolEnv を読まない）: 接続できないときと Stryker の worker の中のときの分岐を、
//   テストで値を変えて確かめるため。
export type CleanupOptions = {
  // 接続先（env.DATABASE_URL）。
  databaseUrl: string;
  // Stryker の worker の中で動いているか（toolEnv.STRYKER_MUTATOR_WORKER）。
  insideStrykerWorker: boolean;
};

export class TestDatabase {
  // WHY private: 作るのは create だけ（スキーマを作ってから渡す。スキーマの無いインスタンスを作らせない）。
  private constructor(
    // テスト用のスキーマを search_path にした接続の db。
    readonly db: Database,
    // db が使う node-postgres の Pool（search_path はテスト用のスキーマ）。
    // WHY db とは別に持つ: Repository が発行した文の数を数えるテスト（todo-repository.postgres.test.ts の read skew）が
    //   Pool の query を spy する。Database 型（NodePgDatabase）は $client を型に持たないので、db から取ると型を崩すことになる。
    readonly pool: Pool,
    // 接続先の URL（search_path の指定は含まない）。
    readonly url: string,
    private readonly schema: string,
  ) {}

  // create が作るスキーマの名前の接頭辞。cleanupSchemas はこれで始まるスキーマを消す。
  // WHY メソッドの中に置く（モジュールの最上位の定数やクラスの static フィールドにしない）: 最上位の式は読み込み時にだけ評価される
  //   static な変異になり、mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで
  //   検出できる（Issue #55）。static フィールドの初期化も読み込み時の評価なので同じ（ADR 20261002-class-based-shared-and-test-support.md）。
  static schemaPrefix(): string {
    return "test_";
  }

  // 接続先は env の DATABASE_URL（アプリと同じ。.env / 環境変数から env.ts が読んで検証した値で、既定値は無い）。
  static async create(): Promise<TestDatabase> {
    const url = env.DATABASE_URL;
    const schema = `${TestDatabase.schemaPrefix()}${randomUUID().replaceAll("-", "")}`;
    // max 4: 以前はトランザクションの runner のテストが「トランザクションの中」と「外」の 2 本を同時に使うため 2 以上にしていた
    //   （Issue #123 で runner を廃止）。値はそのまま残す（下げる理由が無く、同時に複数の接続を使うテストを足しても
    //   接続待ちで止まらない）。
    // options: 接続の開始時に Postgres に渡す設定（node-postgres の options）。search_path をテスト用のスキーマだけにする。
    const pool = new Pool({
      connectionString: url,
      max: 4,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`create schema ${schema}`);
    return new TestDatabase(drizzle({ client: pool }), pool, url, schema);
  }

  // drizzle/ のマイグレーションをテスト用のスキーマに当てる。
  // migrationsFolder: apps/backend/shared/drizzle/（このファイルから ../shared/drizzle。Issue #98 で apps/backend 直下の drizzle/ から移し、
  //   Issue #181 でこのファイルを apps/backend/shared/infra/ から apps/backend/test-support/ に移した）。
  //   WHY このファイルの場所から決める: カレントディレクトリからのパス（"drizzle"）だと、ディレクトリを apps/backend に
  //   移したとき（Issue #68）や、テストをリポジトリ直下以外から動かしたときに見つからない。このファイルは Vitest だけが
  //   読み込み（Next のバンドルには入らない）、import.meta.dirname は元のファイルの場所を指す。
  // migrationsSchema: 当てた記録の表（__drizzle_migrations）もテスト用のスキーマに置く。既定の drizzle スキーマに置くと、
  //   pnpm db:migrate の記録と混ざり、「当て済み」と判断されてテスト用のスキーマに表が作られない。
  async migrate(): Promise<void> {
    await migrate(this.db, {
      migrationsFolder: join(import.meta.dirname, "..", "shared", "drizzle"),
      migrationsSchema: this.schema,
    });
  }

  // テスト用のスキーマを消し、接続を閉じる。
  async close(): Promise<void> {
    await this.pool.query(`drop schema ${this.schema} cascade`);
    await this.pool.end();
  }

  // prefix で始まるスキーマを中の表ごとすべて消し、消した名前を返す。Postgres に接続できなければ、起動を促すエラーにする。
  // vitest.global-setup.ts が Vitest の実行の最初（テストファイルを動かす前）に TestDatabase.schemaPrefix() で呼ぶ。
  // WHY LIKE ではなく starts_with で探す: LIKE の "_" は任意の 1 文字に一致するので、'test_%' は "testX..." のような
  //   テスト用でないスキーマにも一致してしまう。
  // WHY Stryker の worker の中（STRYKER_MUTATOR_WORKER。Stryker が子プロセスに渡す環境変数。@stryker-mutator/core 10.0.0 の
  //   child-process-proxy.js で確認）では消さない: Stryker は複数の worker（それぞれ 1 つの Vitest）を並行して動かし、
  //   worker を途中で作り直すこともある。後から始まった worker の globalSetup が、他の worker が使っている途中の
  //   スキーマを消すと、そのテストが変異と関係なく失敗する。Stryker の後に残ったものは、次の pnpm test で消える
  //   （GitHub Actions の日次実行はランナーごと捨てるので残っても害がない）。
  // WHY 接続できないときに専用のエラーにする: pnpm test は Postgres が起動している前提（.claude/rules/testing.md）。
  //   各テストファイルの ECONNREFUSED が並ぶより、最初に「起動していない」と分かる方が早く直せる。
  static async cleanupSchemas(
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
      // WHY 英語の文言: apps/backend の非テストコード（*.test.ts 以外）には自然言語の日本語を置かない（Issue #116）。
      throw new Error(
        `cannot connect to Postgres (${url}). Unit tests need Postgres: start it with pnpm db:up and run again`,
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
}
