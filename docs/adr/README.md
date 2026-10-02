# ADR（Architecture Decision Record）

決定 1 つにつき 1 ファイルで、「何を・なぜ決めたか」と「採用しなかった案」を残す。Claude Code は自動では読み込まない記録。
規則の本文（最新）は `.claude/rules/`、日ごとの行動・実測は `docs/work-logs/`、手順はスキル（`.claude/skills/`）。規則を変える前に、該当する ADR で経緯を確かめる（CLAUDE.md の 6）。
形式は `rule-tests/instructions.test.ts` の `adr-*` が検査する（分類ディレクトリ、ファイル名、1 行目の見出し、メタ 3 行、必須の見出しの順、この一覧へのリンク）。

## 命名
- `docs/adr/<分類>/yyyymmdd-<topic>.md`。`<分類>` は下の一覧の 4 つ（`architecture` / `tech-stack` / `quality` / `workflow`）のいずれかで、分類の下にさらにディレクトリは作らない。`yyyymmdd` は決定した日（その決定の Issue / PR の日付）、`<topic>` は英小文字・数字の kebab-case。
- `docs/adr/` の直下には、この README.md と分類ディレクトリだけを置く。
- ADR への参照（「置き換え（→ ...）」・この一覧のリンク・ADR の本文の中）は、`docs/adr/` からの相対パス `<分類>/<ファイル名>` で書く（ADR の外からは `docs/adr/<分類>/<ファイル名>`）。
- メタの「日付」はファイル名の日付と同じにする。

## 不変の規則
- 書いた ADR の決定と理由は書き換えない。
- 決定が変わったら新しい ADR を書き、古い ADR の状態を「置き換え（→ <分類>/<新しい ADR のファイル名>）」にする（この一覧の状態も直す）。
- 決定をやめて代わりが無いときは、状態を「廃止」にする。

## テンプレート
見出しとメタの行はこのとおりに書く（3〜5 行目がメタ）。「採用しなかった案」が記録に無いときも節は省かず、「検討した案は記録に無い」と 1 行書く。
実測の数値は ADR に書かず、work-logs の日付（例「2026-09-28 の work-logs」）で参照する。一次情報は URL で示す。

```markdown
# <決定を 1 文で>

- 日付: 2026-09-29
- 状態: 採用 | 置き換え（→ <分類>/yyyymmdd-xxx.md） | 廃止
- 関連: Issue #94 / PR #95 / `.claude/rules/backend.md`

## 背景
何が問題だったか、制約、当時の状況（2〜5 行）。

## 決定
何をどうするか。規則の本文は `.claude/rules/` に置き、ここは判断だけ。

## 理由
なぜその案か。根拠は work-logs の日付（実測。例「2026-09-28 の work-logs」）か URL（一次情報）で示す。

## 採用しなかった案
- 案 A: 採らなかった理由を 1 行

## 影響
良い点 / 悪い点 / 見直す条件。
```

## 一覧
ADR は分類ごとのディレクトリに置く。分類は次の 4 つだけ（`rule-tests/instructions.test.ts` の `adr-category`）。

### architecture/
構造と境界（どこに何を置くか、依存の向き）と設計パターン（ドメイン・永続化・横断的関心の扱い）

