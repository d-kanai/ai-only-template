---
paths:
  - "apps/frontend_customer/**"
---

# frontend

## 概要

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| パッケージ | `apps/frontend_customer/` は workspace パッケージ `@repo/frontend-customer`（Next.js の App Router）。Next は `apps/frontend_customer` をカレントディレクトリにして動く（リポジトリ直下の `pnpm dev/build/start` が `pnpm --filter @repo/frontend-customer <script>` を呼ぶ）。frontend は画面側のアプリ | - | 説明 |
| 検査 | 依存の向きの規則は `rule-tests/architecture.test.ts` が検査する（一覧は `.claude/rules/code/architecture-check.md`）。API 側は `.claude/rules/code/backend.md` | 決定と採用しなかった案は ADR `docs/adr/architecture/20260928-feature-based-directory-and-ddd-backend.md` | 説明 |

## ディレクトリ構成

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 直下 | ソースは `app/`・`features/`・`shared/`・`test-support/` の下か、直下の `next.config.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`proxy.ts`・`next-env.d.ts` だけ（規則 `frontend-placement`）。`src/` は使わない | 依存の規則はこれらの場所にしかかからず、`apps/frontend_customer/lib/db.ts` のような場所から backend の container を import しても素通りしていた（Issue #68 の reviewer 指摘） | `rule-tests/architecture.test.ts` の `frontend-placement` |
| 直下 | `instrumentation.ts` は Next の規約で `apps/frontend_customer/` 直下に置く（起動時の環境変数の検証。`.claude/rules/tooling/env.md`） | - | 説明 |
| 直下 | `proxy.ts`（Next の Proxy。旧 `middleware.ts` は使わない）も規約で直下に置く | - | `rule-tests/architecture.test.ts` の `frontend-placement` |
| feature | `screens/<name>-screen/`: 1 画面 = 1 ディレクトリ。`<name>-screen.tsx`（見た目。先頭に `"use client"`。hook の戻り値を描くだけで、形は下の「画面の骨組み」）と `<name>-screen.hook.ts`（状態・イベント・データ取得。`use<Name>Screen`）と `<name>-screen.messages.ts`（辞書）と、それぞれのテストを隣に置く。ほかのファイル（部品の別ファイル・入れ子のディレクトリ）は置かない（規則 `screen-outline-placement`） | ロジックは `renderHook` で、見た目は操作ベースで小さくテストでき、画面を消すときはディレクトリごと消せる | `rule-tests/screen-outline.test.ts` の `screen-outline-placement` |
| feature | `components/`: feature 内で画面をまたぐ部品（atom を組み合わせて描く。今あるのは `todo-item.tsx`）。1 つの画面だけで使う部品は画面のファイルの中に export せずに置く（下の「画面の骨組み」） | - | レビュー |
| feature | `hooks/`: 画面をまたぐ hook | - | 説明 |
| feature | `api/`: `/api/...` を fetch する薄いラッパー。feature の中で backend を参照してよいのはここだけ | - | `rule-tests/architecture.test.ts` の `screen-to-backend` |
| feature | `index.ts`: 公開 API。feature の外（`app/`・他の feature）から import してよいのはここだけ | 内部の構成を変えても外の import を直さずに済む | `rule-tests/architecture.test.ts` の `feature-to-feature`・`app` |
| shared | `apps/frontend_customer/shared/<name>/`: feature をまたぐ部品。今あるのは `request-log/`（リクエストログの 1 行を組み立てる純粋な処理。`RequestLogBuilder.build`）と `i18n/`（翻訳の仕組み・共通の辞書・ロケール・日時の表示。下の「i18n」）と `ui/`（デザインシステム。下の「デザインシステム」） | - | 説明 |
| shared | 画面をまたぐ見た目の部品は `ui/atoms/` の atom にし、`shared/components/` は作らない（feature の中で画面をまたぐ部品は `features/<f>/components/`） | 以前は「`components/` は使うものが出るまで作らない」だったが、Issue #292 で画面をまたぐ部品（Mantine を包むもの）が出て、置き場所を `ui/atoms/` にした。Mantine を import してよいのは `shared/ui/` の中だけ（規則 `design-system-mantine-boundary`）なので、Mantine を包む部品は `shared/components/` には置けない。限界: `shared/components/` を作ること自体と、Mantine を使わない部品を置くことは止めない | `rule-tests/design-system.test.ts` の `design-system-mantine-boundary` |
| shared | `shared/components/` を作らない・`hooks/` は使うものが出るまで作らない（Mantine を使わない部品の置き場所） | `design-system-mantine-boundary` は Mantine の参照だけを見る | レビュー |
| shared | `apps/frontend_customer/shared/`（画面側の部品）と `apps/shared/`（frontend と backend で共通のサーバ側の基盤。`.claude/rules/code/shared.md`）は別のもの | - | 説明 |
| test-support | `apps/frontend_customer/test-support/`（Issue #181）: テストだけが使うコード（`i18n.tsx` の `JaLocale`・`tJa`、`design-system.tsx` の `DesignSystem`）を置く | WHY は `.claude/rules/code/backend.md` の `apps/backend/test-support/` と同じ | 説明 |
| test-support | 本番のコード（`app/`・`features/`・`shared/`・直下のファイル）から参照しない（`@/test-support/...` はテストからだけ） | WHY は `.claude/rules/code/backend.md` の `apps/backend/test-support/` と同じ | `rule-tests/test-support.test.ts` の `production-imports-test-support` |
| test-support | Docker のイメージに入らない（`.dockerignore` の `**/test-support`）。検査は `rule-tests/test-support.test.ts` と `.github/workflows/deploy.yml` | WHY は `.claude/rules/code/backend.md` の `apps/backend/test-support/` と同じ | `rule-tests/test-support.test.ts` の `dockerignore-excludes`、`.github/workflows/deploy.yml` の `test-support` |

## 依存の向き

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| shared から | `shared/` は `features/`・`app/`・backend・`apps/shared` を参照しない（規則 `shared-to-features`・`screen-to-app`・`screen-to-backend`・`screen-to-shared`） | - | `rule-tests/architecture.test.ts` の `shared-to-features`・`screen-to-app`・`screen-to-backend`・`screen-to-shared` |
| 直下から | 直下のファイルは backend を参照しない（規則 `frontend-root-to-backend`） | - | `rule-tests/architecture.test.ts` の `frontend-root-to-backend` |
| 直下から | 起動時の検証の `env` とログの `logger` は、frontend と backend で共通の `apps/shared` から `@repo/shared/env`・`@repo/shared/logger` で使う（Issue #90） | 以前は backend の中にあり、この規則の例外だった | `rule-tests/architecture.test.ts` の `frontend-to-shared-specifier` |
| features から | feature 同士は原則 import せず、必要なら相手の `index.ts` だけ | `feature-to-feature` は相手の `index.ts` への import を許すので、import すること自体は止めない | レビュー |
| features から | `features/<f>/api/` から backend への参照は `import type` / `export type` だけで、参照先は自 feature の `apps/backend/features/<f>/internal/presentation/<name>.api.ts` と `apps/backend/shared/http/` の下で `exports` にあるもの | 画面とサーバで同じ契約（型）を使い、ずれを型チェックで検出する。`import type` はビルドで消えるので、サーバのコードがバンドルに入らない | `rule-tests/architecture.test.ts` の `feature-api-to-backend`・`backend-exports` |
| features から | features の `api/` は backend の api ファイルの関数や application・domain・infra の実装を import しない（参照してよいのは presentation の `*.api` の型と `apps/backend/shared/http/` だけ） | - | `rule-tests/architecture.test.ts` の `feature-api-to-backend` |
| features から | `apps/backend/shared/http/` から参照するのは `apps/backend/shared/http/problem.ts`（`Problem`・`ErrorKey`・`ErrorKeyParams`）だけ | 限界: `feature-api-to-backend` は `shared/http/` の下を広く許し、`backend-exports` は `exports` のキー（今は `./shared/http/problem` だけ）を足せば通る。`shared/http/` のほかのファイルを `exports` に足して型を読むことは止めない | レビュー |
| features から | screens / components / hooks は backend を直接参照せず、`api/` が re-export した型を使う（`import type { Todo } from "@/features/todo/api/todo-api"`。`Todo` は `api/todo-api.ts` が一覧 API の Response から導出する（`ListTodosResponse["todos"][number]`）） | 契約が変わったときの影響を `api/` の 1 ファイルで追える | `rule-tests/architecture.test.ts` の `screen-to-backend` |

## ルーティング

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 規約ファイル | 置くもの: Next の規約ファイル（`page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx` など）と `app/api/**/route.ts` だけ。テストは置かない。`app/` はルーティングだけ | 仕様は screen と api ファイルのテストで固定し、ルーティングにロジックを置かせない | レビュー |
| 規約ファイル | `page.tsx` は screen を返すだけ（`return <TodoScreen />`。動的セグメントは `await params` で取り出して props で渡す） | ルーティングを分ける: URL を変えてもコードを動かさずに済む（Next は構成について unopinionated で、`app/` の外にコードを置くのは公式の例の 1 つ） | レビュー |
| 規約ファイル | `app/`（`app/api` 以外）が参照してよいのは `features/<f>`（index）と `shared/` だけ | ルーティングを分ける（上の行） | `rule-tests/architecture.test.ts` の `app` |
| Route Handler | `app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ（`export { GET } from "@repo/backend/features/todo/internal/presentation/list-todos.api";`）。同じ URL の複数メソッドはそれぞれ別の api ファイルから re-export する。入力検証やレスポンスの組み立ては書かない | ルーティングを分ける（上の行）。`app-api` が見るのは参照先だけで、route.ts に処理を書くことは止めない | レビュー |
| Route Handler | `app/api/` が参照してよいのは backend の api ファイルだけ | - | `rule-tests/architecture.test.ts` の `app-api` |

