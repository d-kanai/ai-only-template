---
paths:
  - "apps/frontend/**"
---

# frontend（画面側。apps/frontend）

`apps/frontend/` は workspace パッケージ `@repo/frontend`（Next.js の App Router）。Next は `apps/frontend` をカレントディレクトリにして動く（リポジトリ直下の `pnpm dev/build/start` が `pnpm --filter @repo/frontend <script>` を呼ぶ）。
依存の向きの規則は `rule-tests/architecture.test.ts` が検査する（一覧は `.claude/rules/architecture-check.md`）。API 側は `.claude/rules/backend.md`。決定と採用しなかった案は ADR `docs/adr/architecture/20260928-feature-based-directory-and-ddd-backend.md`。

## 置き場所
- ソースは `app/`・`features/`・`shared/` の下か、直下の `next.config.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`proxy.ts`・`next-env.d.ts` だけ（規則 `frontend-placement`）。`src/` は使わない。
  - WHY: 依存の規則はこれらの場所にしかかからず、`apps/frontend/lib/db.ts` のような場所から backend の container を import しても素通りしていた（Issue #68 の reviewer 指摘）。
- `apps/frontend/shared/<name>/`: feature をまたぐ部品。今あるのは `request-log/`（リクエストログの 1 行を組み立てる純粋関数）と `i18n/`（辞書・ロケール・日時の表示。下の「i18n」）。`components/` `hooks/` は使うものが出るまで作らない。`shared/` は `features/`・`app/`・backend・`apps/shared` を参照しない（規則 `shared-to-features`・`screen-to-app`・`screen-to-backend`・`screen-to-shared`）。`apps/frontend/shared/`（画面側の部品）と `apps/shared/`（frontend と backend で共通のサーバ側の基盤。`.claude/rules/shared.md`）は別のもの。

## app/（ルーティングだけ）
- 置くもの: Next の規約ファイル（`page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx` など）と `app/api/**/route.ts` だけ。テストは置かない（仕様は screen と api ファイルのテストで固定し、ルーティングにロジックを置かせない）。
- `page.tsx` は screen を返すだけ（`return <TodoScreen />`。動的セグメントは `await params` で取り出して props で渡す）。
- `app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ（`export { GET } from "@repo/backend/features/todo/presentation/list-todos.api";`）。同じ URL の複数メソッドはそれぞれ別の api ファイルから re-export する。入力検証やレスポンスの組み立ては書かない。
- `instrumentation.ts` は Next の規約で `apps/frontend/` 直下に置く（起動時の環境変数の検証。`.claude/rules/env.md`）。直下のファイルは backend を参照しない（規則 `frontend-root-to-backend`）。起動時の検証の `env` とログの `logger` は、frontend と backend で共通の `apps/shared` から `@repo/shared/env`・`@repo/shared/logger` で使う（Issue #90。以前は backend の中にあり、この規則の例外だった）。
- `proxy.ts`（Next の Proxy。旧 `middleware.ts` は使わない）も規約で直下に置く。画面アクセスと `/api/**` の呼び出しを 1 リクエスト 1 行の JSON で stdout に出すだけにし、1 行の中身は `shared/request-log/` の `buildRequestLog`（テストで固定）で組み立て、`logger.info` で出す。認可・リダイレクトなどのロジックは置かない。決定は ADR `docs/adr/architecture/20260929-request-log-in-proxy.md`、ブラウザのリクエスト一覧の実測は 2026-09-29 の work-logs「docs/ から移した記録」。限界: status と所要時間は取れない（Proxy は応答の前に動く）、プリフェッチは matcher で除く、ブラウザの戻る・進むで Next のルーターのキャッシュが使われると画面の行は出ない（出るのは画面が呼ぶ API の行だけ）、`client.ip` は `x-forwarded-for` を信じる値でクライアントが偽装できるので、信頼できるリバースプロキシがヘッダを付け直す前提で使う。
- WHY ルーティングを分ける: URL を変えてもコードを動かさずに済む（Next は構成について unopinionated で、`app/` の外にコードを置くのは公式の例の 1 つ）。

## features/<feature>/
- `screens/<name>-screen/`: 1 画面 = 1 ディレクトリ。`<name>-screen.tsx`（見た目。先頭に `"use client"`。hook の戻り値を描くだけ）と `<name>-screen.hook.ts`（状態・イベント・データ取得。`use<Name>Screen`）と、それぞれのテストを隣に置く。
  - WHY: ロジックは `renderHook` で、見た目は操作ベースで小さくテストでき、画面を消すときはディレクトリごと消せる。
- `components/`: feature 内で画面をまたぐ部品。`hooks/`: 画面をまたぐ hook。
- `api/`: `/api/...` を fetch する薄いラッパー。feature の中で backend を参照してよいのはここだけ。
- `index.ts`: 公開 API。feature の外（`app/`・他の feature）から import してよいのはここだけ（内部の構成を変えても外の import を直さずに済む）。feature 同士は原則 import せず、必要なら相手の `index.ts` だけ。

