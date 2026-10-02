# Writer の update は変更履歴の before に呼び出し側の origin を使い、before のために行を読み直さない

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #312 / `apps/backend/shared/drizzle/writer.ts` / `apps/backend/shared/change-log/change-log.ts` / `apps/backend/features/todo/internal/infra/todo-repository.postgres.ts` / ADR `architecture/20260930-transaction-from-application.md`（「update は同じトランザクションで FOR UPDATE で読んだ行を before」の部分をこの ADR で変え、状態を「置き換え」にした。それ以外の決定はその ADR のまま）

## 背景
Issue #215 で書き込みの口 Writer を作ったとき、Writer は表・id・変える列だけを受け取る形にし、update の変更履歴の before は Writer が同じトランザクションで `SELECT … FOR UPDATE` で読み直して取るようにした（ADR `architecture/20260930-transaction-from-application.md`。悪い点に「SELECT が 1 文増える」と書いた）。
一方で、更新の command は先に `findByIdForUpdate` で同じ行をロックして集約を読み、Repository は読み込んだときの値（`origin`）と今の値の差分を `ChangedProps.of` で出して Writer に渡している。ユーザーの指摘（2026-10-02）は「update のたびに SELECT が増えている。差分は domain model が知っているので、読み直さなくてよいのでは」。

## 決定
- `Writer.update(table, id, origin, changes)` にし、呼び出し側が渡した変える前の値（`origin`）を変更履歴とログの before にする。Writer は before のための SELECT を発行しない。
- `origin` に `changes` の列が無ければ、SQL を発行する前に Error にする（before が分からず記録が欠けるため）。
- 行が無いことは UPDATE の `returning` が 0 行であることで判定し、今までと同じ Error（`<表> has no row to update: <id>`）にする。
- 行のロックは、今までどおり command（`findByIdForUpdate`）の責務とする。

## 理由
- command は同じトランザクションで先に行を `FOR UPDATE` でロックしてから読むので、ロックが取れている間は別のトランザクションがその行を変えられず、`origin` は DB が UPDATE の直前に持っていた値と同じになる。Writer の読み直しは同じ値をもう一度読むだけで、update のたびに SELECT が 1 文増えていた。
- 差分（どの列を変えるか）はすでに Repository が `origin` から出しているので、before も同じ `origin` から取れば、差分と before の出どころがそろう。

## 採用しなかった案
- Writer が読み直す形を続ける（Issue #215 の形）: ロックせずに読んだ Todo で書く誤りがあっても before が DB の値になる利点はあるが、正しい呼び出し（ロックしてから読む）では毎回重複した SELECT になる。ユーザー判断で採らない。
- before の SELECT を `UPDATE … RETURNING` の副問い合わせ（自己結合で古い値を返す）にまとめる: 文の数は減るが、SQL が表ごとに複雑になり、`origin` があるのに DB から取る理由が無い。

## 影響
- 良い点: update 1 回あたりの SQL が 1 文減る（SELECT … FOR UPDATE が無くなる）。
- 悪い点: before の正しさが呼び出し側のロックに依存する。ロックせずに読んだ Todo で update すると、読んだ後に別の update が変えた値ではなく `origin` が before に残る（`todo-repository.postgres.test.ts` が固定する）。Repository の `update` は読み込み済みの Todo（`origin` あり）しか受け取らず、command は `findByIdForUpdate` で読むので、今の経路では起きない。`Todo.reconstruct` は title を trim した値を origin にするので、手で入れた行など DB の title に前後の空白があると、before は trim 後の値になる（アプリの書き込みは常に trim 後の値で、差分の判定（`ChangedProps.of`）はもともと origin を使っている）。
