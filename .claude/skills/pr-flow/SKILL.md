---
name: pr-flow
description: Issue からブランチ・PR・CI・マージ・後始末までの手順。作業を始める（Issue とブランチを作る）、PR を作る、CI を待つ、マージする、マージ後に後始末するときに使う。
---

# pr-flow（Issue → ブランチ → PR → マージ → 後始末）

WHY 自動起動にしている（`disable-model-invocation` を付けない）: マージはオーケストレータ（モデル）が人間の承認なしに行うので、モデル自身がこの手順を呼べる必要がある。危険な操作（main への push、squash、force push）はスキルを隠すのではなく、PreToolUse フック `scripts/hooks/guard-git.sh` と `permissions.deny`（`.claude/settings.json`）が止める（`.claude/rules/tooling/git-guard.md`）。

main は常にマージ可能に保つ。main への直接コミット・push はしない（GitHub の Ruleset `protect-main` でも禁止）。
コマンドは `gh` で書く。クラウドセッション（`gh` が無い）での読み替えは最後の節。GitHub 側の設定（Projects・Ruleset）の詳細は `${CLAUDE_SKILL_DIR}/github-settings.md`。

## 手順
1. **Issue**: 無ければ作る。type ラベルを 1 つ付ける: `gh issue create --label <type>`（`feat` / `fix` / `docs` / `chore` / `refactor`）。
   - 本文は Issue テンプレート `.github/ISSUE_TEMPLATE/<type>.yml`（Issue forms）と同じ見出しで書く: `### 目的`（WHY）/ `### 内容`（WHAT）/ `### 完了条件`（通るべきテスト・確かめ方）/ `### 前提`（依存する Issue。無ければ「なし」）。WHY: GitHub の画面からテンプレートで作った Issue と、API（`gh issue create`・`issue_write`）で作った Issue の形をそろえる（API はテンプレートを通らない）。テンプレートの形は `rule-tests/issue-template.test.ts` が検査する（Issue #113）。
   - 1 Issue = 1 PR。大きければ Issue を分ける。WHY: PR の差分とレビューを小さく保つ。スレッド（セッション）の分け方は `.claude/rules/workflow/orchestration.md`（ADR `docs/adr/workflow/20261001-project-threads-per-task.md`）。
   - Projects への追加と Status の変更は GitHub 側のワークフローが行う。Projects の API は呼ばない（`github-settings.md`）。
2. **ブランチ**: main の最新から切る。`git checkout main && git pull && git checkout -b <type>/<Issue番号>-<内容>`（例: `feat/12-branch-rules`）。type は Issue のラベルと同じ。
3. **実装**: テストから書く（CLAUDE.md の Test Driven）。作業の分担は `.claude/agents/`（worker / worker-light / researcher / reviewer。使い分けは `.claude/rules/workflow/orchestration.md`）。worker が完了するごとにコミットし、未コミットを長く残さない。
4. **作業ログ**: `docs/work-logs/<YYYY-MM-DD>.md` に、このタスクでやったこと・根拠・判断を追記する。WHY: CI が PR の差分に `docs/work-logs/*.md` の変更が無いと失敗する（文書だけの PR も例外なし）。
5. **コミット**: 1 行目にサマリ、本文に 🎯 WHY / 📝 WHAT / 🛠️ 実装経緯 / ✅ 検証内容、末尾に `Co-Authored-By: <モデル名>`（メールアドレスは任意。詳細は CLAUDE.md から読み込むコミットのルール）。
6. **PR 作成**: `gh pr create --label <type>`。
   - タイトル: コミットメッセージの 1 行目と同じ書き方（何をしたか）。
   - 本文: `.github/PULL_REQUEST_TEMPLATE.md` の 🎯 WHY / 📝 WHAT / 🛠️ 実装経緯 / ✅ 検証内容を埋め、`Closes #<Issue番号>` を入れる。WHY: マージで Issue が自動クローズされ、Projects の Status も進む。
   - 「実装経緯」に、確認した背景（`git log -p`・関連 Issue / PR・`docs/work-logs/`）と判断を書き、手順 4 で追記した `docs/work-logs/<日付>.md` の項目名（`## ...` の見出し）を列挙する。WHY: PR から作業ログへ辿れるようにする。
   - 「検証内容」に、実行したコマンドと結果、fault injection の内容、未確認のことを書く。
