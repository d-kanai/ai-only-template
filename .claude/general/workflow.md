# Issue → ブランチ → PR → マージ（常時）

main は常にマージ可能に保つ。main への直接 commit / push はしない（GitHub の Ruleset `protect-main` と、PreToolUse フック `scripts/hooks/guard-git.sh` で拒否）。
PR の作成・マージの前にスキル `pr-flow` を読む（手順: コマンド・CI の待ち方・クラウドでの読み替え・後始末）。GitHub 側の設定（Projects・Ruleset）は `.claude/skills/pr-flow/github-settings.md`。

- Issue: 作業は Issue から始める（無ければ目的・完了条件を書いて作る）。1 Issue = 1 PR。type ラベルを 1 つ（`feat` / `fix` / `docs` / `chore` / `refactor`）。Projects の Status は GitHub 側のワークフローが変える（API は呼ばない）。
- ブランチ: main から `<type>/<Issue番号>-<内容>`（例: `feat/12-branch-rules`）。type は Issue・PR のラベルと同じ。
- PR: 本文は `.github/PULL_REQUEST_TEMPLATE.md`（WHY / WHAT / 実装経緯 / 検証内容）を埋め、`Closes #<Issue番号>` を入れる。タイトルはコミットの 1 行目と同じ書き方。
- マージ条件（すべて）: reviewer の検証で問題なし（使えなければオーケストレータが確認し、その旨を報告に書く）/ CI の `ci` ジョブが緑（required status check）/ main との競合なし。
- マージ: オーケストレータが merge commit（`--merge`）で行う。squash / rebase は使わない。人間の承認は不要で、マージ後に報告する。
- マージ後: 報告の前に main に戻って pull・prune し、ローカルのブランチを `git branch -d` で消す（`-D` で強制しない）。
- CI が赤なら原因を PR のブランチで直す。テストの skip や無効化で緑にしない。
