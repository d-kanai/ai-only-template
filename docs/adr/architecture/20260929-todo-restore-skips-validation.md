# DB の行から Todo を組み立てる restore は検証せず、口ごとに検証の範囲を分ける

- 日付: 2026-09-29
- 状態: 置き換え（→ architecture/20260929-todo-invariants-always-validated.md）
- 関連: Issue #88 / PR #93 / `apps/backend/todo/domain/todo.ts`

## 背景
zod で不変条件を書く（architecture/20260929-zod-for-backend-validation.md）にあたり、DB の行から Entity を組み立てる口（`Todo.restore`）でも検証するか、DB の行が不正だったときにどう扱うかを決める必要があった（Issue #88）。

## 決定
- `restore` は検証しない（型は Drizzle のスキーマが保証する）。
- `create` は全体を、`rename` はタイトルだけを検証し、`changeCompletion` は検証しない。

## 理由
- 規則を厳しくしたときに、既存のデータの読み込みで 500 にしない（Issue #55 以前からの方針。2026-09-29 の work-logs「Issue #88: zod で…を統一した」「後始末（PR #93）と、Todo の検証を口ごとに分けている理由の質問」）。
- `restore` が検証しないので、`rename` / `changeCompletion` で全体を検証し直すと既存のデータに今の規則を当てることになる。そこから範囲を狭めた。

## 採用しなかった案
- `restore` でも parse する: 規則を厳しくしたときに、既存のデータで 500 になる。

## 影響
- 良い点: 規則を厳しくしても、既存のデータを読める。
- 悪い点: 口ごとに検証の範囲が分かれ、規則を満たさない Todo が存在しうる。分岐ごとに WHY が要った。
- 見直す条件: ユーザーの質問「常に全部の不変条件チェックで良くない？」で見直し、architecture/20260929-todo-invariants-always-validated.md に置き換えた。
