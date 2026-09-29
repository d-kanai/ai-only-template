# 画面側は feature 単位・screen 単位で同居させ、API 側は feature 単位の DDD 4 層にし、app/ はルーティングだけにする

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #39 / PR #42 / `.claude/rules/frontend.md` / `.claude/rules/backend.md`

## 背景
create-next-app の `app/page.tsx` だけの状態から、以後の機能追加が倣える構成を決める必要があった。Next.js はプロジェクトの構成について unopinionated で、置き方は自分で決める（Next.js 16.3.6 同梱 `node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md` の「Organizing your project」）。

## 決定
- `app/` はルーティングだけ。`page.tsx` は screen を返し、`app/api/**/route.ts` は API 側の handler を re-export する。
- 画面側は `features/<feature>/`。screen ごとに見た目（`<name>-screen.tsx`）とロジック（`<name>-screen.hook.ts`）を同じディレクトリに置く。SSR を前提にせず、データは hook から `features/<feature>/api/` 経由で `/api/...` を呼ぶ。
- API 側は feature 単位の DDD 4 層（presentation / application / domain / infra）。presentation は 1 API = 1 ファイルで、リクエスト / レスポンスの型もその中に書く。application は query（読むだけ）と command（状態を変える）に分ける。
- 画面側と API 側の契約は、画面側の `api/` が API 側の型を `import type` することで担保する。URL・メソッドの担保は入れない。
- `src/` は使わない。

## 理由
- 同梱ドキュメントの「Store project files outside of app」の構成を feature 単位にしたもの。1 つの機能のコードが 1 か所にまとまり、URL とコードの置き場所が結びつかない。
- Route Handler は `app/` の中でだけ使える（同梱 `01-app/01-getting-started/15-route-handlers.md`）ので、API の実装は外に置いて re-export する。
- ユーザーの判断（feature ベース、SSR なし、screen 単位の同居、API も Next で完結、query / command、1 API 1 ファイルで型は中で定義、`src/` なし、URL の担保は要らない）。経緯は 2026-09-28 の work-logs（「Next.js のディレクトリ構成を feature ベース + screen コロケーション + サーバ側 DDD 4 層に決定」「ディレクトリ構成のプランをユーザー指示で改訂」「API の URL・メソッドの担保は入れない」）。

## 採用しなかった案
- `app/` の中に `_components` などの private folder を置き、ルート単位で分ける（同梱ドキュメントの「Split project files by feature or route」）: URL とコードの置き場所が結びつき、ルートを動かすとコードも動かすことになる。
- `components/` `hooks/` `lib/` を最上位に並べる層別の構成: 1 つの機能のコードが層をまたいで散る。
- `src/` の下に置く: ユーザーの判断で不要。
- `features/<feature>/` の中に `client/` と `server/` を並べる: 同じディレクトリに `"use client"` とサーバ専用のコードが混ざり、画面からサーバの実装を import する誤りが起きやすい。
- 最初の案（API 側を `server/`、presentation に feature 共通の `dto.ts` と複数の API をまとめたコントローラ、application を `.use-case.ts` の 1 種類）: ユーザーの判断で `backend/`、1 API = 1 ファイル、query / command に変えた。
- URL・メソッドを担保する（各 api ファイルから path の定数を export する案、route.ts の場所を検証する契約テストの案）: ユーザーの判断で入れない。Next の `typedRoutes` は `fetch` の URL には効かない（同梱 `03-api-reference/05-config/02-typescript.md`）。

## 影響
- 良い点: 機能を足すときの置き場所が決まっていて、依存の向きを機械で検査できる（20260928-dependency-direction-checked-by-own-test.md）。
- 悪い点: SSR を使わないので、初回の表示はクライアントでのデータ取得を待つ。URL の打ち間違いは型では止まらない（E2E で確かめる）。
- 同時に決めた「永続化は当面 InMemory」「入力検証は手書き」は、後の決定で変わった（20260928-drizzle-with-generated-sql-migrations.md、20260929-zod-for-backend-validation.md）。ディレクトリの位置は 20260928-monorepo-apps-frontend-backend.md で `apps/` の下に移した。
- 見直す条件: 記録に無い。
