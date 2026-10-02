---
paths:
  - "apps/frontend_customer/**"
---

# frontend（画面側。apps/frontend_customer）

`apps/frontend_customer/` は workspace パッケージ `@repo/frontend-customer`（Next.js の App Router）。Next は `apps/frontend_customer` をカレントディレクトリにして動く（リポジトリ直下の `pnpm dev/build/start` が `pnpm --filter @repo/frontend-customer <script>` を呼ぶ）。
依存の向きの規則は `rule-tests/architecture.test.ts` が検査する（一覧は `.claude/rules/architecture-check.md`）。API 側は `.claude/rules/backend.md`。決定と採用しなかった案は ADR `docs/adr/architecture/20260928-feature-based-directory-and-ddd-backend.md`。

## 置き場所
- ソースは `app/`・`features/`・`shared/`・`test-support/` の下か、直下の `next.config.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`proxy.ts`・`next-env.d.ts` だけ（規則 `frontend-placement`）。`src/` は使わない。
  - WHY: 依存の規則はこれらの場所にしかかからず、`apps/frontend_customer/lib/db.ts` のような場所から backend の container を import しても素通りしていた（Issue #68 の reviewer 指摘）。
- `apps/frontend_customer/test-support/`（Issue #181）: テストだけが使うコード（`i18n.tsx` の `JaLocale`・`tJa`）。本番のコード（`app/`・`features/`・`shared/`・直下のファイル）から参照しない（`@/test-support/...` はテストからだけ）・Docker のイメージに入らない（`.dockerignore` の `**/test-support`）。検査は `rule-tests/test-support.test.ts` と `.github/workflows/deploy.yml`。WHY は `.claude/rules/backend.md` の `apps/backend/test-support/` と同じ。
- `apps/frontend_customer/shared/<name>/`: feature をまたぐ部品。今あるのは `request-log/`（リクエストログの 1 行を組み立てる純粋な処理。`RequestLogBuilder.build`）と `i18n/`（翻訳の仕組み・共通の辞書・ロケール・日時の表示。下の「i18n」）。`components/` `hooks/` は使うものが出るまで作らない。`shared/` は `features/`・`app/`・backend・`apps/shared` を参照しない（規則 `shared-to-features`・`screen-to-app`・`screen-to-backend`・`screen-to-shared`）。`apps/frontend_customer/shared/`（画面側の部品）と `apps/shared/`（frontend と backend で共通のサーバ側の基盤。`.claude/rules/shared.md`）は別のもの。

## app/（ルーティングだけ）
- 置くもの: Next の規約ファイル（`page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx` など）と `app/api/**/route.ts` だけ。テストは置かない（仕様は screen と api ファイルのテストで固定し、ルーティングにロジックを置かせない）。
- `page.tsx` は screen を返すだけ（`return <TodoScreen />`。動的セグメントは `await params` で取り出して props で渡す）。
- `app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ（`export { GET } from "@repo/backend/features/todo/internal/presentation/list-todos.api";`）。同じ URL の複数メソッドはそれぞれ別の api ファイルから re-export する。入力検証やレスポンスの組み立ては書かない。
- `instrumentation.ts` は Next の規約で `apps/frontend_customer/` 直下に置く（起動時の環境変数の検証。`.claude/rules/env.md`）。直下のファイルは backend を参照しない（規則 `frontend-root-to-backend`）。起動時の検証の `env` とログの `logger` は、frontend と backend で共通の `apps/shared` から `@repo/shared/env`・`@repo/shared/logger` で使う（Issue #90。以前は backend の中にあり、この規則の例外だった）。
- `proxy.ts`（Next の Proxy。旧 `middleware.ts` は使わない）も規約で直下に置く。画面アクセスと `/api/**` の呼び出しを 1 リクエスト 1 行の JSON で stdout に出すだけにし、1 行の中身は `shared/request-log/` の `RequestLogBuilder.build`（テストで固定）で組み立て、`logger.emit` で出す。行の形は Cloud Logging の特別フィールドと OTel semconv の HTTP の名前（入れ子）で、`event.name` は `page_request`（画面）/ `api_request`（`/api/**`）、`message` は `<METHOD> <path>`、`traceparent`（W3C）があれば `logging.googleapis.com/trace`（`projects/<GCP_PROJECT_ID>/traces/<trace-id>`）・`spanId`・`trace_sampled` を出す（形が違えば出さない）。`GCP_PROJECT_ID` は `proxy.ts` が `@repo/shared/env` から読んで渡す（`shared/request-log/` は `apps/shared` を参照できない。規則 `screen-to-shared`）。`event.name` が一覧（`apps/shared/log-event.ts`）にあることと種類ごとの必須項目は、`proxy.ts` の `logger.emit(log)` の型チェックが見る。キーの一覧は ADR `docs/adr/architecture/20260930-log-format-cloud-logging-otel.md`（Issue #209）。クエリは `url.query` にキーと値の組で出し、値は logger が `***` にする（キーは自由文としてメールなどだけを `***`）。`referer`（URL のクエリを含みうる）と `client.address`（接続元の IP。GDPR では個人データ）も `***` になる。`RequestLogBuilder.build` と `proxy.ts` は生の値を渡すだけで、伏せる処理を書かない（マスクは logger の中だけ。Issue #216。`.claude/rules/backend.md` の「個人情報のマスク」、ADR `docs/adr/architecture/20260930-log-masking-in-logger.md`）。受信時刻は `@repo/shared/now` の `Clock.now()` で取る（現在時刻の唯一の出口。`new Date()` は書かない。規則 `now-single-source`、`.claude/rules/shared.md` の「now」）。認可・リダイレクトなどのロジックは置かない。決定は ADR `docs/adr/architecture/20260929-request-log-in-proxy.md`、ブラウザのリクエスト一覧の実測は 2026-09-29 の work-logs「docs/ から移した記録」。限界: status と所要時間は取れない（Proxy は応答の前に動く）、プリフェッチは matcher で除く、ブラウザの戻る・進むで Next のルーターのキャッシュが使われると画面の行は出ない（出るのは画面が呼ぶ API の行だけ）、`client.address` は `x-forwarded-for` を信じる値でクライアントが偽装できるので、信頼できるリバースプロキシがヘッダを付け直す前提で使う。
- WHY ルーティングを分ける: URL を変えてもコードを動かさずに済む（Next は構成について unopinionated で、`app/` の外にコードを置くのは公式の例の 1 つ）。

