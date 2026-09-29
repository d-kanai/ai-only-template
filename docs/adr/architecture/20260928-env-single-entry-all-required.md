# 環境変数は env.ts の 1 か所で型付きに読み、すべて必須・既定値なしにして、直参照を 2 系統の検査で止める

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #59 / PR #61 / Issue #68 / Issue #90 / `.claude/rules/env.md` / `apps/shared/env.ts`

## 背景
`DATABASE_URL` などを各所（database.ts・container.ts・drizzle.config.ts・E2E・playwright.config.ts）が `process.env` から直接読み、既定値が 4 か所に重複していた（2026-09-28 の work-logs「環境変数を env.ts で一元管理し、直参照を禁止して検査する（Issue #59）」）。

## 決定
- 環境変数の入口は `env.ts` の 1 か所（Issue #90 で `apps/shared/env.ts` に移した。architecture/20260929-apps-shared-package.md）。必須の変数を読み込み時に全件検証し、欠けや不正はまとめて 1 つのエラーにする。既定値はコードに書かず、開発用の値は `.env.example` に置く。
- `.env` はリポジトリ直下に 1 つ（Issue #68 のユーザー判断）。Node 標準の `process.loadEnvFile` で読み、依存は足さない。
- サーバは起動時に検証し、欠けていれば名前を出して exit 1 する（Next の `instrumentation.ts` の `register`）。
- ツール用の任意のフラグ（`CI` など）は `toolEnv` の別の区画にする。
- `process.env` の直参照は、Biome の `noProcessEnv` と `rule-tests/architecture.test.ts` の `env-direct-access` の 2 系統で止める。

## 理由
- ユーザーの指示（型安全、直参照の禁止とその検知、全部必須、既定値の禁止、起動エラー、`.env` の導入。Issue #59）。
- API の route は最初のリクエストまで読み込まれず、`register` が失敗しても `next start` は動き続けたので、自分で `process.exit(1)` する（同日の work-logs。Next.js 16.3.6 同梱 `01-app/02-guides/instrumentation.md`）。
- Biome とテストでは、片方だけが拾う書き方がある（同日の work-logs）。

## 採用しなかった案
- 既定値をコードに持つ（以前の形）: 重複し、欠けに気づけない。
- `.env` を app ごとに置く: ユーザーの判断でリポジトリ直下に 1 つ（Issue #68）。
- ツール用のフラグも必須にして `.env.example` に値を置く（Issue #59 で挙げた案）: 任意の区画（`toolEnv`）にした。

## 影響
- 良い点: 変数を足すときは `env.ts` と `.env.example` を足すだけ。欠けはどの入口（build / test / E2E / migrate / start）でも名前付きで止まる。
- 悪い点: 分割代入や別名経由など、どちらの検査も拾わない書き方がある（限界は `.claude/rules/env.md`）。
- 見直す条件: 記録に無い。
