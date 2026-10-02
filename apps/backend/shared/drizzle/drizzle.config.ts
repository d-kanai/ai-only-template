import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// WHY クラスの static メソッドにする: backend の本番コードはファイルの最上位に関数を置かない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。drizzle-kit が求めるのは default export の設定オブジェクトだけで、
//   補助の関数の形は求めないので例外にしない。export しない（このファイルの中だけで使う）。
class DrizzleConfigPath {
  // このファイルの置き場所（apps/backend/shared/drizzle/）からのパスを、カレントディレクトリからの相対パスにして返す。
  // WHY: drizzle-kit は schema / out をカレントディレクトリからのパスとして解決する（drizzle-kit 0.31.11 の bin.cjs の
  //   prepareFilenames が glob.sync(path) と path.resolve(path) を使う）。pnpm db:generate は workspace パッケージ
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

// drizzle-kit（マイグレーションの生成）の設定。使い方は .claude/rules/code/backend.md の「永続化（Drizzle + Postgres）」。
//   pnpm db:generate … drizzle-kit generate: schema のファイルと前回のスナップショット（shared/drizzle/migrations/meta/）の差分から、
//                      マイグレーションの SQL を out（shared/drizzle/migrations/）に作る。DB には接続しない。
// 当てるのは drizzle-kit migrate ではなく pnpm db:migrate（shared/drizzle/migrate.ts。drizzle-orm の migrator。Issue #326）。
//   WHY: Cloud Run の migrate ジョブをアプリの runtime イメージで動かすため（drizzle-kit は devDependencies でイメージに無い）。
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
  // dbCredentials（接続先）は書かない（Issue #326）: drizzle-kit は generate（DB に接続しない）にだけ使い、当てるのは
  //   pnpm db:migrate（shared/drizzle/migrate.ts。接続先は env.ts の DATABASE_URL）。そのため、この設定を読むのに .env は要らない。
  // strict: generate / push で、データが消えうる変更（列の削除など）を確認なしで出さない。
  // verbose: 実行する SQL を表示する。
  strict: true,
  verbose: true,
});