## 画面側とサーバ側の境界
- `features/<f>/api/` から backend への参照は `import type` / `export type` だけで、参照先は自 feature の `apps/backend/features/<f>/presentation/<name>.api.ts` と `apps/backend/shared/presentation/`（`ErrorResponse`）。api ファイルの関数や application・domain・infra の実装は import しない。
  - WHY: 画面とサーバで同じ契約（型）を使い、ずれを型チェックで検出する。`import type` はビルドで消えるので、サーバのコードがバンドルに入らない。
- screens / components / hooks は backend を直接参照せず、`api/` が re-export した型を使う（`import type { TodoDto } from "@/features/todo/api/todo-api"`）。WHY: 契約が変わったときの影響を `api/` の 1 ファイルで追える。
- 型で担保されること: リクエスト / レスポンスの形（`pnpm build` / `pnpm typecheck` で不一致を検出）。
- 型で担保されないこと: URL と HTTP メソッド（画面側に文字列で書く）、実行時の JSON の形（`response.json()` を型に当てはめるだけ）。URL を型で担保したくなったら、api ファイルから path の定数を export する案を検討する（今は入れない）。

## ログ
- サーバ側（直下の `proxy.ts`・`instrumentation-node.ts`）のログは `@repo/shared/logger` を通す。`console.*` は書かない（Biome の `noConsole` と規則 `console-direct-access`。`.claude/rules/backend.md` の「ログ」）。
- `features/`・`app/`・`shared/` のクライアントコード（ブラウザ）は logger も console も使わない（画面にはログを出さない）。logger・env はサーバ専用で、`app/`・`features/`・`shared/` から `apps/shared` は参照しない（規則 `screen-to-shared`。env・logger をブラウザのバンドルに持ち込まない）。
  - WHY: ブラウザの console に出したものはサーバのログに残らず、利用者の開発者ツールにだけ見える。エラーは画面の表示（エラー状態）で扱う。

## SSR を前提にしない
- 画面にサーバロジックを書かない。Server Components でのデータ取得や Server Functions（Server Actions）は使わず、データは hook → `api/` → `/api/...`（Route Handler）で取る。
  - WHY: データ取得の経路を 1 本にし、サーバの処理を `apps/backend/` の 4 層に集める。画面と API の境界が HTTP になり、それぞれ単独でテストできる。
- ビルド時の Client Components の prerender は止めない。`output: "export"` と `next/dynamic` の `ssr: false` は、ブラウザ専用 API で困るまで使わない。
  - 例外: i18n のため root layout が `headers()` を読むので、今は全ルートが動的レンダリングで、ビルド時の prerender は無い（下の「i18n」の限界）。ここで止めないのは `output: "export"` / `ssr: false` のような静的化・SSR の無効化のこと。
  - WHY: `output: "export"` では Route Handler が GET だけのビルド時の静的なレスポンスになる。ブラウザ専用 API は `useEffect` の中で触れば prerender と両立する。

## import の書き方
- frontend の中は `@/<path>`（tsconfig の paths `@/*` → `apps/frontend/*`）。
- backend へは `@repo/backend/<path>` だけ（workspace パッケージと `apps/backend/package.json` の `exports` で解決）。相対パス（`../backend/...`）と `@/../backend/...` は使わない（規則 `frontend-to-backend-specifier`）。
- `apps/shared` へは `@repo/shared/<name>` だけ（直下のファイルから。`apps/shared/package.json` の `exports`）。相対パス（`../shared/...`）と `@/../shared/...` は使わない（規則 `frontend-to-shared-specifier`）。
  - WHY: 相対パスは `exports`（公開する入口）を通らずに backend のどのファイルでも指せ、後で別プロセスに分けたときにも壊れる。
- exports に無いファイルを import すると `tsc` / `next build` が「Cannot find module」で止まる。足し方は `.claude/rules/backend.md` の「exports」。
- `apps/frontend/tsconfig.json`: Next 用（plugin・jsx・DOM の型、paths は `@/*` だけ）。`@repo/backend/...`・`@repo/shared/...` を paths に書かない（書くと exports を通らずにパッケージのどのファイルも指せてしまう）。

