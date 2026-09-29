# アプリは常に Postgres を使い、InMemory への切り替えを持たない（InMemory はテスト用だけ）

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #59 / PR #61 / Issue #57 / PR #60 / `.claude/rules/backend.md` / `.claude/rules/testing.md`

## 背景
Issue #57 では、DB なしで `pnpm dev` を触れるように「`DATABASE_URL` が無ければ InMemory」の切り替えを入れた。Issue #59 で環境変数を全部必須・既定値なしにする（architecture/20260928-env-single-entry-all-required.md）にあたり、この切り替えは「変数が無くても黙って別の実装で動く」経路になっていた。

## 決定
- アプリ（`pnpm dev` / `pnpm start` / E2E）は常に Postgres を使う。`DATABASE_URL` が無ければ起動時に止まる。
- InMemory の Repository はテストでだけ使う（application・presentation の単体テスト）。Postgres の実装は実 Postgres でテストする。
- worktree で並列に作業するときも、InMemory / WASM の DB に置き換えず、同じ Postgres の別データベースを使う（workflow/20260928-worktree-isolated-external-resources.md）。

## 理由
- 設定の欠けを黙って別の実装で補うと、気づかないまま本番と違う経路で動く（2026-09-28 の work-logs「環境変数を env.ts で一元管理し、直参照を禁止して検査する（Issue #59）」）。
- DB は `pnpm db:up` でいつでも起動できる（workflow/20260928-postgres-via-docker-compose-everywhere.md）。E2E は元から Postgres が必須だった（PR #61）。

## 採用しなかった案
- `DATABASE_URL` が無ければ InMemory に切り替える（Issue #57 の形）: 欠けに気づけない。
- テストや worktree で pg-mem / PGlite を使う: PGlite はドライバが `pg` と別で、本番の `Pool` の経路を通らない（2026-09-28 の work-logs「worktree で並列作業するときのテスト用 DB の分離方針を検討」）。

## 影響
- 良い点: 開発・E2E・本番が同じ永続化の経路を通る。
- 悪い点: 開発にもテストにも Postgres の起動が要る（`pnpm test` も実 Postgres のテストを含む）。
- 見直す条件: 記録に無い。
