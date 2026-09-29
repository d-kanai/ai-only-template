# ディレクトリ構成の経緯・実測・採用しなかった案

規則と WHY は `.claude/rules/backend.md`・`.claude/rules/frontend.md`・`.claude/rules/architecture-check.md`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。

## 全体像（Issue #39 / #68）
| ディレクトリ | 役割 |
| --- | --- |
| `apps/frontend/` | `@repo/frontend`（Next.js）。`app/`（ルーティングだけ）・`features/`・`next.config.ts`・`instrumentation*.ts` |
| `apps/backend/` | `@repo/backend`（API 側。Next・React に依存しない TS）。`<feature>/` の DDD 4 層、`shared/`、`drizzle/`・`drizzle.config.ts` |
| `apps/e2e/` | `@repo/e2e`（Playwright の E2E。Issue #84）。`*.spec.ts`・`database.ts`・`playwright.config.ts` |
| リポジトリ直下 | ツールの設定・ルール検査テスト・`scripts/`・`docs/`・`work-logs/` |

- frontend と backend を `apps/` で分ける理由（Issue #68。ユーザー指示）: パッケージの単位で画面側と API 側を分け、後で API を別プロセスに分離しやすくする。プロセスは増やさず Next 1 つのまま（Hono などの別サーバは入れない）。
- 段階: 段階 1 でディレクトリを `apps/` に移し、import・設定・検査を書き換えた（`package.json` は 1 つ、`@repo/backend/*` は tsconfig の paths で解決）。段階 2（今の形）で pnpm workspace にし、`apps/backend` を `exports` を明示した `@repo/backend`、`apps/frontend` を `@repo/frontend` にした。段階 1 の限界（frontend から backend を相対パスで参照しても、参照先が許される場所なら違反にしない）は段階 2 の `frontend-to-backend-specifier` で解消した。

## 例（Todo）のファイル構成
ファイル名は例。実際のファイルはリポジトリを正とする。

