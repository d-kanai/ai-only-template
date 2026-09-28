# ブランチ・PRルール

main は常にマージ可能な状態を保つ。作業はすべて Issue → ブランチ → PR → マージ の流れで行い、main への直接コミット・push はしない（GitHub の Ruleset でも禁止している）。

## Issue
- 作業は Issue を起点にする。なければ AI が作成する（目的・完了条件を書く）。
- 1 Issue = 1 PR を基本とする。大きければ Issue を分ける。
- 作成した Issue は GitHub Projects（下記）に自動で追加される。
- Issue には type ラベルを 1 つ付ける（`gh issue create --label <type>`）。type はブランチ命名の type と同じ 5 つ: `feat` / `fix` / `docs` / `chore` / `refactor`。ブランチ名の type、PR のラベル（`gh pr create --label <type>`）も Issue と同じにする。Projects ではラベル列でグループ化・絞り込みができる。

## GitHub Projects（ステータス管理）
- プロジェクト: https://github.com/users/d-kanai/projects/4（ユーザー単位のプロジェクトで、このリポジトリに紐付け済み）。Status は `Todo` / `In Progress` / `Done` の 3 つ。
- Status の遷移はすべて GitHub 側の組み込みワークフロー（プロジェクトの Workflows 画面 https://github.com/users/d-kanai/projects/4/workflows ）で自動化しており、AI は Projects の API を呼ばない。
  - 追加（`Todo`）: 「Auto-add to project」（リポジトリ `ai-only-template`、フィルタ `is:issue is:open`）。Issue の作成・更新で自動追加される。フィルタが空だと追加されなかったため、フィルタは必ず設定する（2026-09-28 実測）。
  - `In Progress`: 「Pull request linked to issue」。PR 本文の `Closes #<Issue番号>` で Issue に紐付いたときに変わる。
  - `Done`: 「Item closed」「Pull request merged」。PR のマージで Issue が自動クローズされて変わる。
- API を使わない理由: クラウドセッション（Claude Code on the web）では GitHub プロキシが PR 用の固定された GraphQL しか通さず、Projects v2 の API は 403 になる（公式 https://code.claude.com/docs/en/cloud-environments 「GitHub proxy」）。ワークフローは GitHub 側で動くのでローカルでもクラウドでも同じに回る。
- ワークフローの設定変更は UI でしかできない（API に作成・更新の手段がない）。変えたときはこの節を更新する。
- ローカルで手動操作が必要になったとき（例: ワークフローが動かない）だけ、次を使う。gh のトークンに `project` スコープが必要（`gh auth refresh -s project` はユーザーが実行する）。
  ```
  gh project item-add 4 --owner d-kanai --url <IssueのURL>
  gh project item-edit 4 --owner d-kanai --url <IssueのURL> --field Status --value "In Progress"
  ```
  `--owner` は `@me` ではなく `d-kanai` を明示する（`@me` だと `gh project link` がオーナー不一致で失敗し、`item-add` の JSON 出力も欠ける）。

## クラウドセッション（Claude Code on the web）での GitHub 操作
- `gh` CLI は入っていない。Issue / PR の作成・ラベル付与・マージは GitHub MCP ツール（`mcp__github__issue_write` / `create_pull_request` / `merge_pull_request` など）で行う。このファイルの `gh` のコマンド例は、クラウドでは対応する MCP ツールに読み替える（PR のラベルは `issue_write` の update で付ける）。
- 前提: Claude GitHub App がこのリポジトリにインストールされていること。未インストールだと読み取りだけ通り、Issue 作成が 403「Resource not accessible by integration」、`git push` が 403「Claude doesn't have GitHub access to ...」になる（2026-09-28 実測。ユーザーが https://github.com/apps/claude/installations/select_target からインストールして解消）。
- インストール後は、Issue 作成（#34）、`<type>/<Issue番号>-<内容>` ブランチの push、PR 作成（#35）、merge commit でのマージまで、ローカルと同じ流れで動くことを確認済み。Projects の Status はローカルと同じく GitHub 側のワークフローで変わる（API は呼ばない）。
- セッション開始時に `claude/<ランダム名>` ブランチが作られるが、作業はルールどおり main から `<type>/<Issue番号>-<内容>` を切って行う。`claude/...` ブランチは使わない（origin に残っていれば削除する）。
- 環境の設定（setup script・許可ドメイン・GitHub App）はセッションの中からは変更できない。必要なときはユーザーに依頼する。

