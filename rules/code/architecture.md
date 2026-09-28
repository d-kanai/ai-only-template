# ディレクトリ構成ルール

Next.js（App Router）のコードを、機能（feature）単位で置く。リポジトリは `apps/frontend`（画面側 = Next.js）と `apps/backend`（API 側 = pure な TypeScript）に分け、画面側は `apps/frontend/features/`、API 側は `apps/backend/<feature>/` に置き、`apps/frontend/app/` はルーティングだけにする（Issue #68）。

## 全体像
`src/` は使わない。`apps/` の下に `frontend/` と `backend/` を置き、リポジトリ直下にはツールの設定・ルール検査テスト・E2E・スクリプトを置く。

| ディレクトリ | 役割 |
| --- | --- |
| `apps/frontend/` | workspace パッケージ `@repo/frontend`（Next.js のアプリ）。`app/` `features/` `next.config.ts` `instrumentation*.ts` `tsconfig.json` `package.json`。Next は `apps/frontend` をカレントディレクトリにして `next dev/build/start` で動かす（リポジトリ直下の `pnpm dev/build/start` が `pnpm --filter @repo/frontend <script>` を呼ぶ） |
| `apps/frontend/app/` | ルーティングだけ。`page.tsx` は screen を返すだけ、`app/api/**/route.ts` は backend の api ファイルの関数を re-export するだけ |
| `apps/frontend/features/<feature>/` | 画面側。screen（見た目 + hook）、feature 内の部品、`/api/...` を呼ぶラッパー |
| `apps/frontend/shared/` | 画面側で feature をまたぐ共通部品。**まだ無いので作らない**。必要になったら作る |
| `apps/backend/` | workspace パッケージ `@repo/backend`（API 側）。Next・React に依存しない TypeScript。サーバの起動口は持たない（Next の Route Handler から呼ばれる）。外に公開するファイルは `package.json` の `exports` に明示する（下の「workspace パッケージと exports」） |
| `apps/backend/<feature>/` | DDD の 4 層（presentation / application / domain / infra） |
| `apps/backend/shared/` | API 側で feature をまたぐ共通部品（DomainError・TransactionRunner の interface、DomainError → HTTP ステータスの変換と `ErrorResponse` 型、環境変数の入口 `env.ts`、Postgres の接続とトランザクションの実装など） |
| `apps/backend/drizzle/`・`apps/backend/drizzle.config.ts` | マイグレーション（生成物）と drizzle-kit の設定 |

- 理由: Next.js はプロジェクトの構成について方針を持たない（unopinionated）。`app/` の外にコードを置き、`app/` をルーティング専用にする構成は公式の例の 1 つ（下の「一次情報」）。ルーティング（URL）と機能のコードを分けることで、URL を変えてもコードを動かさずに済む。
- frontend と backend を `apps/` で分ける理由（Issue #68。ユーザー指示）: パッケージの単位で画面側と API 側を分け、後で API を別プロセスに分離しやすくする。プロセスは増やさず、Next 1 プロセスのまま（Hono などの別サーバは入れない）。分離するときの差分は下の「後で別プロセスに分けるとき」。
- 段階（Issue #68）: 段階 1 でディレクトリを `apps/` に移し、import・設定・検査を書き換えた（`package.json` はリポジトリ直下の 1 つ、`@repo/backend/*` は tsconfig の paths で解決）。段階 2（いまの形）で pnpm workspace にし、`apps/backend` を workspace パッケージ `@repo/backend`（`exports` を明示し、公開するのは外が使う入口だけ）、`apps/frontend` を `@repo/frontend` にした。

### workspace パッケージと exports（段階 2）
pnpm workspace（`pnpm-workspace.yaml` の `packages: ["apps/*"]`）で、`package.json` は 3 つ。版はすべて完全固定（`workspace:*` だけ例外。`rules/code/dependencies.md`）。

| package.json | name | 持つもの |
| --- | --- | --- |
| リポジトリ直下 | `ai-only-template`（private） | ツールと共通の devDependencies（Biome・Lefthook・Vitest・Testing Library・Playwright・Stryker・TypeScript・`@types/node`）、E2E が DB を直接見るための `pg` / `@types/pg`、リポジトリ直下のファイル（`playwright.config.ts`・`vitest.global-setup.ts`・`e2e/`）が使う `"@repo/backend": "workspace:*"`。scripts は `dev` / `build` / `start` → `pnpm --filter @repo/frontend <script>`、`db:generate` / `db:migrate` → `pnpm --filter @repo/backend <script>`、テスト・lint・型チェック・`db:up` などはリポジトリ直下のまま。`packageManager` もここ |
| `apps/frontend/package.json` | `@repo/frontend`（private） | dependencies に `next` / `react` / `react-dom` と `"@repo/backend": "workspace:*"`、devDependencies に `@types/react` / `@types/react-dom`。scripts は `dev` / `build` / `start`（`next dev` など。ディレクトリの引数なし） |
| `apps/backend/package.json` | `@repo/backend`（private） | dependencies に `drizzle-orm` / `pg`、devDependencies に `drizzle-kit` / `@types/pg`。scripts は `db:generate` / `db:migrate`（`drizzle-kit ... --config drizzle.config.ts`）。`exports`（下） |

- 依存の置き場所: そのパッケージのコードが import するものを、そのパッケージの `package.json` に置く（pnpm は宣言した依存だけを `<パッケージ>/node_modules` に置くので、宣言していないパッケージは import できない）。テストだけが使うもの（Vitest・Testing Library）とツールはリポジトリ直下に置く（テストはリポジトリ直下の Vitest が動かし、Node の解決は親のディレクトリの `node_modules` も探すので、`apps/*` のテストからも見える）。
  - 同じパッケージを 2 か所に置くときの版のずれは `package.test.ts` が止める（`rules/code/dependencies.md`）。
  - `@testing-library/react` の peer（`react` / `react-dom`）は、リポジトリ直下に `react` が無いので pnpm が workspace の中の `react@19.2.8` で解決している（lockfile の importers の `.` の `@testing-library/react` の版の文字列で確認）。frontend の `react` と別の版になると、画面のテストで React が 2 つ読み込まれて hook が動かない見込み（未確認）。React を上げるときは lockfile のこの行も同じ版になっていることを確かめる。
- `pnpm --filter` で動く script のカレントディレクトリはパッケージのディレクトリ（`apps/frontend` / `apps/backend`）。`.env` はリポジトリ直下の 1 つを `env.ts` が探して読む（`rules/code/env.md` の「環境変数」）。
- 引数はそのまま渡る: `pnpm start -p 3100` は `pnpm --filter @repo/frontend start -p 3100` → `next start -p 3100`、`pnpm db:generate --name <内容>` も同じ（2026-09-28 実測。`playwright.config.ts` の `webServer.command` もこの形で動く）。

#### exports（`apps/backend/package.json`）
外（apps/frontend・e2e/・リポジトリ直下の設定ファイル）が `@repo/backend/<path>` で使ってよいファイルの一覧。全ファイル（`"./*"`）は公開しない（Issue #68 のユーザー判断）。今の一覧:

| キー | 値 | 使う側 |
| --- | --- | --- |
| `./todo/presentation/*.api` | `./todo/presentation/*.api.ts` | `apps/frontend/app/api/**/route.ts`（Route Handler の re-export）、`apps/frontend/features/todo/api/todo-api.ts`（リクエスト / レスポンスの型） |
| `./shared/presentation/http-error` | `./shared/presentation/http-error.ts` | `apps/frontend/features/todo/api/todo-api.ts`（`ErrorResponse` の型） |
| `./shared/infra/env` | `./shared/infra/env.ts` | `apps/frontend/instrumentation-node.ts`（起動時の検証）、`playwright.config.ts`、`e2e/database.ts`、`vitest.global-setup.ts` |