```
pnpm-workspace.yaml                     # packages: ["apps/*"]（workspace の範囲）と pnpm の設定
package.json                            # リポジトリ直下（ツール・共通の devDependencies、pnpm --filter で apps の script を呼ぶ）
apps/
  frontend/
    package.json                        # @repo/frontend（next / react / "@repo/backend": "workspace:*"）
    next.config.ts                      # Next の設定
    instrumentation.ts                  # Next の規約ファイル（起動時の環境変数の検証。.claude/rules/env.md）
    instrumentation-node.ts             # Node.js runtime 用の処理。@repo/backend/shared/infra/env を読み込む
    tsconfig.json
    app/
      layout.tsx                        # Next の規約ファイル（loading.tsx / error.tsx なども app/ に置く）
      page.tsx                          # return <TodoScreen />
      todo/
        [id]/
          page.tsx                      # await params で id を取り出し、return <TodoDetailScreen todoId={id} />
      api/
        todos/
          route.ts                      # export { GET } from "@repo/backend/todo/presentation/list-todos.api"
                                        # export { POST } from "@repo/backend/todo/presentation/create-todo.api"
          [id]/
            route.ts                    # get-todo.api の GET / update-todo.api の PUT / delete-todo.api の DELETE を re-export
    features/
      todo/
        index.ts                        # 公開 API。外から import してよいのはここだけ
        api/
          todo-api.ts                   # /api/todos を fetch する薄いラッパー（型は backend の api ファイルから import type し、画面側に re-export）
          todo-api.test.ts
        components/
          todo-item.tsx                 # feature 内で画面をまたぐ部品
          todo-item.test.tsx
        hooks/                          # 画面をまたぐ hook（必要になったら作る）
        screens/
          todo-screen/
            todo-screen.tsx             # 見た目。"use client"。hook の戻り値を描くだけ
            todo-screen.hook.ts         # 状態・イベント・データ取得（useTodoScreen）
            todo-screen.test.tsx
            todo-screen.hook.test.ts
          todo-detail-screen/
            todo-detail-screen.tsx      # props は todoId（app/todo/[id]/page.tsx から受け取る）
            todo-detail-screen.hook.ts  # useTodoDetailScreen(todoId)
            todo-detail-screen.test.tsx
            todo-detail-screen.hook.test.ts
  backend/
    package.json                        # @repo/backend（drizzle-orm / pg、exports で公開する入口、db:generate / db:migrate）
    tsconfig.json
    drizzle.config.ts                   # drizzle-kit の設定（apps/backend の db:generate / db:migrate が --config で指す）
    drizzle/                            # 生成したマイグレーション（SQL と meta/）。pnpm db:generate が作り、コミットする
    shared/
      domain/
        domain-error.ts                 # DomainError（code: validation_error / not_found）
        transaction-runner.ts           # TransactionRunner<Tx> の interface（command をトランザクションで実行する窓口）
      presentation/
        http-error.ts                   # DomainError → HTTP ステータスの変換、ErrorResponse 型、InvalidRequestError
        http-error.test.ts
        json-body.ts                    # リクエスト本文を JSON のオブジェクトとして読む（readJsonObject）
        json-body.test.ts
      infra/
        env.ts                          # 環境変数の唯一の入口（env: 必須の設定を検証した値、toolEnv: 開発ツールのフラグ）。リポジトリ直下の .env を読む
        env.test.ts
        database.ts                     # Postgres のプール（env から設定）と Drizzle の db、Executor 型、getDatabase / closeDatabase
        database.test.ts
        database.test-support.ts        # 実 Postgres を使うテスト用。テストファイルごとの別スキーマにマイグレーションを当てる
        database.test-support.test.ts
        drizzle-transaction-runner.ts   # TransactionRunner の Drizzle 実装（db.transaction）
        drizzle-transaction-runner.test.ts
    todo/
      presentation/                     # 1 API = 1 ファイル。リクエスト / レスポンスの型もこの中で定義して export する
        list-todos.api.ts               # export function listTodosApi(container) → handler / export const GET = listTodosApi(todoContainer)
        list-todos.api.test.ts
        get-todo.api.ts                 # getTodoApi(container) の handler は (request, ctx: { params: Promise<{ id: string }> }) / export const GET
        get-todo.api.test.ts
        create-todo.api.ts              # createTodoApi(container) / export const POST
        create-todo.api.test.ts
        update-todo.api.ts              # updateTodoApi(container) / export const PUT
        update-todo.api.test.ts
        delete-todo.api.ts              # deleteTodoApi(container) / export const DELETE
        delete-todo.api.test.ts
      application/
        list-todos.query.ts             # 読むだけ（副作用なし）
        list-todos.query.test.ts
        get-todo.query.ts
        get-todo.query.test.ts
        create-todo.command.ts          # 状態を変える
        create-todo.command.test.ts
        update-todo.command.ts
        update-todo.command.test.ts
        delete-todo.command.ts
        delete-todo.command.test.ts
      domain/
        todo.ts                         # Entity / Value Object
        todo.test.ts
        todo-repository.ts              # Repository の interface
      infra/
        schema.ts                       # todos テーブルの定義（Drizzle のスキーマ。マイグレーションの生成元）
        todo-repository.postgres.ts     # Repository の実装（Postgres。Executor を受け取る）
        todo-repository.postgres.test.ts
        todo-repository.in-memory.ts    # Repository の実装（InMemory。テスト用）
        todo-repository.in-memory.test.ts
        in-memory-transaction-runner.ts # TransactionRunner の InMemory 実装（スナップショットで rollback）
        in-memory-transaction-runner.test.ts
        container.ts                    # 組み立て（DI）。createTodoContainer({ runner, repositoryFor, readExecutor })、
                                        #   createInMemoryTodoContainer / createPostgresTodoContainer、アプリ共有の todoContainer
        container.test.ts
apps/e2e/                               # @repo/e2e。Playwright の E2E（*.spec.ts・database.ts・playwright.config.ts。Issue #84）
architecture.test.ts lint.test.ts …     # ルール検査テスト（リポジトリ直下）
tsconfig.json                           # Vitest とリポジトリ全体の型チェック用
```