## features/<feature>/
- `screens/<name>-screen/`: 1 画面 = 1 ディレクトリ。`<name>-screen.tsx`（見た目。先頭に `"use client"`。hook の戻り値を描くだけ）と `<name>-screen.hook.ts`（状態・イベント・データ取得。`use<Name>Screen`）と、それぞれのテストを隣に置く。
  - WHY: ロジックは `renderHook` で、見た目は操作ベースで小さくテストでき、画面を消すときはディレクトリごと消せる。
- `components/`: feature 内で画面をまたぐ部品。`hooks/`: 画面をまたぐ hook。
- `api/`: `/api/...` を fetch する薄いラッパー。feature の中で backend を参照してよいのはここだけ。
- `index.ts`: 公開 API。feature の外（`app/`・他の feature）から import してよいのはここだけ（内部の構成を変えても外の import を直さずに済む）。feature 同士は原則 import せず、必要なら相手の `index.ts` だけ。

## 画面側とサーバ側の境界
- `features/<f>/api/` から backend への参照は `import type` / `export type` だけで、参照先は自 feature の `apps/backend/features/<f>/internal/presentation/<name>.api.ts` と `apps/backend/shared/presentation/problem.ts`（`Problem`・`ErrorKey`・`ErrorKeyParams`）。api ファイルの関数や application・domain・infra の実装は import しない。
  - WHY: 画面とサーバで同じ契約（型）を使い、ずれを型チェックで検出する。`import type` はビルドで消えるので、サーバのコードがバンドルに入らない。
- screens / components / hooks は backend を直接参照せず、`api/` が re-export した型を使う（`import type { Todo } from "@/features/todo/api/todo-api"`。`Todo` は `api/todo-api.ts` が一覧 API の Response から導出する（`ListTodosResponse["todos"][number]`））。WHY: 契約が変わったときの影響を `api/` の 1 ファイルで追える。
- 型で担保されること: リクエスト / レスポンスの形（`pnpm build` / `pnpm typecheck` で不一致を検出）。
- 型で担保されないこと: URL と HTTP メソッド（画面側に文字列で書く）、実行時の JSON の形（`response.json()` を型に当てはめるだけ）。URL を型で担保したくなったら、api ファイルから path の定数を export する案を検討する（今は入れない）。