## import と exports

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 書き方 | frontend の中は `@/<path>`（tsconfig の paths `@/*` → `apps/frontend_customer/*`） | - | レビュー |
| 書き方 | backend へは `@repo/backend/<path>` だけ（workspace パッケージと `apps/backend/package.json` の `exports` で解決）。相対パス（`../backend/...`）と `@/../backend/...` は使わない（規則 `frontend-to-backend-specifier`） | 相対パスは `exports`（公開する入口）を通らずに backend のどのファイルでも指せ、後で別プロセスに分けたときにも壊れる | `rule-tests/architecture.test.ts` の `frontend-to-backend-specifier` |
| 書き方 | `apps/shared` へは `@repo/shared/<name>` だけ（直下のファイルから。`apps/shared/package.json` の `exports`）。相対パス（`../shared/...`）と `@/../shared/...` は使わない（規則 `frontend-to-shared-specifier`） | 同上 | `rule-tests/architecture.test.ts` の `frontend-to-shared-specifier` |
| 解決 | exports に無いファイルを import すると `tsc` / `next build` が「Cannot find module」で止まる。足し方は `.claude/rules/code/backend.md` の「import と exports」の表の「exports」 | - | `pnpm typecheck` |
| 解決 | `apps/frontend_customer/tsconfig.json`: Next 用（plugin・jsx・DOM の型、paths は `@/*` だけ）。`@repo/backend/...`・`@repo/shared/...` を paths に書かない | 書くと exports を通らずにパッケージのどのファイルも指せてしまう | レビュー |

