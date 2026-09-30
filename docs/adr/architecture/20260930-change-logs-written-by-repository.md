# 全モデルの変更履歴（監査）は汎用の change_logs 表に、Repository が本体と同じトランザクションで書く

- 日付: 2026-09-30
- 状態: 置き換え（→ architecture/20260930-transaction-from-application.md）
- 関連: Issue #189 / `.claude/rules/backend.md` / `rule-tests/persistence.test.ts` / `apps/backend/shared/infra/schema.ts` / `apps/backend/shared/infra/change-log.ts` / `apps/backend/features/todo/infra/todo-repository.postgres.ts`

## 背景
行を変えた・消したときに、前の値が残らない。誰が・いつ・何を変えたかを後から調べる手段（監査）が無い。
完了の遷移は業務の事実として子表（`todo_status_changes`。ADR `architecture/20260930-status-transitions-as-append-only-child-table.md`）に積んだが、名前の変更や削除、今後足す表の変更は残らない。
表ごとに履歴の仕組みを作ると、表を足すたびに同じ作業が要り、漏れる。

## 決定
- すべての表の行の変更を、横断の表 `change_logs`（`table_name`・`row_id`・`operation`（`insert` / `update` / `delete`）・`changes`（jsonb。DB の列名 → `{ before, after }`）・`actor_id`・`occurred_at`）に 1 行ずつ積む。insert のみ。外部キーは張らない（消した行も指す）。index は `(table_name, row_id)`。
- 書くのは Repository。本体の書き込みと同じトランザクションの最後に `recordChange(tx, entries)` の 1 文で書く。insert は全列の `after`、update は変わった列（`changedProps` の差分）だけの `before` / `after`、delete は消す前の全列の `before`（`returning` で受け取る）。差分の無い save・無い id の delete は記録しない。cascade で消える子の行は記録しない（親の delete の 1 件で分かる）。
- 記録の組み立て（`insertEntry` / `updateEntries` / `deleteEntry`）は `shared/infra/change-log.ts` に置き、InMemory の Repository（テスト用）も同じ関数で作って `changeLogs` に積む。
- `actor_id` は Repository のコンストラクタの `actorId`（既定は `null`）。ログインが無い今は本番の組み立て（`new PostgresTodoRepository(getDatabase().db)`）を変えず、常に `null`。ログインが入ったら、要求ごとに利用者の id を渡して組み立てる。
- 書き込みのある `*.postgres.ts` が `change-log` を import すること、`recordChange(` を `transaction(` のコールバックの中に書くこと、`change_logs` を update / delete しないことを `rule-tests/persistence.test.ts` が検査する。

## 理由
- Repository が書けば、記録の組み立てが TypeScript にあり、InMemory でも同じ記録をテストで確かめられる（application のテストが DB 無しで記録を見られる）。
- 同じトランザクションで書けば、本体だけ・記録だけが残らない（記録の INSERT が失敗すると本体も戻ることを、一時的な CHECK 制約で固定した）。
- 1 つの汎用の表なら、表を足しても履歴の表や仕組みを足さずに済む。列の違いは jsonb の `changes` が吸収する。キーを DB の列名にするのは、SQL・BI で元の表とそのまま突き合わせるため。
- update の記録を変わった列だけにするのは、save が差分だけを UPDATE する（Issue #165）のと同じで、何を変えたかが記録だけで分かるため。

## 採用しなかった案
- DB のトリガー / temporal_tables 拡張: 手書きの SQL（マイグレーション・手で直した行）の変更も拾えるが、記録のロジックが SQL に隠れ、InMemory で確かめられない。actor（アプリの利用者）を渡すにも接続ごとの設定が要る。
- 表ごとの履歴の表（`todos_history` のような `*_history`）: ある時点の行の全体（as-of）を引くには向くが、表を足すたびに履歴の表と書き込みが要り、漏れる。
- 記録をトランザクションの外（コミットの後）に書く: 記録の失敗で変更が記録から漏れる。
- 記録を 1 件ずつ別の INSERT にする: save の文の数が書いた行の数だけ増える。1 回の INSERT にまとめた。

## 影響
- 良い点: すべての書き込みが、誰が・いつ・何を（前後の値）で残る。表を足しても同じ仕組みで記録される。
- 悪い点: save / delete の SQL が 1 文ずつ増え、delete もトランザクションを張る。insert と delete は `returning` で行を受け取る。update の `before` は読み込んだときの値で、同じ列の同時更新（後勝ち）では DB が直前に持っていた値と違いうる。手書きの SQL の変更は記録されない。`change_logs` は消さないので増え続ける（保存期間・アーカイブは未定）。
- 見直す条件: ログインが入り actor を渡すとき、記録の保存期間や容量が問題になったとき、手書きの SQL の変更も記録する必要が出たとき、ある時点の行の全体（as-of）を頻繁に引く必要が出たとき。