- 値は TS のソースそのもの（ビルドしない）。Next（Turbopack は workspace パッケージを自動で変換する。`transpilePackages` は不要）、Vitest（Vite）、tsc（`moduleResolution: bundler` は exports を読む）、Playwright はそのまま読める（2026-09-28 実測: `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm test:e2e`）。
- exports に無いファイルを外から import すると、`tsc` / `next build` が「Cannot find module」で止まる（2026-09-28 実測。`todo-api.ts` に `@repo/backend/todo/infra/container` の import を置いて確認）。依存の向きの規則（どこから何を参照してよいか）は exports とは別に `architecture.test.ts` が検査する（exports は「外に見せる範囲」、規則は「どこから使ってよいか」）。
- パターン（`*`）は 1 キーに 1 つ。`./todo/presentation/*.api` は todo の api ファイル（1 API = 1 ファイル）をまとめて公開する。api ファイルを足しても exports を直さなくてよい。feature を足したら `./<feature>/presentation/*.api` を足す。それ以外は 1 ファイルずつ列挙する。
- テスト基盤は公開しない: exports は frontend / e2e / 設定が使うアプリの入口だけにする（ユーザー判断）。`vitest.global-setup.ts`（前の実行が残したテスト用スキーマの後始末。`rules/code/test.md`）が使う `apps/backend/shared/infra/database.test-support` はテストのための処理なので exports に入れず、`vitest.global-setup.ts` からだけ相対パス（`./apps/backend/shared/infra/database.test-support`）で参照する。これは規則 `frontend-to-backend-specifier` の唯一の例外で、ファイルと参照先の組で絞っている（`TEST_INFRA_RELATIVE_EXCEPTION`。ほかのファイルからの test-support、`vitest.global-setup.ts` からほかの backend のファイルへの相対参照は違反）。
- 足し方: 外で `@repo/backend/<path>` の import を書くと、`architecture.test.ts` の `backend-exports` が「exports に無い」と失敗する。`"./<path>": "./<path>.ts"` を足す（キーのパスに `.ts` を付けた値だけを許す。別のファイルを指すキーや条件付きの object は不可）。使わなくなったキーは消す（使われないキーも `backend-exports` が失敗にする）。
- backend の中は exports を通らない: backend の中の import は相対パスだけ（規則 `backend-relative-only`）。自パッケージ名（`@repo/backend/...`）で書くと exports を通り、公開していない内部のファイルを指せなくなるため。

#### 後で別プロセスに分けるとき
1. `apps/backend` に起動口（`server.ts`。HTTP サーバと api ファイルの結線）と、その起動の script を足す。
2. `apps/frontend/app/api/**` を消し、Next の `rewrites` で `/api/*` を backend のサーバに向ける。
3. `apps/frontend/package.json` の `@repo/backend` は型だけの依存になる（`features/*/api/` の `import type`。exports から `*.api` の値の利用が無くなる）。`instrumentation-node.ts` の env の検証は backend のサーバ側に移す。
- backend は Next・React に依存せず、中の import は相対パスだけなので、backend 側のコードはそのまま動く想定（Node で直接動かすときの TS の扱い（`constructor(private readonly ...)` は Node の型除去だけでは動かない見込み）は未確認）。

### import の書き方とパスの解決（段階 2）
| 参照元 → 参照先 | 書き方 | 解決 |
| --- | --- | --- |
| frontend → frontend | `@/<path>`（例: `@/features/todo`） | tsconfig の paths `@/*` → `apps/frontend/*` |
| frontend → backend | `@repo/backend/<path>`（例: `@repo/backend/todo/presentation/list-todos.api`、`@repo/backend/shared/infra/env`）だけ。相対パス（`../backend/...`）と `@/../backend/...` は使わない | workspace パッケージ: `apps/frontend/node_modules/@repo/backend`（`apps/backend` への symlink）と `apps/backend/package.json` の `exports` |
| backend → backend | 相対パスだけ（例: `../domain/todo`、`../../shared/infra/database`） | ファイルの位置から |
| リポジトリ直下の設定・E2E → backend | `@repo/backend/<path>`（例: `@repo/backend/shared/infra/env`）だけ。例外は `vitest.global-setup.ts` → `./apps/backend/shared/infra/database.test-support`（相対パス。テスト基盤は exports に含めないため） | workspace パッケージ: リポジトリ直下の `node_modules/@repo/backend`（リポジトリ直下の `package.json` の devDependencies）と `exports`。tsconfig の paths には頼らない（Playwright は自前の変換で読むため） |
| `apps/backend/drizzle.config.ts` → backend | 相対パス（`./shared/infra/env`） | backend の中なので相対パス（drizzle-kit は tsconfig の paths を解決する保証もない） |

- backend の中で `@/` を使わない理由: Next（Turbopack）は backend のファイルの `@/` にも frontend の tsconfig の paths を当て、`apps/frontend` の中を探してビルドが失敗する（Issue #68 の researcher の実測）。
- backend の中で `@repo/backend/` を使わない理由: 自パッケージ名の参照は `exports` を通り、公開していない内部のファイルを指せなくなる。相対パスなら `exports` に関係なく解決する。
- frontend などから相対パスで backend を指さない理由: `exports`（公開する入口）を通らずに backend の中のどのファイルでも指せてしまい、`exports` を明示した意味がなくなる。後で backend を別プロセスに分けたときにも壊れる。
- 検査: `architecture.test.ts` の規則 `backend-relative-only`・`frontend-to-backend-specifier` と `backend-exports`（下の「依存の向き（全体）」）。
- tsconfig は 3 つ（WHY は各ファイルのコメント）:
  - `apps/frontend/tsconfig.json`: Next（`apps/frontend` の `next build` の型チェックとエディタ）用。Next の plugin・jsx・DOM の型、paths は `@/*` → `./*` だけ。`@repo/backend/...` は paths に書かず、workspace パッケージとして解決する（paths に書くと exports を通らずに backend のどのファイルも指せてしまうため）。frontend が import した backend のファイルも、この設定で型チェックされる。
  - `apps/backend/tsconfig.json`: backend 単体の型チェック（`pnpm exec tsc -p apps/backend --noEmit`）用。Next の plugin・jsx・DOM の型を入れず、paths も持たない。DOM の型が無いので、`Response#json()` は `unknown` を返す（テストでは `as` で型を付ける）。
  - リポジトリ直下の `tsconfig.json`: Vitest（`resolve.tsconfigPaths`）とリポジトリ全体の型チェック（`pnpm exec tsc -p . --noEmit`）用。paths は `@/*` → `./apps/frontend/*`（frontend の tsconfig と同じ行き先）だけ。
  - 強制: `pnpm typecheck`（`tsc -p . --noEmit && tsc -p apps/backend --noEmit`）を CI の `ci` ジョブで `pnpm lint` の後・`pnpm build` の前に実行する。script の中身と CI のステップ（失敗を無視する書き方でないこと、build より前にあること）は `typecheck.test.ts` が検査する。
    - 理由: `apps/frontend` の `next build` は frontend と、そこから import された backend のファイルしか型チェックしない。monorepo にする前はリポジトリ直下の tsconfig（`**/*.ts`）で `next build` がテスト・ルール検査テスト・e2e・設定ファイルまで型チェックしていたが、移動後は backend のテストや `architecture.test.ts` に型エラーを置いても `pnpm build` が exit 0 になった（Issue #68 の reviewer の実測）。Vitest は型を検査しない。
- `.env` はリポジトリ直下に 1 つ（`rules/code/env.md` の「環境変数」）。

## 例（Todo）
ファイル名は例。実際のファイルはリポジトリを正とする。

```
pnpm-workspace.yaml                     # packages: ["apps/*"]（workspace の範囲）と pnpm の設定
package.json                            # リポジトリ直下（ツール・共通の devDependencies、pnpm --filter で apps の script を呼ぶ）
apps/
  frontend/
    package.json                        # @repo/frontend（next / react / "@repo/backend": "workspace:*"）
    next.config.ts                      # Next の設定
    instrumentation.ts                  # Next の規約ファイル（起動時の環境変数の検証。rules/code/env.md）
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
e2e/                                    # Playwright の E2E（リポジトリ直下）
architecture.test.ts lint.test.ts …     # ルール検査テスト（リポジトリ直下）
tsconfig.json                           # Vitest とリポジトリ全体の型チェック用
```

## `apps/frontend/app/`（ルーティング）
- 置くもの: `page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx` などの Next の規約ファイルと、`apps/frontend/app/api/**/route.ts` だけ。
- `instrumentation.ts`（起動時の環境変数の検証。`rules/code/env.md` の「環境変数」）は Next の規約でプロジェクトのルート（`apps/frontend/` 直下）に置く（`app/` の中には置けない。Next.js 16.3.6 同梱ドキュメント `01-app/02-guides/instrumentation.md`）。Node.js 専用の処理は `apps/frontend/instrumentation-node.ts` に置き、`@repo/backend/shared/infra/env` を読み込む（apps/frontend 直下のファイルが backend を参照してよいのはこれだけ。規則 `frontend-root-to-backend`）。
- `page.tsx` は screen を返すだけにする（`return <TodoScreen />`）。状態・データ取得・見た目は screen 側に書く。
- `apps/frontend/app/api/**/route.ts` は `apps/backend/<feature>/presentation` の api ファイルが export する HTTP メソッド名の関数を re-export するだけにする（`export { GET } from "@repo/backend/todo/presentation/list-todos.api";`）。入力検証やレスポンスの組み立ては書かない。
  - 同じ URL の複数のメソッド（`/api/todos` の GET と POST など）は、それぞれ別の api ファイルから re-export する。
  - re-export した関数が Route Handler として動くことは確認済み（公式ドキュメントには明記がないため実測。Next.js 16.3.6、2026-09-28）: `pnpm build` の出力で `/api/todos` と `/api/todos/[id]` が動的ルート（ƒ）として出力され、`next start` に curl して一覧・取得・作成・更新・削除（CRUD）が動いた。
  - 動的セグメント（`[id]`）の `params` は Promise で、`await` して取り出す（`15-route-handlers.md` の「Route Context Helper」の例 `await ctx.params`）。取り出しは api ファイル側で行う。
