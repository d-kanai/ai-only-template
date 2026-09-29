# docs/ の記録を廃止し、決定は ADR（docs/adr）、実測は work-logs、一次情報は規則の WHY に置く

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #96 / `docs/adr/README.md` / `rule-tests/instructions.test.ts`

## 背景
`docs/` の 14 本（20260928-records-in-docs.md）は「最新の設計判断の根拠を主題ごとに置く」意図だったが、Issue ごとの節が積み上がってログに寄り、最新の規則は `.claude/rules/` にあった（2026-09-29 の work-logs「質問: docs/（読み込まれない記録）は何のためにあるか。ログか、最新の設計か」「質問: 最新の規則は .claude/rules で、ADR を別に用意するなら docs/ は不要か」）。

## 決定
- `docs/` の 14 本と `docs/README.md` を廃止し、中身を振り分ける: 決定と採用しなかった案 → ADR（`docs/adr/yyyymmdd-<topic>.md`、1 決定 1 ファイル）、日付付きの実測 → `work-logs/`、一次情報の URL と要点 → `.claude/rules/*.md` の WHY。
- ADR は不変。決定が変わったら新しい ADR を書き、古い方の状態を「置き換え（→ 新しい ADR）」にする。
- ADR の形（命名・見出し・メタ・一覧）は `rule-tests/instructions.test.ts` の `adr-*` で検査する（orphan-docs を置き換える）。

## 理由
- ユーザーの判断（2026-09-29）: 最新の規則は `.claude/rules/` にある。経緯・調査が Issue / PR / commit / work-logs にあるなら重ねて持たない。ADR は別に用意する。形式はオーケストレータの提案をユーザーが承認した（2026-09-29 の work-logs「Issue #96: docs/ の経緯・調査の記録を削除する」）。
- 不変にすると、ある時点で何をなぜ決めたかが上書きで消えず、決定の変化は「置き換え」で辿れる。

## 採用しなかった案
- `docs/` を主題ごとに書き直し、上書きで最新に保つ（2026-09-29 の work-logs で挙げた整理の案）: 最新の規則は `.claude/rules/` にあり、二重になる。

## 影響
- 良い点: 最新の規則（`.claude/rules`）、決定の履歴（ADR）、日ごとの記録（work-logs）の役割が分かれる。
- 悪い点: 決定が変わるたびに ADR を足す手間がかかる。決定の一部だけが変わったときの書き方は形式に無い。
- 見直す条件: 記録に無い。
