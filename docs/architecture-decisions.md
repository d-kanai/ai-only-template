# ディレクトリ構成の経緯・実測・採用しなかった案

規則と WHY は `.claude/rules/backend.md`・`.claude/rules/frontend.md`・`.claude/rules/shared.md`・`.claude/rules/architecture-check.md`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。

## 全体像（Issue #39 / #68）
| ディレクトリ | 役割 |
| --- | --- |
| `apps/frontend/` | `@repo/frontend`（Next.js）。`app/`（ルーティングだけ）・`features/`・`next.config.ts`・`instrumentation*.ts` |
| `apps/backend/` | `@repo/backend`（API 側。Next・React に依存しない TS）。`<feature>/` の DDD 4 層、`shared/`、`drizzle/`・`drizzle.config.ts` |
| `apps/shared/` | `@repo/shared`（frontend と backend で共通の基盤。Issue #90）。`env.ts`（環境変数の入口）・`logger.ts`（ログの出口）だけ |
| `apps/e2e/` | `@repo/e2e`（Playwright の E2E。Issue #84）。`*.spec.ts`・`database.ts`・`playwright.config.ts` |
| リポジトリ直下 | ツールの設定・`rule-tests/`（ルール検査テスト）・`scripts/`・`docs/`・`work-logs/` |

- frontend と backend を `apps/` で分ける理由（Issue #68。ユーザー指示）: パッケージの単位で画面側と API 側を分け、後で API を別プロセスに分離しやすくする。プロセスは増やさず Next 1 つのまま（Hono などの別サーバは入れない）。
- 段階: 段階 1 でディレクトリを `apps/` に移し、import・設定・検査を書き換えた（`package.json` は 1 つ、`@repo/backend/*` は tsconfig の paths で解決）。段階 2（今の形）で pnpm workspace にし、`apps/backend` を `exports` を明示した `@repo/backend`、`apps/frontend` を `@repo/frontend` にした。段階 1 の限界（frontend から backend を相対パスで参照しても、参照先が許される場所なら違反にしない）は段階 2 の `frontend-to-backend-specifier` で解消した。

## apps/shared（Issue #90）
- 何を: 環境変数の入口 `env.ts`（Issue #59）とログの出口 `logger.ts`（Issue #85）を、`apps/backend/shared/infra/` から workspace パッケージ `apps/shared`（`@repo/shared`。exports は `./env`・`./logger`）に `git mv` で移した。
- なぜ（ユーザー指摘、2026-09-29）: どちらも frontend 直下（`instrumentation-node.ts`・`proxy.ts`）・backend・`apps/e2e/`・`vitest.global-setup.ts` が共通で使うもので、backend の中に置くと frontend 直下から backend を参照する例外（`frontend-root-to-backend` の env・logger）が要った。共通のものを共通の場所に置き、`frontend-root-to-backend` の例外を無くした（直下のファイルは backend を参照しない）。
- `packages/` ではなく `apps/` の下に置く: ユーザー判断（workspace のパッケージを `apps/` の下にそろえる。`pnpm-workspace.yaml` の `packages: ["apps/*"]` もそのまま）。
- 何でも置ける場所にしない: 置いてよいファイルを名前で決め（`shared-placement`）、exports も 1 ファイルずつ（`shared-exports`）。画面側（`app/`・`features/`・`shared/`）からは参照しない（`screen-to-shared`）。backend の層ごとの許可は移す前と同じ（infra は env・logger、presentation は logger、domain・application は使わない）。規則と WHY は `.claude/rules/shared.md`。
- 採用しなかった案: `frontend-to-backend-specifier` を「backend と shared」に広げる案（1 規則 = 1 テストで、失敗したときにどちらの境界かが分かるよう、`frontend-to-shared-specifier` を別に足した）。

## 例（Todo）のファイル構成
ファイル名は例。実際のファイルはリポジトリを正とする。

