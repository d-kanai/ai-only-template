# Repository の書き込みは唯一の入口 writeInTransaction を通し、その前後に 1 行ずつログを自動で出す

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #205 / `.claude/rules/backend.md` / `rule-tests/persistence.test.ts` / `apps/backend/shared/infra/write.ts` / `apps/backend/features/todo/infra/todo-repository.postgres.ts` / ADR `architecture/20260930-change-logs-written-by-repository.md` / ADR `architecture/20260929-logger-single-exit.md`

## 背景
すべての Repository の insert / update / delete の前後に、Repository が個別に書かなくてもログが出るようにしたい（ユーザーの依頼）。
それまで各 `*.postgres.ts` は `db.transaction` を自分で張り、その中で `recordChange` を呼んでいた（Issue #189）。ログを Repository ごとに書くと、書き込みを足すたびに書き忘れうる。

## 決定
- 書き込みの唯一の入口 `writeInTransaction(db, { table, rowId, operation }, async (tx) => entries)` を `apps/backend/shared/infra/write.ts` に置く。トランザクションを張り、コールバック（本体の書き込み）が返した記録を同じトランザクションの最後に `recordChange` で `change_logs` に書き、前に info `repository write start`、後に info `repository write done`（`durationMs` と `changes` の `tableName`・`rowId`・`operation`）、失敗なら warn `repository write failed`（`durationMs` と `error`。DB のエラーは pg のエラーと `sqlState`）を出して同じ例外を投げ直す。
- ログに値（`changes` の before / after）は出さない。`table` は Drizzle の表から `getTableName` で取る。
- `*.postgres.ts` が `transaction` / `recordChange` を直接使うことと、書き込みがあるのに `write` を値で import しないことを `rule-tests/persistence.test.ts` が止める（`no-direct-transaction` / `no-direct-record-change` / `writes-through-write-in-transaction`）。ADR `architecture/20260930-change-logs-written-by-repository.md` の検査（`change-log` の import と、`recordChange(` を `transaction(` の中に書くこと）は、これに置き換えた。変更履歴の決定そのもの（何を・どの表に・同じトランザクションで）は変えない。

## 理由
- 入口を 1 つにすれば、Repository は本体の書き込みと記録を返すだけで、ログと変更履歴が必ず付く。入口以外の書き方は検査で止まる（原則 7。文章の規則より機械の検査）。
- トランザクション・記録・ログを 1 つの関数にまとめると、Issue #189 の「記録はトランザクションの中で書く」を字句の範囲で推定する検査（括弧を数える）が要らなくなり、同じトランザクションであることは関数のテスト（一時的な CHECK 制約）で実行して固定できる。
- 値を出さないのは、個人情報を含みうるため（リクエストログがクエリの値を出さないのと同じ。ADR `architecture/20260929-request-log-in-proxy.md`）。値は `change_logs` に残る。
- 失敗を warn にするのは、`not_found` などの DomainError が 404 の正常な結果だから。500 になる例外は `toProblemResponse` が `logger.error` で別に残す。

## 採用しなかった案
- Drizzle の `logger` オプション: 実行前の SQL だけを受け取り「後」（成否・所要時間）が無い。SELECT も出て、パラメータの値も出る。
- `pg.Pool` の `connect` / `query` のラップ: トランザクションは `pool.connect()` で借りた client の上で流れ、ドライバの内部（drizzle-orm の node-postgres の session）の呼び方に依存する。表・行の id・操作の単位も分からない。
- Repository ごとに logger を呼ぶ: 書き込みを足すたびに書く必要があり、書き忘れを検査しにくい（「自動で出る」にならない）。

## 影響
- 良い点: Postgres の Repository の書き込みは、どれも前後のログ・所要時間・書いた行の一覧と変更履歴を同じ形で残す。新しい Repository も入口を通すだけで付く。
- 悪い点: DB のエラー（drizzle-orm 0.45.3 の DrizzleQueryError）の message は SQL とパラメータの値を含む（`drizzle-orm/errors.js` のコンストラクタが `Failed query: <SQL>\nparams: <値>` を message にする）。書き込みのログでは、`error` を元の pg のエラー（cause。message は値を含まない）にし、SQLSTATE を `sqlState` に出すことで値を出さないようにした。500 のときの `toProblemResponse` の `logger.error` には残る（別 Issue）。InMemory（テスト用）はログを出さない。検査は import と名前の字句で見るので、import したうえでコールバックの外で `this.db.insert(` を書くと見逃す（Repository のテストがログと記録を固定する）。
- 見直す条件: 例外のログから値を除く必要が出たとき、複数の書き込みをまたぐトランザクション（command 単位）が要るようになったとき（入口の形を command 側に広げる）、ログの量が問題になったとき。
