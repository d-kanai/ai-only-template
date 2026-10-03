# GitHub 側の設定（pr-flow の補足）

pr-flow の手順から参照する。設定を変えたらこのファイルを更新する。

## GitHub Projects（Status の管理）
- プロジェクト: https://github.com/users/d-kanai/projects/4（ユーザー単位。このリポジトリに紐付け済み）。Status は `Todo` / `In Progress` / `Done`。
- Status の遷移はすべて GitHub 側の組み込みワークフロー（https://github.com/users/d-kanai/projects/4/workflows ）で自動化している。AI は Projects の API を呼ばない。
  - `Todo`: 「Auto-add to project」（リポジトリ `ai-only-template`、フィルタ `is:issue is:open`）。Issue の作成・更新で追加される。フィルタが空だと追加されなかった（2026-09-28 実測）ので、フィルタは必ず設定する。
  - `In Progress`: 「Pull request linked to issue」。PR 本文の `Closes #<Issue番号>` で Issue に紐付いたとき。
  - `Done`: 「Item closed」「Pull request merged」。PR のマージで Issue が自動クローズされたとき。
- API を使わない理由: クラウドセッションの GitHub プロキシは PR 用の固定された GraphQL しか通さず、Projects v2 の API は 403 になる（公式 https://code.claude.com/docs/en/cloud-environments の「GitHub proxy」）。ワークフローは GitHub 側で動くので、ローカルでもクラウドでも同じに回る。
- ワークフローの設定変更は UI でしかできない（API に作成・更新の手段が無い）。
- ワークフローが動かず手動操作が要るとき（ローカルのみ。gh のトークンに `project` スコープが要る。`gh auth refresh -s project` はユーザーが実行する）:
  ```
  gh project item-add 4 --owner d-kanai --url <IssueのURL>
  gh project item-edit 4 --owner d-kanai --url <IssueのURL> --field Status --value "In Progress"
  ```
  `--owner` は `@me` ではなく `d-kanai` を明示する（`@me` だと `gh project link` がオーナー不一致で失敗し、`item-add` の JSON 出力も欠ける）。

## Ruleset `protect-main`（main の保護）
- https://github.com/d-kanai/ai-only-template/rules/24101231 。main への直接 push を禁止し、`required_status_checks` に `ci` を入れている（CI が赤ではマージできない）。
- `pull_request` の `required_review_thread_resolution` は `true`（Require conversation resolution before merging。2026-10-03 に daiki が ON にし、API の GET で確認）。未解決のレビューのスレッドが残る PR はマージできない。WHY: rule-review の指摘（`pr-flow` の手順 8）を処理せずにマージするのを機械で止める（Issue #341 の続き）。承認数（`required_approving_review_count`）は 0 のまま。PR の作成者が daiki のアカウントで、自分の PR は承認できないため、1 以上にするとすべての PR が止まる。
- `strict_required_status_checks_policy` は `false`（PR ブランチが main の最新を取り込んでいなくてもマージできる）。理由: 有効にすると main が進むたびに取り込み直して CI を待つ必要があり、AI が並行して複数 PR を進める運用で待ち時間が増える。main との競合が無いことはマージ条件で別に確かめる。
- Ruleset の変更はユーザーが行う。UI（上の URL → Edit → 「Require status checks to pass」）か、手元の `gh api -X PUT repos/d-kanai/ai-only-template/rulesets/24101231 --input <json>`（rules は PUT で丸ごと置き換わるので、先に GET で現在の rules を取り、変更した配列を送る）。
- クラウドセッションからは、`GH_TOKEN` を付けた `curl` で GET は 200 で読めるが、PUT はプロキシが 403「Write access to this GitHub API path is not permitted through this proxy」で拒否する（2026-09-28 実測。GitHub MCP ツールにも Ruleset の操作は無い）。

## CI（`.github/workflows/ci.yml`）
- main 宛の PR と main への push で、ジョブ `ci` が セキュリティの検査 6 つ（`scripts/security/scan.sh` の gitleaks の全履歴・actionlint・zizmor・hadolint・Trivy config・Semgrep。Issue #362。`.claude/rules/tooling/security-scan.md`）→ `pnpm install --frozen-lockfile` → `pnpm audit --audit-level high`（依存の脆弱性。Issue #112）→ Postgres の起動（`docker compose up -d --wait --wait-timeout 120`）→ psql での接続確認 → `cp .env.example .env` → `pnpm db:migrate` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → Chromium の導入（`pnpm --filter @repo/e2e exec playwright install --with-deps chromium`）→ `pnpm test:e2e` を実行する。ステップはすべてリポジトリ直下で実行する。
- Node の版は `.tool-versions`、pnpm の版は `package.json` の `packageManager` から取る（ワークフローに版を直書きしない）。
- GitHub Actions は `CI=true` を既定で設定するので、lefthook の postinstall はフックを入れない。

## セキュリティ（Issue #112）
- CodeQL（code scanning）は使わない。本番の repo は private にする予定で、private では有料の GitHub Code Security が要るため（daiki の判断 2026-10-03。ADR `docs/adr/quality/20261003-pnpm-audit-in-ci.md`）。コードの脆弱性のパターンは代わりに Semgrep（無料の規則）で止める（ADR `docs/adr/quality/20261003-security-scan-tools.md`）。
- Secret scanning と push protection: Settings → Code security で有効にする（ユーザーが UI で行う。クラウドセッションの `GH_TOKEN` では `security_and_analysis` が読めず（2026-10-03 実測、レスポンスに項目が無い）、状態は未確認）。

## クラウドセッションでの GitHub App
- 前提: Claude GitHub App がこのリポジトリにインストールされていること（https://github.com/apps/claude/installations/select_target からユーザーがインストールする）。未インストールだと読み取りだけ通り、Issue 作成が 403「Resource not accessible by integration」、`git push` が 403「Claude doesn't have GitHub access to ...」になる（2026-09-28 実測）。
- インストール後は、Issue 作成（#34）、`<type>/<Issue番号>-<内容>` ブランチの push、PR 作成（#35）、merge commit でのマージまで、ローカルと同じ流れで動くことを確認済み。
