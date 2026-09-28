import { Client } from "pg";
import { env } from "../apps/backend/shared/infra/env";

// E2E テストが使う Postgres（compose.yaml）への接続と、データのリセット。
// e2e/*.spec.ts（テストの前のリセット・DB の確認）が使う。
// 接続先は env.DATABASE_URL（.env / 環境変数から env.ts が読んで検証した値）で、webServer（next start）と同じ DB を指す
// （playwright.config.ts が同じ env.DATABASE_URL を webServer に渡す）。既定値は持たない（WHY は env.ts）。
// WHY 相対パスで import する: Playwright はテストと設定を自前の変換で読み込む。"@/" の解決（tsconfig の paths）に頼らず、
//   playwright.config.ts と同じ書き方にそろえる。

// 1 本の接続で fn を実行し、終わったら閉じる。
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Todo をすべて消す。各テストの前に呼び、前のテスト・前回の実行のデータに結果が左右されないようにする。
// WHY TRUNCATE: 行を 1 件ずつ消す DELETE より速く、表の中身だけを消す（表の定義とマイグレーションの記録は残る）。
export async function resetTodos(): Promise<void> {
  await withClient((client) => client.query("TRUNCATE todos"));
}

// title が一致する Todo の件数を DB から直接数える。画面の操作が Postgres まで届いていること（InMemory で
// 動いていないこと）を確かめるために使う。
export async function countTodosWithTitle(title: string): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM todos WHERE title = $1",
      [title],
    );
    return Number(result.rows[0]?.count);
  });
}