## 画面の骨組み

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 画面の関数 | `<name>-screen.tsx` の最初の文は `"use client"` のディレクティブ（前のコメントは可。Issue #332） | Next の文書: import より前、ファイルの先頭に置く（`node_modules/next/dist/docs/01-app/03-api-reference/01-directives/index.md`） | `rule-tests/screen-outline.test.ts` の `screen-outline-use-client` |
| 画面の関数 | `<name>-screen.tsx` は hook の戻り値を描くだけにする | `screen-outline-placement` はファイルの置き方だけを見る | レビュー |
| 画面の関数 | 画面のファイルが export する値は画面の関数 `export function <Name>Screen` 1 つだけ（`screen-outline-single-export`。`export default`・`export const` の画面も違反）。規則 `screen-outline-*`、Issue #292 | daiki の依頼（2026-10-02「screen の中身が、見て画面レイアウトが想像できるように」）。ファイルを開いて最初の関数を見るだけで画面のレイアウトが分かる | `rule-tests/screen-outline.test.ts` の `screen-outline-single-export` |
| 画面の関数 | 画面の関数は hook を呼び、`return` を 1 つだけ書く（早期 return も違反。`screen-outline-single-return`） | 早期 return を止めるのは、状態ごとに別のレイアウトになり、最初の関数で画面の形が 1 つに決まらなくなるため | `rule-tests/screen-outline.test.ts` の `screen-outline-single-return` |
| Layout | 根は atom の `<Layout>`（`@/shared/ui/atoms/layout`。`screen-outline-layout-root`） | 最初の関数を見るだけで画面のレイアウトが分かる（上の行） | `rule-tests/screen-outline.test.ts` の `screen-outline-layout-root` |
| Layout | 直下には同じファイルの最上位で定義した export しない部品のうち、名前が `...Section`（表示のまとまり）か `...Form`（入力のまとまり）のものの要素だけを並べる（props は渡してよい。`screen-outline-layout-children`）。例は表の直後 | 最初の関数を見るだけで画面のレイアウトが分かる（上の行） | `rule-tests/screen-outline.test.ts` の `screen-outline-layout-children` |
| Layout | 読み込み中・エラーの出し分け、`.map`、atom の並べ方は Section / Form の中に書く（`Layout` の直下に式・atom・素の要素・Fragment・文字列を置かない） | 最初の関数を見るだけで画面のレイアウトが分かる（上の行） | `rule-tests/screen-outline.test.ts` の `screen-outline-layout-children` |
| 限界 | Section / Form の中身（atom を使っているか）と、部品がファイルの下の方にあるか（並び順）はレビューで見る。`features/<f>/components/` と `app/` の `page.tsx` は対象外 | 限界（見逃す）: 検査はこれらを見ない。詳細は `rule-tests/screen-outline.test.ts` の冒頭 | レビュー |

```tsx
export function TodoScreen() {
  const { ... } = useTodoScreen();
  return (
    <Layout>
      <TitleSection />
      <NewTodoForm ... />
      <TodoListSection ... />
    </Layout>
  );
}
// ↓ ファイルの下の方に、export しない Section / Form を atom で描く
```

