# REVIEW.md

コード・設計ルールのレビューの基準。手順はスキル `rule-review`（`.claude/skills/rule-review/SKILL.md`）。
WHY このファイル名: Claude Code の Code Review（GitHub アプリ）がレビュー専用の指示として読むファイル名と同じにし、後で入れたときもそのまま使えるようにする（https://code.claude.com/docs/en/code-review 。決定は ADR `docs/adr/quality/20261002-rule-review-from-rules-tables.md`）。

## 観点
- 観点は `.claude/rules/code/*.md` の表で、強制の列が `レビュー` の行だけ。差分のファイルに一致する `paths` を持つ rules のファイルの行を使う。
- ここに観点を写さない。WHY: rules と二重管理になり、ずれる。行を足す・変えるときは rules の表を直す。

## 対象外（指摘しない）
- 強制の列が `レビュー` でない行（rule-tests・`pnpm lint`・`pnpm typecheck` などが CI で止める）と `説明` の行。
- rules の行に結び付かない一般的な品質・好みの指摘（バグ探しは別に `/code-review`）。
- 差分が触れていない既存のコード（気づいたら 🟣 として 1 行だけ書いてよい）。
- 生成物: `apps/backend/shared/drizzle/migrations/**`、`pnpm-lock.yaml`。

## 証拠の基準
- 指摘には、コードの `file:line` と、根拠の rules の行（`<rules のファイル>:<行>`）と、その行の WHAT の引用を必ず付ける。引用できない指摘は出さない。
- 挙動についての主張は、開いて読んだコードの `file:line` で示す。名前からの推測で書かない。

## 重大度
- 🔴 Important: rules の行の WHAT にはっきり反する。マージ前に直す。
- 🟡 Nit: 反している可能性が高いが、行の解釈やコードの意図の判断が要る。5 件まで（多ければ確信の高い順）。
- 🟣 Pre-existing: 差分が入れたものではない違反。

## 再レビュー
- 指摘を直した後の 2 回目以降のレビューは 🔴 だけを報告する（指摘の往復で収束させる）。
