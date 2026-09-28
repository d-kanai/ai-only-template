---
name: pr-flow
description: Issue からブランチ・PR・CI・マージ・後始末までの流れ。作業を始めるとき（Issue とブランチを作る）と、PR を作る・マージするときに使う。
disable-model-invocation: true
---

# pr-flow（Issue → ブランチ → PR → マージ → 後始末）

main は常にマージ可能に保つ。main への直接コミット・push はしない（GitHub の Ruleset `protect-main` でも禁止）。
コマンドは `gh` で書く。クラウドセッション（`gh` が無い）での読み替えは最後の節。GitHub 側の設定（Projects・Ruleset）の詳細は `${CLAUDE_SKILL_DIR}/github-settings.md`。

## 手順
1. **Issue**: 無ければ作る（目的・完了条件を書く）。type ラベルを 1 つ付ける: `gh issue create --label <type>`（`feat` / `fix` / `docs` / `chore` / `refactor`）。
   - 1 Issue = 1 PR。大きければ Issue を分ける。WHY: PR の差分とレビューを小さく保つ。
   - Projects への追加と Status の変更は GitHub 側のワークフローが行う。Projects の API は呼ばない（`github-settings.md`）。
2. **ブランチ**: main の最新から切る。`git checkout main && git pull && git checkout -b <type>/<Issue番号>-<内容>`（例: `feat/12-branch-rules`）。type は Issue のラベルと同じ。
3. **実装**: テストから書く（CLAUDE.md の Test Driven）。作業の分担は `.claude/agents/`（worker / researcher / reviewer）。
4. **作業ログ**: `logs/<YYYY-MM-DD>.md` に、このタスクでやったこと・根拠・判断を追記する。WHY: CI が PR の差分に `logs/*.md` の変更が無いと失敗する（文書だけの PR も例外なし）。
5. **コミット**: 1 行目にサマリ、本文に 🎯 WHY / 📝 WHAT / 🛠️ 実装経緯 / ✅ 検証内容、末尾に `Co-Authored-By: <モデル名>`（メールアドレスは付けない。詳細は CLAUDE.md から読み込むコミットのルール）。
6. **PR 作成**: `gh pr create --label <type>`。
   - タイトル: コミットメッセージの 1 行目と同じ書き方（何をしたか）。
   - 本文: `.github/PULL_REQUEST_TEMPLATE.md` の 🎯 WHY / 📝 WHAT / 🛠️ 実装経緯 / ✅ 検証内容を埋め、`Closes #<Issue番号>` を入れる。WHY: マージで Issue が自動クローズされ、Projects の Status も進む。
   - 「実装経緯」に、確認した背景（`git log -p`・関連 Issue / PR・logs）と判断を書き、手順 4 で追記した `logs/<日付>.md` の項目名（`## ...` の見出し）を列挙する。WHY: PR から作業ログへ辿れるようにする。
   - 「検証内容」に、実行したコマンドと結果、fault injection の内容、未確認のことを書く。
7. **レビュー**: reviewer サブエージェントに検証させる。使えないときはオーケストレータ自身がテスト実行・差分確認で確かめ、その旨を報告に書く。指摘は同じブランチで直して push する。
8. **CI を待つ**: push した HEAD の check run `ci` が `completed` / `success` になるまで待つ。
   ```sh
   sha=$(git rev-parse HEAD)
   curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/d-kanai/ai-only-template/commits/$sha/check-runs" \
     | python3 -c 'import sys,json; rs=[r for r in json.load(sys.stdin)["check_runs"] if r["name"]=="ci"]; print(rs[0]["status"], rs[0]["conclusion"]) if rs else print("no ci yet")'
   ```
   - `no ci yet` や `in_progress` の間は間隔をあけて繰り返す。
   - 赤なら原因をこのブランチで直して push する。テストの skip や無効化で緑にしない（Biome の `noSkippedTests` でも止まる）。
9. **マージ条件（すべて満たす）**: (1) reviewer の検証で問題なし、(2) CI の `ci` ジョブが緑（`protect-main` の required status check。赤ではマージできない）、(3) main との競合がない。
   - `ci` の中身: Postgres の起動と接続確認 → `pnpm db:migrate` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm test:e2e`（`.github/workflows/ci.yml`）。
   - main の最新を取り込んでいなくてもマージできる設定（strict は false）なので、競合が無いことは自分で確かめる。
10. **マージ**: merge commit で行う。squash / rebase は使わない。`gh pr merge <PR番号> --merge`。マージはオーケストレータが行う（人間の承認は不要）。サブエージェントは PR 作成・マージをしない。
11. **後始末**: ユーザーへ報告する前に実行し、ローカルにブランチを残さない。
    ```sh
    git checkout main && git pull && git fetch --prune && git branch -d <ブランチ名>
    ```
    - origin のブランチはマージ時に GitHub 側で自動削除される（`git fetch --prune` で追跡ブランチも消える）。
    - `git branch -d` が「not fully merged」で失敗したら `-D` で消さず、PR の状態（本当にマージされたか）を確かめる。
    - worktree を使っていたら、本体で `pnpm exec lefthook install` を実行し、`grep <worktree名> .git/hooks/pre-commit` が 0 件になることを確かめる（LEARNINGS.md）。
12. **報告**: マージしたことと PR の URL を、CLAUDE.md の応答フォーマット（結論 / ポイント / 次のアクション）で伝える。

## クラウドセッション（Claude Code on the web）での読み替え
- `gh` は無い。GitHub MCP ツールを使う: Issue の作成・ラベルは `mcp__github__issue_write`（PR のラベルも `issue_write` の update で付ける）、PR は `create_pull_request`、マージは `merge_pull_request`（`merge_method: "merge"`）。
- `merge_pull_request` の `expectedHeadSha` は `git rev-parse HEAD` の 40 桁を渡す。WHY: 短縮 SHA（7 桁）は「The sha parameter must be exactly 40 characters」で拒否された（2026-09-28 実測）。
- CI の確認は手順 8 の `curl`（セッションの `GH_TOKEN` で読める）。
- 前提: Claude GitHub App がリポジトリにインストール済み。未インストールだと Issue 作成が 403「Resource not accessible by integration」、`git push` が 403「Claude doesn't have GitHub access to ...」になる。403 はまずエラーメッセージを読む（LEARNINGS.md）。
- セッション開始時の `claude/<ランダム名>` ブランチは使わず、手順 2 のブランチで作業する（origin に残っていれば消す）。
- 環境の設定（setup script・許可ドメイン・GitHub App）と Ruleset の変更はセッションの中からできない。必要ならユーザーに依頼する（`github-settings.md`）。
