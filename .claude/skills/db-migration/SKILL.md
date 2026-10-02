---
name: db-migration
description: Drizzle のスキーマ変更とマイグレーション（schema.ts → pnpm db:generate → SQL の確認 → コミット → pnpm db:migrate）。テーブル・列を足す・変えるとき、外部キーを張るとき、apps/backend/features/*/internal/infra/schema.ts・apps/backend/shared/change-log/change-log.schema.ts・apps/backend/shared/drizzle/ を触るとき、DB の表が無いエラーが出たときに使う。
---

# db-migration（Drizzle + Postgres）

テーブルの形は TypeScript で宣言し（codebase-first）、SQL はそこから生成する。WHY: 形の正を 1 か所にし、手書きの SQL とスキーマのずれを無くす。
層の規則（schema は infra、Repository が Entity と行を変換、Repository は `Database` を受け取る、トランザクション）は `.claude/rules/code/backend.md`。

## 前提
- Postgres が起動していること: `pnpm db:up`（`compose.yaml`）。接続先は `.env` の `DATABASE_URL`（無ければ `cp .env.example .env`）。
- コマンドはリポジトリ直下で実行する。`pnpm db:generate` は `pnpm --filter @repo/backend db:generate` を呼び、`apps/backend` をカレントディレクトリにして `drizzle-kit generate --config shared/drizzle/drizzle.config.ts` を動かす（`apps/backend` で直接実行しても、リポジトリ直下から `--config apps/backend/shared/drizzle/drizzle.config.ts` で実行しても同じ）。設定の WHY は `apps/backend/shared/drizzle/drizzle.config.ts` のコメント。`pnpm db:migrate` はリポジトリ直下の script で、`apps/backend` には無い（入口 `migrate.ts` を束ねて実行する。Issue #326）。

## 手順
1. **テスト（仕様）から**: 新しい列・表を使う Repository のテスト（`*.postgres.test.ts`）を先に書き、失敗することを確かめる。
2. **スキーマを変える**: feature の表は `apps/backend/features/<feature>/internal/infra/schema.ts`（Drizzle の `pgTable`）、feature をまたぐ横断の表（変更履歴の `change_logs`。Issue #189）だけ `apps/backend/shared/change-log/change-log.schema.ts` に置く。feature を足したら同じ場所に `schema.ts` を置く（設定の `schema` は両方を配列で読む。`apps/backend/shared/drizzle/drizzle.config.ts`）。
   - 外部キーは `.references()` で書かない（下の「外部キー」）。
   - 列の型は `.claude/rules/code/backend.md` の「DB スキーマ」の表の「列の型」に従う: 文字列は `text`（長さは書かず、上限は domain の zod が持つ）、整数は `integer`（21 億を超えうるものは `bigint`）、小数・金額は `numeric(p, s)`（精度は常に書く）、日時は `timestamp(..., { withTimezone: true })`、id は `uuid`、JSON は `jsonb`。WHY: Postgres では長さで性能は変わらず、上限を DB と domain の 2 か所に書くとずれて、DB の違反は 500 になる（決定は ADR `docs/adr/quality/20260930-db-column-types-default-text-and-integer.md`）。
   - 既定から外れる（`varchar(n)` / `char(n)`・timezone 無しの `timestamp`・`serial`・`json`）ときは、その列の直前の行に `// WHY 長さ: <理由>` など規則ごとの見出しで理由を書く。無いと `rule-tests/schema.test.ts` が失敗する（`pnpm test`）。
3. **SQL を生成する**: `pnpm db:generate --name <内容>`（例: `--name add_todo_due_date`）。前回のスナップショット（`apps/backend/shared/drizzle/migrations/meta/`）との差分から `apps/backend/shared/drizzle/migrations/<番号>_<名前>.sql` を作る。DB には接続しない。
4. **SQL を読む**: 意図どおりか確かめる。とくに列の改名が「削除 + 追加」になっていないか（データが消える）。
   - 意図と違えば `schema.ts` を直して作り直す。**生成済みの SQL は手で直さない**。WHY: `meta/` のスナップショットとずれ、次の generate の差分が壊れる。
   - SQL に `"public".` が無いこと（表をスキーマで修飾しない）。あると `rule-tests/migration.test.ts` の `no-public-schema-qualifier` が失敗する（WHY は下の「外部キー」）。
   - `--custom` の SQL（下の「外部キー」）を書いたら、別の一時スキーマにデータを入れてから当て、行の中身・外部キーの参照先（`pg_constraint` の `confrelid::regclass` が当てたスキーマの表か）・選んだ削除時の動作（親を消したときに子が消える / 拒否される / `NULL` になる）を確かめる。WHY: テストはファイルごとの別スキーマに当てるので、参照先が public だとテストでは気づけないまま壊れる。
5. **当てる**: `pnpm db:migrate`（入口 `apps/backend/shared/drizzle/migrate.ts` を esbuild で `dist/migrate/` に束ね、drizzle-orm の migrator で当てる。Cloud Run の migrate ジョブが runtime イメージで実行するのと同じファイル。Issue #326）。まだ当てていない SQL だけを当てる。当てた記録は DB の `drizzle.__drizzle_migrations` 表に残り、何度実行しても同じ結果になる。
6. **テストを通す**: `pnpm test`。実 Postgres のテストは `TestDatabase.create()` がテストファイルごとの別スキーマにマイグレーションを当てるので、テスト用に migrate する必要はない。E2E（`pnpm test:e2e`）は `public` の表を使うので手順 5 が要る。
7. **コミット**: `schema.ts`・テスト・`apps/backend/shared/drizzle/migrations/`（SQL と `meta/` をまとめて）を同じコミットに入れる。
- データの移行（既存の行を足す・直す）の仕組みは今は無い（Issue #247 で backfill を外した。本番環境が無く移すデータが無い）。要るようになったら方法を決め直す（`.claude/rules/code/backend.md` の「DB スキーマ」の表の「マイグレーション」）。

## 外部キー（`--custom` の SQL で張る。Issue #188）
- `schema.ts` に `.references()` を書かない。WHY: drizzle-kit 0.31.11 の generate は `REFERENCES "public"."todos"` とスキーマ付きで書く（`bin.cjs` の `schemaTo || "public"`。2026-09-30 に生成して確認）。`TestDatabase.create()` はテストファイルごとの別スキーマ（search_path）にマイグレーションを当てるので、public を指す外部キーはテストのスキーマの表を指さず壊れる。
- 手順: `pnpm db:generate --custom --name <内容>` で空の SQL を作り、`ALTER TABLE "<子>" ADD CONSTRAINT "<子>_<列>_<親>_id_fk" FOREIGN KEY ("<列>") REFERENCES "<親>"("id") ON DELETE <動作>;` をスキーマなしで手で書く（`--custom` の SQL は手で書くもの。手順 4 の「手で直さない」は generate が書いた SQL のこと）。例は `apps/backend/shared/drizzle/migrations/0002_todo_status_changes_foreign_key_and_backfill.sql`。列の側の `schema.ts` には、外部キーを SQL で張ったことと WHY をコメントで書く（`features/todo/internal/infra/schema.ts` の `todoId`）。
- `ON DELETE` の動作は関係ごとに選び、理由を SQL のコメントに書く: 子が親に属し親と一緒に消えてよいなら `cascade`（Todo の完了の履歴 `todo_status_changes`）、子が残る間は親を消させないなら `restrict` / `no action`、子を残して参照だけ外すなら `set null`（列は null 可）。WHY: `cascade` を既定にすると、残すべき子が親の削除で黙って消える。
- 張った後は手順 4 の一時スキーマでの確認をする。テストの `truncate` と E2E の後始末は、参照する表と参照される表を同じ文で消す（`.claude/rules/code/backend.md` の「DB スキーマ」の表の「外部キー」）。

## やらないこと
- `drizzle-kit push`（DB をスキーマに直接合わせる）は使わない。WHY: SQL がファイルに残らず、どの環境に何を当てたかが記録されず、レビューもできない。列の改名を「削除 + 追加」と解釈してデータを消す変更も、SQL を読まずに当たってしまう。generate + migrate なら、当てる SQL を PR で読み、すべての環境で同じ SQL を同じ順に当てられる。
- `apps/backend/shared/drizzle/migrations/meta/` を Biome で整形しない（`biome.json` の `files.includes` で対象外。親のディレクトリ `drizzle/` の `drizzle.config.ts` などのソースは検査する。`*.sql` は Biome が読まない）。WHY: drizzle-kit が書く JSON は末尾の改行が無く format に違反するが、整形しても次の generate で書き戻される。
- `webServer.command`（Playwright）やアプリの起動で migrate しない。当てるのは手順 5・CI・クラウドのフックだけ。

## どこで migrate されるか
- CI（`ci.yml` / `mutation.yml`）: Postgres の起動と `cp .env.example .env` の後に `pnpm db:migrate`。
- クラウドセッション: SessionStart フック（`scripts/cloud-session-start.sh`）が Postgres の起動後に `timeout 15 pnpm db:migrate`（`cloud-session` スキル）。
- ローカル: 自分で `pnpm db:up && pnpm db:migrate`。`pnpm dev` の前にも要る（アプリは常に Postgres を使う）。

## 困ったとき
- `relation "todos" does not exist`: migrate していない。手順 5。
- 必須の環境変数が欠けていると `pnpm db:migrate`（入口 `migrate.ts` のアプリのプールが読む `env.ts`）が名前を挙げて止まる。`pnpm db:generate`（drizzle-kit）は DB に接続せず、`.env` も読まない（Issue #326）。`.env` を `.env.example` から作る（`.claude/rules/tooling/env.md`）。