| 日付 | タイトル | 状態 | ファイル |
| --- | --- | --- | --- |
| 2026-09-28 | アプリは常に Postgres を使い、InMemory への切り替えを持たない（InMemory はテスト用だけ） | 採用 | [20260928-always-use-postgres-no-in-memory-switch.md](architecture/20260928-always-use-postgres-no-in-memory-switch.md) |
| 2026-09-28 | command は組み立て（container）で一律にトランザクションで包み、query は包まない | 置き換え（→ architecture/20260929-constructor-injection-without-container.md） | [20260928-commands-always-in-transaction.md](architecture/20260928-commands-always-in-transaction.md) |
| 2026-09-28 | ORM は Drizzle にし、スキーマは TypeScript で宣言して SQL のマイグレーションを生成する（push は使わない） | 採用 | [20260928-drizzle-with-generated-sql-migrations.md](architecture/20260928-drizzle-with-generated-sql-migrations.md) |
| 2026-09-28 | 環境変数は env.ts の 1 か所で型付きに読み、すべて必須・既定値なしにして、直参照を 2 系統の検査で止める | 採用 | [20260928-env-single-entry-all-required.md](architecture/20260928-env-single-entry-all-required.md) |
| 2026-09-28 | 画面側は feature 単位・screen 単位で同居させ、API 側は feature 単位の DDD 4 層にし、app/ はルーティングだけにする | 採用 | [20260928-feature-based-directory-and-ddd-backend.md](architecture/20260928-feature-based-directory-and-ddd-backend.md) |
| 2026-09-28 | ディレクトリを pnpm workspace の apps/frontend（Next）と apps/backend（@repo/backend）に分け、プロセスは Next 1 つのままにする | 採用 | [20260928-monorepo-apps-frontend-backend.md](architecture/20260928-monorepo-apps-frontend-backend.md) |
| 2026-09-29 | frontend と backend で共通の基盤（env と logger）は、workspace パッケージ apps/shared（@repo/shared）に置く | 採用 | [20260929-apps-shared-package.md](architecture/20260929-apps-shared-package.md) |
| 2026-09-29 | backend も最初の階層を features/ と shared/ にし、Drizzle の設定とマイグレーションは shared/drizzle/ に置く | 採用 | [20260929-backend-features-and-shared-directories.md](architecture/20260929-backend-features-and-shared-directories.md) |
| 2026-09-29 | DI コンテナとトランザクションの runner を廃止し、各クラスはコンストラクタ injection にして api ファイルで組み立てる | 採用 | [20260929-constructor-injection-without-container.md](architecture/20260929-constructor-injection-without-container.md) |
| 2026-09-29 | E2E は apps/e2e の workspace パッケージ @repo/e2e にする | 採用 | [20260929-e2e-as-workspace-package.md](architecture/20260929-e2e-as-workspace-package.md) |
| 2026-09-29 | API のエラー応答は RFC 9457（Problem Details）の形にし、key と params を拡張メンバーに、開発者向けの英語を detail に入れる | 採用 | [20260929-error-response-rfc9457.md](architecture/20260929-error-response-rfc9457.md) |
| 2026-09-29 | 画面の i18n はライブラリを使わずに自前の型付き辞書で行い、URL は変えずに Proxy と root layout でロケールを決め、API のエラーは key と params で返す | 採用 | [20260929-i18n-without-library.md](architecture/20260929-i18n-without-library.md) |
| 2026-09-29 | サーバ側のログは logger.ts を唯一の出口にし、console の直接の呼び出しを Biome とテストの 2 系統で止める | 採用 | [20260929-logger-single-exit.md](architecture/20260929-logger-single-exit.md) |
| 2026-09-29 | 画面の文言の辞書は画面・部品ごとに隣の *.messages.ts に置き、共通の辞書は API のエラーだけにし、自前の i18n を 3 ファイルにまとめる | 採用 | [20260929-messages-colocated-per-screen.md](architecture/20260929-messages-colocated-per-screen.md) |
| 2026-09-29 | リクエストログは Next の Proxy（edge 層）で、1 リクエスト = JSON 1 行（5W1H）で出す | 採用 | [20260929-request-log-in-proxy.md](architecture/20260929-request-log-in-proxy.md) |
| 2026-09-29 | リポジトリ全体を検査するルール検査テストは、apps/ ではなくリポジトリ直下の rule-tests/ にまとめる | 採用 | [20260929-rule-tests-directory.md](architecture/20260929-rule-tests-directory.md) |
| 2026-09-29 | Todo の不変条件は、どの口を通ってもコンストラクタで常に全フィールドを検証する（restore は reconstruct に改名） | 採用 | [20260929-todo-invariants-always-validated.md](architecture/20260929-todo-invariants-always-validated.md) |
| 2026-09-29 | DB の行から Todo を組み立てる restore は検証せず、口ごとに検証の範囲を分ける | 置き換え（→ architecture/20260929-todo-invariants-always-validated.md） | [20260929-todo-restore-skips-validation.md](architecture/20260929-todo-restore-skips-validation.md) |
| 2026-09-29 | backend の入力検証と不変条件は zod で書く（presentation は形、domain は値の規則） | 置き換え（→ architecture/20260930-presentation-overlaps-domain-validation.md） | [20260929-zod-for-backend-validation.md](architecture/20260929-zod-for-backend-validation.md) |
| 2026-09-30 | 全モデルの変更履歴（監査）は汎用の change_logs 表に、Repository が本体と同じトランザクションで書く | 置き換え（→ architecture/20260930-transaction-from-application.md） | [20260930-change-logs-written-by-repository.md](architecture/20260930-change-logs-written-by-repository.md) |
| 2026-09-30 | 集約の読み出しは、insert のみの子表を必ず全件 JOIN で読む（最新だけ・一部だけを読まない） | 採用 | [20260930-aggregate-loads-all-children.md](architecture/20260930-aggregate-loads-all-children.md) |
| 2026-09-30 | ログの 1 行は Cloud Logging の特別フィールドと OTel semconv の名前（入れ子）にし、種類を event.name の固定の一覧で全行に出す | 置き換え（→ architecture/20260930-log-masking-in-logger.md） | [20260930-log-format-cloud-logging-otel.md](architecture/20260930-log-format-cloud-logging-otel.md) |
| 2026-09-30 | 個人情報のマスクは logger の中で 3 段構え（種類ごとの zod スキーマ・sensitive の印と列の分類表・自由文の正規表現）で行い、口は logger.emit の 1 つにする | 採用 | [20260930-log-masking-in-logger.md](architecture/20260930-log-masking-in-logger.md) |
| 2026-09-30 | backend の feature をモジュールとし、直下を公開の入口 expose/ と中身 internal/ に分け、他のモジュールは presentation の組み立てで expose だけを使う | 採用 | [20260930-modular-monolith-expose-internal.md](architecture/20260930-modular-monolith-expose-internal.md) |
| 2026-09-30 | 現在時刻は apps/shared/now.ts の now() だけから取り、Entity の作成日時は引数で受け取らずに生成時に自動で入れる | 採用 | [20260930-now-single-source.md](architecture/20260930-now-single-source.md) |
| 2026-09-30 | 1 ユースケース = 1 API = 1 command にし、複数の項目を任意で受けて command の中で分岐する部分更新 API は作らない | 採用 | [20260930-one-api-per-use-case.md](architecture/20260930-one-api-per-use-case.md) |
| 2026-09-30 | presentation の入力検証は domain の規則を重ねてよい（presentation ⊆ domain）。domain は常に完全で、presentation は domain より厳しくしない | 採用 | [20260930-presentation-overlaps-domain-validation.md](architecture/20260930-presentation-overlaps-domain-validation.md) |
| 2026-09-30 | Repository の書き込みは唯一の入口 writeInTransaction を通し、その前後に 1 行ずつログを自動で出す | 置き換え（→ architecture/20260930-transaction-from-application.md） | [20260930-repository-write-log.md](architecture/20260930-repository-write-log.md) |
| 2026-09-30 | Todo の完了の遷移は集約の子表（insert のみ）に積み、最新の状態は集約の現在値の列にも持つ | 採用 | [20260930-status-transitions-as-append-only-child-table.md](architecture/20260930-status-transitions-as-append-only-child-table.md) |
| 2026-09-30 | command がトランザクションを張って Repository に渡し、Repository は insert / update に分け、変更履歴とログは書き込みの口 Writer が文ごとに記録する | 採用 | [20260930-transaction-from-application.md](architecture/20260930-transaction-from-application.md) |
| 2026-10-02 | apps/backend の本番コードはクラスを基本にし、関数を export せず、補助の関数もクラスのメソッドにする | 採用 | [20261002-class-based-backend.md](architecture/20261002-class-based-backend.md) |