- `apps/frontend/app/` にテストは置かない。
  - 理由: `apps/frontend/app/` のファイルは screen / api ファイルを繋ぐだけで、仕様（テスト = 仕様）は screen と api ファイルのテストで固定する。ルーティングのファイルにロジックを置かせない狙いもある。

## `apps/frontend/features/<feature>/`（画面側）
- `screens/<name>-screen/`: 1 画面 = 1 ディレクトリ。次の 2 ファイルとテストを同居（コロケーション）させる。
  - `<name>-screen.tsx`: 見た目。先頭に `"use client"`。hook の戻り値を描くだけで、状態やデータ取得を持たない。
  - `<name>-screen.hook.ts`: 状態・イベントハンドラ・データ取得（`use<Name>Screen`）。
  - テスト: `<name>-screen.test.tsx`（screen）、`<name>-screen.hook.test.ts`（hook）を隣に置く。
  - 理由: 見た目とロジックを分けると、ロジックは hook 単体（`renderHook`）で、見た目は操作ベースで、それぞれ小さくテストできる。1 画面のファイルを 1 か所にまとめ、画面を消すときはディレクトリごと消せるようにする。
- `components/`: feature 内で画面をまたぐ部品。
- `hooks/`: feature 内で画面をまたぐ hook。
- `api/`: `/api/...` を fetch する薄いラッパー。feature の中で backend を参照してよいのはここだけ。リクエスト / レスポンスの型は `apps/backend/<feature>/presentation/<name>.api.ts`（エラー時の `ErrorResponse` は `apps/backend/shared/presentation/`）から `import type` で参照し、画面側の他のコード（screens / components / hooks）が使う型は `api/` から re-export する（下の「画面側とサーバ側の境界」）。
- `index.ts`: feature の公開 API。feature の外（`apps/frontend/app/`・他の feature）から import してよいのはここだけ。
  - 理由: feature の内部構成を変えても、外側の import を直さずに済むようにする。
- `components/` `hooks/` は、使うものが出てくるまで作らない（空のディレクトリを置かない）。

### SSR を前提にしない
- 画面にサーバロジックを書かない。Server Components でのデータ取得や Server Functions（Server Actions）は使わず、データは hook から `api/` 経由で `/api/...` を呼んで取る。
- 理由: 画面側のデータ取得の経路を「hook → `api/` → Route Handler」の 1 本に揃え、サーバの処理はすべて `apps/backend/` の 4 層に集める。画面と API の境界が HTTP になり、それぞれ単独でテストできる。
- Next がビルド時に Client Components を静的 HTML に prerender すること自体は止めない。`output: "export"`（静的エクスポート）や `next/dynamic` の `ssr: false` は、ブラウザ専用 API（`window` / `localStorage` など）で困るまで使わない。
  - 理由: `output: "export"` にすると Route Handler は `GET` だけになり、ビルド時に静的なレスポンスとして固定される（`02-guides/static-exports.md` の「Route Handlers」。Request に依存する Route Handler は「Unsupported Features」）。API を Next で完結させる方針と合わない。ブラウザ専用 API は `useEffect` の中で触れば prerender と両立する（同ファイルの「Browser APIs」）。

## `apps/backend/<feature>/`（API 側、DDD 4 層）
| 層 | 置くもの | 依存してよい先 |
| --- | --- | --- |
| `presentation/` | api ファイル。1 API = 1 ファイル `<verb>-<noun>.api.ts`（例: `list-todos.api.ts`、`create-todo.api.ts`）。コンテナを受け取って handler（Request → 入力の形の検証 → query / command → Response）を返す関数（`listTodosApi(container)`）、それを本番用のコンテナで組み立てた HTTP メソッド名の定数（`export const GET = listTodosApi(todoContainer)`）、その API のリクエスト / レスポンスの型を export する | 許可の一覧（ここに無い自前コードは不可）: 自 feature と `apps/backend/shared` の `application`、`domain`（feature の domain は Entity の型の参照のみ。query / command が返す Entity を DTO に変換するため `import type { Todo }` する。`apps/backend/shared/domain` は値でも可）、同じ `presentation`（re-export など）、自 feature の `infra/container.ts`（コンテナの型と本番用のコンテナの受け取りだけ）。パッケージは `next` / `react` / `react-dom` 以外 |
| `application/` | ユースケース。1 ユースケース = 1 ファイルで、読むだけ（副作用なし）のものは `<verb>-<noun>.query.ts`、状態を変えるものは `<verb>-<noun>.command.ts`（例: `list-todos.query.ts`、`create-todo.command.ts`） | 許可の一覧: 自 feature と `apps/backend/shared` の `domain`・`application`。パッケージは `next` / `react` / `react-dom` と DB のパッケージ（`drizzle-orm` とそのサブパス、`pg`。型だけでも不可）以外 |
| `domain/` | Entity / Value Object / Repository の interface（DomainError は feature をまたいで使うため `apps/backend/shared/domain/` に置く） | 許可の一覧: 自 feature と `apps/backend/shared` の `domain` だけ（Next・React・DB に依存しない）。パッケージは `next` / `react` / `react-dom` と DB のパッケージ（`drizzle-orm` とそのサブパス、`pg`。型だけでも不可）以外（`node:crypto` など） |
| `infra/` | Repository の実装、Drizzle のスキーマ（`schema.ts`）、TransactionRunner の実装、`container.ts`（組み立て = DI。runner と Repository の作り方を受け取ってコンテナを作る `createTodoContainer`、InMemory / Postgres 用の `createInMemoryTodoContainer` / `createPostgresTodoContainer`、アプリで共有する `todoContainer`） | 許可の一覧: 自 feature と `apps/backend/shared` の `domain`（interface を実装する）・`application`（container で組み立てる）・`infra`（container が Repository の実装を組み立てる）。パッケージは `next` / `react` / `react-dom` 以外 |

- 依存の向き: `apps/frontend/app/api → presentation → application → domain`。`infra` は `domain` の interface を実装する（依存性の逆転）。
- 依存してよい先は許可の一覧で決める。一覧に無い自前コード（他 feature のどの層、画面側の `apps/frontend/` のすべて、層に属さない場所）は参照しない。
- backend の中の import は相対パスだけにする（`@/` と `@repo/backend/` は使わない。上の「import の書き方とパスの解決」）。
  - 理由: 禁止の一覧だと、書き忘れた参照先が黙って通る。
  - `apps/backend/shared/` の中も同じ層の許可に従う（例: domain から `apps/backend/shared/presentation/` は不可）。`apps/backend/shared/` から参照してよい自前コードは `apps/backend/shared/` の中だけ。
- backend のファイルは `apps/backend/<feature>/`（`apps/backend/shared/` を含む）の 4 層（`domain/` `application/` `presentation/` `infra/`）のどれかの下に置く。`apps/backend/<feature>/` 直下や `lib/` など層に属さない場所には置かない。例外は `apps/backend/` 直下の設定ファイル（`<name>.config.ts`。今は `drizzle.config.ts` だけ）で、backend → frontend の禁止と相対パスだけの規則はかかる。
  - 理由: 層に属さない場所のファイルにはどの層の規則もかからず、何を参照しても依存の向きの検査を素通りする。`apps/backend/shared/` も domain / presentation に分けて置いているので、直下を許すと同じ抜け道になる（直下は許さず、4 層に置く）。
- presentation は 1 API = 1 ファイルにし、その API のリクエスト / レスポンスの型（DTO）もそのファイルの中で定義して export する。feature で共通の型ファイルは置かない。
  - 例: `list-todos.api.ts` は `listTodosApi(container)`（handler は `(request: Request) => Promise<Response>`）と `export const GET = listTodosApi(todoContainer)` を export する。動的セグメントがある `get-todo.api.ts` の handler は `(request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>`。
  - 複数の API が同じ形を返す場合（`list-todos` / `get-todo` / `create-todo` / `update-todo` が返す `TodoDto` など）も、各ファイルで定義する（共通化しない）。
  - 理由: api ファイルを 1 つ開けば、その API の契約（リクエスト / レスポンスの型）と処理がすべて見えるようにする（ユーザーの判断）。同じ形を複数回書くことになり、形を変えるときは該当する api ファイルをすべて直す必要があるが、その手間よりも 1 ファイルで契約が完結することを優先する。
- application は、読むだけで副作用のない query（`.query.ts`）と、状態を変える command（`.command.ts`）に分ける。
  - 理由: 副作用の有無をファイル名で区別し、読むだけの処理が状態を変えていないか、状態を変える処理がどれかを、開かずに見分けられるようにする。
