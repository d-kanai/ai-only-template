import { Client } from "pg";

// E2E テストが使う Postgres（compose.yaml）への接続と、データのリセット。
// playwright.config.ts（webServer に渡す接続先）と e2e/*.spec.ts（テストの前のリセット・DB の確認）の両方が使う。

// compose.yaml の開発用 DB（.env.example と同じ値。開発用で秘密ではない）。
const LOCAL_DATABASE_URL = "postgresql://app:app@localhost:5432/app";

// E2E で使う接続先。DATABASE_URL が未設定なら compose.yaml の開発用 DB。
// WHY 空文字ならエラーにする: アプリ（backend/todo/infra/container.ts）は DATABASE_URL が空だと InMemory で動く。
//   E2E は Postgres を通した動作（永続化・マイグレーション済みの表）を確かめるためのもので、InMemory で動いて
//   緑になると、DB 経由の不具合を見逃す。`DATABASE_URL=` と空で渡されたときは、サーバを起動する前に止める。
export function e2eDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
  if (url === "") {
    throw new Error(
      "DATABASE_URL が空です。E2E は Postgres で動かすため、接続先を指定するか、未設定にして compose.yaml の開発用 DB を使ってください",
    );
  }
  return url;
}

// 1 本の接続で fn を実行し、終わったら閉じる。
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: e2eDatabaseUrl() });
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