### tech-stack/
言語・ツール・ライブラリの選定

| 日付 | タイトル | 状態 | ファイル |
| --- | --- | --- | --- |
| 2026-09-28 | linter / formatter は Biome を使い、ESLint は使わない。pre-commit は lefthook で止める | 採用 | [20260928-biome-instead-of-eslint.md](tech-stack/20260928-biome-instead-of-eslint.md) |
| 2026-09-28 | Stryker の vitest-runner は pnpm patch で直して使う | 採用 | [20260928-patch-stryker-vitest-runner.md](tech-stack/20260928-patch-stryker-vitest-runner.md) |
| 2026-09-28 | TypeScript は 7 系（7.0.2）を使う | 採用 | [20260928-typescript-7.md](tech-stack/20260928-typescript-7.md) |
| 2026-09-30 | 本番は GCP の Cloud Run + Cloud SQL にし、Terraform は器だけを、イメージの入れ替えは GitHub Actions の gcloud を受け持つ | 採用 | [20260930-gcp-cloud-run-and-cloud-sql.md](tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md) |

### quality/
品質ゲートとテストの方針

| 日付 | タイトル | 状態 | ファイル |
| --- | --- | --- | --- |
| 2026-09-28 | 単体テストのカバレッジは 4 指標とも 100% を必須にし、計測対象外はユーザーが決めたものに限る | 採用 | [20260928-coverage-gate-100.md](quality/20260928-coverage-gate-100.md) |
| 2026-09-28 | 依存の向きは Biome や dependency-cruiser ではなく、自前のテスト（rule-tests/architecture.test.ts）で検査する | 採用 | [20260928-dependency-direction-checked-by-own-test.md](quality/20260928-dependency-direction-checked-by-own-test.md) |
| 2026-09-28 | mutation testing（Stryker）は PR ごとではなく main で日次に実行し、score 100% を必須にする | 採用 | [20260928-mutation-testing-daily-with-score-100.md](quality/20260928-mutation-testing-daily-with-score-100.md) |
| 2026-09-28 | npm の依存は package.json でも完全固定（x.y.z）にする | 採用 | [20260928-pin-exact-dependency-versions.md](quality/20260928-pin-exact-dependency-versions.md) |
| 2026-09-28 | pnpm のサプライチェーン保護をリポジトリの設定に持ち、minimumReleaseAge は 5 日にする | 採用 | [20260928-pnpm-minimum-release-age-5-days.md](quality/20260928-pnpm-minimum-release-age-5-days.md) |
| 2026-09-28 | ルール検査テストは must pass と must reject の両方を持ち、fault injection で効くことを確かめる | 採用 | [20260928-rule-check-tests-must-pass-and-must-reject.md](quality/20260928-rule-check-tests-must-pass-and-must-reject.md) |
| 2026-09-30 | DB の列の型は text / integer / timestamptz などの既定に従い、長さ・精度は意味があるときだけ書き、既定から外れる列はテストで止める | 採用 | [20260930-db-column-types-default-text-and-integer.md](quality/20260930-db-column-types-default-text-and-integer.md) |
| 2026-09-30 | backend に、実 Postgres で複数の API を業務の流れの順に呼ぶジャーニーテストを足し、単体・ジャーニー・E2E の 3 段にする | 採用 | [20260930-backend-journey-tests.md](quality/20260930-backend-journey-tests.md) |
| 2026-09-30 | ジャーニーテストを Gherkin の .feature と step の対だけで書き、vitest-cucumber で Vitest の中で実行し、呼び名を API ジャーニー（apps/backend/spec/journey/）に変える | 採用 | [20260930-gherkin-journeys-with-vitest-cucumber.md](quality/20260930-gherkin-journeys-with-vitest-cucumber.md) |
| 2026-09-30 | API 1 つごとの仕様を Gherkin の .feature に業務の言葉で書き、実 DB で本番の組み立てを通して確かめる（API 仕様。apps/backend/spec/api/） | 採用 | [20260930-api-spec-in-feature.md](quality/20260930-api-spec-in-feature.md) |
| 2026-10-01 | 書き込みの API 仕様は、メインの変更（作成 / 更新 / 削除）とレスポンスを別の Scenario に分け、見出しを一覧の順に並べる | 採用 | [20261001-api-spec-mutation-heading.md](quality/20261001-api-spec-mutation-heading.md) |
| 2026-10-01 | 人が読む backend の仕様（API 仕様・API ジャーニー）を apps/backend/spec/ の下の api/ と journey/ にまとめる | 採用 | [20261001-backend-spec-directory.md](quality/20261001-backend-spec-directory.md) |

