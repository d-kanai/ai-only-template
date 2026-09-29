# ディレクトリを pnpm workspace の apps/frontend（Next）と apps/backend（@repo/backend）に分け、プロセスは Next 1 つのままにする

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #68 / PR #73 / PR #74 / `.claude/rules/frontend.md` / `.claude/rules/backend.md` / `.claude/rules/architecture-check.md`

## 背景
リポジトリ直下の `app/` `features/` `backend/`（architecture/20260928-feature-based-directory-and-ddd-backend.md）を、後で API を別プロセスに分けやすい形にしたかった（ユーザーの要望）。最初の調査では、Hono の別サーバと Next の rewrites、契約用の `packages/contracts` による 2 サーバ構成を計画した。

## 決定
- pnpm workspace（`packages: ["apps/*"]`）にし、`apps/frontend`（`@repo/frontend`、Next.js）と `apps/backend`（`@repo/backend`、Next・React に依存しない TS）に分ける。プロセスは Next 1 つのまま（別のサーバは入れない）。
- frontend から backend への依存は 2 か所だけ: `app/api/**/route.ts` が presentation の `*.api` を re-export する（値）、`features/*/api` が型を `import type` する。backend から frontend は参照しない。
- `apps/backend/package.json` の `exports` は、frontend が使う入口だけを明示する。backend の中の import は相対パスだけ。外からは `@repo/backend/...` の書き方だけ。
- 段階 1（ディレクトリの移動と書き換え。PR #73）と段階 2（workspace パッケージと `exports`。PR #74）に分けて入れる。

## 理由
- ユーザーの指示（「Hono とかいらない。Next の API route が直接 backend dir の presentation 層だけを import して呼ぶ。プロセスは増やさず、後で簡単に分離できるようにするだけ」）とユーザー判断（パッケージ名は `@repo/backend`、`exports` は明示、`.env` はルートに 1 つ）。2026-09-28 の work-logs「monorepo 化の方針をユーザーの指示で変更（Issue #68。Hono なし・プロセス 1 つ）」「monorepo 化（Issue #68）のユーザー判断: .env はルート 1 つ、パッケージ名は @repo/backend、exports は明示」。
- workspace パッケージなら、Next 16.3.6（Turbopack）は `transpilePackages` なしで TS のソースを読める（researcher の実測。同日の work-logs。同梱ドキュメント `transpilePackages.md`）。
- backend の中で `@/` を使うと、Turbopack が frontend の tsconfig の paths を当ててビルドが失敗した（同日の work-logs）ので、backend の中は相対パスにした。
- `exports` を明示すると、公開していないファイルの import を `tsc` と `next build` が止める（2026-09-28 の work-logs「monorepo 化の段階 2…」）。

## 採用しなかった案
- API を別プロセスにする（Hono + `@hono/node-server`、Next の rewrites、`packages/contracts`、2 サーバ）: ユーザーの指示でプロセスを増やさない方針に変え、取り下げた（実測は 2026-09-28 の work-logs「monorepo（apps/frontend + apps/backend）への置き換えを調査し、計画を Issue #68 にした」）。
- `exports` を `"./*": "./*.ts"`（全ファイル公開）にする（researcher の推奨）: 公開の範囲をパッケージの設定で読めるよう、入口だけを明示する形にした（ユーザー判断）。
- 段階 2 でも tsconfig の paths に `@repo/backend/*` を残す: paths は exports より先に解決に使われ、公開していないファイルも型チェックを通る。
- frontend から backend を `@backend/*` のような独自の別名で参照する: パッケージ名の形なら、段階 1（paths）と段階 2（パッケージ）で同じ書き方のまま解決できる。
- Turborepo / Nx: 入れない（Issue #68 の前提）。

## 影響
- 良い点: 後で分けるときは、backend に起動口（`server.ts`）を足し、`app/api/**` を Next の rewrites に置き換えれば済む想定。
- 悪い点: `next build` は frontend から import された backend のファイルしか型チェックしないので、app ごとの `tsc -p`（`pnpm typecheck`）を CI に足した。backend を Node で直接動かすときの TS の扱いは未確認。
- 見直す条件: API を別プロセスに分けるとき。
