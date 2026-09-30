import { relative } from "node:path";
import { fileURLToPath } from "node:url";
// WHY "@repo/shared/env" で import する（Issue #90）: env.ts は frontend と backend で共通の workspace パッケージ apps/shared
//   （@repo/shared）にある。apps/backend/package.json の "@repo/shared": "workspace:*" で入る apps/backend/node_modules/@repo/shared
//   （apps/shared への symlink）と apps/shared/package.json の exports で、Node の解決で見つかる（tsconfig の paths には頼らない。
//   drizzle-kit は設定ファイルを自前で読み込み、paths を解決する保証がない）。backend の中のほかのファイルは相対パスだけ
//   （rule-tests/architecture.test.ts の backend-relative-only）。env.ts は Node の組み込み（node:fs / node:path）しか import しない。
import { env } from "@repo/shared/env";
import { defineConfig } from "drizzle-kit";

// このファイルの置き場所（apps/backend/shared/drizzle/）からのパスを、カレントディレクトリからの相対パスにして返す。
// WHY: drizzle-kit は schema / out をカレントディレクトリからのパスとして解決する（drizzle-kit 0.31.11 の bin.cjs の
//   prepareFilenames が glob.sync(path) と path.resolve(path) を使う）。pnpm db:generate / db:migrate は workspace パッケージ
//   @repo/backend の script として apps/backend で drizzle-kit --config shared/drizzle/drizzle.config.ts を実行する（Issue #68 の
//   段階 2。Issue #98 で設定を shared/drizzle/ に移した）が、リポジトリ直下から
//   drizzle-kit --config apps/backend/shared/drizzle/drizzle.config.ts を実行しても同じ場所を指すよう、このファイルの場所から決める。
// WHY 絶対パスにしない: drizzle-kit generate は out の前に "./" を付けて読むため、絶対パスだと
//   ".//home/.../drizzle/meta/0000_snapshot.json" を開こうとして ENOENT で失敗した（2026-09-28 実測）。
// WHY import.meta.url を使う（import.meta.dirname を使わない）: drizzle-kit は設定ファイルを CommonJS に変換して読み込み、
//   import.meta.url は元のファイルの URL になるが、import.meta.dirname は undefined になった（2026-09-28 実測）。
// WHY 空文字を "." にする: out はこのファイルと同じディレクトリなので、そこをカレントディレクトリにして実行すると relative が
//   "" を返す。drizzle-kit は out が空だと既定の "drizzle" として扱い、shared/drizzle/drizzle/ に新しい SQL を作った
//   （Issue #98、2026-09-29 実測）。
function fromConfigDir(path: string): string {
  return (
    relative(process.cwd(), fileURLToPath(new URL(path, import.meta.url))) ||
    "."
  );
}

// drizzle-kit（マイグレーションの生成と適用）の設定。使い方は .claude/rules/backend.md の「永続化（Drizzle + Postgres）」。
//   pnpm db:generate … drizzle-kit generate: schema のファイルと前回のスナップショット（shared/drizzle/meta/）の差分から、
//                      マイグレーションの SQL を out（shared/drizzle/）に作る。DB には接続しない。
//   pnpm db:migrate  … drizzle-kit migrate: out の SQL のうち、DB にまだ当てていないものを当てる。
//                      当てた記録は DB の drizzle.__drizzle_migrations 表に残る（何度実行しても同じ結果になる）。
// drizzle-kit push（DB を schema に直接合わせる）は使わない。理由は .claude/rules/backend.md。
export default defineConfig({
  // dialect: 接続先の DB の種類。compose.yaml の PostgreSQL 18。
  dialect: "postgresql",
  // schema: テーブル定義のファイル。feature ごとに apps/backend/features/<feature>/infra/schema.ts に置く（feature を足しても
  //   ここを直さずに済むよう glob で指す）。feature をまたぐ横断の表（変更履歴の change_logs。Issue #189）だけは
  //   apps/backend/shared/infra/schema.ts に置く（どの feature にも属さないため）。drizzle-kit は配列で複数の場所を受け取る。
  schema: [
    fromConfigDir("../../features/*/infra/schema.ts"),
    fromConfigDir("../infra/schema.ts"),
  ],
  // out: 生成したマイグレーション（SQL と meta/ のスナップショット）の置き場所。この設定ファイルと同じ
  //   apps/backend/shared/drizzle/（Issue #98。設定と生成物を 1 か所にまとめる）。コミットして、すべての環境で同じ SQL を当てる。
  out: fromConfigDir("."),
  dbCredentials: {
    // url: db:migrate の接続先。env.ts が .env / 環境変数から読んで検証した DATABASE_URL（既定値は持たない。WHY は env.ts）。
    //   drizzle-kit 自身は .env を読まないが、env.ts が読み込み時に .env を読む。ほかの DB に当てるときは
    //   DATABASE_URL=... pnpm db:migrate のように環境変数で渡す（.env より優先される）。
    //   db:generate は接続しないが、この設定ファイルを読むので env.ts の検証は通る必要がある（.env が要る）。
    url: env.DATABASE_URL,
  },
  // strict: generate / push で、データが消えうる変更（列の削除など）を確認なしで出さない。
  // verbose: 実行する SQL を表示する。
  strict: true,
  verbose: true,
});