## 実測（2026-09-28）
- `exports` の値は TS のソースのまま読める: Next（Turbopack は workspace パッケージを自動で変換する。`transpilePackages` は不要）、Vitest（Vite）、tsc（`moduleResolution: bundler` は exports を読む）、Playwright（`pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm test:e2e` で確認）。
- exports に無いファイルを外から import すると `tsc` / `next build` が「Cannot find module」で止まる（`todo-api.ts` に `@repo/backend/todo/infra/container` の import を置いて確認）。
- `pnpm start -p 3100` は `pnpm --filter @repo/frontend start -p 3100` → `next start -p 3100`、`pnpm db:generate --name <内容>` も同じく引数がそのまま渡る。
- backend の中で `@/` を使うと、Next（Turbopack）が frontend の tsconfig の paths を当てて `apps/frontend` の中を探し、ビルドが失敗する（Issue #68 の researcher）。
- re-export した関数が Route Handler として動く（公式ドキュメントに明記が無いため実測。Next.js 16.3.6）: `pnpm build` の出力で `/api/todos` と `/api/todos/[id]` が動的ルート（ƒ）になり、`next start` に curl して CRUD が動いた。
- `// @vitest-environment node` でファイル単位に環境を切り替えられる（Vitest 5.0.1。既定 jsdom で、コメント付きは `document` が undefined、無しは object）。
- Route Handler は Web 標準の `Request` / `Response` で書けるので、api ファイルの handler は Next を起動せずにテストできる。

## tsconfig と型チェックのゲート（Issue #68）
- tsconfig は 3 つ: `apps/frontend/tsconfig.json`（Next 用。paths は `@/*` だけ）、`apps/backend/tsconfig.json`（backend 単体。Next の plugin・jsx・DOM の型なし、paths なし）、リポジトリ直下の `tsconfig.json`（Vitest の `resolve.tsconfigPaths` と全体の型チェック。paths は `@/*` → `./apps/frontend/*`）。WHY は各ファイルのコメント。
- `pnpm typecheck`（`tsc -p . --noEmit && tsc -p apps/backend --noEmit`）を CI で `pnpm lint` の後・`pnpm build` の前に実行する（`typecheck.test.ts` が script と CI の順序を検査）。
  - WHY: `apps/frontend` の `next build` は frontend と、そこから import された backend のファイルしか型チェックしない。monorepo 化の前はリポジトリ直下の tsconfig（`**/*.ts`）で `next build` がテスト・ルール検査テスト・e2e・設定まで型チェックしていたが、移動後は backend のテストや `architecture.test.ts` に型エラーを置いても `pnpm build` が exit 0 になった（reviewer の実測）。Vitest は型を検査しない。
- 段階 2 で tsconfig の paths から `@repo/backend/*` を外した: paths は exports より先に解決に使われ、公開していないファイルも型チェックを通るため。

## 後で別プロセスに分けるとき
1. `apps/backend` に起動口（`server.ts`。HTTP サーバと api ファイルの結線）と、その起動の script を足す。
2. `apps/frontend/app/api/**` を消し、Next の `rewrites` で `/api/*` を backend のサーバに向ける。
3. `apps/frontend/package.json` の `@repo/backend` は型だけの依存になる（`features/*/api/` の `import type`。exports から `*.api` の値の利用が無くなる）。`instrumentation-node.ts` の env の検証は backend のサーバ側に移す。
- backend は Next・React に依存せず、中の import は相対パスだけなので、そのまま動く想定。Node で直接動かすときの TS の扱い（`constructor(private readonly ...)` は Node の型除去だけでは動かない見込み）は未確認。

## Stryker と workspace（Issue #68 の段階 2）
- サンドボックスの中でも、`@repo/backend/...` で import したファイルは変異していない元の `apps/backend` を読む（サンドボックスの `node_modules` は元のリポジトリへの symlink）。backend のテストは相対パスで import するので影響はなく、score は 100%（killed 570 / timeout 3 / survived 0 / ignored 16）。

