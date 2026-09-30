# Todo の完了の遷移は集約の子表（insert のみ）に積み、最新の状態は集約の現在値の列にも持つ

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #188 / `.claude/rules/backend.md` / `rule-tests/persistence.test.ts` / `apps/backend/features/todo/domain/todo.ts` / `apps/backend/features/todo/infra/schema.ts` / `apps/backend/features/todo/infra/todo-repository.postgres.ts`

## 背景
Todo の完了状態は `todos.completed` の 1 列だけで、上書きしていた。いつ完了した・いつ未完了に戻したかが残らない。
完了の日時は業務上の重要な事実（いつ終わったか、何度やり直したか）で、後から集計・表示する要望が出たときに過去の分は取り戻せない。

## 決定
- 完了状態が変わるたびに、変わった後の値と日時を子表 `todo_status_changes` に 1 行足す（insert のみ。UPDATE / DELETE しない。消えるのは親の Todo を消したときの `on delete cascade` だけ）。
- Todo（集約ルート）は履歴を `statusChanges`（古い順）として持ち、不変条件（1 件以上・日時の昇順・最初は作成日時以上・最後の `completed` が今の `completed` と同じ）をコンストラクタで検証する。`create` は「作成日時に未完了」の 1 件から始め、`changeCompletion` は値が変わるときだけ 1 件足す。
- 今の値は `todos.completed` に残す（一覧・詳細はそれだけを読む）。
- Repository の `save` は、`todos` の書き込みと増えた履歴の INSERT を 1 つのトランザクションで行う。履歴の中の位置 `position` を列に持ち、`(todo_id, position)` を一意にする。
- insert のみの表は名前を `*Changes` / `*Events`（表は `*_changes` / `*_events`）にし、`*.postgres.ts` での `.update(` / `.delete(` を `rule-tests/persistence.test.ts` の `no-update-delete-on-append-only-tables` が止める。
- 外部キーは手書きのマイグレーション（`pnpm db:generate --custom`）で張り、既存の Todo の履歴も同じマイグレーションで作る。

## 理由
- 遷移の記録は後から書き換えないことに意味がある（書き換えると「いつ何に変わったか」が失われる）。insert のみなら、同時に書き込んでも既存の行は変わらない。
- 履歴を集約の中に置けば、「最後の履歴 = 今の状態」の整合を Entity の不変条件として 1 か所で検証でき、InMemory（テスト用）でも同じ規則が効く。
- `position` を持つのは、日時は同じ値を許す（作成と完了が同じミリ秒になりうる）ので、日時だけでは足した順が決まらないため。一意にするのは、同じ Todo を 2 か所で読み込んで両方が完了状態を変えたとき、後の save を失敗させ、履歴の最後と `todos.completed` のずれ（読めない Todo）を防ぐため。
- `.references()` で外部キーを生成しないのは、drizzle-kit 0.31.11 の generate が `REFERENCES "public"."todos"` とスキーマ付きで書き、テスト用のスキーマ（search_path で分けた別スキーマ）に当てても public を指すため（drizzle-kit の `bin.cjs` の `PgSquasher.squashFK` が `schemaTo || "public"`）。
- 表の名前の接尾辞で検査するのは、insert のみの表を一覧で持つと、表を足したときに一覧への追加を忘れて素通りするため。

## 採用しなかった案
- 完全なイベントソーシング（状態を持たず、イベントから毎回組み立てる）: 一覧のたびに全 Todo のイベントを読んで畳み込むことになり、読み取りと再構築が重い。スナップショットや射影の仕組みも要る。
- `todos` に `completed_at` の列を足すだけ: 最後に完了した日時しか残らず、完了と未完了の往復の履歴が残らない。
- DB のトリガーで `todos.completed` の変更を履歴の表に書く: InMemory（テスト用）で同じ振る舞いを確かめられず、履歴の規則が DB の SQL と domain の 2 か所に分かれる。
- 履歴の順序を日時と行の id（uuid）で決める: 日時が同じ行の順が乱数で決まり、読み出すたびに「最後の completed」が変わりうる。

## 影響
- 良い点: 完了・未完了の遷移の日時がすべて残り、後から集計・表示できる。履歴の書き換え・削除は検査で止まる。
- 悪い点: Repository の読み出しが子表も読む（Todo の行の後に 1 クエリ）。save は増分の INSERT が加わり、トランザクションを張る。同じ Todo の完了状態を同時に変えると、後の要求は 500 になる（今の画面の使い方では起きにくい）。既存の完了済みの Todo の完了日時は分からないので、移行では作成日時を入れた。
- 見直す条件: 履歴を画面・API で表示する（別 Issue）、ほかの遷移（名前の変更など）も履歴に残す、同時の変更を 409 などで利用者に返す必要が出たとき。
