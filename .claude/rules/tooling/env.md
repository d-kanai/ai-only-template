---
paths:
  - ".env.example"
  - "apps/shared/env*"
  - "apps/frontend_customer/instrumentation*"
  - "compose.yaml"
  - ".tool-versions"
---

# 実行環境と環境変数

決定は ADR `docs/adr/architecture/20260928-env-single-entry-all-required.md`、実測（どこで止まるか、Next の `.env` の読み方、検査の限界の確かめ方など）は 2026-09-28 の work-logs。クラウドセッションは `.claude/rules/tooling/cloud-session.md`。

## ツールの版（asdf）
ツールの版は asdf で管理し、`.tool-versions` をコミットして全員（人間・AI）が同じ環境で動かす。
- Node.js: 現行の **LTS** の具体的な版（例: `24.x.y`）を書く。Current（奇数メジャー・LTS 前）と `lts` のようなエイリアスは使わない（時間で解決先が変わる）。
  - 決め方: `curl -s https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0] | .version + " " + .lts'`。`asdf nodejs resolve lts --latest-available` には頼らない（古い LTS を返した実測がある）。
  - 新しい LTS が出たら Issue → PR で上げる。`@types/node` も同じメジャーに合わせる（`.claude/rules/tooling/dependencies.md`）。
- pnpm: パッケージマネージャは pnpm だけ（npm / yarn、`package-lock.json` / `yarn.lock` は使わない）。版は latest（`asdf list all pnpm | tail -1`）。リポジトリ直下の `package.json` の `packageManager`（`pnpm@x.y.z`）にも同じ版を書く。`apps/*/package.json` には書かない（版を 1 か所で管理する）。
- 初回・更新時: `asdf plugin add nodejs` / `asdf plugin add pnpm`（未追加なら）→ `asdf install` → `node --version && pnpm --version`。
- `.tool-versions` を変えたら `asdf install` し、`node --version` / `pnpm --version` の一致を確かめてからコミットする。
  - Claude Code から実行するシェルでは素の `node` が `.tool-versions` と一致しない（Claude Code を入れた asdf の Node の bin が PATH の先頭に入る）。AI は `asdf which node` / `~/.asdf/shims/node --version` で確かめる。
  - パッケージのインストール・実行はリポジトリ直下で素の `pnpm` を使う（`~/.asdf/shims/pnpm` を直接叩かない。LEARNINGS.md）。
- CI は `.tool-versions` の `nodejs` 行と `packageManager` から版を取る（ワークフローに直書きしない）。

## 環境変数
- 入口は `apps/shared/env.ts` に一元化する。`process.env` を直接読んでよいのは `env.ts` だけ。ほかは `import { env, toolEnv } from "@repo/shared/env"` で使う（Issue #59）。
  - 置き場所は frontend と backend で共通の workspace パッケージ `apps/shared`（`@repo/shared`。Issue #90 で `apps/backend/shared/infra/` から移した。`.claude/rules/code/shared.md`）。WHY: frontend 直下の `instrumentation-node.ts`・backend・`apps/e2e/`・`vitest.global-setup.ts` が共通で使い、backend の中に置くと frontend 直下から backend を参照する例外が要った。
  - `env`（型 `Env`）: アプリの設定。**すべて必須で、コードに既定値を持たない**。今は `DATABASE_URL` / `DATABASE_POOL_MAX` / `DATABASE_POOL_IDLE_TIMEOUT_MS` / `DATABASE_CONNECTION_TIMEOUT_MS` / `DATABASE_STATEMENT_TIMEOUT_MS` / `DATABASE_LOCK_TIMEOUT_MS` / `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`（DB 側のタイムアウト。Issue #58）/ `GCP_PROJECT_ID`（リクエストログの trace に入れる GCP のプロジェクト ID。開発・CI・E2E は `local`、本番は Cloud Run の env に Terraform の `var.project_id` を渡す（`infra/modules/app/run.tf` の `app_env`。migrate の job も `env.ts` を通るので同じく渡す）。Issue #209）（値の意味と開発用の値は `.env.example`）。
  - `toolEnv`（型 `ToolEnv`）: 開発ツールの切り替え（任意）。`CI`・`PLAYWRIGHT_CHROMIUM_EXECUTABLE`・`STRYKER_MUTATOR_WORKER`・`E2E_PORT`（ツールの動かし方 = E2E のポート。未設定なら `apps/e2e/playwright.config.ts` が 3100 を使う）。ツールが設定する・ツールの動かし方を切り替えるものだけを足す。アプリの設定は必ず `env` に足して必須にする。
    - 任意でも、値があれば検証し、不正なら読み込み時にエラーにする（`E2E_PORT` は 1〜65535 の整数。黙って既定値に戻すと worktree ごとに分けたポートが 3100 に戻るため）。
    - WHY `E2E_PORT` を `env`（必須）にしない: E2E 専用でアプリ（`next start`）は使わない。必須にすると本番や既存の `.env` にテスト用の変数を要求し、足すまで全コマンドが止まる（Issue #64 の reviewer 指摘）。
