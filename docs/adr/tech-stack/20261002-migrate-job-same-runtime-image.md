# migrate ジョブはアプリの runtime イメージをコマンド違いで動かし、マイグレーションは drizzle-orm の migrator を束ねた入口で当てる

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #326 / tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md / `Dockerfile` / `.github/workflows/deploy.yml` / `infra/modules/app/run.tf` / `apps/backend/shared/drizzle/migrate.ts`

## 背景
tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md で、マイグレーションは Cloud Run の job で Dockerfile の migrate ステージ（deps ステージ全体と drizzle-kit。`pnpm db:migrate`）のイメージを使うことにした。デプロイのたびに runtime と migrate の 2 つのイメージを build / push し、それぞれに test-support の検査を持っていた。daiki が「2 つ image build push するのは嫌。同じ image のコマンド違いで migrate だけ実行にしたい」と判断した（2026-10-02）。runtime イメージ（next build の standalone）には pg はあるが drizzle-orm は無く（Turbopack がサーバのチャンクに束ねる）、drizzle-kit も無い（2026-10-02 の work-logs）。

## 決定
- マイグレーションの入口 `apps/backend/shared/drizzle/migrate.ts`（drizzle-orm の migrator を、アプリのプール `AppDatabase` で呼ぶ）を esbuild で依存ごと 1 ファイル（`dist/migrate/migrate.mjs`）に束ね、隣に `migrations/` を置く（`pnpm db:migrate:bundle`）。
- Dockerfile の build ステージで束ね、runtime イメージの `/app/migrate` に載せる。migrate ステージは消す。
- deploy.yml は runtime イメージだけを build / push し、`gcloud run jobs update --image <同じイメージ> --command node --args migrate/migrate.mjs` でジョブを入れ替える。Terraform は job の command / args を見ない（ignore_changes）。
- 手元・CI・クラウドセッションの `pnpm db:migrate` も、同じ束ねたファイルを実行する。drizzle-kit は `pnpm db:generate` だけに使う。

## 理由
- build / push / イメージの検査が 1 回で済み、ジョブとサービスが同じコミットの同じイメージで動く。
- CI の `pnpm db:migrate`（E2E の DB を作る）が、ジョブで動くのと同じファイルを PR ごとに実行するので、入口の壊れに main へのデプロイより前に気づける。
- drizzle-kit migrate も中で drizzle-orm の migrator を同じ既定（記録は `drizzle.__drizzle_migrations`）で呼ぶので、drizzle-kit で当てた DB に続けて当てられる（2026-10-02 の work-logs で実測）。
- コマンドをイメージと同じ gcloud の呼び出しで入れ替えるので、Terraform の apply の有無・順序によらず、ジョブがイメージに無いコマンドを実行することが無い。

## 採用しなかった案
- runtime イメージに drizzle-kit と依存（deps ステージの node_modules）を入れる: runtime が大きくなり、本番のサービスに devDependencies を載せることになる。
- TypeScript のまま node の型の除去で動かす: 相対 import に拡張子が要り、@repo/shared のソースも drizzle-orm もイメージに無い。node_modules の下の .ts は型の除去の対象外。
- `pnpm deploy` で backend の依存をイメージに入れる: 上と同じく node_modules の下の @repo/shared（.ts）を node が読めない。
- コマンドを Terraform の job に書く: 初回の apply の仮のイメージ（hello）に node が無く、イメージの入れ替えと apply の順序に気を配る必要がある。

## 影響
- 良い点: デプロイの時間と Artifact Registry の保存量が減る（migrate イメージ 約 385MB が無くなる）。マイグレーションの経路が手元・CI・本番で 1 つになる。
- 悪い点: esbuild（devDependencies）が増え、束ねたファイルの書き出し（`dist/`）の手順が要る。DB 側のタイムアウト（DATABASE_STATEMENT_TIMEOUT_MS など）がマイグレーションにも効くので、ジョブは 0（上限なし）を渡す。
- 見直す条件: マイグレーションに drizzle-kit だけの機能（push・check など）を本番で使う必要が出たとき。
