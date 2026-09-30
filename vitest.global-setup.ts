import { env, toolEnv } from "@repo/shared/env";
import {
  cleanupTestSchemas,
  testSchemaPrefix,
} from "./apps/backend/shared/infra/database.test-support";

// Vitest の globalSetup（vitest.config.mts の test.globalSetup）。テストファイルを動かす前に、Vitest のプロセスで 1 回だけ実行される。
// 前の実行が afterAll の前に止まって残ったテスト用のスキーマ（test_<UUID>。apps/backend/shared/infra/database.test-support.ts）を消す。
// Postgres に接続できなければ、ここで分かりやすいエラーにして止める（単体テストは Postgres が前提。.claude/rules/testing.md）。
// env.ts を読み込むので、.env が無い・必須の変数が欠けているときも、テストファイルを動かす前にここで欠けた名前を出して止まる。
// WHY ここ（テストの前）で消すか: テストファイルはまだ 1 つも動いていないので、消してよいのは前の実行の残りだけになる。
//   同じ理由で、Stryker の worker の中では消さない（他の worker が並行して動いているため。WHY は cleanupTestSchemas）。
// WHY env は "@repo/shared/env" で import する（Issue #68 の段階 2・Issue #90）: env.ts は frontend と backend で共通の workspace
//   パッケージ apps/shared にあり、リポジトリ直下のファイルも公開の入口（apps/shared/package.json の exports）からだけ使う
//   （rule-tests/architecture.test.ts の frontend-to-shared-specifier）。
// WHY database.test-support だけは相対パスで import する: テストのための処理で、パッケージの公開面（exports）に含めない
//   （exports はアプリの入口だけ）。exports に無いので @repo/backend では解決できない。このファイルからのこの参照だけを、
//   frontend-to-backend-specifier の例外（TEST_INFRA_RELATIVE_EXCEPTION）として許している。
// WHY 処理を database.test-support.ts に置くか: ルート直下のファイルはカバレッジの計測対象外（vitest.config.mts）で、
//   globalSetup の中の分岐はテストから通せない。消し方・接続できないときの扱いはテスト（database.test-support.test.ts）で固定する。
export default async function setup(): Promise<void> {
  await cleanupTestSchemas(
    {
      databaseUrl: env.DATABASE_URL,
      insideStrykerWorker: toolEnv.STRYKER_MUTATOR_WORKER,
    },
    testSchemaPrefix(),
  );
}