- WHY 一元化: 読む場所が散らばると既定値や検証が場所ごとにずれ、要る変数を一覧できない。検証した値だけを配れば、使う側で `string | undefined` を扱わずに済む。
- WHY 必須・既定値なし: 既定値があると `.env` の書き忘れや CI での渡し忘れが黙って既定値で動き、意図しない DB に接続しても気づけない（以前は `DATABASE_URL` が無いと InMemory に落ちていた）。開発用の値は `.env.example` の 1 か所だけ。
- WHY ツールのフラグを分ける: 手元では `CI` も `PLAYWRIGHT_CHROMIUM_EXECUTABLE` も無いのが正常。必須にすると `.env.example` に嘘の値を置くことになり、コピーした `.env` で CI として動く。
- 起動時に全件検証する: `env.ts` の読み込み時に `EnvReader.read(process.env)` が、欠けている・空（空白だけを含む）・不正な値（数でない、負、小数、`DATABASE_POOL_MAX=0`）の名前を**すべて**集めて 1 つのエラーにし、`cp .env.example .env` の手順を出して止まる。WHY すべて集める: 直すたびに次の 1 件が見つかる往復を無くす。
  - `pnpm build` / `pnpm test` / `pnpm test:e2e` / `pnpm db:migrate` / `pnpm start` / `pnpm dev` はすべて exit 1 で止まる（2026-09-28 に実測）。
- `next start` / `next dev` の起動時の検証: `apps/frontend_customer/instrumentation.ts` の `register`（起動時に 1 回、リクエストを受け付ける前に完了する Next の規約。同梱ドキュメント `02-guides/instrumentation.md` の「Convention」で、`instrumentation.ts` はプロジェクトのルートに置く）が、`process.env.NEXT_RUNTIME === "nodejs"` のときだけ `instrumentation-node.ts` の `verifyEnvAtStartup` を呼び、`env.ts` を読み込む。
  - WHY: API の route は最初のリクエストまで読み込まれず、`env.ts` だけではサーバが起動したまま最初の `/api/todos` が 500 になるまで気づけない。
  - `register` が失敗しても `next start` は動き続けるので、エラーを出してから `process.exit(1)` する。
  - WHY `NEXT_RUNTIME` で分ける: `register` は Edge 向けにもビルドされ、分岐が無いと Node の API が Edge に入って `next build` が警告を出す。Next がビルド時に埋め込む変数なので `process.env.NEXT_RUNTIME` と書く必要があり、ここだけを直参照の例外にしている（Biome は行単位の `biome-ignore`、`rule-tests/architecture.test.ts` は変数名まで絞った `allowedVariables`）。
  - 単体テストは無い（カバレッジの対象外）。起動時に止まることは実測で確かめた（2026-09-28 の work-logs）。