## デザインシステム

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 構成 | 置き場所は `shared/ui/` だけ: `atoms/`（Mantine の部品を包む atom。今は Alert / Button / Checkbox / Form / Group / Layout / Link / List / ListItem / PageTitle / Stack / Surface / Text / TextInput / Time の 15 個）、`themes/<名前>/`（`<名前>.theme.ts` と `<名前>.module.css`。今は `bento` と `pop`）と `themes/theme-definition.ts`（テーマの型）、`active-theme.ts`（使うテーマ。今は `bento`）、`design-system-provider.tsx`（`MantineProvider`。`app/layout.tsx` が包む）、`design-system-document.tsx`（`<html>` / `<head>` に要るもの）。Mantine を使う。規則 `design-system-*`、Issue #292 | - | 説明 |
| 構成 | テーマを替える: `active-theme.ts` の 1 行を別のテーマに差し替える（画面のコードは変えない） | - | 説明 |
| 構成 | テーマを足すときは `ThemeDefinition` の型（`spacing` の全段階と `ThemedComponent` の全部品が必須）を満たす | - | `pnpm typecheck` |
| 画面の書き方 | `shared/ui/` の外のテスト以外のソース（`app/`・`features/`・`shared/` のほかの場所・`test-support/`・直下のファイル）は Mantine を値でも型でも参照せず（`design-system-mantine-boundary`）、画面は atom を置くだけにする | テーマを差し替えるだけで全体の見た目が変わるようにする（daiki の要望 2026-10-02）。atom で包むと、画面が Mantine を知らずに済み、ライブラリを替えても atom の中だけ直せばよい | `rule-tests/design-system.test.ts` の `design-system-mantine-boundary` |
| 画面の書き方 | style・className・Styles API（`classNames` / `styles` / `vars`）・Mantine の style props（`mt`・`c`・`w` など）・見た目を選ぶ props（`color` / `variant` / `size` など）を書かない（`design-system-no-direct-style`） | 画面に見た目を書くと、その箇所はテーマを替えても変わらず、見た目の正がテーマと画面の 2 か所に分かれる | `rule-tests/design-system.test.ts` の `design-system-no-direct-style` |
| 画面の書き方 | `.css` は `shared/ui/` の下にだけ置き、外から import しない（`design-system-css-placement`） | 見た目の正をテーマに 1 つにする（上の行） | `rule-tests/design-system.test.ts` の `design-system-css-placement` |
| 画面の書き方 | 余白だけは画面に書く: 段階名 `xs` / `sm` / `md` / `lg` / `xl`（`SpacingStep`）の文字列だけで、atom の `Stack` / `Group` の `gap` に渡す（atom の型が段階名だけを受ける） | 部品の並べ方（どこを詰め、どこを空けるか）は画面の構造なので画面に書き、各段階の値（rem）の正はテーマの `spacing`（型で全段階が必須）に残す。テーマを替えると余白も替わる | `pnpm typecheck` |
| 画面の書き方 | atom の外で余白の props（`m*` / `p*` / `gap` など）を書くときも段階名の文字列リテラルだけ（数値・px・式は違反）。幅・高さは余白に入れない（違反） | 同上 | `rule-tests/design-system.test.ts` の `design-system-no-direct-style` |
| 画面の書き方 | スプレッド（`{...props}`）・`createElement` の props・`useMantineTheme` で取り出した値を別の口から当てる書き方で見た目を当てない | 限界（見逃す）: 検査はこれらを見ないのでレビューで見る。詳細は `rule-tests/design-system.test.ts` の冒頭 | レビュー |
| atom | atom を足す・変えるとき: props は画面が要るものだけを自前の型で出し（Mantine の props 型を渡さない）、イベントは文字列・boolean・引数なしで渡す（`preventDefault` などは atom の中） | Mantine の props 型を渡すと見た目の口が画面に開くため | レビュー |
| atom | 包む Mantine の部品を `theme-definition.ts` の `ThemedComponent` に足し、すべてのテーマの `components` に見た目を書く（足し忘れは `design-system-themed-components` と型チェックで止まる） | - | `rule-tests/design-system.test.ts` の `design-system-themed-components`、`pnpm typecheck` |
| atom | atom のテストは `shared/ui/atoms/<name>.test.tsx` | - | レビュー |

## データ取得とレンダリング

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| サーバロジック | 画面にサーバロジックを書かない。Server Components でのデータ取得や Server Functions（Server Actions）は使わず、データは hook → `api/` → `/api/...`（Route Handler）で取る | データ取得の経路を 1 本にし、サーバの処理を `apps/backend/` の 4 層に集める。画面と API の境界が HTTP になり、それぞれ単独でテストできる | レビュー |
| 型の担保 | 型で担保されること: リクエスト / レスポンスの形（`pnpm build` / `pnpm typecheck` で不一致を検出） | - | `pnpm typecheck` |
| 型の担保 | 型で担保されないこと: URL と HTTP メソッド（画面側に文字列で書く）、実行時の JSON の形（`response.json()` を型に当てはめるだけ）。URL を型で担保したくなったら、api ファイルから path の定数を export する案を検討する（今は入れない） | - | 説明 |
| prerender | ビルド時の Client Components の prerender は止めない。`output: "export"` と `next/dynamic` の `ssr: false` は、ブラウザ専用 API で困るまで使わない | `output: "export"` では Route Handler が GET だけのビルド時の静的なレスポンスになる。ブラウザ専用 API は `useEffect` の中で触れば prerender と両立する | レビュー |
| prerender | 例外: i18n のため root layout が `headers()` を読むので、今は全ルートが動的レンダリングで、ビルド時の prerender は無い（下の「i18n」の限界）。ここで止めないのは `output: "export"` / `ssr: false` のような静的化・SSR の無効化のこと | - | 説明 |