- api ファイルは「コンテナを受け取って handler を返す関数」（`listTodosApi(container)`）を export し、本番の Route Handler はそれに `infra/container.ts` の共有コンテナ `todoContainer` を渡して作る（`export const GET = listTodosApi(todoContainer)`）。
  - 理由: テストでは `listTodosApi(createInMemoryTodoContainer())` のように空の InMemory リポジトリで組み立てた handler を使い、共有のコンテナ（`todoContainer`）に依存しないようにするため。共有のコンテナをテストで使うと、前のテストが作った Todo が残り、結果がテストの実行順に左右される。handler の中身は本番と同じものをテストする。
  - 受け取るコンテナの型は `Pick<TodoContainer, "listTodos">` のように、その API が使う query / command だけに絞る（何に依存しているかを型で読めるようにするため）。
- `presentation` は query / command を `infra/container.ts` で組み立てたコンテナからだけ受け取る。Repository の実装を直接 new しない（テストで `createInMemoryTodoContainer` を使うのは除く）。
  - 理由: 実装の切り替え（InMemory / Postgres）とトランザクションの張り方を `container.ts` の 1 か所で決めるため。
- `domain` は Next・React・DB に依存させない。
  - 理由: ビジネスルールをフレームワークや永続化の都合から切り離し、純粋な単体テストで検証できるようにする。
- `apps/backend/shared/`: feature をまたいで使う型や処理。`DomainError` は `apps/backend/shared/domain/domain-error.ts`、`TransactionRunner` の interface は `apps/backend/shared/domain/transaction-runner.ts`、環境変数の読み込みと検証は `apps/backend/shared/infra/env.ts`（`rules/code/env.md` の「環境変数」）、Postgres の接続（プール）と Drizzle の db は `apps/backend/shared/infra/database.ts`、TransactionRunner の Drizzle 実装は `apps/backend/shared/infra/drizzle-transaction-runner.ts`、DomainError → HTTP ステータスの変換・エラー時のレスポンスの型 `ErrorResponse`・リクエストの形の誤りを表す `InvalidRequestError` は `apps/backend/shared/presentation/http-error.ts`、リクエスト本文を JSON のオブジェクトとして読む `readJsonObject` は `apps/backend/shared/presentation/json-body.ts` に置く。
- 永続化は Postgres（Drizzle + node-postgres）。アプリは常に Postgres を使い、InMemory（`todo-repository.in-memory.ts`）はテスト用。詳細は下の「永続化（Drizzle + Postgres）」。
- 入力検証は手書きにする（バリデーションライブラリは入れない）。
  - 理由: 現状の規模では依存を増やすほどの必要がない。入力が複雑になったら Issue で導入を検討する。
- 入力検証の分担: presentation は入力の「形」だけを検査し、値の中身の規則は domain の不変条件に一本化する。
  - presentation（api ファイル）: 本文が JSON のオブジェクトか（`readJsonObject`）、項目の型（`title` が string か、`completed` が boolean か）。違反は `InvalidRequestError` → 400（`validation_error`）。
  - domain: 値の中身の規則（例: `title` は前後の空白を除いて 1〜100 文字。`Todo.create` / `Todo#rename`）。違反は `DomainError("validation_error")` → 400。
  - 理由: 同じ規則を presentation と domain の 2 か所に書くと、片方だけ直してずれる。どちらの違反もレスポンスは同じ 400 / `validation_error` になるので、クライアントから見た結果は変わらない。

## 永続化（Drizzle + Postgres）
Issue #57 で導入した。Todo は Postgres（`compose.yaml`）に保存する。InMemory はテスト用（Issue #59 で、`DATABASE_URL` が無いときに InMemory に切り替える分岐を削除した）。

### スキーマとマイグレーション
- テーブルの形は TypeScript で宣言する（codebase-first）。feature ごとに `apps/backend/<feature>/infra/schema.ts` に Drizzle の `pgTable` で書く（例: `apps/backend/todo/infra/schema.ts` の `todos`）。
  - 理由: テーブルの形の正を 1 か所にし、SQL はそこから生成する。手で SQL を書くと、スキーマのファイルと DB の形がずれても気づけない。
  - schema は infra に置く（テーブルの形は永続化の都合で、domain は知らない）。domain の Entity との変換は Repository の実装（`todo-repository.postgres.ts`）が行う。
- 変えるときの手順:
  1. `schema.ts` を変える。
  2. `pnpm db:generate`（`drizzle-kit generate`）で、前回のスナップショット（`apps/backend/drizzle/meta/`）との差分から SQL（`apps/backend/drizzle/<番号>_<名前>.sql`）を作る。DB には接続しない。名前は `pnpm db:generate --name <内容>` で付ける。
  3. 生成された SQL を読んで意図どおりか確かめ、`apps/backend/drizzle/` をまとめてコミットする。生成済みの SQL は手で直さない（直すと `apps/backend/drizzle/meta/` のスナップショットとずれる）。
  4. `pnpm db:migrate`（`drizzle-kit migrate`）で、DB にまだ当てていない SQL を当てる。当てた記録は DB の `drizzle.__drizzle_migrations` 表に残り、何度実行しても同じ結果になる。
- 設定は `apps/backend/drizzle.config.ts`（WHAT / WHY はファイル内のコメント）。`pnpm db:generate` / `pnpm db:migrate`（リポジトリ直下）は `pnpm --filter @repo/backend <script>` を呼び、`apps/backend` をカレントディレクトリにして `drizzle-kit ... --config drizzle.config.ts` を実行する（Issue #68 の段階 2。`apps/backend` で `pnpm db:migrate` を直接実行しても同じ）。`schema` / `out` は、drizzle-kit がカレントディレクトリからのパスとして読むので、設定ファイルの場所（`apps/backend/`）から求めたカレントディレクトリからの相対パスにしている（`apps/backend` で実行しても同じ場所を指す。2026-09-28 にリポジトリ直下と `apps/backend` の両方で generate / migrate を実測。絶対パスは generate が `./` を前に付けて ENOENT になった）。`dbCredentials.url` は `env.DATABASE_URL`（`apps/backend/shared/infra/env.ts` を相対パスで import する。drizzle-kit 自身は `.env` を読まないが、`env.ts` が読み込み時に `.env` を読む）。既定値は持たない。
- `drizzle-kit push`（DB をスキーマに直接合わせる）は使わない。
  - 理由: push は差分を DB に直接当て、SQL をファイルに残さない。どの環境にどの変更を当てたかが記録されず、レビューもできない。列の改名を「削除 + 追加」と解釈してデータを消すような変更も、SQL を読まずに当たってしまう。generate + migrate なら、当てる SQL を PR で読み、すべての環境で同じ SQL を同じ順に当てられる。
- `apps/backend/drizzle/` は Biome の対象外（`biome.json` の `files.includes`。`rules/code/lint.md`）。生成物で、整形すると次の generate で書き戻されるため。

### Repository と Executor
- Postgres の Repository（`PostgresTodoRepository`）は `Executor`（`apps/backend/shared/infra/database.ts`。Drizzle の db かトランザクションのどちらか）を受け取る。自分ではトランザクションを始めない。
  - 理由: 同じ実装を、query ではトランザクションの外（db）で、command ではトランザクションの中（tx）で使うため。どちらを渡すかは `container.ts` が決める。
- DB の行から Entity に戻すときは `Todo.restore` を使う（不変条件で検査しない。WHY は `todo.ts` のコメント）。利用者の入力から作るときは `Todo.create` / `rename` を使う。
- id 列は uuid 型。uuid の形でない id（`/api/todos/abc`）は DB に渡さず「無い」として扱う（Postgres が形の違いでエラーを返し、404 ではなく 500 になるのを防ぐ）。

### command は一律トランザクション
- `container.ts` の `createTodoContainer` が、すべての command（create / update / delete）を `TransactionRunner#run` で包む。query（list / get）は包まない。
  - 仕組み: `TransactionRunner<Tx>`（`apps/backend/shared/domain/transaction-runner.ts`）の `run(fn)` が fn に Tx を渡し、正常終了で commit、例外で rollback して例外を投げ直す。container は `repositoryFor(tx)` でその Tx を使う Repository を作り、command に渡す。query には `repositoryFor(readExecutor)` で作った Repository を渡す。
  - Postgres は `DrizzleTransactionRunner`（`db.transaction`）、InMemory は `InMemoryTransactionRunner`（実行前のスナップショットに戻す）。InMemory でも「失敗した command の変更は残らない」をそろえる。
  - command / query の本体（application 層）は Repository を受け取るだけで、トランザクションを知らない。
  - 理由: command は「全部成功するか、何も変えないか」にする。今は 1 つの command が書き込むのは 1 回だが、書き込みが増えたときに途中までの変更が残らない形を先に決めておく。包む場所を container の 1 か所にし、command ごとの付け忘れを無くす。