## .env
- 作り方: リポジトリ直下で `cp .env.example .env`。`.env` はコミットしない（`.gitignore` の `.env*`、`!.env.example`）。置くのはリポジトリ直下の 1 つだけ（`apps/*/.env` は置かない。Issue #68 のユーザー判断）。worktree では WorktreeCreate フックが worktree ごとの値で `.env` を書く（`.claude/rules/tooling/worktree.md`）。
- `.env.local`（や `.env.development` など）は使わない。残っていれば消す。WHY: Next.js は `.env.local` を `.env` より優先して読むが、`env.ts` は `.env` だけを読むので、`pnpm dev` と `pnpm test` / `pnpm db:migrate` で値がずれる。
- 読み込み: `env.ts` が読み込み時に、カレントディレクトリから上に `pnpm-workspace.yaml` のあるディレクトリ（リポジトリ直下）を探し（`DotEnvFile.findRepoRoot`。無ければカレントディレクトリ）、そこの `.env` を Node 標準の `process.loadEnvFile` で読む（`DotEnvFile.loadFromRepoRoot`）。依存（dotenv など）は足さない。
  - WHY 上に探す: `pnpm --filter` の script はパッケージのディレクトリ（`apps/frontend_customer`・`apps/backend`）で動く。Next.js 自身は `apps/frontend_customer` の `.env` を探すので、リポジトリ直下の `.env` は `env.ts` が読む。
  - WHY `pnpm-workspace.yaml` を目印にする: リポジトリ直下にだけあり、`.git` のように worktree でファイルになったり Stryker のサンドボックスに無かったりしない。`import.meta.dirname` から探さないのは、Next のビルドでバンドルされると元の場所を指さないため。
  - `.env` が無いとき（`ENOENT`）だけ何もしない（環境変数だけで渡す動かし方を許す。足りなければ `EnvReader.read` が止める）。ほかの読み込みエラーは投げる。
  - 既に環境にある変数はファイルの値で上書きされない（`DATABASE_URL=... pnpm db:migrate` が優先される）。
- CI（`ci.yml` / `mutation.yml`）は Postgres の起動後に `cp .env.example .env` のステップで作る（ワークフローの `env:` に書かない。値を 1 か所にするため）。Stryker は `.env` もサンドボックスにコピーする。クラウドセッションはフックが `.env` が無ければコピーする。

## 直参照の検査（2 系統。どちらも CI で止まる）
- Biome の `style/noProcessEnv`（`biome.json` で `"error"`。`overrides` で `env.ts` とテストだけ off。`.claude/rules/quality/lint.md`）。
- `rule-tests/architecture.test.ts` の規則 `env-direct-access`（`.claude/rules/code/architecture-check.md`）。
- WHY 2 系統: Biome は `biome.json` の overrides の書き換えで黙って効かなくなる。テスト側で対象と例外を固定し、片方が壊れてももう片方で止める。
- 限界（Biome 2.5.13 で実測）:
  - 両方とも見逃す（レビューで見る）: 分割代入 `const { env } = process`、別名 `const p = process; p.env`、`Reflect.get(process, "env")`、`import proc from "node:process"; proc.env`。
  - Biome だけが拾う: テンプレートリテラルの `${process.env.X}`、`import { env } from "node:process"`。
  - `rule-tests/architecture.test.ts` だけが拾う: `global.process.env`、`(process).env`。
  - `rule-tests/architecture.test.ts` 側の限界は、同ファイルの「環境変数の直参照の抽出」のテストで固定している。
- 同じ設計（Biome のルール + `rule-tests/architecture.test.ts` の規則で、唯一の入口・出口のファイルだけを許す）を、ログの `console` にも使っている（`noConsole` と `console-direct-access`。`.claude/rules/code/backend.md` の「ログ」、ADR `docs/adr/architecture/20260929-logger-single-exit.md`）。

## 変数を足すとき
- `env.ts` の `Env` と `PARSERS` に足し（必須、既定値なし）、`.env.example` に開発用の値と WHAT / WHY のコメントを書き、`env.test.ts` に検証のテストを足す。CI・クラウドは `.env.example` をコピーするので、ワークフローやスクリプトは直さなくてよい。
- worktree ごとに変える値（DB 名・ポートなど、並列の worktree でぶつかるもの）なら、`scripts/worktree-env.sh` の生成規則も足す（`.claude/rules/tooling/worktree.md`）。
- テスト用の接続先（`apps/backend/test-support/database.ts`・`apps/e2e/support/database.ts`）とマイグレーションの入口（`apps/backend/shared/drizzle/migrate.ts`）もアプリと同じ `env.DATABASE_URL` を使う。

## compose.yaml（開発用 Postgres）
- 手元・CI・クラウドで同じ `compose.yaml` を使う。イメージは `mirror.gcr.io/library/postgres:18-alpine`（Docker Hub の匿名 pull のレート制限を避ける。経緯は ADR `docs/adr/workflow/20260928-postgres-via-docker-compose-everywhere.md` と 2026-09-28 の work-logs）。healthcheck は `pg_isready`。