## ログ
- サーバ側（直下の `proxy.ts`・`instrumentation-node.ts`）のログは `@repo/shared/logger` を通す。`console.*` は書かない（Biome の `noConsole` と規則 `console-direct-access`。`.claude/rules/backend.md` の「ログ」）。
- `features/`・`app/`・`shared/` のクライアントコード（ブラウザ）は logger も console も使わない（画面にはログを出さない）。logger・env はサーバ専用で、`app/`・`features/`・`shared/` から `apps/shared` は参照しない（規則 `screen-to-shared`。env・logger をブラウザのバンドルに持ち込まない。now も今は画面が現在時刻を読まないので同じく参照しない）。
  - WHY: ブラウザの console に出したものはサーバのログに残らず、利用者の開発者ツールにだけ見える。エラーは画面の表示（エラー状態）で扱う。

## SSR を前提にしない
- 画面にサーバロジックを書かない。Server Components でのデータ取得や Server Functions（Server Actions）は使わず、データは hook → `api/` → `/api/...`（Route Handler）で取る。
  - WHY: データ取得の経路を 1 本にし、サーバの処理を `apps/backend/` の 4 層に集める。画面と API の境界が HTTP になり、それぞれ単独でテストできる。
- ビルド時の Client Components の prerender は止めない。`output: "export"` と `next/dynamic` の `ssr: false` は、ブラウザ専用 API で困るまで使わない。
  - 例外: i18n のため root layout が `headers()` を読むので、今は全ルートが動的レンダリングで、ビルド時の prerender は無い（下の「i18n」の限界）。ここで止めないのは `output: "export"` / `ssr: false` のような静的化・SSR の無効化のこと。
  - WHY: `output: "export"` では Route Handler が GET だけのビルド時の静的なレスポンスになる。ブラウザ専用 API は `useEffect` の中で触れば prerender と両立する。

## import の書き方
- frontend の中は `@/<path>`（tsconfig の paths `@/*` → `apps/frontend_customer/*`）。
- backend へは `@repo/backend/<path>` だけ（workspace パッケージと `apps/backend/package.json` の `exports` で解決）。相対パス（`../backend/...`）と `@/../backend/...` は使わない（規則 `frontend-to-backend-specifier`）。
- `apps/shared` へは `@repo/shared/<name>` だけ（直下のファイルから。`apps/shared/package.json` の `exports`）。相対パス（`../shared/...`）と `@/../shared/...` は使わない（規則 `frontend-to-shared-specifier`）。
  - WHY: 相対パスは `exports`（公開する入口）を通らずに backend のどのファイルでも指せ、後で別プロセスに分けたときにも壊れる。
- exports に無いファイルを import すると `tsc` / `next build` が「Cannot find module」で止まる。足し方は `.claude/rules/backend.md` の「exports」。
- `apps/frontend_customer/tsconfig.json`: Next 用（plugin・jsx・DOM の型、paths は `@/*` だけ）。`@repo/backend/...`・`@repo/shared/...` を paths に書かない（書くと exports を通らずにパッケージのどのファイルも指せてしまう）。