### workflow/
開発プロセス・環境・AI エージェントの運用

| 日付 | タイトル | 状態 | ファイル |
| --- | --- | --- | --- |
| 2026-09-28 | クラウドセッションの Node / pnpm は setup script と SessionStart フックの二段で用意し、nodejs.org に届かなければ npm レジストリから取る | 採用 | [20260928-cloud-session-setup-script-and-hook.md](workflow/20260928-cloud-session-setup-script-and-hook.md) |
| 2026-09-28 | git 操作の禁止は文章ではなく、permissions.deny・PreToolUse フック・lefthook の commit-msg で止める | 採用 | [20260928-git-operations-enforced-by-hooks.md](workflow/20260928-git-operations-enforced-by-hooks.md) |
| 2026-09-28 | 指示ファイルを読み込まれるときで分ける: 常時（CLAUDE.md・.claude/general）、パス依存（.claude/rules）、手順（スキル）、強制（フック・テスト） | 採用 | [20260928-instruction-files-by-load-timing.md](workflow/20260928-instruction-files-by-load-timing.md) |
| 2026-09-28 | Postgres は手元・CI・クラウドのすべてで同じ compose.yaml から起動する | 採用 | [20260928-postgres-via-docker-compose-everywhere.md](workflow/20260928-postgres-via-docker-compose-everywhere.md) |
| 2026-09-28 | 実測・経緯・一次情報・採用しなかった案は、読み込まれない docs/ に置き、規則からリンクする | 置き換え（→ workflow/20260929-replace-docs-with-adr.md） | [20260928-records-in-docs.md](workflow/20260928-records-in-docs.md) |
| 2026-09-28 | 作業ログの記録漏れを、Stop フックと CI の差分検査で止める | 採用 | [20260928-work-log-enforced-by-stop-hook-and-ci.md](workflow/20260928-work-log-enforced-by-stop-hook-and-ci.md) |
| 2026-09-28 | worktree ごとの外部リソースは、worktree 名から値を導いて WorktreeCreate フックが .env に書き、作成まで行う | 採用 | [20260928-worktree-isolated-external-resources.md](workflow/20260928-worktree-isolated-external-resources.md) |
| 2026-09-29 | CI の完了をポーリングで待たず、PR に auto-merge（merge commit）を付けて終える | 採用 | [20260929-merge-with-auto-merge.md](workflow/20260929-merge-with-auto-merge.md) |
| 2026-09-29 | docs/ の記録を廃止し、決定は ADR（docs/adr）、実測は work-logs、一次情報は規則の WHY に置く | 採用 | [20260929-replace-docs-with-adr.md](workflow/20260929-replace-docs-with-adr.md) |
| 2026-09-29 | Usage limit の節約のため、1 Issue = 1 セッション・wake の削減・軽い worker・reviewer と fault injection の最小化を運用にする | 採用 | [20260929-save-usage-limit.md](workflow/20260929-save-usage-limit.md) |
| 2026-10-01 | 1 Issue = 1 セッションをやめ、Claude Code Projects のスレッドは業務の単位で分け、開発は 1 つのスレッドで続ける | 置き換え（→ workflow/20261001-project-threads-per-task.md） | [20261001-project-threads-by-business-area.md](workflow/20261001-project-threads-by-business-area.md) |
| 2026-10-01 | Claude Code Projects のスレッドは開発もタスクごとに分け、関連が深くコンテキストを引き継ぎたいときだけ同じスレッドで続ける | 採用 | [20261001-project-threads-per-task.md](workflow/20261001-project-threads-per-task.md) |
| 2026-10-01 | スキーマの変更はデプロイの切替の前、データの移行（backfill）は切替の後に冪等な SQL で流す | 採用 | [20261001-backfill-after-traffic-switch.md](workflow/20261001-backfill-after-traffic-switch.md) |
