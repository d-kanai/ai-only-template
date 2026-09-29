# frontend と backend で共通の基盤（env と logger）は、workspace パッケージ apps/shared（@repo/shared）に置く

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #90 / PR #92 / `.claude/rules/shared.md` / `apps/shared/package.json`

## 背景
環境変数の入口 `env.ts`（architecture/20260928-env-single-entry-all-required.md）とログの出口 `logger.ts`（architecture/20260929-logger-single-exit.md）は、frontend 直下・backend・E2E・globalSetup が共通で使うのに `apps/backend/shared/infra/` にあった。frontend 直下から backend を参照する例外（規則 `frontend-root-to-backend`）が要っていた。

## 決定
- `apps/shared`（`@repo/shared`。依存なし、`exports` は `./env`・`./logger` だけ）を作り、`env.ts` と `logger.ts` を移す。
- 置いてよいのは frontend と backend の両方が使う横断的な基盤だけ。置けるファイルを名前で決め（`shared-placement`）、外への参照も止める（`shared-self-contained`。同じディレクトリのファイルと `node:` だけ）。
- 画面側（`app/`・`features/`・`apps/frontend/shared/`）からは参照しない。参照の書き方は `@repo/shared/...` だけ。
- `packages/` ではなく `apps/` の下に置く。

## 理由
- 共通のものは共通の場所に置き、frontend 直下から backend への参照を無くす（ユーザーの指摘。2026-09-29 の work-logs「env / logger を frontend と backend の共通パッケージ apps/shared に移す指示 → Issue #90」）。
- workspace のパッケージを `apps/` の下にそろえる（ユーザー判断。`pnpm-workspace.yaml` の `packages: ["apps/*"]` もそのまま）。
- 何でも置ける場所にしないため、置けるものと外への参照を規則で決めた。`shared-self-contained` は、文書にだけあって検査が無かったことを reviewer が見つけて足した（2026-09-29 の work-logs「Issue #90: env / logger を apps/shared（@repo/shared）に移した」）。

## 採用しなかった案
- `packages/shared` に置く: ユーザー判断で `apps/` の下にそろえる。
- `frontend-to-backend-specifier` を「backend と shared」に広げる: 1 規則 = 1 テストで、失敗したときにどちらの境界かが分かるよう、`frontend-to-shared-specifier` を別に足した。
- 依存を持てるパッケージにする（`dependencies` に書けば使える形）: 置いてよいかの判断がレビューに出ないので、`node:` 以外は違反にし、許可は Issue で広げる（PR #92）。

## 影響
- 良い点: frontend 直下は backend を参照しなくなった。後で API を別プロセスに分けても、両方が env と logger をそのまま使える。
- 悪い点: `apps/shared` に zod などの依存を入れるには、規則の許可を Issue で広げる必要がある。
- 見直す条件: 共通の基盤を足すとき（規則と `exports` を更新する）。