7. **レビュー**: ロジックのある変更は reviewer サブエージェントに差分と観点を絞って検証させる。機械的な変更（改名・文書・参照の更新だけ）と、reviewer が使えないときは、オーケストレータ自身がテスト実行・差分確認で確かめ、その旨を PR の「検証内容」に書く。指摘は同じブランチで直し、1 ラウンド（実装 → 検証 → 指摘の反映）につき push は 1 回にまとめる（push ごとに CI が再実行され、完了の通知で wake が増える）。
8. **rule-review を PR に残す**（ユーザー判断 2026-10-02、Issue #341）: PR を作ったら、auto-merge を付ける前にスキル `rule-review` を引数なしで回し、結果を PR のレビュー 1 つにまとめて残す。WHY: レビューの結果と直した経過が PR に残り、後から PR を開けば何を見て何を直したかが分かる。auto-merge を先に付けると、CI が緑になった時点でレビューの前にマージされる。
   - 残し方: 指摘ごとに、その `file:line` への行コメント（重大度・何が反しているか・観点 `<rules file>:<行>` と WHAT の引用）。本文に rule-review の報告（`## rule-review: 🔴 n / 🟡 n / 🟣 n`。指摘なし・観点なしもそのまま）。クラウドでは `pull_request_review_write`（`method: create`、event なし）→ `add_comment_to_pending_review`（`subjectType: LINE`、`side: RIGHT`）→ `pull_request_review_write`（`method: submit_pending`、`event: COMMENT`）。指摘なしのときは `pull_request_review_write`（`method: create`、`event: COMMENT`）で本文だけを出す。`commitID` は `git rev-parse HEAD` の 40 桁（短縮 SHA は「Could not coerce value ... to GitObjectID」で拒否された。2026-10-02 実測）。差分の外の 🟣 は行コメントにせず本文にだけ書く（GitHub は差分の外の行にコメントできない）。
   - ローカル（`gh`）では、レビューは 1 回の REST 呼び出しで行コメントごと出す（`gh pr review` は行コメントを付けられない）:
     ```sh
     gh api repos/d-kanai/ai-only-template/pulls/<PR番号>/reviews \
       -f commit_id="$(git rev-parse HEAD)" -f event=COMMENT -f body="$(cat <報告のファイル>)" \
       -f 'comments[][path]=<file>' -F 'comments[][line]=<line>' -f 'comments[][side]=RIGHT' -f 'comments[][body]=<指摘>'
     # 返信: gh api repos/d-kanai/ai-only-template/pulls/<PR番号>/comments/<comment_id>/replies -f body='<返信>'
     # resolve（GraphQL）: スレッドの id を
     #   gh api graphql -f query='query{repository(owner:"d-kanai",name:"ai-only-template"){pullRequest(number:<PR番号>){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}'
     # で取り、gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<PRRT_...>
     ```
     クラウドでは GraphQL が使えない（「GitHub GraphQL is not available from Claude Code sessions」。2026-10-02 実測）ので、返信は `add_reply_to_pull_request_comment`、resolve は `resolve_review_thread`（スレッドの id は `pull_request_read` の `get_review_comments`）を使う。
   - 直す: 🔴 は直す。🟡 は直すか、直さない理由を返信する。🟣 は返信だけ（直すなら別の Issue）。どのスレッドも、返信したら resolve する（直したものは直したコミットを返信する）。WHY: 直さないと決めたスレッドも resolve しないと、Ruleset の「Require conversation resolution before merging」を ON にしたときにマージが止まる（PR #342 の Codex の指摘）。push は手順 7 と同じく 1 ラウンドに 1 回。
   - 再レビュー: 直した後にもう一度 rule-review を回し、🔴 だけを同じ形で残す（REVIEW.md の再レビュー）。🔴 が 0 になったら手順 9 に進む。