## i18n

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 構成 | 対応するロケールは `ja`（既定）と `en`（`shared/i18n/locale.ts` の `SUPPORTED_LOCALES`） | - | 説明 |
| 構成 | ライブラリは使わない | 決定と採用しなかった案は ADR `docs/adr/architecture/20260929-i18n-without-library.md` と `docs/adr/architecture/20260929-messages-colocated-per-screen.md`（Issue #116・#125） | レビュー |
| 構成 | `shared/i18n/` は `i18n.tsx`（`defineMessages`・`useT`・`useLocale`・`LocaleProvider`・`formatMessage`・`isMessageKey`・型）、`locale.ts`（ロケールの判定。Proxy から React なしで使う）、`format.ts`（日時の表示）、`common.messages.ts`（共通の辞書）だけ（テスト用の `JaLocale`・`tJa` は `apps/frontend_customer/test-support/i18n.tsx`） | - | レビュー |
| 辞書 | 辞書は画面・部品ごとに隣に置く（colocation）: `screens/<name>-screen/<name>-screen.messages.ts`、`components/<name>.messages.ts`。書き方は `export const todoScreenMessages = defineMessages({ ja: {...}, en: {...} })`。平坦なオブジェクトで、キーは dot 区切りの 1 つの文字列 | 1 つの辞書では、画面を消す・言い回しを変えるときに、どのキーがどの画面のものかを辞書を読んで探すことになる。隣に置けば、画面のディレクトリだけで完結し、ディレクトリごと消せる（`screens/` の方針と同じ） | レビュー |
| 辞書 | 共通の辞書 `shared/i18n/common.messages.ts` に置くのは、API から返る `ErrorKey` の文言と画面側だけのエラー `error.*` だけ（どの画面の操作でも同じキーで出るため）。画面・部品に固有の文言は置かない（`api-error.test.ts` が「共通の辞書のキー = `ErrorKey` + `error.unknown` + `error.unexpected`」を型で検査する） | どの画面の操作でも同じキーで出るため | `apps/frontend_customer/features/todo/api/api-error.test.ts` の `ErrorKey`、`pnpm typecheck` |
| 辞書 | `*.messages.ts` を import してよいのは同じディレクトリのファイルだけ（`./todo-screen.messages`）。`common.messages.ts` だけは `apps/frontend_customer/` のどこからでも可（`@/shared/i18n/common.messages`）。検査は `rule-tests/architecture.test.ts` の規則 `messages-colocation`（テストは対象外で、画面のテストが部品の辞書で期待値を作るのは可）。辞書を re-export（`export ... from`）して中継しない（同じディレクトリでも違反） | 隣に置く（上の行） | `rule-tests/architecture.test.ts` の `messages-colocation` |
| 辞書 | 複数の画面で同じ言い回しを使うときも、それぞれの辞書に書く | 隣に置く（上の行） | レビュー |
| キー | 画面・部品の辞書のキーは、その画面の中で短く付ける（`title`・`form.submit`・`deleteAria`。画面の名前はファイルの場所で分かるので入れない） | 画面の名前はファイルの場所で分かる | レビュー |
| キー | 共通の辞書のサーバのエラーは backend の `ErrorKey` と同じ文字列、画面側だけのエラーは `error.<理由>`（`error.unknown` = HTTP ステータスだけが分かる失敗、`error.unexpected` = API の応答ではない失敗） | - | `apps/frontend_customer/features/todo/api/api-error.test.ts` の `ErrorKey`、`pnpm typecheck` |
| キー | サーバのエラーのキーは `<対象>.<項目>.<理由>`（例 `todo.title.tooLong`。backend の `error-key.ts` のコメントは `<領域>.<対象>.<理由>`） | 限界: 検査が見るのは辞書のキーと `ErrorKey` の一致だけで、キーの形（`todo.notFound` のような 2 段も通る）は見ない | レビュー |
| 文言 | 画面に出す文言（JSX のテキスト、`aria-label` などの利用者向けの属性、エラーの文言）は辞書にだけ書き、画面・hook・components は `t(...)` を通す。検査は規則 `frontend-hardcoded-text`（例外は `apps/frontend_customer/` の `*.messages.ts` の `defineMessages(...)` の引数の中だけ。辞書のファイルでも引数の外に文言を書くと違反） | 文言が散らばると、言語を足すときに漏れ、言い回しの変更がコードの変更になる | `rule-tests/architecture.test.ts` の `frontend-hardcoded-text` |
| 文言 | サーバのログ（`proxy.ts`・`instrumentation-node.ts`）は辞書の対象外で、英語で書く | 日本語のリテラルは `frontend-hardcoded-text` が止めるが、英語で書いたかは見ない | レビュー |
| 型 | `defineMessages`: `ja` がキーの一覧と placeholder の正（`const` の型引数で文字列リテラルの型になるので `as const` は書かない）。`en` のキーの欠け・余分、placeholder の名前の集合の違い（順番は問わない）、空白だけの文言（全角の空白・`\r` を含む）、文字列リテラルでない `string` 型の値はコンパイルエラーになる | - | `pnpm typecheck` |
| 型 | placeholder の名前は英数字と `_` だけ（`{max}`・`{max_1}`）。実行時の置換（`formatMessage` の `/\{(\w+)\}/`）と同じ規則を型でも強制し、`{a-b}`・`{}`・`{ max }` のような `{...}` を含む文言はコンパイルエラーになる（対にならない `{` や `}` は書ける） | 実行時の置換と同じ規則にそろえる | `pnpm typecheck` |
| 型 | `t(key, params)` の params は ja の文言の `{name}` から型で導く（`i18n.tsx` の `MessageParams`）。placeholder が無いキーは params を渡せず、あるキーは必須で、名前の違いもコンパイルエラーになる | - | `pnpm typecheck` |
| 型 | 使い方: 画面・部品では `const t = useT(todoScreenMessages);`（その辞書のキーだけを受け付ける `t`。別の画面の辞書のキーはコンパイルエラー） | - | `pnpm typecheck` |
| 型 | キーが実行時の値（サーバの Problem Details の `key`）のときだけ `formatMessage(commonMessages, locale, key, params)` を使う（`features/todo/api/api-error.ts` の `ApiErrorMessage.toMessage`） | - | レビュー |
| ロケールの決め方 | `proxy.ts` が Cookie `NEXT_LOCALE` → Accept-Language（q 値の高い順、言語の部分で照合）→ 既定の ja で決め（`Locales.negotiate`）、リクエストヘッダ `x-locale` に載せる（`/api/**` には載せない）。`app/layout.tsx` が `headers()` で読み、`<html lang>` と `LocaleProvider` に渡す | - | 説明 |
| ロケールの決め方 | URL のパスは変えない（`app/[lang]` にしない） | - | レビュー |
| ロケールの決め方 | 限界: `headers()` を読むので全画面が動的レンダリングになり、ビルド時の静的な prerender は無い。matcher が除く `next/link` のプリフェッチには `x-locale` が付かないが、root layout はクライアント遷移で描き直されないので表示は変わらない（E2E `apps/e2e/spec/i18n.feature`） | 限界（この方式で失うもの） | 説明 |
| 日時の表示 | `shared/i18n/format.ts` の `DateTimeFormatter.format(iso, locale, timeZone)`（`Intl.DateTimeFormat`、`dateStyle: "medium"` / `timeStyle: "short"`）に、ブラウザのタイムゾーン（`Intl.DateTimeFormat().resolvedOptions().timeZone`）を渡す | DB は timestamptz（UTC）で API は ISO 8601。表示だけを利用者のタイムゾーンで行う。ブラウザのタイムゾーンを描画で読んでよいのは、一覧が useEffect の取得後にブラウザでだけ描かれるため（hydration の不一致にならない） | レビュー |
| 日時の表示 | サーバは UTC で動かす（リポジトリ直下の `package.json` の `dev` / `start` の `TZ=UTC`、`instrumentation-node.ts` が UTC でなければ起動を止める） | サーバの動作は環境のタイムゾーンに依存させない | `apps/frontend_customer/instrumentation-node.ts` の `UTC` |
| 日時の表示 | テストは `vitest.config.mts` の `test.env.TZ = "UTC"`、E2E はブラウザを `ja-JP` / `Asia/Tokyo` にする（`apps/e2e/playwright.config.ts`） | - | 説明 |

