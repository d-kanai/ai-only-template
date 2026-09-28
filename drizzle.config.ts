import { defineConfig } from "drizzle-kit";

// drizzle-kit（マイグレーションの生成と適用）の設定。使い方は rules/code/architecture.md の「永続化（Drizzle + Postgres）」。
//   pnpm db:generate … drizzle-kit generate: schema のファイルと前回のスナップショット（drizzle/meta/）の差分から、
//                      マイグレーションの SQL を out（drizzle/）に作る。DB には接続しない。
//   pnpm db:migrate  … drizzle-kit migrate: out の SQL のうち、DB にまだ当てていないものを当てる。
//                      当てた記録は DB の drizzle.__drizzle_migrations 表に残る（何度実行しても同じ結果になる）。
// drizzle-kit push（DB を schema に直接合わせる）は使わない。理由は rules/code/architecture.md。
export default defineConfig({
  // dialect: 接続先の DB の種類。compose.yaml の PostgreSQL 18。
  dialect: "postgresql",
  // schema: テーブル定義のファイル。feature ごとに backend/<feature>/infra/schema.ts に置く（feature を足しても
  //   ここを直さずに済むよう glob で指す）。
  schema: "./backend/**/infra/schema.ts",
  // out: 生成したマイグレーション（SQL と meta/ のスナップショット）の置き場所。コミットして、すべての環境で同じ SQL を当てる。
  out: "./drizzle",
  dbCredentials: {
    // url: db:migrate の接続先。DATABASE_URL が無ければ compose.yaml の開発用 DB（.env.example と同じ値）。
    // WHY 既定値を持つ: drizzle-kit は .env / .env.local を自動では読まない。手元・クラウドのフックで毎回
    //   DATABASE_URL を渡さなくても開発用 DB に当てられるようにする（単体テストと E2E の既定値と同じ）。
    //   本番などほかの DB に当てるときは DATABASE_URL を必ず渡す。db:generate は接続しないので、値は使わない。
    url: process.env.DATABASE_URL || "postgresql://app:app@localhost:5432/app",
  },
  // strict: generate / push で、データが消えうる変更（列の削除など）を確認なしで出さない。
  // verbose: 実行する SQL を表示する。
  strict: true,
  verbose: true,
});
