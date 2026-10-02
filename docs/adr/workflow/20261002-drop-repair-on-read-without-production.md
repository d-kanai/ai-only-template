# データの移行（backfill）は切替の後に冪等な SQL で流す方針を保ち、切替から backfill までの間の repair on read / write はやめる

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #260 / Issue #194 / Issue #237 / `.claude/rules/backend.md` / `apps/backend/features/todo/internal/infra/todo-repository.postgres.ts`

## 背景
workflow/20261001-backfill-after-traffic-switch.md（Issue #194）と Issue #237 で、デプロイの切替から backfill を流し終えるまでの間に旧リビジョン（完了の履歴を知らない版）が書いた Todo（履歴が無い・最後の履歴が `todos.completed` と食い違う）を、新しいアプリの Repository が補って読み（repair on read。`repairHistory`）、次の update で書く（repair on write。`Todo.reconstruct(values, stored?)` の `stored`）ようにした。本番環境はまだ無く、旧リビジョンのデータを読むことは無い。

## 決定
- Repository の `repairHistory` と `Todo.reconstruct` の第 2 引数 `stored` を消す。履歴が無い・食い違う行は、ほかの不変条件の違反と同じく 500（`stored Todo (id: ...) violates the invariants`）にする。
- それ以外の workflow/20261001-backfill-after-traffic-switch.md の決定（スキーマの変更は切替の前、データの移行は `apps/backend/shared/drizzle/backfill/` の冪等な SQL で切替の後に `pnpm db:backfill` で流す。`FOR UPDATE OF` と `ON CONFLICT … DO NOTHING`）は変えない。

## 理由
- 補いは旧リビジョンのデータを読むための下位互換で、本番環境が無い今は守るデータが無い（ユーザー判断 2026-10-02）。残すと、domain の `reconstruct` に永続化の都合の引数が残り、Repository の読み出しに分岐が残る。
- 今のアプリは Todo（不変条件を満たす値）を通してしか書かないので、履歴が無い・食い違う行は手で入れた行などのデータの誤りで、500 にして気づけるほうがよい（Issue #94 と同じ考え方）。
- backfill の仕組みは今回の対象（`repairHistory`）の外で、デプロイの手順・検査（`rule-tests/migration.test.ts`）に広く関わるので、この決定では残す。

## 採用しなかった案
- backfill の仕組み（`db:backfill`・deploy.yml の Run backfill・`backfill/0001_*.sql`）も同時に消す: 依頼の対象は `repairHistory` で、デプロイの手順の変更は別に判断する。
- 補いを残し、本番環境ができるまで使わない: 使わないコードとテストを持ち続けることになる。

## 影響
- 良い点: Todo の読み出しと `reconstruct` が単純になる（origin は常に検証後の値）。
- 悪い点: 本番環境を作った後に履歴の形を変えるデプロイをするなら、切替から backfill までの間は旧リビジョンの書いた行が 500 になる。そのときは書き込みを止める・補いを戻すなどを改めて決める。
- 見直す条件: 本番環境ができ、旧リビジョンと新しいリビジョンが同じ DB を読み書きする期間が生じるとき。