## エラー表示

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| Problem Details | backend は RFC 9457 の Problem Details（`application/problem+json`。`.claude/rules/code/backend.md`）を返す。`features/<f>/api/` は本文が Problem Details（`type` が文字列・`status` が数値・`key` が共通の辞書のキー・`params` は省略かオブジェクト。`todo-api.ts` の `TodoApi.isProblem`）なら `ApiError`（`status`（HTTP の応答のステータス）・`type`・`key`・`params`）を、そうでなければ `error.unknown`（`params.status`、`type` は無し）の `ApiError` を投げる | - | 説明 |
| Problem Details | `detail` は開発者向けの英語で読まない・出さない | - | レビュー |
| Problem Details | hook は失敗の理由を持って描画のときに翻訳する（ロケールが変わっても、その言語で出る） | ロケールが変わっても、その言語で出る | レビュー |
| Problem Details | backend の `ErrorKey` がすべて共通の辞書にあること・params の名前が placeholder と同じことは、`api-error.ts` の `ApiErrorKey` の型の制約と `api-error.test.ts` の型の検査で止める | `shared/` は backend を参照できないので、`api/` で突き合わせる | `apps/frontend_customer/features/todo/api/api-error.test.ts` の `ErrorKey`、`pnpm typecheck` |
| 項目ごとの誤り | 項目ごとの誤り（Issue #144）: 400 の本文の `errors`（`{ pointer, key, params?, detail }[]`。`pointer` は RFC 6901 の JSON Pointer の fragment の形で、本文全体は `#`）を `ApiError` の `errors`（`pointer`・`key`・`params`。本文に無ければ `[]`、`detail` は持たない）に載せる | - | 説明 |
| 項目ごとの誤り | `isProblem` は `errors` が省略か配列で、各要素の `pointer` が文字列・`key` が共通の辞書のキー・`params` が省略か配列でないオブジェクトであることを確かめ、1 件でも崩れていれば本文全体を Problem Details とみなさない（`error.unknown`） | 崩れた要素だけを捨てると、捨てた誤りが出ないまま残りだけを直せばよいように見える | レビュー |
| 項目ごとの誤り | 表示は `api-error.ts` の `ApiErrorMessage.toMessages(reason, locale, fields)` で、フォーム全体の文言（`form`）と入力の下の文言（`fields`）に分ける。`fields` はその画面が入力を描く項目の名前（本文の最上位のキー）で、`pointer` が `#/<項目名>` と完全一致する誤りをその項目に、それ以外（`#`・描いていない項目・入れ子の位置）を `form` に出す。項目・`form` とも最初の 1 件。`errors` が無い失敗（404・500・JSON でない応答・fetch の失敗）は今までどおり `form` だけ | - | 説明 |
| 項目ごとの誤り | 項目の誤りも全体の文言も、入力を編集しても消えず、次の送信の成功・失敗で置き換わる（hook の `setFailure`。既存の全体のエラーと同じ扱い） | 編集で消すと「まだ直っていない」状態で文言が消え、送信するまで結果が分からない。項目の誤りだけのときは `role="alert"` が無いのでスクリーンリーダーは自動では読み上げない（入力にフォーカスしたときに説明として読まれる。変えるなら入力にフォーカスを移す）。方針の ADR は `docs/adr/architecture/20260930-presentation-overlaps-domain-validation.md` | レビュー |
| 項目ごとの誤り | 項目の誤りがあるときは、本文の `key`（全体の文言）を重ねて出さない | 本文の `key` は `errors` の最初の 1 件と同じ（backend の `Problem`）で、両方出すと同じ文言が 2 回出る | レビュー |
| 項目ごとの誤り | hook は `error`（`form`）と `fieldErrors`（`fields`）を返し、画面は項目の文言を入力を包む `label` の直後（外）に出して、入力の `aria-describedby`（`useId` の id）と `aria-invalid` で結び付ける。`role="alert"` はフォーム全体の文言だけに付ける | `label` の外: `label` の中の文字はすべて入力の名前（accessible name）になる | レビュー |

