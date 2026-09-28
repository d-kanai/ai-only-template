import {
  cleanupTestSchemas,
  testSchemaPrefix,
} from "./apps/backend/shared/infra/database.test-support";
import { env, toolEnv } from "./apps/backend/shared/infra/env";

// Vitest の globalSetup（vitest.config.mts の test.globalSetup）。テストファイルを動かす前に、Vitest のプロセスで 1 回だけ実行される。
// 前の実行が afterAll の前に止まって残ったテスト用のスキーマ（test_<UUID>。backend/shared/infra/database.test-support.ts）を消す。
// Postgres に接続できなければ、ここで分かりやすいエラーにして止める（単体テストは Postgres が前提。rules/code/test.md）。
// env.ts を読み込むので、.env が無い・必須の変数が欠けているときも、テストファイルを動かす前にここで欠けた名前を出して止まる。
// WHY ここ（テストの前）で消すか: テストファイルはまだ 1 つも動いていないので、消してよいのは前の実行の残りだけになる。
//   同じ理由で、Stryker の worker の中では消さない（他の worker が並行して動いているため。WHY は cleanupTestSchemas）。
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
