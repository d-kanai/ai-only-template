# 1 ユースケース = 1 API = 1 command にし、複数の項目を任意で受けて command の中で分岐する部分更新 API は作らない

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #175 / `.claude/rules/backend.md` / `rule-tests/api-request.test.ts` / `apps/backend/features/todo/presentation/rename-todo.api.ts` / `apps/backend/features/todo/presentation/change-todo-completion.api.ts`

## 背景
Todo の更新は `PUT /api/todos/:id`（`UpdateTodoApi` / `UpdateTodoCommand`）の 1 つで、本文 `{ title?, completed? }` のどちらも任意にし、command の中で `if` で分岐して名前の変更と完了をまとめて扱っていた。
名前の変更と完了は業務プロセスが別で、例えば完了で通知を送るようになると、その処理をこの command の分岐に足すことになる。項目が増えるほど分岐と組み合わせのテストが増える。

## 決定
- 1 ユースケース = 1 API = 1 command にする。Todo の更新は `PUT /api/todos/:id/title`（`RenameTodoApi` / `RenameTodoCommand`。本文 `{ title }`）と `PUT /api/todos/:id/completion`（`ChangeTodoCompletionApi` / `ChangeTodoCompletionCommand`。本文 `{ completed }`）に分け、`PUT /api/todos/:id` は無くす。
- リクエストの項目は必須にする。任意（`.optional()`）の項目は `rule-tests/api-request.test.ts` が止め、同じユースケースの中で本当に任意の項目だけ、直前の行の `// WHY 任意: <理由>` で通す。

## 理由
- 業務プロセスごとに command が 1 つなら、片方だけに処理（通知など）が付いても他方の command とテストは変わらない。command の中に「どの項目が来たか」の分岐が無くなる。
- 項目が必須なら、「何も変えない」本文（`{}`）の扱いを決める必要が無く、欠落は 400 で知らせられる。
- 検査はリポジトリの規則として決定的に止める（CLAUDE.md の原則 7）。

## 採用しなかった案
- (a) 1 つの PUT で部分更新（今までの形）: 業務プロセスが増えるたびに command の分岐が増える。
- (b) PATCH（JSON Merge Patch。RFC 7396）: 1 つの API で任意の項目を受ける点は (a) と同じで、同じ問題が残る。
- (c) `POST /api/todos/:id/complete` と `POST /api/todos/:id/reopen` のようなアクション: completed の値を受ける 1 つの PUT の方が、同じ要求を何度送っても結果が同じ（冪等）で、画面のチェックボックスのトグルは次の値をそのまま送れる。

## 影響
- 良い点: ユースケースごとに api・command・テストが閉じ、処理を足すときに他のユースケースに触れない。
- 悪い点: 名前と完了を同時に変える要求は 2 回の API 呼び出しになる（1 つにまとめた原子性は無い）。項目ごとに api ファイルと Route Handler が増える。
- 見直す条件: 複数の項目を 1 つの業務プロセスとして同時に変える必要が出たとき（そのユースケースの API を新しく作る。任意の項目で分岐させない）。