## ログ

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| logger と console | サーバ側（直下の `proxy.ts`・`instrumentation-node.ts`）のログは `@repo/shared/logger` を通す。`console.*` は書かない（Biome の `noConsole` と規則 `console-direct-access`。`.claude/rules/code/backend.md` の「ログ」） | - | `biome.json` の `noConsole`、`rule-tests/architecture.test.ts` の `console-direct-access` |
| logger と console | `features/`・`app/`・`shared/` のクライアントコード（ブラウザ）は console を使わない（画面にはログを出さない） | ブラウザの console に出したものはサーバのログに残らず、利用者の開発者ツールにだけ見える。エラーは画面の表示（エラー状態）で扱う | `biome.json` の `noConsole`、`rule-tests/architecture.test.ts` の `console-direct-access` |
| logger と console | logger・env はサーバ専用で、`app/`・`features/`・`shared/` から `apps/shared` は参照しない（規則 `screen-to-shared`。env・logger をブラウザのバンドルに持ち込まない。now も今は画面が現在時刻を読まないので同じく参照しない） | 同上 | `rule-tests/architecture.test.ts` の `screen-to-shared` |
| リクエストログ | 画面アクセスと `/api/**` の呼び出しを 1 リクエスト 1 行の JSON で stdout に出すだけにし、1 行の中身は `shared/request-log/` の `RequestLogBuilder.build`（テストで固定）で組み立て、`logger.emit` で出す | 決定は ADR `docs/adr/architecture/20260929-request-log-in-proxy.md`、ブラウザのリクエスト一覧の実測は 2026-09-29 の work-logs「docs/ から移した記録」 | 説明 |
| リクエストログ | 行の形は Cloud Logging の特別フィールドと OTel semconv の HTTP の名前（入れ子）で、`event.name` は `page_request`（画面）/ `api_request`（`/api/**`）、`message` は `<METHOD> <path>`、`traceparent`（W3C）があれば `logging.googleapis.com/trace`（`projects/<GCP_PROJECT_ID>/traces/<trace-id>`）・`spanId`・`trace_sampled` を出す（形が違えば出さない） | キーの一覧は ADR `docs/adr/architecture/20260930-log-format-cloud-logging-otel.md`（Issue #209） | 説明 |
| リクエストログ | `GCP_PROJECT_ID` は `proxy.ts` が `@repo/shared/env` から読んで渡す | `shared/request-log/` は `apps/shared` を参照できない（規則 `screen-to-shared`） | `rule-tests/architecture.test.ts` の `screen-to-shared` |
| リクエストログ | `event.name` が一覧（`apps/shared/log-event.ts`）にあることと種類ごとの必須項目は、`proxy.ts` の `logger.emit(log)` の型チェックが見る | - | `pnpm typecheck` |
| リクエストログ | クエリは `url.query` にキーと値の組で出し、値は logger が `***` にする（キーは自由文としてメールなどだけを `***`）。`referer`（URL のクエリを含みうる）と `client.address`（接続元の IP。GDPR では個人データ）も `***` になる | - | 説明 |
| リクエストログ | `RequestLogBuilder.build` と `proxy.ts` は生の値を渡すだけで、伏せる処理を書かない（マスクは logger の中だけ。Issue #216） | `.claude/rules/code/backend.md` の「ログ」の表の「マスク」、ADR `docs/adr/architecture/20260930-log-masking-in-logger.md` | レビュー |
| リクエストログ | 受信時刻は `@repo/shared/now` の `Clock.now()` で取る（現在時刻の唯一の出口。`new Date()` は書かない。規則 `now-single-source`、`.claude/rules/code/shared.md` の「現在時刻」） | - | `rule-tests/architecture.test.ts` の `now-single-source` |
| リクエストログ | 認可・リダイレクトなどのロジックは置かない | - | レビュー |
| リクエストログ | 限界: status と所要時間は取れない（Proxy は応答の前に動く）、プリフェッチは matcher で除く、ブラウザの戻る・進むで Next のルーターのキャッシュが使われると画面の行は出ない（出るのは画面が呼ぶ API の行だけ）、`client.address` は `x-forwarded-for` を信じる値でクライアントが偽装できるので、信頼できるリバースプロキシがヘッダを付け直す前提で使う | 限界（ログに出ないもの・信頼できない値） | 説明 |

