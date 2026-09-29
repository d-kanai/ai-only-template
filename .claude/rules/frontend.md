---
paths:
  - "apps/frontend/**"
---

# frontend（画面側。apps/frontend）

`apps/frontend/` は workspace パッケージ `@repo/frontend`（Next.js の App Router）。Next は `apps/frontend` をカレントディレクトリにして動く（リポジトリ直下の `pnpm dev/build/start` が `pnpm --filter @repo/frontend <script>` を呼ぶ）。
依存の向きの規則は `architecture.test.ts` が検査する（一覧は `.claude/rules/architecture-check.md`）。API 側は `.claude/rules/backend.md`。経緯・採用しなかった案・一次情報は `docs/architecture-decisions.md`。

## 置き場所
- ソースは `app/`・`features/`・`shared/` の下か、直下の `next.config.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`proxy.ts`・`next-env.d.ts` だけ（規則 `frontend-placement`）。`src/` は使わない。
  - WHY: 依存の規則はこれらの場所にしかかからず、`apps/frontend/lib/db.ts` のような場所から backend の container を import しても素通りしていた（Issue #68 の reviewer 指摘）。
- `apps/frontend/shared/<name>/`: feature をまたぐ部品。今あるのは `request-log/`（リクエストログの 1 行を組み立てる純粋関数）だけ。`components/` `hooks/` は使うものが出るまで作らない。`shared/` は `features/`・`app/`・backend を参照しない（規則 `shared-to-features`・`screen-to-app`・`screen-to-backend`）。

## app/（ルーティングだけ）
- 置くもの: Next の規約ファイル（`page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx` など）と `app/api/**/route.ts` だけ。テストは置かない（仕様は screen と api ファイルのテストで固定し、ルーティングにロジックを置かせない）。
- `page.tsx` は screen を返すだけ（`return <TodoScreen />`。動的セグメントは `await params` で取り出して props で渡す）。
- `app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ（`export { GET } from "@repo/backend/todo/presentation/list-todos.api";`）。同じ URL の複数メソッドはそれぞれ別の api ファイルから re-export する。入力検証やレスポンスの組み立ては書かない。
- `instrumentation.ts` は Next の規約で `apps/frontend/` 直下に置く（起動時の環境変数の検証。`.claude/rules/env.md`）。直下のファイルが backend を参照してよいのは `instrumentation-node.ts` → `@repo/backend/shared/infra/env` だけ（規則 `frontend-root-to-backend`）。
- `proxy.ts`（Next の Proxy。旧 `middleware.ts` は使わない）も規約で直下に置く。画面アクセスと `/api/**` の呼び出しを 1 リクエスト 1 行の JSON で stdout に出すだけにし、1 行の中身は `shared/request-log/` の `buildRequestLog`（テストで固定）で組み立てる。認可・リダイレクトなどのロジックは置かない。仕様・実測・限界（status と所要時間は取れない、プリフェッチは matcher で除く）は `docs/request-log.md`。
- WHY ルーティングを分ける: URL を変えてもコードを動かさずに済む（Next は構成について unopinionated で、`app/` の外にコードを置くのは公式の例の 1 つ）。

## features/<feature>/
- `screens/<name>-screen/`: 1 画面 = 1 ディレクトリ。`<name>-screen.tsx`（見た目。先頭に `"use client"`。hook の戻り値を描くだけ）と `<name>-screen.hook.ts`（状態・イベント・データ取得。`use<Name>Screen`）と、それぞれのテストを隣に置く。
  - WHY: ロジックは `renderHook` で、見た目は操作ベースで小さくテストでき、画面を消すときはディレクトリごと消せる。
- `components/`: feature 内で画面をまたぐ部品。`hooks/`: 画面をまたぐ hook。
- `api/`: `/api/...` を fetch する薄いラッパー。feature の中で backend を参照してよいのはここだけ。
- `index.ts`: 公開 API。feature の外（`app/`・他の feature）から import してよいのはここだけ（内部の構成を変えても外の import を直さずに済む）。feature 同士は原則 import せず、必要なら相手の `index.ts` だけ。

## 画面側とサーバ側の境界
- `features/<f>/api/` から backend への参照は `import type` / `export type` だけで、参照先は自 feature の `apps/backend/<f>/presentation/<name>.api.ts` と `apps/backend/shared/presentation/`（`ErrorResponse`）。api ファイルの関数や application・domain・infra の実装は import しない。
  - WHY: 画面とサーバで同じ契約（型）を使い、ずれを型チェックで検出する。`import type` はビルドで消えるので、サーバのコードがバンドルに入らない。
- screens / components / hooks は backend を直接参照せず、`api/` が re-export した型を使う（`import type { TodoDto } from "@/features/todo/api/todo-api"`）。WHY: 契約が変わったときの影響を `api/` の 1 ファイルで追える。
- 型で担保されること: リクエスト / レスポンスの形（`pnpm build` / `pnpm typecheck` で不一致を検出）。
- 型で担保されないこと: URL と HTTP メソッド（画面側に文字列で書く）、実行時の JSON の形（`response.json()` を型に当てはめるだけ）。URL を型で担保したくなったら、api ファイルから path の定数を export する案を検討する（今は入れない）。

## SSR を前提にしない
- 画面にサーバロジックを書かない。Server Components でのデータ取得や Server Functions（Server Actions）は使わず、データは hook → `api/` → `/api/...`（Route Handler）で取る。
  - WHY: データ取得の経路を 1 本にし、サーバの処理を `apps/backend/` の 4 層に集める。画面と API の境界が HTTP になり、それぞれ単独でテストできる。
- ビルド時の Client Components の prerender は止めない。`output: "export"` と `next/dynamic` の `ssr: false` は、ブラウザ専用 API で困るまで使わない。
  - WHY: `output: "export"` では Route Handler が GET だけのビルド時の静的なレスポンスになる。ブラウザ専用 API は `useEffect` の中で触れば prerender と両立する。

## import の書き方
- frontend の中は `@/<path>`（tsconfig の paths `@/*` → `apps/frontend/*`）。
- backend へは `@repo/backend/<path>` だけ（workspace パッケージと `apps/backend/package.json` の `exports` で解決）。相対パス（`../backend/...`）と `@/../backend/...` は使わない（規則 `frontend-to-backend-specifier`）。
  - WHY: 相対パスは `exports`（公開する入口）を通らずに backend のどのファイルでも指せ、後で別プロセスに分けたときにも壊れる。
- exports に無いファイルを import すると `tsc` / `next build` が「Cannot find module」で止まる。足し方は `.claude/rules/backend.md` の「exports」。
- `apps/frontend/tsconfig.json`: Next 用（plugin・jsx・DOM の型、paths は `@/*` だけ）。`@repo/backend/...` を paths に書かない（書くと exports を通らずに backend のどのファイルも指せてしまう）。

## 命名
- ディレクトリ・ファイルは kebab-case（`todo-screen/`）。コンポーネントと型は PascalCase（`TodoScreen`）。hook は `use` 始まり（`useTodoScreen`）。役割の接尾辞は `.` の後ろ（`.hook.ts`・`.test.tsx`）。

## テスト
- hook は `renderHook`、screen は render して操作し表示を検証する（どちらも jsdom。`vitest.config.mts` の既定）。`api/` は `vi.mock` で差し替える（`.claude/rules/testing.md`）。
