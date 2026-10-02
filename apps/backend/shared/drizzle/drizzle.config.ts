import { relative } from "node:path";
import { fileURLToPath } from "node:url";
// WHY "@repo/shared/env" で import する（Issue #90）: env.ts は frontend と backend で共通の workspace パッケージ apps/shared
//   （@repo/shared）にある。apps/backend/package.json の "@repo/shared": "workspace:*" で入る apps/backend/node_modules/@repo/shared
//   （apps/shared への symlink）と apps/shared/package.json の exports で、Node の解決で見つかる（tsconfig の paths には頼らない。
//   drizzle-kit は設定ファイルを自前で読み込み、paths を解決する保証がない）。backend の中のほかのファイルは相対パスだけ
//   （rule-tests/architecture.test.ts の backend-relative-only）。env.ts は Node の組み込み（node:fs / node:path）しか import しない。
import { env } from "@repo/shared/env";
import { defineConfig } from "drizzle-kit";

// WHY クラスの static メソッドにする: backend の本番コードはファイルの最上位に関数を置かない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。drizzle-kit が求めるのは default export の設定オブジェクトだけで、
//   補助の関数の形は求めないので例外にしない。export しない（このファイルの中だけで使う）。
class DrizzleConfigPath {
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
  // WHY 空文字を "." にする: 渡したパスがカレントディレクトリそのものだと relative が "" を返す。drizzle-kit は out が空だと
  //   既定の "drizzle" として扱い、そこに新しい SQL を作った（Issue #98、2026-09-29 実測。当時は out が設定と同じディレクトリだった）。
  static fromConfigDir(path: string): string {
    return (
      relative(process.cwd(), fileURLToPath(new URL(path, import.meta.url))) ||
      "."
    );
  }
}

// drizzle-kit（マイグレーションの生成と適用）の設定。使い方は .claude/rules/code/backend.md の「永続化（Drizzle + Postgres）」。
//   pnpm db:generate … drizzle-kit generate: schema のファイルと前回のスナップショット（shared/drizzle/migrations/meta/）の差分から、
//                      マイグレーションの SQL を out（shared/drizzle/migrations/）に作る。DB には接続しない。
//   pnpm db:migrate  … drizzle-kit migrate: out の SQL のうち、DB にまだ当てていないものを当てる。
//                      当てた記録は DB の drizzle.__drizzle_migrations 表に残る（何度実行しても同じ結果になる）。
// drizzle-kit push（DB を schema に直接合わせる）は使わない。理由は .claude/rules/code/backend.md。
export default defineConfig({
  // dialect: 接続先の DB の種類。compose.yaml の PostgreSQL 18。
  dialect: "postgresql",
  // schema: テーブル定義のファイル。feature ごとに apps/backend/features/<feature>/internal/infra/schema.ts に置く（feature を足しても
  //   ここを直さずに済むよう glob で指す）。feature をまたぐ横断の表（変更履歴の change_logs。Issue #189）だけは
  //   apps/backend/shared/change-log/change-log.schema.ts に置く（どの feature にも属さないため）。shared の下は glob で読む。drizzle-kit は配列で複数の場所を受け取る。
  schema: [
    DrizzleConfigPath.fromConfigDir(
      "../../features/*/internal/infra/schema.ts",
    ),
    // WHY shared は glob で読む（Issue #310）: rule-tests の schema・persistence は shared の下の schema.ts と *.schema.ts を
    //   表の定義として検査する。ここを 1 ファイルに固定すると、shared に足した表は検査を通るのに drizzle-kit が読まず、
    //   マイグレーションが作られないまま気づけない。検査の対象と同じ範囲を読む。
    DrizzleConfigPath.fromConfigDir("../**/*.schema.ts"),
    DrizzleConfigPath.fromConfigDir("../**/schema.ts"),
  ],
  // out: 生成したマイグレーション（SQL と meta/ のスナップショット）の置き場所。この設定ファイルの隣の
  //   apps/backend/shared/drizzle/migrations/（Issue #98 で設定と生成物を shared/drizzle/ にまとめ、Issue #310 で drizzle/ に
  //   接続・書き込みのソースも置くようにしたので、生成物だけを migrations/ に分けた）。コミットして、すべての環境で同じ SQL を当てる。
  out: DrizzleConfigPath.fromConfigDir("./migrations"),
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