9. **CI は待たない**（ユーザー判断 2026-09-29、Issue #82）: マージ条件の「`ci` が緑」は Ruleset `protect-main` の required status check が守るので、オーケストレータがポーリングで待つ必要はない（ポーリングの完了通知は wake になり消費が増える。ADR `docs/adr/workflow/20260929-save-usage-limit.md`）。
   - 手順 8 で 🔴 が 0 になったら auto-merge（merge commit）を付けて、そのターンを終える: `gh pr merge <PR番号> --merge --auto`（クラウドでは GitHub MCP の `enable_pr_auto_merge`、`mergeMethod: MERGE`）。緑になった時点で GitHub 側がマージし、赤なら止まったままになる。
   - リポジトリの auto-merge は有効（2026-09-29 にユーザーが Settings → General → Pull Requests → Allow auto-merge を ON）。付けられなかったとき（無効に戻っている・API のエラー）だけ、ポーリングせず次の人間のターンで下の curl を 1 回だけ実行し、緑ならマージする（手順 11）。
   ```sh
   sha=$(git rev-parse HEAD)
   curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/d-kanai/ai-only-template/commits/$sha/check-runs" \
     | python3 -c 'import sys,json; rs=[r for r in json.load(sys.stdin)["check_runs"] if r["name"]=="ci"]; print(rs[0]["status"], rs[0]["conclusion"]) if rs else print("no ci yet")'
   ```
   - 赤なら原因をこのブランチで直して push する。テストの skip や無効化で緑にしない（Biome の `noSkippedTests` でも止まる）。
10. **マージ条件（すべて満たす）**: (1) reviewer の検証で問題なし、(2) rule-review の結果が PR にあり、🔴 のスレッドがすべて resolve 済み（手順 8）、(3) CI の `ci` ジョブが緑（`protect-main` の required status check。赤ではマージできない）、(4) main との競合がない。
   - `ci` の中身: Postgres の起動と接続確認 → `pnpm db:migrate` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm test:e2e`（`.github/workflows/ci.yml`）。
   - main の最新を取り込んでいなくてもマージできる設定（strict は false）なので、競合が無いことは自分で確かめる。
11. **マージ**: merge commit で行う。squash / rebase は使わない。`gh pr merge <PR番号> --merge`。マージはオーケストレータが行う（人間の承認は不要）。サブエージェントは PR 作成・マージをしない。
12. **後始末**: ローカルにブランチを残さない。auto-merge に任せたときは、次の作業の最初（main から新しいブランチを切る前）にまとめて行う。
    ```sh
    git checkout main && git pull && git fetch --prune && git branch -d <ブランチ名>
    ```
    - origin のブランチはマージ時に GitHub 側で自動削除される（`git fetch --prune` で追跡ブランチも消える）。
    - `git branch -d` が「not fully merged」で失敗したら `-D` で消さず、PR の状態（本当にマージされたか）を確かめる。
    - worktree を使っていたら、本体で `pnpm exec lefthook install` を実行し、`grep <worktree名> .git/hooks/pre-commit` が 0 件になることを確かめる（LEARNINGS.md）。
13. **報告**: マージしたことと PR の URL を、CLAUDE.md の応答フォーマット（結論 / ポイント / 次のアクション）で伝える。

## クラウドセッション（Claude Code on the web）での読み替え
- `gh` は無い。GitHub MCP ツールを使う: Issue の作成・ラベルは `mcp__github__issue_write`（PR のラベルも `issue_write` の update で付ける）、PR は `create_pull_request`、マージは `merge_pull_request`（`merge_method: "merge"`）。
- `merge_pull_request` の `expectedHeadSha` は `git rev-parse HEAD` の 40 桁を渡す。WHY: 短縮 SHA（7 桁）は「The sha parameter must be exactly 40 characters」で拒否された（2026-09-28 実測）。
- CI の確認は手順 9 の `curl`（セッションの `GH_TOKEN` で読める）。
- 前提: Claude GitHub App がリポジトリにインストール済み。未インストールだと Issue 作成が 403「Resource not accessible by integration」、`git push` が 403「Claude doesn't have GitHub access to ...」になる。403 はまずエラーメッセージを読む（LEARNINGS.md）。
- セッション開始時の `claude/<ランダム名>` ブランチは使わず、手順 2 のブランチで作業する（origin に残っていれば消す）。
- 環境の設定（setup script・許可ドメイン・GitHub App）と Ruleset の変更はセッションの中からできない。必要ならユーザーに依頼する（`github-settings.md`）。
