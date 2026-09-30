# 集約の読み出しは、insert のみの子表を必ず全件 JOIN で読む（最新だけ・一部だけを読まない）

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #188 / Issue #189 / `.claude/rules/backend.md` / `rule-tests/persistence.test.ts` / `apps/backend/features/todo/infra/todo-repository.postgres.ts` / ADR `architecture/20260930-status-transitions-as-append-only-child-table.md`

## 背景
状態の遷移を insert のみの子表（`todo_status_changes`）に積み、`todos.completed` は現在値として残した。domain の `Todo` は履歴の全体を持ち、不変条件（1 件以上・昇順・最後の `completed` = `completed`）を `reconstruct` で検証する。
Repository が子表の最新の 1 行だけ・一部だけを読んで集約を組み立てると、不変条件を検証できず、部分的な集約が domain に入る。親と子を別の文で読むと、READ COMMITTED では 2 文の間に別の要求の変更が片方だけに見える（read skew）。

## 決定
- 集約の読み出し（`findAll` / `findById`）は、親の表 LEFT JOIN 子表の 1 文で、子表の全件を読んで組み立てる（ユーザー判断 2026-09-30「必ずステータステーブルを all find する」）。
- 子表だけを読まない。`limit` / `offset` / `selectDistinctOn` で件数を絞らない。`where` で子表の列を絞らない（LEFT JOIN の WHERE で子表を絞ると履歴の無い親も外れる）。`orderBy` で子表の並び（`position`）を指定するのは可。
- 検査は `rule-tests/persistence.test.ts` の `aggregate-loads-all-children`（子表を import した `*.postgres.ts` が対象。行ロック付き（`.for(`）の読み取りは save の存在確認なので対象外）。

## 理由
- 不変条件は履歴の全体で決まる（最後の要素と現在値の一致・昇順）。全件を読めば「読めた Todo = 不変条件を満たす Todo」が常に成り立つ。
- 1 文で読めば 1 スナップショットになり、分離レベルに依存せず read skew が起きない。
- 履歴は 1 つの Todo の遷移の回数分で、全件を読むコストは小さい。一覧で件数が問題になったら、集約の読み出しではなく読み取り専用のクエリ（一覧用の投影）を別に作る。

## 採用しなかった案
- 最新の 1 行だけを読む（`selectDistinctOn` / `limit 1`）: 現在値は `todos` の列にあるので読む理由が無く、不変条件を検証できない。
- 子表を別の文で読む（`where todo_id in (...)`）: read skew で一時的に不変条件違反の Error（500）になる（Issue #188 の reviewer が再現）。
- 読み出しをトランザクション（REPEATABLE READ）で包む: 1 文なら要らない。

## 影響
- 良い点: 集約が常に完全で、domain の不変条件がそのまま守られる。同時実行で壊れた集約を読まない。
- 悪い点: 履歴が長い Todo ほど一覧の行が増える（親 1 件につき履歴の件数）。一覧用の投影を分けるまでは、履歴の件数が読み出しの量になる。
- 見直す条件: 履歴の件数が一覧の性能に影響したとき（一覧用の投影を分ける）。集約の子表が増えて JOIN が重なったとき。
