import {
  cleanupTestSchemas,
  TEST_SCHEMA_PREFIX,
} from "./backend/shared/infra/database.test-support";

// Vitest の globalSetup（vitest.config.mts の test.globalSetup）。テストファイルを動かす前に、Vitest のプロセスで 1 回だけ実行される。
// 前の実行が afterAll の前に止まって残ったテスト用のスキーマ（test_<UUID>。backend/shared/infra/database.test-support.ts）を消す。
// Postgres に接続できなければ、ここで分かりやすいエラーにして止める（単体テストは Postgres が前提。rules/code/test.md）。
// WHY ここ（テストの前）で消すか: テストファイルはまだ 1 つも動いていないので、消してよいのは前の実行の残りだけになる。
//   同じ理由で、Stryker の worker の中では消さない（他の worker が並行して動いているため。WHY は cleanupTestSchemas）。
// WHY 処理を database.test-support.ts に置くか: ルート直下のファイルはカバレッジの計測対象外（vitest.config.mts）で、
//   globalSetup の中の分岐はテストから通せない。消し方・接続できないときの扱いはテスト（database.test-support.test.ts）で固定する。
export default async function setup(): Promise<void> {
  await cleanupTestSchemas(process.env, TEST_SCHEMA_PREFIX);
}