## i18n（Issue #116・#125。決定と採用しなかった案は ADR `docs/adr/architecture/20260929-i18n-without-library.md` と `docs/adr/architecture/20260929-messages-colocated-per-screen.md`）
- 対応するロケールは `ja`（既定）と `en`（`shared/i18n/locale.ts` の `SUPPORTED_LOCALES`）。ライブラリは使わない。
- ファイル構成: `shared/i18n/` は `i18n.tsx`（`defineMessages`・`useT`・`useLocale`・`LocaleProvider`・`formatMessage`・`isMessageKey`・型）、`locale.ts`（ロケールの判定。Proxy から React なしで使う）、`format.ts`（日時の表示）、`common.messages.ts`（共通の辞書）だけ（テスト用の `JaLocale`・`tJa` は `apps/frontend_customer/test-support/i18n.tsx`）。
- 辞書は画面・部品ごとに隣に置く（colocation）: `screens/<name>-screen/<name>-screen.messages.ts`、`components/<name>.messages.ts`。書き方は `export const todoScreenMessages = defineMessages({ ja: {...}, en: {...} })`。平坦なオブジェクトで、キーは dot 区切りの 1 つの文字列。
  - 共通の辞書 `shared/i18n/common.messages.ts` に置くのは、API から返る `ErrorKey` の文言と画面側だけのエラー `error.*` だけ（どの画面の操作でも同じキーで出るため）。画面・部品に固有の文言は置かない（`api-error.test.ts` が「共通の辞書のキー = `ErrorKey` + `error.unknown` + `error.unexpected`」を型で検査する）。
  - `*.messages.ts` を import してよいのは同じディレクトリのファイルだけ（`./todo-screen.messages`）。`common.messages.ts` だけは `apps/frontend_customer/` のどこからでも可（`@/shared/i18n/common.messages`）。検査は `rule-tests/architecture.test.ts` の規則 `messages-colocation`（テストは対象外で、画面のテストが部品の辞書で期待値を作るのは可）。辞書を re-export（`export ... from`）して中継しない（同じディレクトリでも違反）。複数の画面で同じ言い回しを使うときも、それぞれの辞書に書く。
  - WHY: 1 つの辞書では、画面を消す・言い回しを変えるときに、どのキーがどの画面のものかを辞書を読んで探すことになる。隣に置けば、画面のディレクトリだけで完結し、ディレクトリごと消せる（`screens/` の方針と同じ）。
  - 画面に出す文言（JSX のテキスト、`aria-label` などの利用者向けの属性、エラーの文言）は辞書にだけ書き、画面・hook・components は `t(...)` を通す。検査は規則 `frontend-hardcoded-text`（例外は `apps/frontend_customer/` の `*.messages.ts` の `defineMessages(...)` の引数の中だけ。辞書のファイルでも引数の外に文言を書くと違反）。サーバのログ（`proxy.ts`・`instrumentation-node.ts`）は辞書の対象外で、英語で書く。
  - WHY: 文言が散らばると、言語を足すときに漏れ、言い回しの変更がコードの変更になる。
- キーの命名: 画面・部品の辞書のキーは、その画面の中で短く付ける（`title`・`form.submit`・`deleteAria`。画面の名前はファイルの場所で分かるので入れない）。共通の辞書のサーバのエラーは backend の `ErrorKey` と同じ文字列（`<対象>.<項目>.<理由>`。例 `todo.title.tooLong`）、画面側だけのエラーは `error.<理由>`（`error.unknown` = HTTP ステータスだけが分かる失敗、`error.unexpected` = API の応答ではない失敗）。
- 型（`defineMessages`）: `ja` がキーの一覧と placeholder の正（`const` の型引数で文字列リテラルの型になるので `as const` は書かない）。`en` のキーの欠け・余分、placeholder の名前の集合の違い（順番は問わない）、空白だけの文言（全角の空白・`\r` を含む）、文字列リテラルでない `string` 型の値はコンパイルエラーになる。
  - placeholder の名前は英数字と `_` だけ（`{max}`・`{max_1}`）。実行時の置換（`formatMessage` の `/\{(\w+)\}/`）と同じ規則を型でも強制し、`{a-b}`・`{}`・`{ max }` のような `{...}` を含む文言はコンパイルエラーになる（対にならない `{` や `}` は書ける）。
  - `t(key, params)` の params は ja の文言の `{name}` から型で導く（`i18n.tsx` の `MessageParams`）。placeholder が無いキーは params を渡せず、あるキーは必須で、名前の違いもコンパイルエラーになる。
  - 使い方: 画面・部品では `const t = useT(todoScreenMessages);`（その辞書のキーだけを受け付ける `t`。別の画面の辞書のキーはコンパイルエラー）。キーが実行時の値（サーバの Problem Details の `key`）のときだけ `formatMessage(commonMessages, locale, key, params)` を使う（`features/todo/api/api-error.ts` の `ApiErrorMessage.toMessage`）。
