# E2E は apps/e2e の workspace パッケージ @repo/e2e にする

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #84 / PR #87 / `.claude/rules/testing.md` / `apps/e2e/package.json`

## 背景
E2E（Playwright）はリポジトリ直下の `e2e/` と `playwright.config.ts` にあり、Playwright と `pg` の依存はリポジトリ直下の `package.json` にあった。ユーザーの指示は「`e2e/` を `apps/` の下に移す」。

## 決定
- `apps/e2e/` を workspace パッケージ `@repo/e2e` にし、`@playwright/test`・`pg`・`@types/pg` はそのパッケージの `package.json` に置く。
- `pnpm test:e2e` は `pnpm --filter @repo/e2e test` を呼ぶ。

## 理由
- frontend / backend と同じ形（依存は使うパッケージの `package.json`）にし、E2E だけが使う依存をリポジトリ直下から外す（ユーザーの選択。2026-09-29 の work-logs「auto-merge を使う運用に切り替え（PR #83）、e2e/ の移動は apps/e2e の workspace パッケージに決めた（Issue #84）」）。
- `.env` はリポジトリ直下の 1 つを `env.ts` が上にたどって読むので、カレントディレクトリが `apps/e2e` でも同じ値になる（2026-09-29 の work-logs「Issue #84: e2e/ を apps/e2e（@repo/e2e）に移した」）。

## 採用しなかった案
- 検討した案は記録に無い。

## 影響
- 良い点: 依存の置き場所の規則が apps でそろう。
- 悪い点: Playwright の `webServer.command` はカレントディレクトリが `apps/e2e` になるので、`pnpm -w` でリポジトリ直下の script を呼ぶ必要がある。
- 見直す条件: 記録に無い。
