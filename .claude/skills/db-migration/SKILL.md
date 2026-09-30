---
name: db-migration
description: Drizzle のスキーマ変更とマイグレーション（schema.ts → pnpm db:generate → SQL の確認 → コミット → pnpm db:migrate）。テーブル・列を足す・変えるとき、apps/backend/features/*/internal/infra/schema.ts や apps/backend/shared/drizzle/ を触るとき、DB の表が無いエラーが出たときに使う。
---

# db-migration（Drizzle + Postgres）

テーブルの形は TypeScript で宣言し（codebase-first）、SQL はそこから生成する。WHY: 形の正を 1 か所にし、手書きの SQL とスキーマのずれを無くす。
層の規則（schema は infra、Repository が Entity と行を変換、Repository は `Database` を受け取る、トランザクション）は `.claude/rules/backend.md`。

## 前提
- Postgres が起動していること: `pnpm db:up`（`compose.yaml`）。接続先は `.env` の `DATABASE_URL`（無ければ `cp .env.example .env`）。
- コマンドはリポジトリ直下で実行する。`pnpm db:generate` / `pnpm db:migrate` は `pnpm --filter @repo/backend <script>` を呼び、`apps/backend` をカレントディレクトリにして `drizzle-kit ... --config shared/drizzle/drizzle.config.ts` を動かす（`apps/backend` で直接実行しても、リポジトリ直下から `--config apps/backend/shared/drizzle/drizzle.config.ts` で実行しても同じ）。設定の WHY は `apps/backend/shared/drizzle/drizzle.config.ts` のコメント。

## 手順
1. **テスト（仕様）から**: 新しい列・表を使う Repository のテスト（`*.postgres.test.ts`）を先に書き、失敗することを確かめる。
2. **スキーマを変える**: `apps/backend/features/<feature>/internal/infra/schema.ts`（Drizzle の `pgTable`）。feature を足したら同じ場所に `schema.ts` を置く（設定の `schema` は `apps/backend/features/*/internal/infra/schema.ts` を読む。`apps/backend/shared/` にはテーブルを置かない）。
   - 列の型は `.claude/rules/backend.md` の「列の型」の表に従う: 文字列は `text`（長さは書かず、上限は domain の zod が持つ）、整数は `integer`（21 億を超えうるものは `bigint`）、小数・金額は `numeric(p, s)`（精度は常に書く）、日時は `timestamp(..., { withTimezone: true })`、id は `uuid`、JSON は `jsonb`。WHY: Postgres では長さで性能は変わらず、上限を DB と domain の 2 か所に書くとずれて、DB の違反は 500 になる（決定は ADR `docs/adr/quality/20260930-db-column-types-default-text-and-integer.md`）。
   - 既定から外れる（`varchar(n)` / `char(n)`・timezone 無しの `timestamp`・`serial`・`json`）ときは、その列の直前の行に `// WHY 長さ: <理由>` など規則ごとの見出しで理由を書く。無いと `rule-tests/schema.test.ts` が失敗する（`pnpm test`）。
3. **SQL を生成する**: `pnpm db:generate --name <内容>`（例: `--name add_todo_due_date`）。前回のスナップショット（`apps/backend/shared/drizzle/meta/`）との差分から `apps/backend/shared/drizzle/<番号>_<名前>.sql` を作る。DB には接続しない。
4. **SQL を読む**: 意図どおりか確かめる。とくに列の改名が「削除 + 追加」になっていないか（データが消える）。
   - 意図と違えば `schema.ts` を直して作り直す。**生成済みの SQL は手で直さない**。WHY: `meta/` のスナップショットとずれ、次の generate の差分が壊れる。
5. **当てる**: `pnpm db:migrate`（`drizzle-kit migrate`）。まだ当てていない SQL だけを当てる。当てた記録は DB の `drizzle.__drizzle_migrations` 表に残り、何度実行しても同じ結果になる。
6. **テストを通す**: `pnpm test`。実 Postgres のテストは `createTestDatabase()` がテストファイルごとの別スキーマにマイグレーションを当てるので、テスト用に migrate する必要はない。E2E（`pnpm test:e2e`）は `public` の表を使うので手順 5 が要る。
7. **コミット**: `schema.ts`・テスト・`apps/backend/shared/drizzle/`（SQL と `meta/` をまとめて）を同じコミットに入れる。

## やらないこと
- `drizzle-kit push`（DB をスキーマに直接合わせる）は使わない。WHY: SQL がファイルに残らず、どの環境に何を当てたかが記録されず、レビューもできない。列の改名を「削除 + 追加」と解釈してデータを消す変更も、SQL を読まずに当たってしまう。generate + migrate なら、当てる SQL を PR で読み、すべての環境で同じ SQL を同じ順に当てられる。
- `apps/backend/shared/drizzle/meta/` を Biome で整形しない（`biome.json` の `files.includes` で対象外。同じディレクトリの `drizzle.config.ts` は検査する。`*.sql` は Biome が読まない）。WHY: drizzle-kit が書く JSON は末尾の改行が無く format に違反するが、整形しても次の generate で書き戻される。
- `webServer.command`（Playwright）やアプリの起動で migrate しない。当てるのは手順 5・CI・クラウドのフックだけ。

## どこで migrate されるか
- CI（`ci.yml` / `mutation.yml`）: Postgres の起動と `cp .env.example .env` の後に `pnpm db:migrate`。
- クラウドセッション: SessionStart フック（`scripts/cloud-session-start.sh`）が Postgres の起動後に `timeout 15 pnpm db:migrate`（`cloud-session` スキル）。
- ローカル: 自分で `pnpm db:up && pnpm db:migrate`。`pnpm dev` の前にも要る（アプリは常に Postgres を使う）。

## 困ったとき
- `relation "todos" does not exist`: migrate していない。手順 5。
- 必須の環境変数が欠けていると `drizzle.config.ts` の読み込み（`env.ts`）で名前を挙げて止まる。`.env` を `.env.example` から作る（`.claude/rules/env.md`）。