- サーバのエラー: backend は RFC 9457 の Problem Details（`application/problem+json`。`.claude/rules/backend.md`）を返す。`features/<f>/api/` は本文が Problem Details（`type` が文字列・`status` が数値・`key` が共通の辞書のキー・`params` は省略かオブジェクト。`todo-api.ts` の `TodoApi.isProblem`）なら `ApiError`（`status`（HTTP の応答のステータス）・`type`・`key`・`params`）を、そうでなければ `error.unknown`（`params.status`、`type` は無し）の `ApiError` を投げる。`detail` は開発者向けの英語で読まない・出さない。hook は失敗の理由を持って描画のときに翻訳する（ロケールが変わっても、その言語で出る）。backend の `ErrorKey` がすべて共通の辞書にあること・params の名前が placeholder と同じことは、`api-error.ts` の `ApiErrorKey` の型の制約と `api-error.test.ts` の型の検査で止める（`shared/` は backend を参照できないので、`api/` で突き合わせる）。
  - 項目ごとの誤り（Issue #144）: 400 の本文の `errors`（`{ pointer, key, params?, detail }[]`。`pointer` は RFC 6901 の JSON Pointer の fragment の形で、本文全体は `#`）を `ApiError` の `errors`（`pointer`・`key`・`params`。本文に無ければ `[]`、`detail` は持たない）に載せる。`isProblem` は `errors` が省略か配列で、各要素の `pointer` が文字列・`key` が共通の辞書のキー・`params` が省略か配列でないオブジェクトであることを確かめ、1 件でも崩れていれば本文全体を Problem Details とみなさない（`error.unknown`）。WHY: 崩れた要素だけを捨てると、捨てた誤りが出ないまま残りだけを直せばよいように見える。
  - 表示は `api-error.ts` の `ApiErrorMessage.toMessages(reason, locale, fields)` で、フォーム全体の文言（`form`）と入力の下の文言（`fields`）に分ける。`fields` はその画面が入力を描く項目の名前（本文の最上位のキー）で、`pointer` が `#/<項目名>` と完全一致する誤りをその項目に、それ以外（`#`・描いていない項目・入れ子の位置）を `form` に出す。項目・`form` とも最初の 1 件。`errors` が無い失敗（404・500・JSON でない応答・fetch の失敗）は今までどおり `form` だけ。
  - 項目の誤りも全体の文言も、入力を編集しても消えず、次の送信の成功・失敗で置き換わる（hook の `setFailure`。既存の全体のエラーと同じ扱い）。WHY: 編集で消すと「まだ直っていない」状態で文言が消え、送信するまで結果が分からない。項目の誤りだけのときは `role="alert"` が無いのでスクリーンリーダーは自動では読み上げない（入力にフォーカスしたときに説明として読まれる。変えるなら入力にフォーカスを移す）。方針の ADR は `docs/adr/architecture/20260930-presentation-overlaps-domain-validation.md`。
  - 項目の誤りがあるときは、本文の `key`（全体の文言）を重ねて出さない。WHY: 本文の `key` は `errors` の最初の 1 件と同じ（backend の `Problem`）で、両方出すと同じ文言が 2 回出る。
  - hook は `error`（`form`）と `fieldErrors`（`fields`）を返し、画面は項目の文言を入力を包む `label` の直後（外）に出して、入力の `aria-describedby`（`useId` の id）と `aria-invalid` で結び付ける。`role="alert"` はフォーム全体の文言だけに付ける。WHY `label` の外: `label` の中の文字はすべて入力の名前（accessible name）になる。
- ロケールの決め方: `proxy.ts` が Cookie `NEXT_LOCALE` → Accept-Language（q 値の高い順、言語の部分で照合）→ 既定の ja で決め（`Locales.negotiate`）、リクエストヘッダ `x-locale` に載せる（`/api/**` には載せない）。`app/layout.tsx` が `headers()` で読み、`<html lang>` と `LocaleProvider` に渡す。URL のパスは変えない（`app/[lang]` にしない）。
  - 限界: `headers()` を読むので全画面が動的レンダリングになり、ビルド時の静的な prerender は無い。matcher が除く `next/link` のプリフェッチには `x-locale` が付かないが、root layout はクライアント遷移で描き直されないので表示は変わらない（E2E `apps/e2e/spec/i18n.feature`）。
