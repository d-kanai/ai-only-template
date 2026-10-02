import { join } from "node:path";
import { AppDatabase } from "./database";
import { DatabaseMigration } from "./migration";

// マイグレーションの入口（Issue #326）。このファイルを esbuild で依存ごと 1 ファイル（dist/migrate/migrate.mjs）に束ねて実行する。
//   手元・CI・クラウドセッション: pnpm db:migrate（束ねてから node dist/migrate/migrate.mjs）。
//   Cloud Run の migrate ジョブ: アプリの runtime イメージの /app/migrate/migrate.mjs（Dockerfile と infra/modules/app/run.tf）。
// WHY 束ねるか: runtime イメージ（next build の standalone）には pg はあるが drizzle-orm は無い（Turbopack がサーバのチャンクに
//   束ねる。2026-10-02 実測）。TypeScript のまま node で動かす（型の除去）のも、相対 import に拡張子が要り、@repo/shared の
//   ソースもイメージに無いので使えない。
// WHY 接続はアプリのプール（AppDatabase.get。env.ts の DATABASE_*）を使う: 接続先とタイムアウトの読み方をアプリと 1 か所に
//   そろえる。ジョブの値（文の時間・ロック待ちの上限を外す）は infra/modules/app/run.tf。
// WHY migrations/ をこのファイルの場所から決める: 束ねたファイルの隣に migrations/ を置く（package.json の db:migrate と
//   Dockerfile がコピーする）。import.meta.dirname は束ねたファイルの場所を指す。
// WHY 単体テストのカバレッジから外すか（vitest.config.mts）: 読み込むと最上位で DB にマイグレーションを当てる入口で、
//   中身（DatabaseMigration.run）は migration.postgres.test.ts が仕様にしている。この入口そのものは、CI の pnpm db:migrate
//   （E2E の DB を作る）が毎回、束ねたファイルとして実行する。
await DatabaseMigration.run(
  AppDatabase.get(),
  join(import.meta.dirname, "migrations"),
);
