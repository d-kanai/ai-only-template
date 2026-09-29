# Todo の不変条件は、どの口を通ってもコンストラクタで常に全フィールドを検証する（restore は reconstruct に改名）

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #94 / PR #95 / `.claude/rules/backend.md` / スキル `db-migration` / `apps/backend/todo/domain/todo.ts`

## 背景
20260929-todo-restore-skips-validation.md で `restore` を検証しないとした連鎖で、`rename` はタイトルだけ、`changeCompletion` は検証なし、と口ごとに範囲が分かれ、規則を満たさない Todo が存在しうる状態だった。

## 決定
- `Todo` の private コンストラクタが毎回、全フィールドのスキーマ（`todoPropsSchema`）で検証する。`create` / `reconstruct` / `rename` / `changeCompletion` は値を渡すだけ。
- 規則を変えるときは、既存のデータを移行して追従する（スキル `db-migration`）。
- DB の行から Entity を再構成する口は `Todo.restore` から `Todo.reconstruct` に改名する。`InMemoryTodoRepository#restore(snapshot)`（トランザクションの rollback の代わり）は別の意味なので変えない。
- 不変条件を満たさない DB の行は、Repository が DomainError ではない `Error` にして投げ、API は 500 にする。

## 理由
- 「Todo 型の値 = 不変条件を満たす値」を常に成り立たせる方が単純（ユーザーの判断。2026-09-29 の work-logs「Issue #94: Todo の不変条件を常に全フィールドで検証し、restore を reconstruct に改名する」）。範囲を分けていた根拠は「restore は検証しない」の 1 点だけだった（2026-09-29 の work-logs「後始末（PR #93）と、Todo の検証を口ごとに分けている理由の質問」）。
- 保存済みのデータの不整合はクライアントには直せないので、400（入力の誤り）ではなく 500 にする。
- `restore` は意味が伝わりにくい（Issue #94）。

## 採用しなかった案
- 口ごとに検証の範囲を分ける（20260929-todo-restore-skips-validation.md）: 規則を満たさない Todo が存在しうる。
- 不正な行を DomainError（validation_error）のまま 400 にする: クライアントに直せない誤りを、入力の誤りと伝えてしまう。
- 不正な行を一覧から読み飛ばす: データが消えたように見え、不整合に気づけない。

## 影響
- 良い点: 分岐と口ごとの WHY が消え、Todo の値は常に不変条件を満たす。
- 悪い点: 不変条件を満たさない行が 1 件あると、一覧とその id への GET / PUT / DELETE がすべて 500 になり、画面からは直せない（reviewer が Postgres で確認。2026-09-29 の work-logs の Issue #94 の項目）。直すのは DB 側。規則を変えるたびにデータの移行が要る。一覧のたびに全行を parse するコストは未実測。
- 見直す条件: 記録に無い。