## クラスと命名

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| クラス | `features/`・`shared/`・`test-support/` の React 以外のモジュール（`.ts` など。`*.tsx`・`*.jsx`・`*.hook.*` 以外）は、ファイルの最上位に関数を置かず、クラスのメソッド（状態が無ければ static だけのクラス。インスタンスで使うクラスには自分を返すファクトリ以外の static を置かない。規則 `no-static-in-instance-class`、Issue #300）にする。検査は `rule-tests/architecture.test.ts` の `class-based` | daiki の判断（2026-10-02「クラス必須でルールにして」）。backend・apps/shared と同じ形にそろえ、画面のテストの差し替えも `vi.mocked(TodoApi.list)` の形になる（`vi.mocked(Clock.now)` と同じ）。ADR `docs/adr/architecture/20261002-class-based-frontend-modules.md` | `rule-tests/architecture.test.ts` の `class-based`・`no-static-in-instance-class` |
| クラス | 今あるもの: `TodoApi`（`list`・`get`・`create`・`rename`・`changeCompletion`・`delete`）・`ApiErrorMessage`（`toMessage`・`toMessages`）・`Locales`（`is`・`negotiate`・`fromHeader`）・`DateTimeFormatter`（`format`）・`RequestLogBuilder`（`build`）。定数（`SUPPORTED_LOCALES`・`LOCALE_HEADER` など）と型はクラスの外の値のまま | - | 説明 |
| クラス | static だけのクラスの許可は `biome.json` の override（`.claude/rules/quality/lint.md`） | - | `biome.json` の `noStaticOnlyClass`、`rule-tests/lint.test.ts` の `noStaticOnlyClass` |
| クラス | 対象外（関数のまま）: React の component（`*.tsx`・`*.jsx`。JSX を含むファイルの補助 `i18n.tsx` の `defineMessages`・`formatMessage` なども、ファイルごと外す）、hook（`*.hook.*`）、`app/` の下（Next の規約）、直下のファイル（`proxy.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`next.config.ts`）。対象外の範囲を広げない | React と Next が関数の形を求める（クラスの component は非推奨、hook は Rules of Hooks、`proxy`・`register`・`page` の default export は規約）。`instrumentation-node.ts` は Vitest のカバレッジの対象外で、形を変えても単体テストで確かめられない | 説明 |
| 命名 | ディレクトリ・ファイルは kebab-case（`todo-screen/`） | - | レビュー |
| 命名 | コンポーネントと型は PascalCase（`TodoScreen`） | - | レビュー |
| 命名 | hook は `use` 始まり（`useTodoScreen`） | - | レビュー |
| 命名 | 役割の接尾辞は `.` の後ろ（`.hook.ts`・`.test.tsx`） | - | レビュー |

## テスト

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 書き方 | hook は `renderHook`、screen は render して操作し表示を検証する（どちらも jsdom。`vitest.config.mts` の既定） | - | レビュー |
| 書き方 | `api/` は `vi.mock` で差し替える（`.claude/rules/quality/testing.md`） | - | レビュー |
| 書き方 | Mantine で描く画面・部品は Provider で包む必要がある。`test-support/i18n.tsx` の `JaLocale` が `test-support/design-system.tsx` の `DesignSystem`（`DesignSystemProvider` と jsdom に無い `window.matchMedia` の代わり）も含むので、画面のテストは今までどおり `JaLocale` を wrapper にする | - | レビュー |
| i18n | 画面・components は `test-support/i18n.tsx`（`@/test-support/i18n`）の `JaLocale` を wrapper にして描き、期待する文言は `tJa(todoScreenMessages, key, params)`（対応する辞書で翻訳した結果）と比べる | 言い回しの変更でテストを直さずに済む | レビュー |
| i18n | en で描いて英語になることも画面ごとに 1 件見る（辞書の en の中身はここで見る） | - | レビュー |
| i18n | 仕組み（`defineMessages`・`useT` など）は `shared/i18n/i18n.test.tsx` がテスト用の辞書で固定する | - | 説明 |
