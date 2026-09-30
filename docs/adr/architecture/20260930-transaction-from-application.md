# command がトランザクションを張って Repository に渡し、Repository は insert / update に分け、変更履歴とログは書き込みの口 Writer が文ごとに記録する

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #215 / `.claude/rules/backend.md` / `rule-tests/persistence.test.ts` / `rule-tests/use-case.test.ts` / `rule-tests/architecture.test.ts` / `apps/backend/shared/domain/transaction.ts` / `apps/backend/shared/infra/transaction.postgres.ts` / `apps/backend/shared/infra/writer.ts` / ADR `architecture/20260929-constructor-injection-without-container.md` / ADR `architecture/20260930-repository-write-log.md` / ADR `architecture/20260930-change-logs-written-by-repository.md`

## 背景
Issue #123（ADR `architecture/20260929-constructor-injection-without-container.md`）で、command を一律に包むトランザクションの runner を廃止し、トランザクションは Repository の `save` / `delete` が張る形にした。その後、集約の子表（Issue #188）・変更履歴（Issue #189）・書き込みのログ（Issue #205）が加わり、`save` は `origin` の有無で新規と更新を分け、読み込んだ後に消された場合を確かめる `updateOrLock`（差分が無いときの `for key share`）と、記録を組み立てて返すコールバック（`writeInTransaction`）を組み合わせる複雑な形になった。ユーザーの依頼（2026-09-30 の work-logs）は「集約の Repository が複雑。トランザクションは application から渡し、insert = 根 + 子、update = 根の差分だけに」と「変更履歴を Repository に書かせず、AOP のように共通で記録したい」。

## 決定
- トランザクションの口を domain（`apps/backend/shared/domain/transaction.ts`）に置く: 中身を見せない `Transaction`（`unique symbol` のキーの brand）と `TransactionRunner { run(work) }`。実体は infra の `PostgresTransactionRunner(db, actorId = null)`（`db.transaction` の tx を包んだ Writer を `Transaction` として work に渡す）。テストは `InMemoryTransactionRunner`（work を呼ぶだけ）。
- 書き込みの command（create / rename / change-todo-completion / delete）はコンストラクタで `TransactionRunner` を受け取り、`execute` の本体を `this.transactions.run(async (tx) => …)` で包む。query（list / get）はトランザクションを張らない。完了の通知はトランザクションの外（`run` が resolve した後）で呼ぶ。
- `TodoRepository` は `findAll()` / `findById(id)`（query 用。tx 無し）、`findByIdOrThrow(id, tx)`（command 用。根の行を `FOR UPDATE` でロックしてから集約を読む）、`insert(todo, tx)`（根と子の全件。`origin` があれば Error）、`update(todo, tx)`（`changedProps` の差分の列と、子の増分だけ。`origin` が無ければ Error）、`delete(id, tx)`。`save` と `updateOrLock` は廃止する。
- 変更履歴（`change_logs`）と書き込みのログ（`db_write`）は、Repository ではなく書き込みの口 Writer（`apps/backend/shared/infra/writer.ts`）が文ごとに横断的に記録する。Repository は `writerOf(tx)` で Writer を取り出し、表と行（と id）を渡すだけにする（`change-log` を import しない）。Writer は insert / update / delete を `returning()` で実行し、insert は全列の after、update は同じトランザクションで `FOR UPDATE` で読んだ行を before、delete は消した行を before にした記録を同じトランザクションの `change_logs` に書き、前後のログを出す。`writeInTransaction`（`write.ts`）は廃止する。ADR `architecture/20260930-repository-write-log.md` の「書き込みの唯一の入口 writeInTransaction」と、ADR `architecture/20260930-change-logs-written-by-repository.md` の「Repository が記録を組み立てて書く」は、これに置き換える（`change_logs` の表の形・何を記録するかは変えない）。
- 検査: `rule-tests/persistence.test.ts` の `writes-through-writer`（書き込みの受け手は `writerOf(` で得た Writer）・`no-change-log-in-repository`・`update-uses-changed-props`（`save-uses-changed-props` を改名）・`no-direct-transaction`（runner のファイルは対象外）、`rule-tests/use-case.test.ts` の `command-runs-in-transaction`（DB に触らない command は `// WHY トランザクション無し:` で通す）、`rule-tests/architecture.test.ts` の規則 `presentation` に `shared/infra/transaction.postgres` を足す。

