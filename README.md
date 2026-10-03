# ai-only-template

AI（Claude Code）が Issue → ブランチ → PR → マージ の流れで開発を進めるためのテンプレートリポジトリ。
運用ルールは `CLAUDE.md` から辿れるように置いている（下の「指示ファイルの構成」）。

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
| mutation testing | [Stryker](https://stryker-mutator.io/) | 単体テストが変異（コードの一部を壊したもの）を検出できるかを測る。GitHub Actions で main を毎日実行し、レポートを artifact に残す（`pnpm test:mutation`。`.claude/rules/quality/testing.md`・スキル `mutation-testing`） |
| E2E テスト | [Playwright](https://playwright.dev/) | Chromium のみ。本番ビルドを起動し、ブラウザで画面を操作して検証する（`pnpm test:e2e`） |
| Lint / Format | [Biome](https://biomejs.dev/) | typescript-eslint が TypeScript 7 未対応のため ESLint ではなく Biome を使う（`.claude/rules/quality/lint.md`） |
| Git フック | [Lefthook](https://github.com/evilmartians/lefthook) | pre-commit・pre-push・commit-msg で検査を動かす（中身は下の「品質ツール」） |
| コンテナ | [Docker Compose](https://docs.docker.com/compose/) | `compose.yaml` を手元・GitHub Actions・クラウドセッションの 3 環境で共通に使う。Podman（`podman compose`）でも同じファイルを使う想定 |
| データベース | [PostgreSQL](https://www.postgresql.org/) | 18（`mirror.gcr.io/library/postgres:18-alpine`。Docker Hub の匿名 pull のレート制限を避けるためミラーから取る）。Todo の保存先（アプリは常に Postgres。InMemory のリポジトリはテスト用） |
| ORM / マイグレーション | [Drizzle ORM](https://orm.drizzle.team/) + [drizzle-kit](https://orm.drizzle.team/docs/kit-overview) | スキーマを TypeScript で宣言し、`pnpm db:generate` で SQL を生成、`pnpm db:migrate` で当てる（`push` は使わない。`.claude/rules/code/backend.md` の「DB スキーマ」の表の「マイグレーション」・スキル `db-migration`） |
| DB ドライバ | [node-postgres（pg）](https://node-postgres.com/) | 接続先とプールの設定は `.env` から読む（`apps/shared/env.ts`。値は `.env.example`。本番用の値は Issue #58 で決める） |

ツールのバージョンは `.tool-versions` が正（決め方と更新手順は `.claude/rules/tooling/env.md`）。npm パッケージのバージョンは各 `package.json`（リポジトリ直下・`apps/frontend_customer`・`apps/backend`・`apps/e2e`・`apps/shared`）と `pnpm-lock.yaml` が正（`.claude/rules/tooling/dependencies.md`）。pnpm のサプライチェーン保護設定は `pnpm-workspace.yaml` を参照。

### 品質ツール（役割と実行タイミング）

どれも設定ファイルが正（`lefthook.yml`・`.github/workflows/*.yml`・`biome.json`・`vitest.config.mts`・`.github/renovate.json5`・`scripts/security/scan.sh`）。セキュリティの検査は `scripts/security/scan.sh` が Docker イメージで動かし（イメージは digest で固定。zizmor だけは版を固定した Dockerfile から手元でビルドしたイメージ）、フック・CI・デプロイが同じスクリプトを呼ぶ（`.claude/rules/tooling/security-scan.md`）。

タイミングの凡例:
* commit: `git commit` のとき（lefthook の pre-commit / commit-msg）
* push: `git push` のとき（lefthook の pre-push）
* CI: PR と main への push のたび（`ci.yml` の `ci` ジョブ。required status check）
* 毎日: GitHub Actions の schedule（手動実行も可）
* デプロイ: main への push と手動のデプロイ（`deploy.yml`）
* 手元: 必要なときに自分で実行する

| 種類 | ツール | 役割 | いつ |
| --- | --- | --- | --- |
| Lint / Format | [Biome](https://biomejs.dev/) | lint と format。warn でも失敗（`--error-on-warnings`）。長さ・複雑さの上限: 関数 50 行・ファイル 300 行・引数 4 個・1 ファイル 1 クラス・認知的複雑度（`.claude/rules/quality/lint.md`） | commit（ステージ済みファイル）・CI（`pnpm lint`） |
| 型 | [TypeScript](https://www.typescriptlang.org/)（tsc） | 型検査（ルート・`apps/backend`・`apps/shared` の 3 つ） | CI（`pnpm typecheck`） |
| テスト | [Vitest](https://vitest.dev/) | 単体・API ジャーニーのテスト。カバレッジは 4 指標すべて 100% を下回ると失敗 | CI（`pnpm test`） |
| ルール検査テスト | Vitest（`rule-tests/`） | 依存の向き・命名・置き場所・設定値など、規則が守られていることを検査する。依存パッケージのライセンスの許可リスト（`licenses`）もここ | CI（`pnpm test` に含む） |
| CSP の評価 | [CSP Evaluator](https://csp-evaluator.withgoogle.com/)（npm `csp_evaluator`） | セキュリティヘッダの CSP を Google の検査で評価する（`security-headers.test.ts`） | CI（`pnpm test` に含む） |
| E2E | [Playwright](https://playwright.dev/) + [playwright-bdd](https://vitalets.github.io/playwright-bdd/) | 本番ビルドをブラウザで操作して業務の流れを検証する（`apps/e2e/spec/*.feature`） | CI・手元（`pnpm test:e2e`） |
| 動的検査（DAST） | [ZAP](https://www.zaproxy.org/) | E2E の通信をプロキシで受けて受け身の検査（passive scan）にかけ、その記録に攻撃を送る検査（active scan）もかける。Low 以上の警告で失敗 | main の日次（`zap.yml` の `scan.sh zap-e2e`） |
| mutation testing | [Stryker](https://stryker-mutator.io/) | テストが変異（コードの一部を壊したもの）を検出できるかを測り、レポートを artifact に残す（スキル `mutation-testing`） | 毎日（`mutation.yml`。08:55 JST）・手元（`pnpm test:mutation`） |
| 秘密情報 | [gitleaks](https://github.com/gitleaks/gitleaks) | API キー・トークンなどの混入を検出する | commit（ステージ済みの変更）・CI（全履歴） |
| コードの脆弱性（SAST） | [Semgrep](https://semgrep.dev/) | JavaScript / TypeScript の脆弱性のパターン（security の ERROR の規則） | push・CI |
| 依存の脆弱性 | pnpm audit | 依存パッケージの既知の脆弱性。high 以上で失敗 | CI（`pnpm audit --audit-level high`） |
| ワークフローの検査 | [actionlint](https://github.com/rhysd/actionlint) | GitHub Actions の構文・式・`run` の shellcheck | commit（ワークフローを変えたとき）・CI |
| ワークフローの検査 | [zizmor](https://github.com/zizmorcore/zizmor) | GitHub Actions のセキュリティ（スクリプトインジェクション・資格情報の残留など） | commit（ワークフローを変えたとき）・CI |
| Dockerfile の lint | [hadolint](https://github.com/hadolint/hadolint) | Dockerfile の書き方。warning 以上で失敗 | commit（Dockerfile を変えたとき）・CI |
| 設定・イメージの脆弱性 | [Trivy](https://trivy.dev/) | Dockerfile と Terraform（`infra/`）の設定ミス、ビルドしたイメージの OS パッケージの脆弱性。HIGH / CRITICAL で失敗（イメージは直した版があるものだけ） | commit（Dockerfile か `infra/` を変えたとき）・CI（設定）・デプロイ（イメージ） |
| AI のセキュリティレビュー | [Claude Code Action](https://github.com/anthropics/claude-code-action) | 前回から main に入った差分を Claude がレビューし、見つかったものを private の security advisory にする | 毎日（`security-review.yml`。08:47 JST） |
| ルールのレビュー | Claude Code のスキル `rule-review` | 機械で止めていないコード・設計ルール（`.claude/rules/code` の表の「レビュー」の行）で差分をレビューし、結果を PR に残す | 手元（PR を作った後、マージの前） |
| 依存の更新 | [Renovate](https://docs.renovatebot.com/) | npm・asdf・GitHub Actions の更新 PR を作る。公開から 5 日経った版だけ。minor / patch は CI が緑なら自動マージ（0.x と Next.js / React を除く） | 毎週月曜 00:00〜08:59 JST |
| サプライチェーン保護 | pnpm の設定（`pnpm-workspace.yaml`） | 公開から 5 日未満の版・信頼度の下がった版・推移的依存の git / URL 取得を install で拒否する | `pnpm install` のたび |
| コミットメッセージ | `scripts/hooks/check-commit-msg.sh` | 4 項目（WHY / WHAT / 実装経緯 / 検証内容）と `Co-Authored-By:` の形式 | commit（commit-msg） |
| 作業ログ | `scripts/hooks/check-work-logs-diff.sh` ほか | PR の差分に作業ログ（`docs/work-logs/`）があり、各項目に `- 機械化:` の行があること | CI（PR のとき）・Claude Code の Stop フック |

## ディレクトリ構成

機能（feature）単位で置く。画面側（Next.js）を `apps/frontend_customer/`、API 側（Next・React に依存しない TypeScript）を `apps/backend/` に分け、それぞれ pnpm workspace のパッケージ（`@repo/frontend-customer` / `@repo/backend`）にする（Issue #68。プロセスは Next 1 つのまま）。両方が使う環境変数の入口とログの出口は `apps/shared/`（`@repo/shared`。Issue #90）に置く。`src/` は使わない（例は Todo）。

```
pnpm-workspace.yaml     # packages: apps/*（workspace の範囲）と pnpm の設定
package.json            # ツールと共通の devDependencies。pnpm dev/build/start・db:generate は pnpm --filter で apps の script を呼ぶ。db:migrate は直下の script（入口を束ねて実行）
apps/
  frontend_customer/    # @repo/frontend-customer。Next.js（apps/frontend_customer で next dev/build/start）
    package.json        # next / react / "@repo/backend"・"@repo/shared": "workspace:*"
    app/                # ルーティングだけ（page.tsx は screen を返すだけ、api/**/route.ts は backend の api ファイルの GET / POST などを re-export するだけ）
    features/todo/      # 画面側
      screens/todo-screen/  # 一覧画面。todo-screen.tsx（見た目）+ todo-screen.hook.ts（状態・データ取得）+ テスト
      screens/todo-detail-screen/  # 詳細画面（/todo/[id]）。構成は todo-screen/ と同じ
      components/         # feature 内で画面をまたぐ部品（今は無い。1 画面だけで使う部品は画面のファイルの中）
      api/                # /api/... を fetch する薄いラッパー（型は backend の api ファイルから import type）
      index.ts            # 公開 API（外から import してよいのはここだけ）
    shared/             # 画面側で feature をまたぐ共通部品（必要になったら作る）
    instrumentation.ts  # 起動時の環境変数の検証（Next の規約ファイル）
  backend/
    package.json        # @repo/backend。drizzle-orm / pg / @repo/shared、exports（外に公開するファイルの一覧）、db:generate
    features/           # 機能ごとのまとまり（frontend の features/ と同じ。Issue #98）
      todo/               # API 側の 1 機能 = 1 モジュール（直下は internal/ と、必要なら expose/ だけ。Issue #208）
        internal/           # feature の中だけで使う実装（DDD 4 層。Issue #208）
          presentation/       # 1 API = 1 ファイル（list-todos.api.ts など）。クラス <Verb><Noun>Api（コンストラクタで query / command を受け取り、handle が Route Handler）、ファイルの最下部で組み立てた本番用の GET / POST など、リクエスト / レスポンスの型を export
          application/        # 読むだけの query（list-todos.query.ts）と状態を変える command（create-todo.command.ts）
          domain/             # Entity / Value Object / Repository の interface
          infra/              # Repository の Postgres の実装、schema.ts（Drizzle のスキーマ）。テスト用の InMemory は apps/backend/test-support/<feature>/
      notification/       # 通知のモジュール（今はログに出すだけ。Todo の完了で todo から呼ばれる）
        expose/             # 他のモジュールへ公開する入口（notifier.ts。直下のファイルだけ）。他のモジュールは expose/ だけを使い、internal/ は参照しない
        internal/           # 中身（domain/ の送信口の interface、application/ の command、infra/ のログに出す実装）
    shared/             # API 側で feature をまたぐ共通部品。層ではなく意味の単位で置く（Issue #310）
      error/              # エラーのキー（ErrorKey）・DomainError・zod の検証をそれに変える道具
      transaction/        # トランザクションの印と port（TransactionRunner）
      http/               # エラー応答（RFC 9457 の Problem Details）とリクエストの読み取り
      drizzle/            # drizzle.config.ts（drizzle-kit の設定）、Postgres のプール、トランザクションの実装、書き込みの口 Writer
        migrations/         # 生成したマイグレーション（*.sql と meta/。pnpm db:generate が作る。コミットする）
      change-log/         # 変更履歴（change_logs の表と記録）
  shared/               # @repo/shared。frontend と backend で共通の基盤だけ（Issue #90。.claude/rules/code/shared.md）
    package.json        # 依存なし。exports は ./env・./logger だけ
    env.ts              # 環境変数の唯一の入口（リポジトリ直下の .env を読み、必須の変数を検証する）
    logger.ts           # サーバ側のログの唯一の出口（JSON 1 行）
  e2e/
    package.json        # @repo/e2e。@playwright/test / playwright-bdd / pg / @repo/shared、test（bddgen && playwright test）
    playwright.config.ts # 設定（spec/ の .feature を playwright-bdd で実行する）
    spec/               # 読むもの: E2E の業務の流れ（*.feature。Gherkin。日本語の step。API ジャーニーと同じ書き方）と step の実装（*.steps.ts。クラスのメソッド。shared.steps.ts は共有の step）
    support/            # テストの土台: fixtures.ts（step のクラスを fixture にする）・database.ts（Todo のリセット）・log-server.ts（stdout を読めるサーバ）
```

- 画面は SSR を前提にせず、データは hook から `/api/...` を呼んで取る。サーバの処理はすべて `apps/backend/` に置く。
- frontend（と `apps/e2e/`・リポジトリ直下の設定ファイル）から backend へは `@repo/backend/<path>` でだけ参照する（相対パスは使わない。例外はテスト基盤の `vitest.global-setup.ts` → `apps/backend/test-support/database` だけ）。使えるのは `apps/backend/package.json` の `exports` に書いたファイルだけ。frontend で参照してよいのは `app/api/**`（api ファイルの値）と `features/*/api/`（型だけ）だけ。`apps/shared`（env・logger）は frontend 直下のサーバ側のファイル・backend・`apps/e2e/`・リポジトリ直下から `@repo/shared/<name>` で参照し、画面側（`app/`・`features/`・`shared/`）からは参照しない。backend は frontend を参照せず、backend の中の import は相対パスだけにする（`rule-tests/architecture.test.ts` で検査。`.claude/rules/code/backend.md` の「import と exports」）。
- 画面側からサーバ側へは、各 api ファイル（`apps/backend/features/<feature>/internal/presentation/<name>.api.ts`）の型を `import type` で参照するだけ。型で担保されるのはリクエスト / レスポンスの形で、URL・メソッド・実行時の JSON の形は担保されない。
- テストは対象の隣に置く（`app/` には置かない）。

詳細は `.claude/rules/code/backend.md`（API 側）・`.claude/rules/code/frontend.md`（画面側）・`.claude/rules/code/architecture-check.md`（依存の向きの検査）・`.claude/rules/quality/testing.md`（テストの置き方）、決定と採用しなかった案は ADR（`docs/adr/README.md` の一覧）を参照。

## セットアップ

```sh
asdf plugin add nodejs
asdf plugin add pnpm
asdf install
```

バージョンの確認方法や更新手順の詳細は `.claude/rules/tooling/env.md` を参照。

環境変数は `.env` に置く。最初に `.env.example` をコピーする（開発用の値がそのまま入っている）。

```sh
cp .env.example .env
```

- `.env` はコミットしない（`.gitignore` 済み）。変数はすべて必須で、コードに既定値は無い。`.env` が無い・変数が欠けていると、`pnpm dev` / `pnpm start` / `pnpm build` / `pnpm test` / `pnpm test:e2e` / `pnpm db:migrate` は欠けた変数の名前を出して起動時に止まる（非 0 で終わる。`pnpm dev` / `pnpm start` は `apps/frontend_customer/instrumentation.ts` で検証する）。
- コマンドの前に付けた環境変数（`DATABASE_URL=... pnpm db:migrate`）は `.env` より優先される。
- `.env` はリポジトリ直下に 1 つだけ置く（`apps/frontend_customer/` などには置かない）。
- 仕組み（`apps/shared/env.ts` への一元化、`process.env` の直参照の禁止）は `.claude/rules/tooling/env.md` の「環境変数」を参照。

開発用の PostgreSQL は Docker Compose（`compose.yaml`）で起動する。

```sh
pnpm db:up       # Postgres を起動し、healthcheck が通るまで待つ（docker compose up -d --wait）
pnpm db:migrate  # apps/backend/shared/drizzle/ のマイグレーションを当てる（入口 migrate.ts を esbuild で束ねて実行。Cloud Run の migrate ジョブと同じファイル。当て済みのものは飛ばす）
pnpm db:psql     # psql で接続する（docker compose exec db psql -U app -d app）
pnpm db:down     # 止める（データは名前付きボリューム pgdata に残る。消すときは docker compose down -v）
pnpm db:generate # apps/backend/features/*/internal/infra/schema.ts を変えたら、差分の SQL を apps/backend/shared/drizzle/ に生成する（drizzle-kit generate。DB には接続しない）
```

- 接続先は `.env` の `DATABASE_URL`（`.env.example` の値は `postgresql://app:app@localhost:5432/app`。開発用の固定値で秘密ではない）。アプリは常に Postgres を使うので、`pnpm dev` の前にも `pnpm db:up` と `pnpm db:migrate` が要る。
- 接続・プールの環境変数（`DATABASE_POOL_MAX` など）は `.claude/rules/code/backend.md` の「Repository」の表の「接続とプール」、スキーマの変え方はスキル `db-migration` を参照。
- Docker Desktop は、従業員 250 人以上または年間売上 1,000 万ドル以上の企業での業務利用などに有料サブスクリプションが必要になる（[Docker Desktop license agreement](https://docs.docker.com/subscription-billing/desktop-license/)）。該当する場合は [Podman](https://podman.io/) の `podman compose up -d --wait` でも同じ `compose.yaml` を使える想定（Podman での実動作は未確認）。

Claude Code のクラウドセッション（asdf が無い環境）では、`scripts/cloud-session-start.sh` で `.tool-versions` どおりの Node.js / pnpm を用意する（環境設定の setup script に `bash scripts/cloud-session-start.sh --install-only` を書くと初回だけで済む）。`.tool-versions` の版を上げたら setup script も更新してキャッシュを作り直す。あわせて SessionStart フックが毎セッション `dockerd` を起動し、`docker compose pull`（最大 3 回再試行）と `docker compose up -d --wait --wait-timeout 120` で Postgres を立ち上げ、`.env` が無ければ `.env.example` からコピーして、`pnpm db:migrate` でマイグレーションを当てる。詳細は `.claude/rules/tooling/cloud-session.md`（規則）・スキル `cloud-session`（確認と復旧）・ADR `docs/adr/workflow/20260928-cloud-session-setup-script-and-hook.md`（決定）を参照。

## 開発

```sh
pnpm install   # 依存をインストール（リポジトリ直下で実行する。workspace のすべてのパッケージに入る）
pnpm dev       # 開発サーバを起動（http://localhost:3000。pnpm --filter @repo/frontend-customer dev。引数は pnpm dev -p 3001 のように渡せる）
pnpm typecheck # 型チェック（リポジトリ全体と apps/backend・apps/shared の tsconfig。next build は frontend から import したファイルしか見ないため）
pnpm test      # 単体テストを実行し、カバレッジ 100% 未満なら失敗（Vitest。詳細は .claude/rules/quality/testing.md）
pnpm test:unit # 単体テストだけを実行（カバレッジを計測しない。速く回したいとき）
pnpm test:api-journey # API ジャーニーテストだけを実行（実 Postgres で複数の API を、.feature に書いた業務の流れの順に呼ぶ。詳細は .claude/rules/quality/testing.md）
pnpm test:e2e  # E2E テストを実行（Playwright。本番ビルドを Postgres に接続して起動し、ブラウザで操作する。詳細は .claude/rules/quality/testing.md）
pnpm test:mutation # mutation testing を実行し、reports/mutation/ にレポートを出す（Stryker。数分かかる。詳細はスキル mutation-testing）
pnpm lint      # lint + format の違反を検査（Biome。変更しない）
pnpm check     # 安全な自動修正を適用して再検査（Biome）
pnpm format    # format だけを適用（Biome）
pnpm build     # 本番ビルド（pnpm --filter @repo/frontend-customer build。apps/frontend_customer/.next/ に出力）
pnpm start     # 本番ビルドを起動（pnpm --filter @repo/frontend-customer start）
```

- コマンドはリポジトリ直下で実行する。`dev` / `build` / `start` は `apps/frontend_customer`、`db:generate` は `apps/backend` の script を `pnpm --filter` で呼ぶ。`db:migrate` はリポジトリ直下の script で、`apps/backend/shared/drizzle/migrate.ts` を esbuild で `dist/migrate/` に束ねて実行する（Issue #326）（そのパッケージのディレクトリで動くが、`.env` はリポジトリ直下の 1 つを読む）。依存の追加は `pnpm --filter @repo/backend add <pkg>@<x.y.z>` のように置き場所のパッケージを指定する（`.claude/rules/tooling/dependencies.md`）。

- どのコマンドも `.env` がある前提（上の「セットアップ」）。
- `pnpm dev` は Postgres の起動とマイグレーションが前提（先に `pnpm db:up && pnpm db:migrate`）。
- `pnpm test` / `pnpm test:unit` / `pnpm test:mutation` は Postgres が起動している前提（先に `pnpm db:up`）。Postgres を使うテストは、テストファイルごとに別のスキーマを作ってマイグレーションを当てるので、`pnpm db:migrate` は不要で、`pnpm dev` のデータも消さない。前の実行が残したテスト用のスキーマは、実行の最初に消す（Postgres に接続できなければそこで止まる）。
- `pnpm test:e2e` は Postgres の起動とマイグレーションが前提（先に `pnpm db:up && pnpm db:migrate`）。各テストの前に `todos` を空にする（`pnpm dev` と同じ DB を使うので、開発中のデータも消える）。

`pnpm install` で pre-commit フック（Lefthook）も入り、コミット時にステージ済みファイルが Biome で検査される。詳細は `.claude/rules/quality/lint.md` を参照。

## デプロイ

デプロイ先は GCP の Cloud Run（`frontend-customer`）+ Cloud SQL for PostgreSQL で、環境は stg と prod の 2 つ（GCP のプロジェクトが別。Issue #137。決定は ADR `docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md`）。

- 器（Cloud SQL・Cloud Run の service / job・Secret・IAM・GitHub Actions 用の WIF）は Terraform。リソースは `infra/modules/app`、環境ごとの設定は `infra/envs/stg`・`infra/envs/prod`（同じ module を別のプロジェクトで呼ぶ）。初回の手順（環境ごとに state のバケット → `terraform apply` → GitHub の Environment の Variables）と、Data Studio・Metabase・Cloud SQL の MCP の接続は `infra/README.md`。
- main へのマージで `.github/workflows/deploy.yml` が stg にデプロイする（イメージを build し、migrate ジョブ → service の順に入れ替える）。prod は Actions の「Run workflow」で `prod` を選んだ手動実行だけ。
- ロールバック・migrate の再実行・パスワードのローテーションはスキル `deploy`（`.claude/skills/deploy/SKILL.md`）。

## 指示ファイルの構成

AI（Claude Code）への指示は、常に読み込むもの・必要なときだけ読み込むもの・読み込まない記録に分けている（Issue #64。決定は ADR `docs/adr/workflow/20260928-instruction-files-by-load-timing.md`、rules への統合は `docs/adr/workflow/20261002-always-loaded-rules-in-rules-workflow.md`）。構成は `rule-tests/instructions.test.ts` が検査する（CLAUDE.md の行数と `@` import、`.claude/rules` の分類と `paths`、ADR の形式、スキルのフロントマター）。

| 置き場所 | 読み込まれるとき | 置くもの |
| --- | --- | --- |
| `CLAUDE.md` | 常時 | 原則（FACT ベース・Test Driven など）と、ほかの置き場所の一覧。`@` で `LEARNINGS.md` を読む |
| `LEARNINGS.md` | 常時（`CLAUDE.md` から） | 改善ループで得た再発防止ルール |
| `.claude/rules/workflow/` | 常時（`paths` を持たないので起動時に読まれる） | オーケストレーション・Issue → PR → マージ・コミットメッセージ・作業ログの要点 |
| `.claude/rules/<分類>/` | フロントマターの `paths` に一致するファイルを触ったとき | 規則と WHY。`code/`（backend・frontend・shared・依存の向きの検査）・`quality/`（テスト・lint）・`tooling/`（環境変数・依存・クラウドセッション・git ガード・作業ログのフック・worktree） |
| `.claude/skills/` | 説明は常時、本文は呼び出したとき | 手順（`pr-flow`・`rule-check-test`・`mutation-testing`・`db-migration`・`dependency-update`・`cloud-session`） |
| `.claude/agents/` | サブエージェントの起動時 | worker / researcher / reviewer の定義 |
| `docs/adr/` | 読み込まれない | ADR（決定の記録。1 決定 1 ファイル、不変。一覧は `docs/adr/README.md`） |
| `docs/work-logs/` | 読み込まれない | 日ごとの作業ログ |

- 文章のルールより、lint・テスト・フック・CI での機械的な強制を優先する（CLAUDE.md の 7）。フックは `.claude/settings.json` と `scripts/hooks/`。
