---
paths:
  - "apps/shared/**"
---

# shared（frontend と backend で共通の基盤。apps/shared）

`apps/shared/` は workspace パッケージ `@repo/shared`（Issue #90）。frontend（直下のサーバ側のファイル）と backend の両方が使う横断的な基盤だけを置く。Node 標準だけを使う TypeScript で、依存（`dependencies`）は持たない。
規則は `rule-tests/architecture.test.ts` が検査する（一覧は `.claude/rules/architecture-check.md`）。決定は ADR `docs/adr/architecture/20260929-apps-shared-package.md`。

## 置いてよいもの
- `env.ts`（環境変数の唯一の入口。`.claude/rules/env.md`）と `logger.ts`（サーバ側のログの唯一の出口。`.claude/rules/backend.md` の「ログ」）、そのテスト（`env.test.ts`・`logger.test.ts`）、`package.json`・`tsconfig.json` だけ（規則 `shared-placement`。ソース以外のファイルも名前で決める）。
  - WHY: 「frontend と backend の両方で使う」ものは多く、共通の置き場所を自由にすると feature のコードや DB・React に依存するコードが集まり、層の規則（backend の 4 層・画面側の境界）の外で依存が育つ。置いてよいのは、どの層・どのパッケージからも同じものを使うべき基盤（外の世界との入口・出口）だけにする。
- 置かないもの: feature のコード（型・DTO を含む。画面とサーバの契約は backend の api ファイルに置く）、DB（`drizzle-orm` / `pg`。永続化は backend の infra）、React・Next・ブラウザの API。
- 足すときは、Issue で「frontend と backend の両方が使う基盤か」を決めてから、`shared-placement` の一覧（`SHARED_FILES`）・`exports`・このファイルを同じ変更で直す（足すことを規則の変更としてレビューに出す）。

## 使い方（import の書き方）
- 外からは `@repo/shared/env`・`@repo/shared/logger` で使う（各パッケージの `package.json` に `"@repo/shared": "workspace:*"`）。
  - frontend 直下（`instrumentation-node.ts`・`proxy.ts`）・`apps/e2e/`・リポジトリ直下（`vitest.global-setup.ts`）は `@repo/shared/...` の書き方だけ（相対パスと `@/../shared/...` は不可。規則 `frontend-to-shared-specifier`）。
  - backend の中も `@repo/shared/...` だけで書く（相対パスは違反。規則 `backend-relative-only`）。WHY: exports を経由しない参照を許すと、公開範囲（exports）が意味を持たなくなる。backend の層ごとに使ってよいもの: infra は env・logger、presentation は logger だけ、domain・application は使わない（`SHARED_MODULES_BY_LAYER`）。
  - 画面側（`apps/frontend/` の `app/`・`features/`・`shared/`）は使わない（規則 `screen-to-shared`）。WHY: env は `process.env` と `.env` のファイルを読み、logger は stdout に書くサーバ専用のもので、ブラウザのバンドルに入れない。
- `apps/shared` の中は同じディレクトリのファイルと `node:` の組み込みだけを読む。backend・frontend、React・Next・DB、`node:` 以外のパッケージは参照しない（規則 `shared-self-contained`）。WHY: frontend 直下と backend の両方が読み込む基盤なので、ここから外を参照すると `frontend-root-to-backend` や層の規則を `apps/shared` 経由ですり抜けられ、依存も env・logger を使うすべての場所に入る。

## exports（`apps/shared/package.json`）
- キーは `./env` と `./logger` の 2 つ。1 ファイル = 1 キーで、パターン（`"./*"`）を使わない（規則 `shared-exports` が過不足と値の形を止める。検査の内容は `backend-exports` と同じ）。
  - WHY: 置いてよいファイルを名前で決めている（`shared-placement`）ので、公開も名前で決め、置き場所と公開を 1 対 1 にする。
- 値はキーのパスに `.ts` を付けた TS のソース（ビルドしない。`@repo/backend` と同じ）。

## 型チェック・テスト
- `apps/shared/tsconfig.json` は `apps/backend/tsconfig.json` と同じ方針（Next の plugin・jsx・DOM の型なし）。`pnpm typecheck` が `tsc -p apps/shared --noEmit` で検査する（`rule-tests/typecheck.test.ts`）。
- テストは隣に置き、先頭に `// @vitest-environment node`。カバレッジ（`vitest.config.mts` の `coverage.include`）と Stryker（`stryker.config.mjs` の `mutate`）の対象（`.claude/rules/testing.md`）。
- テストは同じディレクトリのファイルを相対パス（`./env`）で import する。WHY: Stryker のサンドボックスで `@repo/shared/...` から読むと、変異していない元のファイルに解決される（`stryker.config.mjs` の注意）。