- 危険な点と対策:
  - トランザクションの外の Repository で書き込むと rollback されない: command には `repositoryFor(tx)` で作った Repository しか渡さない（組み立ては `container.ts` だけ。presentation は Repository を new しない）。
  - トランザクションの間は接続を 1 本占有する: command の中で外部 API の呼び出しなど遅い処理をしない（プールの接続を使い切ると、他のリクエストが接続待ちになる）。接続待ちは `DATABASE_CONNECTION_TIMEOUT_MS`（既定 5 秒）でエラーにし、無期限に固まらないようにしている。
  - 入れ子にしない: command の中から別の command（`runner.run`）を呼ばない。`DrizzleTransactionRunner` は外側の tx ではなく db から新しいトランザクションを始めるので、内側は別の接続・別のトランザクションになり、外側が rollback しても戻らない（接続も 2 本占有する）。InMemory の runner は、前の run の終わりを待つので止まったままになる。
  - 分離レベルは Postgres の既定（READ COMMITTED）: 同じ Todo を同時に更新すると、後から保存した方が勝つ（lost update）。今は許容している。防ぐ必要が出たら、`SELECT ... FOR UPDATE` か分離レベルの変更を Issue で検討する。
  - InMemory の runner は run を 1 つずつ順番に実行する（並行した run の rollback が、他の run の確定した変更を消さないようにするため）。query は待たないので、実行中の command の途中の状態が見えることがある（InMemory の限界。WHY は `in-memory-transaction-runner.ts`）。

### InMemory はテスト用のみ
- `todoContainer`（アプリ共有）は常に `createPostgresTodoContainer(getDatabase().db)` で作る。環境変数で InMemory に切り替える分岐は持たない（Issue #59）。
  - 理由: 以前は `DATABASE_URL` が無いと InMemory に落ちていたため、`.env` の書き忘れや CI での渡し忘れでも黙って動き、データが保存されないことに気づけなかった。環境変数はすべて必須にして起動時に検証する（`rules/code/env.md` の「環境変数」）。
  - そのため `pnpm dev` の前にも `pnpm db:up` と `pnpm db:migrate` が要る。
- `createInMemoryTodoContainer`（`InMemoryTodoRepository` と `InMemoryTransactionRunner`）はテスト用に残す。presentation のテストなどで、DB に接続せずに handler の振る舞いを確かめる（下の「テストの置き方」）。
  - presentation のテストなどが `container.ts` を読み込むと、`todoContainer` のためにプールを作る（接続は最初のクエリまで張らないので、DB は要求しない）。`env.ts` の検証は通る必要がある（`.env` が要る）。

### 接続とプール（暫定）
- `apps/backend/shared/infra/database.ts` が `pg.Pool` を自分で作り、`drizzle({ client: pool })` に渡す。設定は `env.ts` の `env`（`.env` / 環境変数を検証した値）から取る。変数はすべて必須で、コードに既定値は無い（`rules/code/env.md` の「環境変数」）。
  | 環境変数 | `.env.example` の値 | 意味 |
  | --- | --- | --- |
  | `DATABASE_URL` | `postgresql://app:app@localhost:5432/app` | 接続先（compose.yaml の開発用 DB） |
  | `DATABASE_POOL_MAX` | 10 | プールの最大接続数（1 以上。node-postgres の既定と同じ値） |
  | `DATABASE_POOL_IDLE_TIMEOUT_MS` | 10000 | 使われない接続を閉じるまでの時間（0 以上。node-postgres の既定と同じ値） |
  | `DATABASE_CONNECTION_TIMEOUT_MS` | 5000 | 接続待ちの上限（0 以上）。node-postgres の既定 0（無制限）だと、DB が落ちているときやプールが埋まっているときにリクエストが無期限に待つため、5 秒でエラーにする |
- 欠けている値と、数として使えない値（`abc`、負の数、小数、`DATABASE_POOL_MAX=0`）は、`env.ts` の読み込み時にまとめてエラーにする（NaN のままプールに渡すと上限が効かないため。検証は `env.test.ts`）。
- アイドル中の接続のエラー（DB の再起動など）は `pool.on("error")` でログに出すだけにし、プロセスを落とさない。
- プールはプロセスで 1 つだけ（`globalThis` に保持）。`next dev` の再読み込み（HMR）でモジュールが読み込み直されても、プールが増えて接続を使い切らないようにするため。終了時は `closeDatabase()`（`pool.end()`）。
- これらの値は開発・CI・E2E 用の暫定値。本番用の最終的な設定（接続数、タイムアウト、TLS、サーバレス環境での接続の扱いなど）は Issue #58 で決める。

### テスト
- `pnpm test` は Postgres が起動している前提（`pnpm db:up` してから実行する）。接続先は `env.DATABASE_URL`（`.env`。アプリと同じ）。
- 実 Postgres を使うテストは `createTestDatabase()`（`apps/backend/shared/infra/database.test-support.ts`）で、テストファイルごとに別のスキーマ（`test_<UUID>`）を作り、`search_path` をそこに向けて使う。マイグレーションはそのスキーマに当て（`migrate()`）、各テストの前に `TRUNCATE` し、終わったらスキーマごと消す（`close()`）。
  - 理由: Vitest はテストファイルを並列に実行し、Stryker はさらに複数のプロセスで同じテストを並行して実行する。全員が同じ `public.todos` を使うと、あるファイルの `TRUNCATE` が別のファイルの途中のデータを消す。スキーマを分ければ互いに干渉せず、`pnpm dev` や E2E が使う `public` の表も消さない。drizzle の migrator には同時実行の排他が無い（drizzle-orm 0.45.3 の `pg-core/dialect.js` の `migrate`）ので、同じスキーマに並行して当てることも避ける。
  - テストが途中で強制終了して残ったスキーマは、次の Vitest の実行の最初に globalSetup（`vitest.global-setup.ts`）が消す（`rules/code/test.md` の「テスト用スキーマの後始末（globalSetup）」）。Postgres に接続できなければ、globalSetup が `pnpm db:up` を促すエラーで止める。

## 画面側とサーバ側の境界
- 画面側で backend を参照してよいのは `apps/frontend/features/<feature>/api/` だけ。参照先は `apps/backend/<feature>/presentation/<name>.api.ts`（リクエスト / レスポンスの型）と `apps/backend/shared/presentation/`（エラー時の `ErrorResponse`）で、いずれも `import type` のみ。api ファイルの関数や、application・domain・infra の実装は import しない。
  - 理由: 画面とサーバで同じ契約（型）を使い、ずれを型チェックで検出する。`import type` はビルド時に消えるので、サーバ専用のコードが画面のバンドルに入らない。
- 画面側の他のコード（screens / components / hooks）は backend を直接参照せず、`api/` が re-export した型を使う（例: `import type { TodoDto } from "@/features/todo/api/todo-api"`）。
  - 理由: 画面とサーバの境界を `api/` の 1 ファイルに集約し、契約（型）が変わったときの影響と変更点を 1 か所で追えるようにする。
- 型で担保されること: リクエスト / レスポンスの「形」。api ファイルの型を変えると、それを使う画面側のコードの不一致が `pnpm build` の型チェックで検出される。
- 型で担保されないこと（画面側に文字列で書く）:
  - URL と HTTP メソッド（`fetch("/api/todos", { method: "POST" })` の `"/api/todos"` と `"POST"`）。`apps/frontend/app/api/**/route.ts` の置き場所や re-export するメソッドを変えても、型チェックでは検出されない。
  - 実行時の JSON の形。`response.json()` の結果を型に当てはめるだけで、実際に返ってきた値がその形かは検査しない。
  - URL を型で担保したくなったら、各 api ファイルから path の定数を export して画面側で使う案を検討する（今回は入れない）。

## 依存の向き（全体）
- frontend と backend: `apps/frontend → apps/backend` の向きだけ（Issue #68）。backend は frontend を参照しない。frontend から backend への参照は、`@repo/backend/...` の書き方（exports を通る）で、次の 3 か所だけ。
  - `apps/frontend/app/api/**`: `apps/backend/<feature>/presentation/*.api` の値（Route Handler の re-export）。
  - `apps/frontend/features/<feature>/api/`: `apps/backend/<feature>/presentation/<name>.api.ts` と `apps/backend/shared/presentation/` の `import type` だけ（上の「画面側とサーバ側の境界」）。
  - `apps/frontend/instrumentation-node.ts`（`apps/frontend/` 直下）: `apps/backend/shared/infra/env`（起動時の環境変数の検証。`rules/code/env.md`）。
