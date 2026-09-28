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
  2. テストが通っている（CI 導入後は CI 緑を必須にする）
  3. main との競合がない
- マージはオーケストレータ（メイン）が行う。人間の承認は不要。マージ後にユーザーへ報告する。
- サブエージェントは PR 作成・マージをしない。

## マージ後の後始末（オーケストレータが必ず行う）
マージしたら、ユーザーへ報告する前に次を実行し、ローカルにブランチを残さない。

```
git checkout main
git pull
git fetch --prune
git branch -d <ブランチ名>
```

- `git branch -d` が「not fully merged」で失敗したら、マージが完了していない可能性がある。`-D` で強制削除せず、PR の状態を確認する。
