# ルール検査テストは must pass と must reject の両方を持ち、fault injection で効くことを確かめる

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #49 / PR #54 / Issue #50 / PR #62 / `.claude/rules/testing.md` / スキル `rule-check-test`

## 背景
規則を守らせるテスト（依存の向き、lint、依存の版など）は、違反を見逃す（false negative）と存在する意味が無い。Issue #47 では、文書にある規則の一部がテストに無いことを reviewer の検証で見つけた。`package.test.ts` / `pnpm-workspace.test.ts` は今のファイルに違反が無いことしか見ておらず、判定が常に「違反なし」を返しても緑だった（Issue #50）。

## 決定
- ルール検査テストは、規則ごとに must pass（許可される例が通る）と must reject（違反が検出される）の両方を持つ。判定は関数に切り出し、架空の入力・一時ディレクトリの fixture・実ファイルに同じ関数を当てる。
- 書く・変えるたびに fault injection（違反を置く・判定を壊すとテストが落ちることを確かめ、戻す）を行い、結果を PR の「検証内容」に書く。reviewer も独立に行う。
- 規則の本文は `.claude/rules/testing.md`、手順はスキル `rule-check-test` に置く。

## 理由
- must reject だけでは「何でも違反にする」壊れ方を、must pass だけでは「何も違反にしない」（常に緑）壊れ方を検出できない（ユーザーの指示。Issue #49）。
- 実例: Issue #47（must reject の不足）、Issue #36 / PR #38（書き換えで検証が消えていた）、Issue #26 / #23 / #45（変異とゲートの実測で効くことを確かめた）。記録は 2026-09-28 の work-logs（「既存のルール検査テストに must reject と fault injection を揃えた（Issue #50）」など）と各 PR の「検証内容」。

## 採用しなかった案
- 検討した案は記録に無い。

## 影響
- 良い点: 検査が効いていない（常に緑の）状態に気づける。
- 悪い点: 変異を多く試すほど消費が増える。既定は最小セットにした（20260929-save-usage-limit.md）。
- 見直す条件: 記録に無い。