## 採用しなかった案
- `app/` 内に `_components` などの private folder を置き、ルート単位でコードを分ける構成（公式の「Split project files by feature or route」）: URL とコードの置き場所が結びつき、ルートを動かすとコードも動かすことになる。
- `components/` `hooks/` `lib/` を最上位に並べる層別の構成: 1 つの機能のコードが層をまたいで散る。
- `src/` の下に置く構成: ユーザーの判断で不要。
- API を別プロセス（Hono + `@hono/node-server`、Next の `rewrites`、契約用の `packages/contracts`、2 サーバ）にする案（Issue #68 の最初の調査）: ユーザーの指示でプロセスを増やさない方針に変え、取り下げた（実測結果は `work-logs/2026-09-28.md`）。
- frontend から backend を `@backend/*` のような独自の別名で参照する案: パッケージ名の形（`@repo/backend/*`）にしておけば、段階 1 は paths、段階 2 はパッケージで、同じ書き方のまま解決できる。
- `apps/backend/package.json` の `exports` を `"./*": "./*.ts"`（全ファイル公開）にする案（researcher の推奨）: ユーザー判断で、公開する入口だけを明示する形にした（公開の範囲をパッケージの設定で読め、型チェック・ビルドでも公開外の import を止める）。
- 段階 2 でも tsconfig の paths に `@repo/backend/*` を残す案: 上の「tsconfig」のとおり exports を明示した意味がなくなる。
- `features/<feature>/` の中に `client/` と `server/` を並べる構成: 同じディレクトリに `"use client"` とサーバ専用のコードが混在し、画面からサーバの実装を import する誤りが起きやすい。
- 依存の向きの検査に dependency-cruiser を使う案: 18.4.0（2026-09-28 時点の latest）は `supportedTranspilers.typescript` が `>=2.0.0 <7.0.0` で、TypeScript 7.0.2 が範囲外（npm レジストリのメタデータで確認）。TS 7 に対応したら再検討する。
- Biome の `noRestrictedImports` で依存の向きを検査する案（Issue #47）: 制限したパスへの `import type` も違反になり（2.5.13 で実測）、型だけを許せない。参照元ごとに制限を変えるには feature・層ごとの `overrides` が要り、feature を足すたびに `biome.json` を直すことになる。
- 旧案（Issue #39 の最初の案）: API 側を `server/`、presentation に feature 共通の `dto.ts` と複数 API をまとめたコントローラ、application を `.use-case.ts` の 1 種類にする構成。ユーザーの判断で、`apps/backend/`、1 API = 1 ファイル（型もその中）、query / command に分ける形に変えた。

## 一次情報
- Next.js 16.3.6 同梱ドキュメント `node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md`
  - 「Organizing your project」: Next.js はプロジェクトの構成について unopinionated。
  - 「Store project files outside of `app`」: コードをルート直下の共有フォルダに置き、`app/` をルーティング専用にする構成。本リポジトリはこれを feature 単位にし、API 側を `apps/backend/` に分けたもの。
  - 「Private folders」（`_folderName` はルーティングから外れる）: `app/` の外にコードを置くので使わない。「Route groups」（`(folderName)` は URL に含まれない）: `app/` の中で完結し、コードの置き場所には関係しない。
  - 「Split project files by feature or route」: 採用しなかった案の 1 つ目。
- 同 `15-route-handlers.md`: 「Route Handlers」（Web 標準の Request / Response。Route Handler は `app/` の中でだけ使える → api ファイルの関数を `app/api/**/route.ts` で re-export する理由）、「Route Context Helper」（`await ctx.params`）。
- 同 `02-guides/static-exports.md` の「Route Handlers」「Unsupported Features」「Browser APIs」、`02-guides/lazy-loading.md` の「Skipping SSR」（`ssr: false`）。
- 同 `02-guides/instrumentation.md`: `instrumentation.ts` はプロジェクトのルートに置く（`app/` の中には置けない）。
- drizzle-orm 0.45.3 の `pg-core/dialect.js` の `migrate`: 同時実行の排他が無い（テストのスキーマを分ける理由の 1 つ）。