- 日時の表示: `shared/i18n/format.ts` の `DateTimeFormatter.format(iso, locale, timeZone)`（`Intl.DateTimeFormat`、`dateStyle: "medium"` / `timeStyle: "short"`）に、ブラウザのタイムゾーン（`Intl.DateTimeFormat().resolvedOptions().timeZone`）を渡す。サーバは UTC で動かす（リポジトリ直下の `package.json` の `dev` / `start` の `TZ=UTC`、`instrumentation-node.ts` が UTC でなければ起動を止める）。テストは `vitest.config.mts` の `test.env.TZ = "UTC"`、E2E はブラウザを `ja-JP` / `Asia/Tokyo` にする（`apps/e2e/playwright.config.ts`）。
  - WHY: DB は timestamptz（UTC）で API は ISO 8601。表示だけを利用者のタイムゾーンで行い、サーバの動作は環境のタイムゾーンに依存させない。ブラウザのタイムゾーンを描画で読んでよいのは、一覧が useEffect の取得後にブラウザでだけ描かれるため（hydration の不一致にならない）。
- テスト: 画面・components は `test-support/i18n.tsx`（`@/test-support/i18n`）の `JaLocale` を wrapper にして描き、期待する文言は `tJa(todoScreenMessages, key, params)`（対応する辞書で翻訳した結果）と比べる（言い回しの変更でテストを直さずに済む）。en で描いて英語になることも画面ごとに 1 件見る（辞書の en の中身はここで見る）。仕組み（`defineMessages`・`useT` など）は `shared/i18n/i18n.test.tsx` がテスト用の辞書で固定する。

## クラスと関数（規則 `class-based`。ADR `docs/adr/architecture/20261002-class-based-frontend-modules.md`）
- `features/`・`shared/`・`test-support/` の React 以外のモジュール（`.ts` など。`*.tsx`・`*.jsx`・`*.hook.*` 以外）は、ファイルの最上位に関数を置かず、クラスのメソッド（状態が無ければ static だけのクラス。インスタンスで使うクラスには自分を返すファクトリ以外の static を置かない。規則 `no-static-in-instance-class`、Issue #300）にする。今あるもの: `TodoApi`（`list`・`get`・`create`・`rename`・`changeCompletion`・`delete`）・`ApiErrorMessage`（`toMessage`・`toMessages`）・`Locales`（`is`・`negotiate`・`fromHeader`）・`DateTimeFormatter`（`format`）・`RequestLogBuilder`（`build`）。定数（`SUPPORTED_LOCALES`・`LOCALE_HEADER` など）と型はクラスの外の値のまま。検査は `rule-tests/architecture.test.ts` の `class-based`、static だけのクラスの許可は `biome.json` の override（`.claude/rules/lint.md`）。
  - WHY: daiki の判断（2026-10-02「クラス必須でルールにして」）。backend・apps/shared と同じ形にそろえ、画面のテストの差し替えも `vi.mocked(TodoApi.list)` の形になる（`vi.mocked(Clock.now)` と同じ）。
- 対象外（関数のまま）: React の component（`*.tsx`・`*.jsx`。JSX を含むファイルの補助 `i18n.tsx` の `defineMessages`・`formatMessage` なども、ファイルごと外す）、hook（`*.hook.*`）、`app/` の下（Next の規約）、直下のファイル（`proxy.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`next.config.ts`）。WHY: React と Next が関数の形を求める（クラスの component は非推奨、hook は Rules of Hooks、`proxy`・`register`・`page` の default export は規約）。`instrumentation-node.ts` は Vitest のカバレッジの対象外で、形を変えても単体テストで確かめられない。

## 命名
- ディレクトリ・ファイルは kebab-case（`todo-screen/`）。コンポーネントと型は PascalCase（`TodoScreen`）。hook は `use` 始まり（`useTodoScreen`）。役割の接尾辞は `.` の後ろ（`.hook.ts`・`.test.tsx`）。

## テスト
- hook は `renderHook`、screen は render して操作し表示を検証する（どちらも jsdom。`vitest.config.mts` の既定）。`api/` は `vi.mock` で差し替える（`.claude/rules/testing.md`）。
