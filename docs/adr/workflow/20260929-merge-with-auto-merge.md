# CI の完了をポーリングで待たず、PR に auto-merge（merge commit）を付けて終える

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #82 / PR #83 / スキル `pr-flow` / `.claude/general/workflow.md`

## 背景
マージ条件「CI の `ci` ジョブが緑」を確かめるため、オーケストレータが check-runs をポーリングしていた（workflow/20260929-save-usage-limit.md）。完了の通知で起きる wake は、全コンテキストのターンになる。

## 決定
- PR を作ったら auto-merge（merge commit）を付けて終える。CI が緑になった時点で GitHub がマージする。
- auto-merge を付けられない（リポジトリで無効、または付ける前に CI が終わっていた）ときは、次の人間のターンで CI を 1 回だけ確かめてマージする。

## 理由
- マージ条件は main の Ruleset の required status check（`ci`）が守るので、オーケストレータが待たなくても、赤ならマージされない（2026-09-29 の work-logs「CI（テストなど）が失敗するとマージはブロックされるか（ユーザーの質問）」）。
- ユーザーの判断（「なしでも良い」「CI fail で止まればそれで良い」）。ユーザーがリポジトリの auto-merge を ON にした（2026-09-29 の work-logs「CI のポーリングは要るか」「auto-merge を使う運用に切り替え（PR #83）…」）。

## 採用しなかった案
- CI をポーリング 1 本で待つ（Issue #78 の形）: 完了の通知で wake が増える。

## 影響
- 良い点: CI の待ちで wake が増えない。
- 悪い点: マージが後から起きるので、後始末（main の pull・ブランチの削除）は次の作業の最初に行う。auto-merge は CI が pending のときだけ付けられる（2026-09-29 の work-logs「PR #92（Issue #90）をマージした」）。
- 見直す条件: 記録に無い。