- 画面側: `app → features → shared`（いずれも `apps/frontend/` の下）
- API 側: `apps/frontend/app/api → apps/backend/<feature>/presentation → application → domain`
- 画面側 → API 側: `apps/frontend/features/<feature>/` の `api/` 以外は backend を参照せず、`api/` が re-export した型を使う。
- feature 同士は原則 import しない。必要なときは相手の `index.ts` だけを import する。
- `apps/frontend/shared/` は `apps/frontend/features/` を import しない（逆向きの依存を作らない）。
- e2e/ とリポジトリ直下の設定ファイル（`playwright.config.ts`・`vitest.global-setup.ts` など）から backend への参照も、`@repo/backend/...` の書き方だけ（exports を通る）。
- 検査: ルート直下の `architecture.test.ts`（`pnpm test` に含まれ、CI の `ci` ジョブで失敗する）が、`apps/frontend/` と `apps/backend/` の全体（再帰。除くのは `node_modules/` と `.next/` だけで、ほかの `.` で始まるディレクトリも検査する）と、`e2e/` とリポジトリ直下のファイル（下の `frontend-to-backend-specifier` と `backend-exports` のため）の `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` / `.cjs`（テスト `*.test.*` は除く。JS は tsconfig の `allowJs: true` に合わせる）の import / re-export / dynamic import を抜き出し、次の規則を 1 規則 = 1 テストで検査する。違反があると「ファイル → 参照先」の一覧を出して失敗する。
  - 参照先の正規化: `@/x` は `apps/frontend/x`（backend のファイルに書いても frontend の paths が当たるため）、`@repo/backend/x` は `apps/backend/x`（`@repo/backend-extra` のような前方一致だけが同じ別パッケージは含めない。exports の値がキーのパスの `.ts` であることは `backend-exports` で検査しているので、キーのパスがそのまま参照先になる）、相対パスはファイルの位置から解決したリポジトリ相対のパス、それ以外はパッケージとして扱う。`@/` と `@repo/backend/` の後ろの `..` も解決する（`@/../backend/x` は `apps/backend/x`）。
  - `apps/frontend/`・`e2e/`・リポジトリ直下のファイルから `apps/backend/` への参照は `@repo/backend/...` の書き方だけ（規則 `frontend-to-backend-specifier`。Issue #68 の段階 2）。相対パス（`../backend/...`・`./apps/backend/...`）と `@/../backend/...` は、参照先がほかの規則で許される場所でも違反。例外は `vitest.global-setup.ts` から `apps/backend/shared/infra/database.test-support` への相対参照だけ（上の「exports」の「テスト基盤は公開しない」）。参照先が backend のものだけを見るので、frontend の中の参照（`@/...`・`./x`）は対象外。
  - `apps/backend/package.json` の `exports`（規則 `backend-exports`。Issue #68 の段階 2。上の「exports」）: (1) 外（apps/backend の外）の `@repo/backend/<path>` の参照は、すべて exports のキーに当たる（Node.js の解決と同じく、完全一致を優先し、次に `*` の前が最も長いパターン）、(2) 各キーは外から 1 か所以上で参照されている、(3) キーは `./` で始まり、値はキーのパスに `.ts` を付けた文字列、(4) キーが指すファイルがある（パターンなら当たるファイルが 1 つ以上）。違反は「参照元 → specifier」か「apps/backend/package.json の exports "キー" …」の行で出す。本番の検査では、exports を 1 件以上読めることと、apps/frontend・e2e/・リポジトリ直下の `@repo/backend` の参照を取り出せていることも確かめる（読み込みや列挙が壊れて素通りするのを防ぐ）。
  - `apps/backend/` は `apps/frontend/` を参照しない（規則 `backend-to-frontend`。Issue #68）。4 層の規則は層の下のファイルにしかかからないので、`apps/backend/` 直下の `drizzle.config.ts` からの参照もこの規則で止める。
  - `apps/backend/` の中の import は相対パスだけで、`@/` と `@repo/backend/` を使わない（規則 `backend-relative-only`。Issue #68）。参照先ではなく書き方（specifier）で判定する（`@repo/backend/x` と `../x` は同じファイルを指すため）。
  - `apps/frontend/` 直下のファイルが `apps/backend/` を参照するときは `apps/backend/shared/infra/env` だけ（規則 `frontend-root-to-backend`。Issue #68）。
  - `apps/frontend/features/<f>/` の `api/` 以外と `apps/frontend/shared/` は `apps/backend/` を参照しない。
  - `apps/frontend/features/<f>/api/` から `apps/backend/` への参照は `import type` / `export type` だけで、参照先は自 feature の `apps/backend/<f>/presentation/*.api` か `apps/backend/shared/presentation/` だけ。
  - 別の feature を参照するときは `apps/frontend/features/<other>`（`apps/frontend/features/<other>/index`）だけ。
  - `apps/frontend/features/` と `apps/frontend/shared/` は `apps/frontend/app/` を参照しない（`app → features → shared` の向き）。
  - `apps/frontend/shared/` は `apps/frontend/features/` を参照しない。
  - backend の 4 層は許可の一覧（上の「`apps/backend/<feature>/`」の表）で検査する。自前コードは、自 feature か `apps/backend/shared/` の、参照元の層が参照してよい層だけ。パッケージは `next` / `react` / `react-dom`（サブパスを含む）以外を許す。
    - `apps/backend/<f>/domain/`: `domain/`。
    - `apps/backend/<f>/application/`: `domain/`・`application/`。
    - `apps/backend/<f>/presentation/`: `application/`・`domain/`（feature の domain は `import type` だけ。`apps/backend/shared/domain/` は値でも可）・`presentation/`・自 feature の `infra/container` だけ（他 feature の container は不可）。
    - `apps/backend/<f>/infra/`: `domain/`・`application/`・`infra/`。
  - `apps/backend/` の `domain/`・`application/`（`apps/backend/shared/` を含む）は DB のパッケージ（`drizzle-orm` とそのサブパス、`pg`）を参照しない（`import type` も不可）。上の許可の一覧はパッケージを `next` / `react` / `react-dom` 以外すべて許すので、DB への依存を infra に閉じ込めることは別の規則（`core-to-persistence`）で検査する。前方一致だけが同じ別パッケージ（`pg-format` など）は対象外。DB のパッケージを足したら `architecture.test.ts` の `PERSISTENCE_PACKAGES` にも足す。
  - `apps/backend/shared/` が参照してよい自前コードは `apps/backend/shared/` の中だけ。`next` / `react` / `react-dom` も参照しない。
  - `apps/backend/` のソースファイルは `apps/backend/<x>/` の `domain/`・`application/`・`presentation/`・`infra/` のどれかの下に置く（置き場所の検査 `backend-placement`。参照の有無に関係なく違反）。例外は `apps/backend/` 直下の `<name>.config.<拡張子>`（`drizzle.config.ts`）だけ。
  - `apps/frontend/` のソースファイルは `app/`・`features/`・`shared/` の下か、直下の `next.config.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`next-env.d.ts` だけに置く（置き場所の検査 `frontend-placement`。Issue #68 の reviewer 指摘）。理由: 依存の規則は `app/`・`features/`・`shared/` と直下のファイルにしかかからず、`apps/frontend/lib/db.ts` のような場所から backend の container を値で import しても素通りしていたため。
  - `apps/frontend/app/`（`apps/frontend/app/api` 以外）が `apps/frontend/features/` / `apps/backend/` / `apps/frontend/shared/` を参照するときは `apps/frontend/features/<f>`（`apps/frontend/features/<f>/index`）か `apps/frontend/shared/` だけ（`apps/backend/` と feature の深いパスは不可）。パッケージ（`next` / `react` など）と、`apps/frontend/app/` の中の相対参照（`import "./globals.css"` など）は検査しない。
  - `apps/frontend/app/api/` が参照してよいのは `apps/backend/<x>/presentation/*.api` だけ。
  - 規則の判定そのものも、規則ごとに「違反になる例」「ならない例」を架空の参照で 3 件以上ずつ固定している（`architecture.test.ts` の「規則ごとの判定」）。今のコードに違反が無いことだけでは、規則が緩すぎても気づけないため。
  - さらに、一時ディレクトリに架空のツリーを作って実ファイルを置き、本番と同じ列挙 → 抽出 → 正規化 → 判定（`collectViolations(root)`）に通す fixture テストがある（同ファイルの「fixture のツリーを検査したときに検出される違反」）。
    - must-reject: 依存の 17 規則と置き場所の 2 規則、`backend-exports` の (1)〜(4) それぞれの違反を、alias（`@/`・`@repo/backend/`）と相対パス、値の import / `import type` / inline の `type` / `export { X } from` / `export type { X } from` / dynamic `import()` / 副作用だけの import、`.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` / `.cjs` で置き、前方一致の境界（`apps/backend/shared-x`、`apps/frontend/app/api-x`、`apps/frontend/features/todo-extra`）やパスに `test` を含む本番のファイルも含めて、検出される「規則: ファイル → 参照先」の一覧を丸ごと比較する（見逃しも余分な検出も失敗にする）。
    - must-pass: 許可される参照を網羅したツリーで違反 0 件を確かめる。今のリポジトリの本番コードの参照（参照元・参照先・型だけか）はすべて含めている。コメント・文字列の中の import 風の文字列、テストファイル、TS / JS 以外のファイル、生成物・依存（`apps/frontend/.next/`・`apps/backend/node_modules/`）の中の違反も置く。
    - 理由: 抽出の取りこぼし（書き方によって import を拾えない）は、規則が正しくても違反の見逃しになる。1 件の参照を規則に渡すだけのテストではそこを検証できない。
  - 環境変数の直参照（規則 `env-direct-access`。Issue #59）: `process.env` を読んでよいのは `apps/backend/shared/infra/env.ts` だけ（例外は `apps/frontend/instrumentation.ts` の `NEXT_RUNTIME` だけで、変数の名前まで絞っている）。対象は依存の向きの検査と同じファイル（`apps/frontend/next.config.ts`・`apps/backend/drizzle.config.ts` を含む）に、`e2e/` のソースとリポジトリ直下の設定・セットアップファイルを足したもの（テストは除く）。依存の向きとは別に、ソースの中身（`process.env` / `process["env"]` など）で判定し、「ファイル:行」を出して失敗する。判定の例（`ENV_ACCESS_EXAMPLES`）と fixture の must-reject / must-pass も持つ。規則の中身・限界（分割代入は拾わない）・Biome の `noProcessEnv` との二重化の理由は `rules/code/env.md` の「環境変数」。
  - 規則は全部で 21（依存の 17 規則 `RULES` + 置き場所 `BACKEND_PLACEMENT`・`FRONTEND_PLACEMENT` + 環境変数の直参照 `ENV_DIRECT_ACCESS` + exports の `BACKEND_EXPORTS`）。`RULES` のすべての規則に判定の例（`RULE_EXAMPLES`）があることもテストで確かめる。exports のキーの照合（`resolveExportKey`）とキーごとの違反（`findExportsViolations`）にも、当たる例・当たらない例と違反の例を持つ。
  - 段階 1 の限界（frontend から backend を相対パスで参照しても、参照先が許される場所なら違反にしない）は、段階 2 の `frontend-to-backend-specifier` で解消した。
  - 限界: `frontend-to-backend-specifier` と `backend-exports` が参照を取り出すのは `apps/`・`e2e/`・リポジトリ直下のファイルだけで、リポジトリ直下のほかのディレクトリ（`scripts/*.ts` のテスト以外など）は見ない。今は該当するソースが無い（`scripts/` はシェルスクリプトとテストだけ）。足すときは `architecture.test.ts` の `listReferencingFiles` と fixture も直す。
  - テストを対象外にする理由: テストは組み立てのために規則の外側を参照する（presentation のテストが infra の InMemory リポジトリを使うなど。上の「テストの置き方」）。
  - 抽出は正規表現で行う（依存は足さない）。コメントと文字列リテラルの中の import 風の文字列は除く。dynamic import は ``import(`x`)``（`${}` 無し）と第 2 引数つきの `import("x", { with: ... })` も拾う。限界: 正規表現リテラルやテンプレートリテラルの入れ子はコメント・文字列の区切りを誤認しうる、`${}` の中の `import()`、`${}` を含むテンプレートリテラルを渡した ``import(`@repo/backend/${name}`)``（参照先を静的に決められない）、`}` の直後に同じ行で続けた `export ... from` は拾わない（見逃す方向）、型の位置の `import("x").T` は値の参照として数える（多く検出する方向）（詳細と WHY は `architecture.test.ts` のコメント。抽出の仕様は同ファイルの「参照の抽出」「参照先の正規化」のテストで固定している）。
  - この節や上の「画面側とサーバ側の境界」「`apps/backend/<feature>/`」の依存の規則を足す・変えるときは、`architecture.test.ts` の `RULES` と `RULE_EXAMPLES`（判定の例）、置き場所の規則 `BACKEND_PLACEMENT` と `PLACEMENT_EXAMPLES`、fixture の must-reject / must-pass（`MUST_REJECT_FILES` / `MUST_REJECT_VIOLATIONS` / `MUST_PASS_FILES`）も合わせて直す。本番コードに新しい import の形（新しい層の組み合わせや書き方）を足したときも、must-pass に同じ形を足す。
  - Biome の `noRestrictedImports` を使わなかった理由: `import type` だけを許すことを表現できない（Biome 2.5.13 で、制限したパスへの `import type` も違反になることを実測。Issue #47）。また参照元のディレクトリごとに制限を変えるには feature・層ごとに `overrides` を書く必要があり、feature を足すたびに `biome.json` を直すことになる。
  - テストの書き方の要件（must pass / must reject、fault injection）は `rules/code/test.md`。

## 命名
- ディレクトリとファイル: kebab-case（例: `todo-screen/`、`create-todo.command.ts`、`todo-repository.in-memory.ts`）。
- コンポーネントと型: PascalCase（例: `TodoScreen`、`TodoDto`）。
- hook: `use` 始まり（例: `useTodoScreen`）。
- api ファイル・query・command: `<verb>-<noun>`（例: `list-todos`、`get-todo`、`create-todo`、`update-todo`、`delete-todo`）に役割の接尾辞を付ける。
- 役割を表す接尾辞はファイル名の `.` の後ろに付ける（`.hook.ts`、`.api.ts`、`.query.ts`、`.command.ts`、`.in-memory.ts`、`.test.ts(x)`）。

## テストの置き方
テストは対象と同じディレクトリに `<対象>.test.ts(x)` で置く（例: `create-todo.api.test.ts`、`list-todos.query.test.ts`、`create-todo.command.test.ts`）。

| 対象 | テストの方法 | 環境 |
| --- | --- | --- |
| `apps/backend/**/domain` | 純粋な単体テスト | Node |
| `apps/backend/**/application`（`.query.ts` / `.command.ts`） | InMemory リポジトリを渡して検証 | Node |
| `apps/backend/**/infra` の Postgres の実装（`*.postgres.ts`、`drizzle-transaction-runner.ts`、`database.ts`） | 実 Postgres（compose.yaml）に対して実行する。`createTestDatabase()`（`apps/backend/shared/infra/database.test-support.ts`）でテストファイルごとの別スキーマを作り、マイグレーションを当て、各テストの前に `TRUNCATE` する | Node |
| `apps/backend/**/presentation`（`.api.ts`） | 空の InMemory リポジトリで組み立てた handler（`listTodosApi(createInMemoryTodoContainer())`）に `new Request()` を渡し（動的セグメントがあれば `ctx` も）、返る `Response` を検証。共有の `todoContainer` は使わない（上の「`apps/backend/<feature>/`」）。Next の起動は不要 | Node |
| `apps/frontend/features/**/*.hook.ts` | `renderHook` で状態とイベントを検証 | jsdom |
| `apps/frontend/features/**/*-screen.tsx` | render して操作（クリック・入力）し、表示を検証 | jsdom |
| 画面から API まで通した動作（`e2e/*.spec.ts`） | Playwright で本番ビルドを起動し、ブラウザ（Chromium）で画面を操作して表示を検証 | Chromium |

- `apps/backend/` のテストはファイル先頭に `// @vitest-environment node` を書き、Node 環境で実行する。画面側のテストは `vitest.config.mts` の既定（jsdom）で実行する。
  - 理由: サーバのコードはブラウザ上では動かないため、DOM のない Node 環境で検証する。ファイル単位のコメントで環境を切り替えられることは、Vitest 5.0.1 で実測済み（既定を jsdom にした状態で、このコメントを付けたテストでは `document` が undefined、付けないテストでは object になった）。
- Route Handler は Web 標準の `Request` / `Response` で書ける（`15-route-handlers.md` の「Route Handlers」）ため、api ファイルの handler は Next を起動せずに `Request` → `Response` の関数としてテストできる。

### カバレッジ
- `pnpm test`（`vitest run --coverage`）は単体テストのカバレッジを計測し、Statements / Branches / Functions / Lines のいずれかが 100% を下回ると失敗する。CI の `ci` ジョブもこの `pnpm test` を実行するので、100% 未満では PR をマージできない。設定は `vitest.config.mts` の `coverage`（WHY はファイル内のコメント）。
- カバレッジなしで速く回したいときは `pnpm test:unit`（`vitest run`）。完了前には必ず `pnpm test` を通す。
- 計測対象: `apps/frontend/features/` `apps/frontend/shared/` `apps/backend/` の `.ts` / `.tsx` と `scripts/` の `.ts`（テスト `*.test.ts(x)` と型宣言 `*.d.ts`、`apps/backend/` 直下の設定ファイル `*.config.ts` は除く）。
- 計測しないもの（ユーザー判断、Issue #45）:
  - `apps/frontend/app/`: ルーティングだけで、テストを置かない方針（上の「`apps/frontend/app/`（ルーティング）」）。結線は E2E で確かめる。
  - 設定ファイル（リポジトリ直下の `playwright.config.ts` など、`apps/frontend/next.config.ts`、`apps/backend/drizzle.config.ts`）: ツールに渡す値を並べるだけで、単体テストで検証する振る舞いを持たない。
  - `apps/frontend/instrumentation.ts` / `apps/frontend/instrumentation-node.ts`: `next start` / `next dev` の起動でだけ動き、失敗時にプロセスを終える。起動時に止まることは実測で確かめ、検証の中身は `env.ts` のテストで固定している。
  - `scripts/` のシェルスクリプト（`.sh`）: V8 のカバレッジは JS しか計測できない（include に入れても解析に失敗して自動で外される）。
- 100% に満たないときは、テストを足して埋める。`/* v8 ignore */` などのコメントで計測から外すことはしない。
  - 理由: テスト = 仕様なので、テストが通らないコードは仕様のないコードになる。ignore で逃がすと数字だけが 100% になり、仕様の抜けが見えなくなる。
  - 分岐を通すだけのテストにしない。その分岐で起きること（返り値・状態・呼び出し）を検証する。
  - 計測の対象外を増やすときは、上の方針に当てはまることを確かめ、`vitest.config.mts` とこの節に理由を書く。

### E2E テスト（Playwright）
- 置き場所: ルート直下の `e2e/` に `<feature>.spec.ts` で置く（例: `e2e/todo.spec.ts`）。対象の隣には置かない。
  - 理由: E2E は画面・API・ルーティングをまたいで 1 つの操作の流れを検証するもので、特定のファイルに対応しない。
- 実行: `pnpm test:e2e`（`playwright test`）。設定は `playwright.config.ts`。`webServer` が `pnpm build && pnpm start -p 3100`（`pnpm --filter @repo/frontend` 経由で、`apps/frontend` の `next build` と `next start -p 3100`）で本番ビルドを起動してからテストする（ローカルで 3100 番にサーバが起動済みなら、それを使う）。`pnpm test`（Vitest）には含めない（`vitest.config.mts` で `e2e/**` を除外）。
- E2E は Postgres で動かす（アプリは常に Postgres）。`playwright.config.ts` が `webServer.env` に `env.DATABASE_URL`（`.env` / 環境変数を `env.ts` で検証した値）を渡し、テスト側（`e2e/database.ts`）も同じ `env.DATABASE_URL` に接続する。必須の変数が欠けていれば、`playwright.config.ts` の読み込み（`env.ts`）でサーバを起動する前に失敗する。
  - 理由: E2E は利用者に届く構成（Postgres に保存する）を検証する。テストの中でも、画面で追加した Todo が DB に行として入っていることを直接確かめる。サーバとテストが同じ値を使うので、コマンドの前に付けた `DATABASE_URL` で接続先を変えても両者がずれない。
  - 前提: Postgres が起動していて（`pnpm db:up`）、マイグレーションを当ててある（`pnpm db:migrate`）こと。`webServer.command` の中では当てない（Issue #57 の方針）。CI とクラウドのフックは E2E の前に `pnpm db:migrate` を実行する。
  - 注意: ローカルで `reuseExistingServer` により 3100 番の起動済みサーバを使うときは、そのサーバの環境変数のまま動く。別の `DATABASE_URL` で起動したサーバが残っていると、DB の確認で失敗する。
- 各テストの前に `todos` を空にする（`test.beforeEach` で `e2e/database.ts` の `resetTodos()` が `TRUNCATE todos`）。データの冪等性はこれで担保する。title に実行時刻を付けてユニークにしているのは補助（リセットが効かなかったときに、失敗の原因を分かりやすくする）。
  - 理由: Postgres のデータはサーバを起動し直しても残る。前のテストや、途中で失敗した前回の実行のデータが一覧に出ると、結果が実行順や過去の実行に左右される。
- 1 テストで CRUD を一周する（追加 → 完了 → 詳細で title を変更 → 一覧から削除）。
  - 理由: `webServer` の 1 プロセスと 1 つの Postgres を全テストが共有する（`workers: 1` で順番に実行）。1 本の中の操作の順序で状態を担保する。
- Chromium のビルド: `@playwright/test` が要求するビルドと、環境に入っているブラウザが一致しないときは、環境変数 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` に Chromium の実行ファイルを渡す（例: クラウド VM では `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e`）。CI では `pnpm exec playwright install --with-deps chromium`（OS の依存ライブラリも入れる）、ローカルでは `pnpm exec playwright install chromium` で版の合ったブラウザを入れ、この変数は使わない。
  - 理由: クラウド VM の `/opt/pw-browsers` にある Chromium はビルド 1194 で、`@playwright/test@1.63.0` の要求（1243）と一致しない。変数なしで実行すると、Playwright が 1243 の実行ファイル（`/opt/pw-browsers/chromium_headless_shell-1243/...`）を探して `Executable doesn't exist` で失敗し、この変数で 1194 の Chromium（141）を渡すと通った（2026-09-28 実測）。

## 採用しなかった案
- `apps/frontend/app/` 内に `_components` などの private folder を置き、ルート単位でコードを分ける構成（公式の「Split project files by feature or route」）: URL とコードの置き場所が結びつき、ルートを移動・改名するとコードも動かすことになる。
- `components/` `hooks/` `lib/` を最上位に並べる層別の構成: 1 つの機能のコードが層をまたいで散り、機能の追加・削除で複数のディレクトリを触ることになる。
- `src/` の下に置く構成: ユーザーの判断で不要。`apps/frontend/` `apps/backend/` の直下に置く。
- API を別プロセス（Hono + `@hono/node-server`、Next の `rewrites`、契約用の `packages/contracts`、2 サーバ）にする案（Issue #68 の最初の調査）: ユーザーの指示でプロセスは増やさない方針に変え、取り下げた（実測結果は `logs/2026-09-28.md`）。
- frontend から backend を tsconfig の paths の `@backend/*` のような独自の別名で参照する案（Issue #68）: 段階 2 の workspace パッケージでは import の書き方を変える必要がある。パッケージ名の形（`@repo/backend/*`）にしておけば、段階 1 は paths、段階 2 はパッケージで、同じ書き方のまま解決できる。
- `apps/backend/package.json` の `exports` を `"./*": "./*.ts"`（全ファイル公開）にする案（Issue #68 の researcher の推奨）: 境界は `architecture.test.ts` で守れるが、ユーザー判断で、公開する入口だけを明示する形にした（公開の範囲をパッケージの設定そのもので読めるようにし、型チェック・ビルドでも公開外の import を止める）。
- 段階 2 でも tsconfig の paths に `@repo/backend/*` を残す案: paths は exports より先に解決に使われ、公開していないファイルも型チェックを通る（exports を明示した意味がなくなる）ため、paths から外した。
- `apps/frontend/features/<feature>/` の中に `client/` と `server/` を並べる構成: 同じ feature ディレクトリに `"use client"` のコードとサーバ専用のコードが混在し、画面からサーバの実装を import する誤りが起きやすい。API 側は `apps/backend/` として最上位で分離する。
- 依存の向きの検査に dependency-cruiser を使う案: 18.4.0（2026-09-28 時点の latest）は `supportedTranspilers.typescript` が `>=2.0.0 <7.0.0` で、本リポジトリの TypeScript 7.0.2 が範囲外（npm レジストリの 18.4.0 のメタデータで確認）。`import type` の区別や層ごとのルールは書けるので、TS 7 に対応したら再検討する。
- 旧案（Issue #39 の最初の案）: API 側のディレクトリ名を `server/` にし、presentation に feature 共通の型ファイル `dto.ts` と、複数の API をまとめたコントローラを置き、application のユースケースを `.use-case.ts` の 1 種類にする構成。ユーザーの判断で、ディレクトリ名は `apps/backend/`、presentation は 1 API = 1 ファイル（型もその中で定義）、application は query / command に分ける形に変えた。

## 一次情報
- Next.js 16.3.6 同梱ドキュメント `node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md`
  - 「Organizing your project」: Next.js はプロジェクトの構成について unopinionated。
  - 「Store project files outside of `app`」（「Examples」の中）: コードをプロジェクトのルート直下の共有フォルダに置き、`app/` をルーティング専用にする構成。本リポジトリはこれを feature 単位にし、API 側を `apps/backend/` に分けたもの。
  - 「Private folders」: `_folderName` はルーティングから外れる。本リポジトリでは `apps/frontend/app/` の外にコードを置くため使わない。
  - 「Route groups」: `(folderName)` は URL に含まれない。ルーティングの整理の仕組みで `apps/frontend/app/` の中で完結し、コードの置き場所には関係しない。
  - 「Split project files by feature or route」（「Examples」の中）: 採用しなかった案の 1 つ目。
- 同 `15-route-handlers.md`
  - 「Route Handlers」: Web 標準の Request / Response API で書く。Route Handler は `apps/frontend/app/` の中でだけ使える（api ファイルの関数を `apps/frontend/app/api/**/route.ts` で re-export する理由）。
  - 「Route Context Helper」: 動的セグメントの `params` は `await ctx.params` で取り出す。
- 同 `node_modules/next/dist/docs/01-app/02-guides/static-exports.md` の「Route Handlers」「Unsupported Features」「Browser APIs」、`02-guides/lazy-loading.md` の「Skipping SSR」（`ssr: false`）。
