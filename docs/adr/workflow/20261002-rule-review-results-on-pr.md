# rule-review は PR を作った後に回し、結果を PR のレビュー（行コメントとまとめ）に残してから直す

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #341 / `.claude/skills/pr-flow/SKILL.md` の手順 8 / `.claude/skills/rule-review/SKILL.md` / `docs/adr/quality/20261002-rule-review-from-rules-tables.md`

## 背景
Issue #330 で、差分を rules の表の `レビュー` の行でレビューするスキル `rule-review` を作った。結果はスキルの報告として返すだけで、どこにも残らなかった。daiki が「PR をつくったらローカルでスキルを回し、指摘を PR にコメントして修正する。レビュー結果が PR に残るために」と決めた（2026-10-02）。それまでの pr-flow は、PR を作ったらすぐ auto-merge を付けていた（Issue #82）。

## 決定
- PR を作ったら、auto-merge を付ける前に `rule-review` を回す。
- 結果は PR のレビュー 1 つにまとめる: 本文に報告（`## rule-review: 🔴 n / 🟡 n / 🟣 n`。指摘なし・観点なしも残す）、指摘ごとに `file:line` への行コメント（差分の外の 🟣 は本文だけ）。
- 🔴 は直し、🟡 は直すか理由を返信し、🟣 は返信だけ。直したら各スレッドに直したコミットを返信して resolve する。直した後の再レビューは 🔴 だけを同じ形で残す。
- 🔴 が 0 になってから auto-merge を付ける。マージ条件に「rule-review の結果が PR にあり 🔴 が残っていない」を足す。

## 理由
- PR に残せば、後から PR を開くだけで、何の観点で見て何を直したかが分かる（コミットと指摘のスレッドが対になる）。
- 行コメントにすると、指摘ごとに返信・resolve でき、直したかどうかが GitHub の画面で追える。
- auto-merge を先に付けると、CI が緑になった時点でレビューの前にマージされる。

## 採用しなかった案
- PR の前（ローカル）に回して結果を PR の本文に書く: 指摘と修正のやりとりがスレッドにならず、直したかを追えない。
- CI で Code Review（GitHub アプリ）を回す: 未導入。REVIEW.md は同じファイル名なので、入れたときに見直す。

## 影響
- 良い点: レビューの記録が PR に残る。
- 悪い点: PR ごとにレビューのエージェントを起動するので消費が増え、マージまでの時間が延びる。
- 機械化: 未対応。「🔴 のスレッドが resolve 済み」は Ruleset の「Require conversation resolution before merging」で止められる（Ruleset の変更はユーザーが行う）。「rule-review を回したか」は今は手順で守る。
- 見直す条件: Code Review（GitHub アプリ）を入れるとき、または消費が問題になったとき。