## 理由
- Repository が `origin` で新規と更新を分けなくてよくなる（呼び出し側の command は、新規か読み込み済みかを知っている）。取り違えは `origin` で Error にする。
- 読み込み（行ロック）と書き込みが同じトランザクションになり、読んだ後に消される・変えられる競合を考えずに済む。`updateOrLock` が消え、`update` は「行が無い」を呼び出し側の誤りとして Error にするだけになる。
- 変更履歴とログを Writer が文ごとに付けるので、Repository を足しても記録の組み立てを書く必要が無く、書き忘れた書き込みも記録される（検査が Writer を通ることを止める）。
- 行ロックと集約の読み込みを 1 文の `SELECT … LEFT JOIN … FOR UPDATE` にしない: READ COMMITTED でロックを待つと、ロックした行（todos）だけを最新の版で読み直し、JOIN した履歴は文の始めのスナップショットのままになり（https://www.postgresql.org/docs/current/transaction-iso.html の Read Committed の節）、同時に完了にした Todo を不変条件の違反として読んだ（2026-09-30 の work-logs。Issue #215 の実測）。ロックの文と読み込みの文を分ければ、ロックを取った後の新しいスナップショットでそろって読める。

## 採用しなかった案
- Repository がトランザクションを張る（Issue #123〜#205 の形）: `origin` による分岐と `updateOrLock` が残り、読み込みと書き込みが別のトランザクションになる。
- DI コンテナで command を一律に包む（Issue #123 より前。ADR `architecture/20260928-commands-always-in-transaction.md`）: コンテナは分かりにくい（Issue #123 のユーザー判断）。包む場所は command の中に明示し、組み立ては api ファイルのまま。
- query もトランザクションで包む: 1 文の読み取りで要らず、行ロックを取ると command の間は一覧・詳細が待たされる。
- 変更履歴を TypeScript のデコレータで記録する: メソッドの引数と戻り値から書いた行の値が取れず、結局 Repository が行を返す約束が要る。
- 変更履歴を DB のトリガーで書く: 組み立てが TypeScript に無く、テストで確かめにくい（ADR `architecture/20260930-change-logs-written-by-repository.md` の理由と同じ）。
- drizzle のビルダーを Proxy で包んで記録する: chain の型と `then` の横取りが壊れやすい。

## 影響
- 良い点: Repository は行と Entity の変換だけになり、書き込みはすべて Writer を通って記録とログが付く。同じ Todo を変える command は根の行のロックで直列化され、後の command は先の COMMIT の後の値を読む（別の列の変更は両方残り、同じ列は後勝ち。この性質は変わらない）。
- 悪い点: 更新の command は根の行を `FOR UPDATE` でロックし、同じ Todo の同時更新は待つ（別の Todo は待たない）。update の変更履歴の before は、DB が UPDATE の直前に持っていた値になる（以前は読み込んだときの値）。Writer は update のたびに行を 1 回読む（SELECT が 1 文増える）。書き込みのログは文ごとになり、1 回の command で複数の行が出る（完了の履歴の INSERT は複数行なら `row_ids`）。書き込みの後のログは COMMIT の前に出るので、COMMIT が失敗したとき（遅延制約など）も done のまま残る（失敗は 500 のログで分かる）。InMemory の runner は rollback を再現しない（今の command は書き込みが最後の 1 回だけなので結果は変わらない。原子性は Postgres のテストが固定する）。完了の履歴の行の id は、前のログと記録のために Writer が `randomUUID` で作る（DB の既定値は手で足す行のために残す）。
- 見直す条件: 複数の書き込みを持つ command を InMemory で確かめたくなったとき（InMemory の runner で rollback を再現する）、ロックの待ちが問題になったとき（`FOR UPDATE` を `NOWAIT` や楽観ロックにする）、ログの量が問題になったとき。
