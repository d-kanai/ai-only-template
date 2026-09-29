# 実行環境と環境変数の実測

規則と WHY は `.claude/rules/env.md`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。

## Node.js / asdf（2026-09-28）
- `asdf nodejs resolve lts --latest-available` は、最新 LTS が 24.21.0 なのに 22.x を返した。実行時刻で 22.21.1 / 22.23.3 と値も変わった（そのため nodejs.org の `index.json` を 1 次情報にする）。
- Claude Code は asdf 管理の Node（2026-09-28 時点 22.12.0）配下にグローバルインストールされており、asdf の shim が起動時にその Node の bin を PATH の先頭に入れるため、子プロセスの素の `node` は `.tool-versions` を無視してその Node になる。`which node` が `~/.asdf/shims/node` 以外（`~/.asdf/installs/nodejs/<別バージョン>/bin/node` など）を指すなら PATH の問題で、`.tool-versions` は正しい。

## 必須の環境変数が欠けたときに止まる場所（Issue #59。`.env` から `DATABASE_POOL_MAX` を消して確認）
- `pnpm build`: ページデータの収集で `/api/todos/[id]` の読み込みが失敗。
- `pnpm test`: globalSetup。`pnpm test:e2e`: `apps/e2e/playwright.config.ts` の読み込み。`pnpm db:migrate`: `drizzle.config.ts` の読み込み。
- `pnpm start` / `pnpm dev`: Next が「✓ Ready」を出した直後に、欠けた名前を出して exit 1（Ready の表示は `register` の前に出る。`register` はリクエストを受け付ける前に完了する、と Next のドキュメントにある）。
- いずれも exit 1。

## instrumentation.ts（Next.js 16.3.6）
- `register` の仕様: サーバの起動時に 1 回だけ呼ばれ、リクエストを受け付ける前に完了する（同梱ドキュメント `node_modules/next/dist/docs/01-app/02-guides/instrumentation.md` の「Convention」）。`NEXT_RUNTIME` での分岐は同ドキュメントの「Importing runtime-specific code」の例と同じ。
- API の route は最初のリクエストまで読み込まれないため、`env.ts` の読み込み時の検証だけでは、サーバは起動したまま最初の `/api/todos` が 500 になった。
- `register` が失敗しても `next start` は「Failed to prepare server」を出すだけで動き続けた（`timeout 60` で打ち切り、exit 124）。そのため `process.exit(1)` する。
- `NEXT_RUNTIME` の分岐が無いと、`process.loadEnvFile` / `process.exit` が Edge 向けに入って `next build` が「A Node.js API is used ... not supported in the Edge Runtime」の警告を出した。分岐後は警告 0。
- `register` は `next build` では呼ばれない（一時的なログで確認）。`next build` は、ページデータの収集で API のモジュールを読み込むときに止まる。
- `DATABASE_POOL_MAX` を消すと `pnpm start -p 3101` / `pnpm dev -p 3102` とも「✓ Ready」の直後に欠けた名前を出して exit 1。戻すと両方とも `/api/todos` が 200。

## .env の読み込み（Issue #59 / #68）
- `apps/backend` で `pnpm db:migrate` を直接実行しても、リポジトリ直下の `.env` を読む（シェルに `DATABASE_*` が無い状態で migrate が通り、`DATABASE_POOL_MAX=abc` を付けると欠けた・不正な変数の名前で止まった）。
- Next.js（`apps/frontend` の `next dev/build/start`）はプロジェクトのディレクトリの `.env` を探す（`next/dist/server/config.js` の `loadEnvConfig(dir, ...)`）ので、リポジトリ直下の `.env` は Next.js 自身は読まない（起動時のログに「Environments: .env」が出ない）。`apps/frontend/.env` が無い状態で `next start apps/frontend` / `next dev apps/frontend` が `/api/todos` に 200 を返し、`DATABASE_POOL_MAX=abc` を付けると `instrumentation.ts` の検証で exit 1 になった。段階 2 の `pnpm start -p <port>` でも `/api/todos` が 200。
- `process.loadEnvFile` は、すでに環境にある変数をファイルの値で上書きしない（Node 24.21.0 で実測）。
- Next.js は `.env.local` を `.env` より優先して読む（同梱ドキュメント `01-app/02-guides/environment-variables.md` の「Environment Variable Load Order」）。
- Stryker は `.env` もサンドボックスにコピーする（`.gitignore` を見ない。Issue #59 で `stryker run --mutate backend/shared/infra/env.ts` で確認）。サンドボックスにも `pnpm-workspace.yaml` があるので、`env.ts` はサンドボックスの `.env` を読む。

## 直参照の検査の限界（Biome 2.5.13 で実測）
- `rule-tests/architecture.test.ts` の抽出は正規表現で式の流れを追わず、Biome の `noProcessEnv` も違反にしなかったもの: 分割代入 `const { env } = process`、別名経由 `const p = process; p.env`、`Reflect.get(process, "env")`、`import proc from "node:process"; proc.env`。
- Biome だけが拾ったもの: テンプレートリテラルの `${}` の中、`import { env } from "node:process"`。
- `rule-tests/architecture.test.ts` だけが拾ったもの: `global.process.env`、`(process).env`（Biome の `noProcessEnv` は違反にしない）。
- `biome.json` の `overrides` の `includes` はリポジトリ直下からの相対パスで照合される（リポジトリの外の同名ファイル `.../apps/backend/shared/infra/env.ts` には効かないことを `rule-tests/lint.test.ts` で確認）。
