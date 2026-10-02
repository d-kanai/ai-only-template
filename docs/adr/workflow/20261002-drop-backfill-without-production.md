# 本番環境ができるまでデータの移行（backfill）の仕組みを持たず、下位互換の処理を残さない

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #247 / Issue #260 / Issue #194 / Issue #237 / `.claude/rules/backend.md` / `rule-tests/migration.test.ts`

## 背景
workflow/20261001-backfill-after-traffic-switch.md（Issue #194）で、データの移行をデプロイの切替の後に冪等な SQL（`pnpm db:backfill`・deploy.yml の Run backfill・`apps/backend/shared/drizzle/backfill/`）で流すことにし、workflow/20261002-drop-repair-on-read-without-production.md（Issue #260）で repair on read / write だけを外して backfill は残した。本番環境は無く、stg も一度もデプロイされていない（deploy.yml の実行は Variables が無く build 以降が skipped。2026-10-02 の work-logs）。

## 決定
- backfill の仕組み一式を消す: `pnpm db:backfill`（ルートと `apps/backend`）、`apps/backend/shared/infra/backfill.ts`・`ts-resolve.ts` とテスト、`apps/backend/shared/drizzle/backfill/`、deploy.yml の Run backfill、ログのイベント `db_backfill`、`rule-tests/migration.test.ts` の `idempotent-insert-select`・`backfill-after-traffic`・`backfill-file-name`。
- マイグレーション `0002_todo_status_changes_foreign_key_and_backfill.sql` の中のデータの移行（INSERT 2 文）を消す。外部キーの ALTER は残し、ファイル名（journal の tag）は変えない。
- `no-public-schema-qualifier`（Issue #192。外部キーを正しく張るため）は残す。
- 本番環境ができてデータの移行が要るときに、方法を決め直す。

## 理由
- 下位互換の処理は守るデータ・クライアントがあってはじめて意味を持つ。本番環境が無い今は、使わないコード・テスト・検査・手順を持ち続ける費用だけが残る（ユーザー判断 2026-10-02「下位互換のための処理が残っていたら全体的に消して。DB問わず」）。
- 0002 の INSERT は、新しい DB ではこの時点で todos が空なので 0 行だった。drizzle-orm 0.45.3 の migrator は適用済みかをハッシュで見ず、`__drizzle_migrations` の最後の `created_at` と journal の `when` を比べるだけ（`node_modules/drizzle-orm/pg-core/dialect.js` の migrate）なので、当て済みの開発 DB で書き換えても再実行もエラーも起きない。
- `idempotent-insert-select` の WHY は「backfill は毎回流す」「backfill に移すときに書き直さずに済む」で、backfill が無くなると根拠が無い。

## 採用しなかった案
- backfill の仕組みを、使い道ができるまで残す: 使わない間もテスト（実 Postgres のロックの検査）・rule-tests・デプロイの手順の保守がかかる。必要になったら workflow/20261001-backfill-after-traffic-switch.md を参考に作り直せる。
- マイグレーションを 1 本に作り直す（squash）: 当て済みの開発 DB と worktree の DB の作り直しが要る。INSERT を消すだけで足りる。

## 影響
- 良い点: デプロイの手順・Node の実験的な `registerHooks` への依存・ログの種類が減る。
- 悪い点: 本番環境を作った後に既存のデータを直すマイグレーションが要るときは、仕組みを作り直す。
- 見直す条件: 本番環境ができ、既存のデータを移す・旧リビジョンと新しいリビジョンが同じ DB を読み書きする期間が生じるとき。