```
pnpm-workspace.yaml                     # packages: ["apps/*"]（workspace の範囲）と pnpm の設定
package.json                            # リポジトリ直下（ツール・共通の devDependencies、pnpm --filter で apps の script を呼ぶ）
apps/
  frontend/
    package.json                        # @repo/frontend（next / react / "@repo/backend"・"@repo/shared": "workspace:*"）
    next.config.ts                      # Next の設定
    instrumentation.ts                  # Next の規約ファイル（起動時の環境変数の検証。.claude/rules/env.md）
    instrumentation-node.ts             # Node.js runtime 用の処理。@repo/shared/env を読み込む
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
    package.json                        # @repo/backend（drizzle-orm / pg / zod / @repo/shared、exports で公開する入口、db:generate / db:migrate）
    tsconfig.json
    drizzle.config.ts                   # drizzle-kit の設定（apps/backend の db:generate / db:migrate が --config で指す）
    drizzle/                            # 生成したマイグレーション（SQL と meta/）。pnpm db:generate が作り、コミットする
    shared/
      domain/
        domain-error.ts                 # DomainError（code: validation_error / not_found）
        transaction-runner.ts           # TransactionRunner<Tx> の interface（command をトランザクションで実行する窓口）
      presentation/
        http-error.ts                   # DomainError → HTTP ステータスの変換、ErrorResponse・ErrorIssue 型、InvalidRequestError（issues 付き）
        http-error.test.ts
        json-body.ts                    # リクエスト本文の zod スキーマの土台（requestBodySchema）と、JSON を読んで parse する parseJsonBody
        json-body.test.ts
      infra/
        database.ts                     # Postgres のプール（@repo/shared/env から設定）と Drizzle の db、Executor 型、getDatabase / closeDatabase
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
        todo.ts                         # Entity / Value Object（不変条件は zod のスキーマ。完全コンストラクタ）
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
  shared/
    package.json                        # @repo/shared（依存なし。exports は ./env・./logger。Issue #90）
    tsconfig.json                       # apps/backend と同じ方針（DOM の型なし）
    env.ts                              # 環境変数の唯一の入口（env: 必須の設定を検証した値、toolEnv: 開発ツールのフラグ）。リポジトリ直下の .env を読む
    env.test.ts
    logger.ts                           # サーバ側のログの唯一の出口（JSON 1 行。Issue #85）
    logger.test.ts
apps/e2e/                               # @repo/e2e。Playwright の E2E（*.spec.ts・database.ts・playwright.config.ts。Issue #84）
rule-tests/                             # ルール検査テスト（architecture.test.ts・lint.test.ts など 8 本。Issue #86）
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
- tsconfig は 4 つ: `apps/frontend/tsconfig.json`（Next 用。paths は `@/*` だけ）、`apps/backend/tsconfig.json`（backend 単体。Next の plugin・jsx・DOM の型なし、paths なし）、`apps/shared/tsconfig.json`（Issue #90。backend と同じ方針）、リポジトリ直下の `tsconfig.json`（Vitest の `resolve.tsconfigPaths` と全体の型チェック。paths は `@/*` → `./apps/frontend/*`）。WHY は各ファイルのコメント。
- `pnpm typecheck`（`tsc -p . --noEmit && tsc -p apps/backend --noEmit && tsc -p apps/shared --noEmit`）を CI で `pnpm lint` の後・`pnpm build` の前に実行する（`rule-tests/typecheck.test.ts` が script と CI の順序を検査）。
  - WHY: `apps/frontend` の `next build` は frontend と、そこから import された backend のファイルしか型チェックしない。monorepo 化の前はリポジトリ直下の tsconfig（`**/*.ts`）で `next build` がテスト・ルール検査テスト・e2e・設定まで型チェックしていたが、移動後は backend のテストや `rule-tests/architecture.test.ts` に型エラーを置いても `pnpm build` が exit 0 になった（reviewer の実測）。Vitest は型を検査しない。
- 段階 2 で tsconfig の paths から `@repo/backend/*` を外した: paths は exports より先に解決に使われ、公開していないファイルも型チェックを通るため。

## 入力検証を zod に統一（Issue #88）
- 経緯: 以前は「入力検証は手書き（ライブラリは入れない。規模が大きくなったら Issue で検討）」で、presentation が `typeof` で項目の型を、domain（`Todo`）が `if` でタイトルの規則を確かめていた。ユーザーの指示で zod 4.6.5（`apps/backend` の dependencies）に統一した。
- 理由: 規則の宣言と型の導出を 1 か所にする（`z.infer` / `z.output` でリクエストの型と `TodoProps` をスキーマから作る）。項目ごとの誤りを `ErrorResponse` の `error.issues`（`{ path, message }` の一覧）としてレスポンスに出せる。
- 分担は変えない: presentation は「形」（`requestBodySchema` = `z.strictObject`、動的セグメントの `id` は `z.uuid()`）、domain は「値の規則」（`todoTitleSchema`）。規則の置き場所・未知のキー・`isUuid` の判断と WHY は `.claude/rules/backend.md` の「presentation」と各ファイルのコメント。
- 当時は `Todo.restore`（DB の行から組み立てる口）を検証せず、`rename` はタイトルだけ、`changeCompletion` は検証なし、と口ごとに検証の範囲を分けていた（規則を厳しくしたときに既存のデータの読み込みで失敗させないため）。Issue #94 で撤回した（次の節）。
- 実測（zod 4.6.5、2026-09-29）:
  - `z.string().trim()` は値を置き換え、後の `refine` と parse の結果は trim 後の値になる。`.min` / `.max` は `String#length` なので、タイトルの文字数（コードポイント数）は `refine` と `Array.from` で数える（`"🍎".repeat(100)` は length 200）。
  - `z.strictObject(shape, { error })` の `error` は、そのオブジェクト自身の issue（`invalid_type` と `unrecognized_keys`）だけに当たり、項目の issue は項目のスキーマの `error` が決める。`unrecognized_keys` の issue は path が `[]` で、`keys` に未知のキーが入る。
  - `z.uuid()` は RFC 9562 の形（版の桁 1〜8、variant 8 / 9 / a / b、nil と max）だけを受け付け、大文字も通す。Postgres の uuid 型より狭い（版の桁が 0 の値は Postgres は受け付けるが `z.uuid()` は拒否する）。Todo の id は `randomUUID`（v4）なので影響しない。より広い `z.guid()` もあるが、Issue の指示どおり `z.uuid()` にした。
  - `z.date()` は Invalid Date を拒否する。
- 採用しなかった案（比較は各プロジェクトの公式の説明による。性能・サイズは実測していない）:
  - valibot: 主な利点は関数単位の import によるバンドルの小ささで、サーバ側（`apps/backend`）だけで使う今は効かない。
  - ArkType: スキーマを TypeScript の型に似た文字列の DSL で書く独自の構文で、読み手の学習が要る。利点の検証の速さは、1 リクエスト数項目のこの規模では効かない。

## 常に全体を検証する・restore を reconstruct に改名（Issue #94）
- ユーザーの判断: 口ごとに検証の範囲を分けず、`Todo` の private コンストラクタが毎回 `todoPropsSchema`（全フィールド）で検証する。「Todo 型の値 = 不変条件を満たす値」を常に成り立たせる方が単純。規則を変えるときは既存のデータを移行（スキル `db-migration`）して追従する。
- 改名: `Todo.restore` → `Todo.reconstruct`（DB の行から Entity を再構成する口）。`InMemoryTodoRepository#restore(snapshot)`（トランザクションの rollback の代わりに snapshot の時点へ戻す）は別の意味で、`snapshot` と対の名前なので変えていない。
- DB の行が不変条件を満たさないとき: `PostgresTodoRepository` の `toTodo` が DomainError ではない `Error` にして投げ、API は 500（`internal_error`、ログに id と違反の理由）。400 にしない理由は、クライアントに直せないサーバ側のデータの不整合だから。
- 採用しなかった案: DomainError(validation_error) のまま 400 にする（クライアントに直せない誤りを入力の誤りと伝える）。不正な行を一覧から読み飛ばす（データが消えたように見え、不整合に気づけない）。
- presentation のテスト（get / update / delete）は、以前は uuid の形でない id の Todo を `restore` でリポジトリに置き「あっても 404」を見ていた。そうした Todo は作れなくなったので、Repository のメソッドの spy が呼ばれないこと（`parseUuidParam` が query / command に渡す前に 404 にする）で確かめる。

## 後で別プロセスに分けるとき
1. `apps/backend` に起動口（`server.ts`。HTTP サーバと api ファイルの結線）と、その起動の script を足す。
2. `apps/frontend/app/api/**` を消し、Next の `rewrites` で `/api/*` を backend のサーバに向ける。
3. `apps/frontend/package.json` の `@repo/backend` は型だけの依存になる（`features/*/api/` の `import type`。exports から `*.api` の値の利用が無くなる）。env・logger は `apps/shared`（Issue #90）にあるので、frontend と backend のサーバの両方がそのまま使える。
- backend は Next・React に依存せず、中の import は相対パスだけなので、そのまま動く想定。Node で直接動かすときの TS の扱い（`constructor(private readonly ...)` は Node の型除去だけでは動かない見込み）は未確認。

## Stryker と workspace（Issue #68 の段階 2）
- サンドボックスの中でも、`@repo/backend/...`（Issue #90 からは `@repo/shared/...` も）で import したファイルは変異していない元の `apps/backend`（`apps/shared`）を読む（サンドボックスの `node_modules` は元のリポジトリへの symlink）。backend のテストは相対パスで import するので影響はなく、score は 100%（killed 570 / timeout 3 / survived 0 / ignored 16）。

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