## ブランチ
- main から切る。
- 命名: `<type>/<Issue番号>-<内容>`（例: `feat/12-branch-rules`）
- type: `feat` / `fix` / `docs` / `chore` / `refactor`
- マージ後のブランチは GitHub 側で自動削除し、ローカルも下記「マージ後の後始末」で削除する。

## PR
- 作成は `gh pr create`。本文は `.github/PULL_REQUEST_TEMPLATE.md` の項目（WHY / WHAT / 実装経緯 / 検証内容）を埋める。
- 本文に `Closes #<Issue番号>` を入れ、マージで Issue を自動クローズする。
- タイトルはコミットメッセージ1行目と同じ書き方（何をしたか）。

## マージ
- 方式: merge commit（`gh pr merge --merge`）。squash / rebase は使わない。
- マージ条件（すべて満たすこと）:
  1. reviewer サブエージェントの検証で問題なし（reviewer が使えない場合はオーケストレータ自身がテスト実行・差分確認で確認し、その旨を報告に書く）
  2. CI（GitHub Actions の `ci` ジョブ: Postgres の起動と接続確認 / `pnpm lint` / `pnpm test` / `pnpm build` / `pnpm test:e2e`）が緑。main の Ruleset `protect-main` の required status check にしているので、赤のままではマージできない（下の「CI」）
  3. main との競合がない
- マージはオーケストレータ（メイン）が行う。人間の承認は不要。マージ後にユーザーへ報告する。
- サブエージェントは PR 作成・マージをしない。

## CI（GitHub Actions）
- `.github/workflows/ci.yml` が、main 宛の PR と main への push で `pnpm install --frozen-lockfile` → Postgres の起動（`docker compose up -d --wait --wait-timeout 120`）→ psql での接続確認（`docker compose exec -T db psql -U app -d app -c 'select 1'`）→ `pnpm lint` → `pnpm test` → `pnpm build` → Chromium の導入（`pnpm exec playwright install --with-deps chromium`）→ `pnpm test:e2e` を実行する（ジョブ名 `ci`）。
- Node の版は `.tool-versions` の `nodejs` 行、pnpm の版は `package.json` の `packageManager` から取る（ワークフローに版を直書きしない。`rules/code/env.md`）。
- GitHub Actions は `CI=true` を既定で設定するため、lefthook の postinstall はフックを入れない（`rules/code/lint.md`）。
- マージ条件への組み込み: main の Ruleset `protect-main`（https://github.com/d-kanai/ai-only-template/rules/24101231 ）の `required_status_checks` に `ci` を入れている。
  - `strict_required_status_checks_policy` は `false`（PR ブランチが main の最新を取り込んでいなくてもマージできる）。理由: 有効にすると main が進むたびに取り込み直して CI を待つ必要があり、AI が並行して複数 PR を進める運用で待ち時間が増える。main との競合が無いことは別途マージ条件で確認する。
  - Ruleset の変更はユーザーが行う（UI: https://github.com/d-kanai/ai-only-template/rules/24101231 → Edit → 「Require status checks to pass」に `ci` を追加。または手元の `gh api -X PUT repos/d-kanai/ai-only-template/rulesets/24101231 --input <json>`。rules は PUT で丸ごと置き換わるので、先に GET で現在の rules を取り、追加した配列を送る）。クラウドセッションからは、セッションの `GH_TOKEN` を付けた `curl` で GET は 200 で読めるが、PUT はプロキシが 403「Write access to this GitHub API path is not permitted through this proxy」で拒否する（2026-09-28 実測。GitHub MCP ツールにも Ruleset の操作は無い）。
- CI が赤のときは、原因を PR のブランチで直して push する。テストの skip や無効化で緑にしない（`rules/code/lint.md` の `noSkippedTests`）。

## マージ後の後始末（オーケストレータが必ず行う）
マージしたら、ユーザーへ報告する前に次を実行し、ローカルにブランチを残さない。

```
git checkout main
git pull
git fetch --prune
git branch -d <ブランチ名>
```

- `git branch -d` が「not fully merged」で失敗したら、マージが完了していない可能性がある。`-D` で強制削除せず、PR の状態を確認する。