## i18n（Issue #116。決定と採用しなかった案は ADR `docs/adr/architecture/20260929-i18n-without-library.md`）
- 対応するロケールは `ja`（既定）と `en`（`shared/i18n/locale.ts` の `SUPPORTED_LOCALES`）。ライブラリは使わない。
- 辞書: `shared/i18n/messages/ja.ts`（`as const`。キーの一覧と placeholder の正）と `en.ts`（`satisfies Dictionary` でキーの過不足をコンパイルエラーにする）。平坦なオブジェクトで、キーは dot 区切りの 1 つの文字列。
  - 画面に出す文言（JSX のテキスト、`aria-label` などの利用者向けの属性、エラーの文言）は辞書にだけ書き、画面・hook・components は `t(...)` を通す。検査は `rule-tests/architecture.test.ts` の規則 `frontend-hardcoded-text`（例外は `shared/i18n/messages/` 直下の `*.ts` だけ）。サーバのログ（`proxy.ts`・`instrumentation-node.ts`）は辞書の対象外で、英語で書く。
  - WHY: 文言が散らばると、言語を足すときに漏れ、言い回しの変更がコードの変更になる。
- キーの命名: サーバのエラーは backend の `ErrorKey` と同じ文字列（`<対象>.<項目>.<理由>`。例 `todo.title.tooLong`）、画面の文言は `<feature>.<画面・部品>.<要素>`（例 `todo.item.delete`）、画面側だけのエラーは `error.<理由>`（`error.unknown` = HTTP ステータスだけが分かる失敗、`error.unexpected` = API の応答ではない失敗）。
- params の型: `t(key, params)` の params は ja の文言の `{name}` から型で導く（`shared/i18n/messages.ts` の `MessageParams`）。placeholder が無いキーは params を渡せず、あるキーは必須で、名前の違いもコンパイルエラーになる。en の placeholder が ja と同じ集合であることは `messages.test.ts` が検査する（型で表せないため）。
  - 使い方: 画面では `const t = useT();`（`shared/i18n/use-t.ts`）。キーが実行時の値（サーバの `ErrorResponse`）のときだけ `formatMessage(locale, key, params)` を使う（`features/todo/api/api-error.ts` の `toErrorMessage`）。
- サーバのエラー: `features/<f>/api/` は失敗を `ApiError`（`key` と `params`）で投げ、hook は失敗の理由を持って描画のときに翻訳する（ロケールが変わっても、その言語で出る）。backend の `ErrorKey` がすべて辞書にあること・params の名前が placeholder と同じことは、`api-error.ts` の `ApiErrorKey` の型の制約と `api-error.test.ts` の型の検査で止める（`shared/` は backend を参照できないので、`api/` で突き合わせる）。
- ロケールの決め方: `proxy.ts` が Cookie `NEXT_LOCALE` → Accept-Language（q 値の高い順、言語の部分で照合）→ 既定の ja で決め（`negotiateLocale`）、リクエストヘッダ `x-locale` に載せる（`/api/**` には載せない）。`app/layout.tsx` が `headers()` で読み、`<html lang>` と `LocaleProvider` に渡す。URL のパスは変えない（`app/[lang]` にしない）。
  - 限界: `headers()` を読むので全画面が動的レンダリングになり、ビルド時の静的な prerender は無い。matcher が除く `next/link` のプリフェッチには `x-locale` が付かないが、root layout はクライアント遷移で描き直されないので表示は変わらない（E2E `apps/e2e/i18n.spec.ts`）。
- 日時の表示: `shared/i18n/format.ts` の `formatDateTime(iso, locale, timeZone)`（`Intl.DateTimeFormat`、`dateStyle: "medium"` / `timeStyle: "short"`）に、ブラウザのタイムゾーン（`Intl.DateTimeFormat().resolvedOptions().timeZone`）を渡す。サーバは UTC で動かす（リポジトリ直下の `package.json` の `dev` / `start` の `TZ=UTC`、`instrumentation-node.ts` が UTC でなければ起動を止める）。テストは `vitest.config.mts` の `test.env.TZ = "UTC"`、E2E はブラウザを `ja-JP` / `Asia/Tokyo` にする（`apps/e2e/playwright.config.ts`）。
  - WHY: DB は timestamptz（UTC）で API は ISO 8601。表示だけを利用者のタイムゾーンで行い、サーバの動作は環境のタイムゾーンに依存させない。ブラウザのタイムゾーンを描画で読んでよいのは、一覧が useEffect の取得後にブラウザでだけ描かれるため（hydration の不一致にならない）。
- テスト: 画面・components は `shared/i18n/i18n.test-support.tsx` の `JaLocale` を wrapper にして描き、期待する文言は `tJa(key, params)` と比べる（言い回しの変更でテストを直さずに済む。辞書の中身は `messages.test.ts` で固定）。en で描いて英語になることも画面ごとに 1 件見る。

## 命名
- ディレクトリ・ファイルは kebab-case（`todo-screen/`）。コンポーネントと型は PascalCase（`TodoScreen`）。hook は `use` 始まり（`useTodoScreen`）。役割の接尾辞は `.` の後ろ（`.hook.ts`・`.test.tsx`）。

## テスト
- hook は `renderHook`、screen は render して操作し表示を検証する（どちらも jsdom。`vitest.config.mts` の既定）。`api/` は `vi.mock` で差し替える（`.claude/rules/testing.md`）。
