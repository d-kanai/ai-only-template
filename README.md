# ai-only-template

AI（Claude Code）が Issue → ブランチ → PR → マージ の流れで開発を進めるためのテンプレートリポジトリ。
運用ルールは `CLAUDE.md` と `rules/` にまとめている。

## Tech Stack

| 領域 | 技術 | 備考 |
| --- | --- | --- |
| バージョン管理 | [asdf](https://asdf-vm.com/) | ツールのバージョンを `.tool-versions` でピン留めし、人間・AI が同じ環境で動かす |
| ランタイム | [Node.js](https://nodejs.org/) | 現行 LTS を使う |
| パッケージマネージャ | [pnpm](https://pnpm.io/) | latest を使う。npm / yarn は使わない |
| フレームワーク | [Next.js](https://nextjs.org/) | App Router を使う |
| UI ライブラリ | [React](https://react.dev/) | Next.js（create-next-app）が指定するバージョンに合わせる |
| 言語 | [TypeScript](https://www.typescriptlang.org/) | 最新版を使う |
| テスト | [Vitest](https://vitest.dev/) | React Testing Library + jsdom でコンポーネントをテストする |
| mutation testing | [Stryker](https://stryker-mutator.io/) | 単体テストが変異（コードの一部を壊したもの）を検出できるかを測る。GitHub Actions で main を毎日実行し、レポートを artifact に残す（`pnpm test:mutation`。`rules/code/test.md`） |
| E2E テスト | [Playwright](https://playwright.dev/) | Chromium のみ。本番ビルドを起動し、ブラウザで画面を操作して検証する（`pnpm test:e2e`） |
| Lint / Format | [Biome](https://biomejs.dev/) | typescript-eslint が TypeScript 7 未対応のため ESLint ではなく Biome を使う（`rules/code/lint.md`） |
| Git フック | [Lefthook](https://github.com/evilmartians/lefthook) | pre-commit でステージ済みファイルを Biome で検査する |
| コンテナ | [Docker Compose](https://docs.docker.com/compose/) | `compose.yaml` を手元・GitHub Actions・クラウドセッションの 3 環境で共通に使う。Podman（`podman compose`）でも同じファイルを使う想定 |
| データベース | [PostgreSQL](https://www.postgresql.org/) | 18（`mirror.gcr.io/library/postgres:18-alpine`。Docker Hub の匿名 pull のレート制限を避けるためミラーから取る）。Todo の保存先（アプリは常に Postgres。InMemory のリポジトリはテスト用） |
| ORM / マイグレーション | [Drizzle ORM](https://orm.drizzle.team/) + [drizzle-kit](https://orm.drizzle.team/docs/kit-overview) | スキーマを TypeScript で宣言し、`pnpm db:generate` で SQL を生成、`pnpm db:migrate` で当てる（`push` は使わない。`rules/code/architecture.md` の「永続化」） |
| DB ドライバ | [node-postgres（pg）](https://node-postgres.com/) | 接続先とプールの設定は `.env` から読む（`apps/backend/shared/infra/env.ts`。値は `.env.example`。本番用の値は Issue #58 で決める） |

ツールのバージョンは `.tool-versions` が正（決め方と更新手順は `rules/code/env.md`）。npm パッケージのバージョンは各 `package.json`（リポジトリ直下・`apps/frontend`・`apps/backend`）と `pnpm-lock.yaml` が正（`rules/code/dependencies.md`）。pnpm のサプライチェーン保護設定は `pnpm-workspace.yaml` を参照。

## ディレクトリ構成

機能（feature）単位で置く。画面側（Next.js）を `apps/frontend/`、API 側（Next・React に依存しない TypeScript）を `apps/backend/` に分け、それぞれ pnpm workspace のパッケージ（`@repo/frontend` / `@repo/backend`）にする（Issue #68。プロセスは Next 1 つのまま）。`src/` は使わない（例は Todo）。

```
pnpm-workspace.yaml     # packages: apps/*（workspace の範囲）と pnpm の設定
package.json            # ツールと共通の devDependencies。pnpm dev/build/start・db:generate/db:migrate は pnpm --filter で apps の script を呼ぶ
apps/
  frontend/             # @repo/frontend。Next.js（apps/frontend で next dev/build/start）
    package.json        # next / react / "@repo/backend": "workspace:*"
    app/                # ルーティングだけ（page.tsx は screen を返すだけ、api/**/route.ts は backend の api ファイルの GET / POST などを re-export するだけ）
    features/todo/      # 画面側
      screens/todo-screen/  # 一覧画面。todo-screen.tsx（見た目）+ todo-screen.hook.ts（状態・データ取得）+ テスト
      screens/todo-detail-screen/  # 詳細画面（/todo/[id]）。構成は todo-screen/ と同じ
      components/         # feature 内で画面をまたぐ部品（todo-item.tsx）
      api/                # /api/... を fetch する薄いラッパー（型は backend の api ファイルから import type）
      index.ts            # 公開 API（外から import してよいのはここだけ）
    shared/             # 画面側で feature をまたぐ共通部品（必要になったら作る）
    instrumentation.ts  # 起動時の環境変数の検証（Next の規約ファイル）
  backend/
    package.json        # @repo/backend。drizzle-orm / pg、exports（外に公開するファイルの一覧）、db:generate / db:migrate
    todo/               # API 側（DDD 4 層）
      presentation/       # 1 API = 1 ファイル（list-todos.api.ts など）。コンテナを受け取って handler を返す関数（listTodosApi(container)）、本番用の GET / POST など、リクエスト / レスポンスの型を export
      application/        # 読むだけの query（list-todos.query.ts）と状態を変える command（create-todo.command.ts）
      domain/             # Entity / Value Object / Repository の interface
      infra/              # Repository の実装（Postgres / InMemory）、schema.ts（Drizzle のスキーマ）、container.ts（DI。command をトランザクションで包む）
    shared/             # API 側で feature をまたぐ共通部品（domain/ に DomainError と TransactionRunner、presentation/ に HTTP ステータス変換と本文の読み取り、infra/ に環境変数の入口 env.ts と Postgres のプール、Drizzle のトランザクション）
    drizzle/            # 生成したマイグレーション（pnpm db:generate が作る。コミットする）
    drizzle.config.ts   # drizzle-kit の設定
e2e/                    # Playwright の E2E
```

- 画面は SSR を前提にせず、データは hook から `/api/...` を呼んで取る。サーバの処理はすべて `apps/backend/` に置く。
- frontend（と `e2e/`・リポジトリ直下の設定ファイル）から backend へは `@repo/backend/<path>` でだけ参照する（相対パスは使わない）。使えるのは `apps/backend/package.json` の `exports` に書いたファイルだけ。frontend で参照してよいのは `app/api/**`（api ファイルの値）、`features/*/api/`（型だけ）、`instrumentation-node.ts`（`env.ts`）だけ。backend は frontend を参照せず、backend の中の import は相対パスだけにする（`architecture.test.ts` で検査。`rules/code/architecture.md` の「workspace パッケージと exports」）。
- 画面側からサーバ側へは、各 api ファイル（`apps/backend/<feature>/presentation/<name>.api.ts`）の型を `import type` で参照するだけ。型で担保されるのはリクエスト / レスポンスの形で、URL・メソッド・実行時の JSON の形は担保されない。
- テストは対象の隣に置く（`app/` には置かない）。

詳細（依存の向き、命名、テストの置き方、採用しなかった案）は `rules/code/architecture.md` を参照。

## セットアップ

```sh
asdf plugin add nodejs
asdf plugin add pnpm
asdf install
```

バージョンの確認方法や更新手順の詳細は `rules/code/env.md` を参照。

環境変数は `.env` に置く。最初に `.env.example` をコピーする（開発用の値がそのまま入っている）。

```sh
cp .env.example .env
```

- `.env` はコミットしない（`.gitignore` 済み）。変数はすべて必須で、コードに既定値は無い。`.env` が無い・変数が欠けていると、`pnpm dev` / `pnpm start` / `pnpm build` / `pnpm test` / `pnpm test:e2e` / `pnpm db:migrate` は欠けた変数の名前を出して起動時に止まる（非 0 で終わる。`pnpm dev` / `pnpm start` は `apps/frontend/instrumentation.ts` で検証する）。
- コマンドの前に付けた環境変数（`DATABASE_URL=... pnpm db:migrate`）は `.env` より優先される。
- `.env` はリポジトリ直下に 1 つだけ置く（`apps/frontend/` などには置かない）。
- 仕組み（`apps/backend/shared/infra/env.ts` への一元化、`process.env` の直参照の禁止）は `rules/code/env.md` の「環境変数」を参照。

開発用の PostgreSQL は Docker Compose（`compose.yaml`）で起動する。

```sh
pnpm db:up       # Postgres を起動し、healthcheck が通るまで待つ（docker compose up -d --wait）
pnpm db:migrate  # apps/backend/drizzle/ のマイグレーションを当てる（drizzle-kit migrate。当て済みのものは飛ばす）
pnpm db:psql     # psql で接続する（docker compose exec db psql -U app -d app）
pnpm db:down     # 止める（データは名前付きボリューム pgdata に残る。消すときは docker compose down -v）
pnpm db:generate # apps/backend/*/infra/schema.ts を変えたら、差分の SQL を apps/backend/drizzle/ に生成する（drizzle-kit generate。DB には接続しない）
```

- 接続先は `.env` の `DATABASE_URL`（`.env.example` の値は `postgresql://app:app@localhost:5432/app`。開発用の固定値で秘密ではない）。アプリは常に Postgres を使うので、`pnpm dev` の前にも `pnpm db:up` と `pnpm db:migrate` が要る。
- 接続・プールの環境変数（`DATABASE_POOL_MAX` など）とスキーマの変え方は `rules/code/architecture.md` の「永続化（Drizzle + Postgres）」を参照。
- Docker Desktop は、従業員 250 人以上または年間売上 1,000 万ドル以上の企業での業務利用などに有料サブスクリプションが必要になる（[Docker Desktop license agreement](https://docs.docker.com/subscription-billing/desktop-license/)）。該当する場合は [Podman](https://podman.io/) の `podman compose up -d --wait` でも同じ `compose.yaml` を使える想定（Podman での実動作は未確認）。

Claude Code のクラウドセッション（asdf が無い環境）では、`scripts/cloud-session-start.sh` で `.tool-versions` どおりの Node.js / pnpm を用意する（環境設定の setup script に `bash scripts/cloud-session-start.sh --install-only` を書くと初回だけで済む）。`.tool-versions` の版を上げたら setup script も更新してキャッシュを作り直す。あわせて SessionStart フックが毎セッション `dockerd` を起動し、`docker compose pull`（最大 3 回再試行）と `docker compose up -d --wait --wait-timeout 120` で Postgres を立ち上げ、`.env` が無ければ `.env.example` からコピーして、`pnpm db:migrate` でマイグレーションを当てる。詳細は `rules/code/env.md` の「クラウドセッション」を参照。

## 開発

```sh
pnpm install   # 依存をインストール（リポジトリ直下で実行する。workspace のすべてのパッケージに入る）
pnpm dev       # 開発サーバを起動（http://localhost:3000。pnpm --filter @repo/frontend dev。引数は pnpm dev -p 3001 のように渡せる）
pnpm typecheck # 型チェック（リポジトリ全体と apps/backend の tsconfig。next build は frontend から import したファイルしか見ないため）
pnpm test      # 単体テストを実行し、カバレッジ 100% 未満なら失敗（Vitest。詳細は rules/code/architecture.md）
pnpm test:unit # 単体テストだけを実行（カバレッジを計測しない。速く回したいとき）
pnpm test:e2e  # E2E テストを実行（Playwright。本番ビルドを Postgres に接続して起動し、ブラウザで操作する。詳細は rules/code/architecture.md）
pnpm test:mutation # mutation testing を実行し、reports/mutation/ にレポートを出す（Stryker。数分かかる。詳細は rules/code/test.md）
pnpm lint      # lint + format の違反を検査（Biome。変更しない）
pnpm check     # 安全な自動修正を適用して再検査（Biome）
pnpm format    # format だけを適用（Biome）
pnpm build     # 本番ビルド（pnpm --filter @repo/frontend build。apps/frontend/.next/ に出力）
pnpm start     # 本番ビルドを起動（pnpm --filter @repo/frontend start）
```

- コマンドはリポジトリ直下で実行する。`dev` / `build` / `start` は `apps/frontend`、`db:generate` / `db:migrate` は `apps/backend` の script を `pnpm --filter` で呼ぶ（そのパッケージのディレクトリで動くが、`.env` はリポジトリ直下の 1 つを読む）。依存の追加は `pnpm --filter @repo/backend add <pkg>@<x.y.z>` のように置き場所のパッケージを指定する（`rules/code/dependencies.md`）。

- どのコマンドも `.env` がある前提（上の「セットアップ」）。
- `pnpm dev` は Postgres の起動とマイグレーションが前提（先に `pnpm db:up && pnpm db:migrate`）。
- `pnpm test` / `pnpm test:unit` / `pnpm test:mutation` は Postgres が起動している前提（先に `pnpm db:up`）。Postgres を使うテストは、テストファイルごとに別のスキーマを作ってマイグレーションを当てるので、`pnpm db:migrate` は不要で、`pnpm dev` のデータも消さない。前の実行が残したテスト用のスキーマは、実行の最初に消す（Postgres に接続できなければそこで止まる）。
- `pnpm test:e2e` は Postgres の起動とマイグレーションが前提（先に `pnpm db:up && pnpm db:migrate`）。各テストの前に `todos` を空にする（`pnpm dev` と同じ DB を使うので、開発中のデータも消える）。

`pnpm install` で pre-commit フック（Lefthook）も入り、コミット時にステージ済みファイルが Biome で検査される。詳細は `rules/code/lint.md` を参照。
