import { env } from "@repo/shared/env";
import { Client } from "pg";

// E2E テストが使う Postgres（compose.yaml）への接続と、データのリセット。
// apps/e2e/*.spec.ts（テストの前のリセット・DB の確認）が使う。
// 接続先は env.DATABASE_URL（.env / 環境変数から env.ts が読んで検証した値）で、webServer（next start）と同じ DB を指す
// （playwright.config.ts が同じ env.DATABASE_URL を webServer に渡す）。既定値は持たない（WHY は env.ts）。
// WHY "@repo/shared/..." で import する（Issue #68 の段階 2・Issue #90）: Playwright はテストと設定を自前の変換で読み込むので、
//   "@/" の解決（tsconfig の paths）には頼らず、workspace パッケージとして Node の解決（node_modules/@repo/shared と
//   apps/shared/package.json の exports）で読む。playwright.config.ts と同じ書き方にそろえる。
// WHY pg を apps/e2e/package.json の devDependencies にも置く: pg は apps/backend の依存だが、このファイル（apps/e2e/）からは
//   apps/backend/node_modules が見えない（pnpm は宣言した依存だけを apps/e2e/node_modules に置く）。E2E が DB を直接確かめる
//   ための依存として、apps/backend と同じ版を置く（rule-tests/package.test.ts が同じ名前の依存の版がそろっていることを検査する）。

// WHY クラスの static メソッドにする（Issue #262。以前は関数 resetTodos・countTodosWithTitle・withClient）: テストの補助も最上位に
//   関数を置かない（ADR docs/adr/architecture/20261002-class-based-shared-and-test-support.md。rule-tests/architecture.test.ts の
//   class-based が apps/e2e の *.spec.ts 以外を検査する）。状態を持たないので static だけのクラスにする（biome の noStaticOnlyClass は
//   apps/e2e/** で off。.claude/rules/lint.md）。
export class E2eDatabase {
  // Todo をすべて消す。各テストの前に呼び、前のテスト・前回の実行のデータに結果が左右されないようにする。
  // WHY TRUNCATE: 行を 1 件ずつ消す DELETE より速く、表の中身だけを消す（表の定義とマイグレーションの記録は残る）。
  // WHY 完了の履歴（todo_status_changes）も同じ文で消す（Issue #188）: todo_status_changes は todos を外部キーで参照するので、
  //   todos だけの TRUNCATE は Postgres が拒否する（参照する表も同じ文で指定するか CASCADE が要る）。
  // WHY 変更履歴（change_logs。Issue #189）も消す: 前のテスト・前回の実行の記録が残り続けて増えないようにする（外部キーは無いが、
  //   Todo と一緒に消して「Todo が無い状態」にそろえる）。
  static async resetTodos(): Promise<void> {
    await E2eDatabase.withClient((client) =>
      client.query("TRUNCATE change_logs, todo_status_changes, todos"),
    );
  }

  // title が一致する Todo の件数を DB から直接数える。画面の操作が Postgres まで届いていること（InMemory で
  // 動いていないこと）を確かめるために使う。
  static async countTodosWithTitle(title: string): Promise<number> {
    return E2eDatabase.withClient(async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM todos WHERE title = $1",
        [title],
      );
      return Number(result.rows[0]?.count);
    });
  }

  // 1 本の接続で fn を実行し、終わったら閉じる。
  private static async withClient<T>(
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
}
