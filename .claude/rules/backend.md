---
paths:
  - "apps/backend/**"
---

# backend（API 側。apps/backend）

`apps/backend/` は workspace パッケージ `@repo/backend`。Next・React に依存しない TypeScript で、サーバの起動口は持たない（Next の Route Handler から呼ばれる）。
依存の向きの規則はすべて `rule-tests/architecture.test.ts` が検査する（規則の一覧は `.claude/rules/architecture-check.md`）。決定と採用しなかった案は ADR（`docs/adr/README.md` の一覧）、実測は 2026-09-28 の work-logs。

## 置き場所（DDD 4 層）
- ファイルは `apps/backend/<feature>/`（`apps/backend/shared/` を含む）の `domain/` `application/` `presentation/` `infra/` のどれかの下に置く。例外は `apps/backend/` 直下の設定ファイル `<name>.config.ts`（今は `drizzle.config.ts`）と `drizzle/`（生成したマイグレーション）。
  - WHY: 層に属さない場所のファイルにはどの層の規則もかからず、依存の向きの検査を素通りする（規則 `backend-placement`）。
- `apps/backend/shared/`: feature をまたぐもの。`domain/domain-error.ts`（DomainError: `validation_error` / `not_found`）、`domain/transaction-runner.ts`（TransactionRunner の interface）、`presentation/http-error.ts`（DomainError → HTTP ステータス、`ErrorResponse`・`ErrorIssue`、`InvalidRequestError`）、`presentation/json-body.ts`（`requestBodySchema`・`parseJsonBody`）、`presentation/resource-id.ts`（`parseUuidParam`: 動的セグメントの id が uuid の形でなければ 404）、`infra/database.ts`（プールと Drizzle の db、`Executor`）、`infra/drizzle-transaction-runner.ts`。
- 環境変数の唯一の入口 `env.ts` とログの唯一の出口 `logger.ts` は、frontend と backend で共通の workspace パッケージ `apps/shared`（`@repo/shared`）にある（Issue #90。`.claude/rules/shared.md`）。backend からは `@repo/shared/env`・`@repo/shared/logger` で使う。

| 層 | 置くもの | 参照してよい先（許可の一覧。無いものは不可） |
| --- | --- | --- |
| `presentation/` | api ファイル（1 API = 1 ファイル `<verb>-<noun>.api.ts`）。コンテナを受け取って handler を返す関数（`listTodosApi(container)`）、本番用の HTTP メソッド名の定数（`export const GET = listTodosApi(todoContainer)`）、その API のリクエスト / レスポンスの型 | 自 feature と shared の `application`、`domain`（feature の domain は `import type` のみ。shared の domain は値でも可）、`presentation`、自 feature の `infra/container.ts`（コンテナの型と本番用のコンテナだけ）、`@repo/shared/logger`。パッケージは `next` / `react` / `react-dom` 以外 |
| `application/` | ユースケース 1 つ = 1 ファイル。読むだけは `<verb>-<noun>.query.ts`、状態を変えるものは `<verb>-<noun>.command.ts` | 自 feature と shared の `domain`・`application`。パッケージは `next` / `react` / `react-dom` と DB（`drizzle-orm` とサブパス、`pg`。型だけでも不可）以外 |
| `domain/` | Entity / Value Object / Repository の interface | 自 feature と shared の `domain` だけ。パッケージは application と同じ制限（`node:crypto` などは可） |
| `infra/` | Repository の実装、Drizzle のスキーマ `schema.ts`、TransactionRunner の実装、`container.ts`（DI） | 自 feature と shared の `domain`・`application`・`infra`、`@repo/shared/env`・`@repo/shared/logger`。パッケージは `next` / `react` / `react-dom` 以外 |

- 向き: `apps/frontend/app/api → presentation → application → domain`。infra は domain の interface を実装する（依存性の逆転）。他 feature・`apps/frontend/`・層に属さない場所は参照しない。
  - WHY 許可の一覧にする: 禁止の一覧だと、書き忘れた参照先が黙って通る。
- `apps/backend/shared/` が参照してよい自前コードは shared の中と `apps/shared`（`@repo/shared`）だけ（層の許可にも従う）。`next` / `react` / `react-dom` も不可。
- `apps/shared` を使ってよい層は、移す前（`backend/shared/infra` にあったとき）と同じ: infra は env・logger、presentation は logger だけ、domain・application は使わない（`rule-tests/architecture.test.ts` の `SHARED_MODULES_BY_LAYER`）。WHY: env・logger は外の世界（環境変数・stdout）に触る基盤で、domain・application から使うと infra を参照させない意味が無くなる。
- domain は Next・React・DB に依存させない。WHY: ビジネスルールを永続化やフレームワークから切り離し、純粋な単体テストで検証する。

## import の書き方と公開の範囲（exports）
- backend の中の import は相対パスだけ（`@/` と `@repo/backend/` は使わない。規則 `backend-relative-only`）。`apps/shared` は別のパッケージなので `@repo/shared/...` だけで書く（相対パスの `../../../shared/env` は違反。`apps/backend/package.json` に `"@repo/shared": "workspace:*"`。Issue #90）。
  - WHY `apps/shared` へ相対パスを使わない: exports を経由しない参照を許すと、`apps/shared` の公開範囲（exports。規則 `shared-exports`）が意味を持たなくなる（frontend・e2e と同じ扱い）。
  - WHY `@/` 不可: Next（Turbopack）は backend のファイルの `@/` にも frontend の paths を当て、ビルドが失敗する。
  - WHY `@repo/backend/` 不可: 自パッケージ名の参照は `exports` を通り、公開していない内部のファイルを指せなくなる。
- 外（apps/frontend・apps/e2e/・リポジトリ直下の設定）が使ってよいのは `apps/backend/package.json` の `exports` に書いたファイルだけ。全ファイル（`"./*"`）は公開しない（ユーザー判断）。
  - 今のキー: `./todo/presentation/*.api`（Route Handler と画面側の型）、`./shared/presentation/http-error`（`ErrorResponse`）。env・logger は Issue #90 で `apps/shared` に移し、キーを消した（`@repo/shared` の exports）。
  - 値はキーのパスに `.ts` を付けた TS のソース（ビルドしない）。feature を足したら `./<feature>/presentation/*.api` を足す。それ以外は 1 ファイルずつ。使わなくなったキーは消す（規則 `backend-exports` が過不足を止める）。
  - テスト基盤（`shared/infra/database.test-support`）は公開しない。`vitest.global-setup.ts` からだけ相対パスで読む（唯一の例外）。
- 依存（`package.json`）: backend のコードが import するもの（`drizzle-orm` / `pg` / `zod` / `@repo/shared`、devDependencies に `drizzle-kit` / `@types/pg`）を `apps/backend/package.json` に置く（`.claude/rules/dependencies.md`）。
- `apps/backend/tsconfig.json` は Next の plugin・jsx・DOM の型を持たない（backend 単体の型チェック。`Response#json()` は `unknown` なのでテストでは `as` で型を付ける）。`pnpm typecheck` が検査する。

## presentation（api ファイル）
- 1 API = 1 ファイルにし、その API のリクエスト / レスポンスの型（DTO）もそのファイルで定義して export する。複数の API が同じ形（`TodoDto` など）を返しても各ファイルで定義する（共通の型ファイルを置かない）。
  - WHY: api ファイルを 1 つ開けば契約と処理がすべて見える（ユーザー判断）。形を変えるときに複数ファイルを直す手間より優先する。
- handler は `(request: Request) => Promise<Response>`。動的セグメントがあれば `(request, ctx: { params: Promise<{ id: string }> })` で、`await ctx.params` は api ファイル側で行う。
- 「コンテナを受け取って handler を返す関数」を export し、本番は共有の `todoContainer` を渡して作る。受け取る型は `Pick<TodoContainer, "listTodos">` のように使うものだけに絞る。
  - WHY: テストでは `listTodosApi(createInMemoryTodoContainer())` で組み立て、共有のコンテナ（前のテストのデータが残る）に依存しない。
- query / command は `infra/container.ts` で組み立てたコンテナからだけ受け取る。Repository を直接 new しない（テストで `createInMemoryTodoContainer` を使うのは除く）。WHY: 実装の切り替えとトランザクションの張り方を 1 か所で決める。
- 入力検証は zod で統一する（Issue #88。以前の「手書き」は撤回）。分担は変えない:
  - presentation は「形」だけ: 各 api ファイルにリクエストの zod スキーマを置き（`requestBodySchema({ 項目: z.string({ error: "..." }) })`）、`parseJsonBody(request, schema)` で読む。違反は `InvalidRequestError`（`issues` 付き）→ 400（`validation_error`、`ErrorResponse` の `error.issues` に `{ path, message }` の一覧）。型は `z.infer` でスキーマから導出する。
    - 未知のキーは拒否する（`z.strictObject`）。WHY: 部分更新で項目名を打ち間違えた本文が「何も変えない」200 に化ける。画面と API は同時に変えるので互換性の心配は無い。
    - 動的セグメントの `id` は `z.uuid()` で確かめ、形が違えば 404（`not_found`。無い Todo と同じ契約）。本文より先に確かめる。
  - 値の中身の規則（例: `title` は前後の空白を除いて 1〜100 文字。文字数はコードポイント数で、zod の `.min` / `.max`（`String#length`）は使わない）は domain の zod スキーマ（`todo.ts` の `todoTitleSchema`）に一本化。`Todo` のコンストラクタがそれで検証し、違反は `DomainError("validation_error", message)` → 400（`issues` は付かない）。
  - 完全コンストラクタ: `Todo` の private コンストラクタが毎回、値のすべてを `todoPropsSchema`（Todo の不変条件）で検証する。`create` / `reconstruct`（DB の行）/ `rename` / `changeCompletion` はコンストラクタに値を渡すだけで、口ごとに検証の範囲を分けない（Issue #94。Issue #88 の「restore は検証しない」を撤回）。WHY: 「Todo 型の値 = 不変条件を満たす値」が常に成り立つ。規則を変えるときは既存のデータを移行（スキル `db-migration`）して追従する。branded 型は使わない（Todo 型そのものが不変条件を満たす値を表すため。`todo.ts` のコメント）。
  - スキーマは関数の中で作る（最上位の定数にしない）。WHY: static な変異になり mutation testing で数えない（`stryker.config.mjs` の `ignoreStatic`）。
  - WHY zod: 規則の宣言と型の導出を 1 か所にし、項目ごとの誤り（`issues`）をレスポンスに出せる。同じ規則を 2 か所に書くと片方だけ直してずれるので、presentation に値の規則は書かない（どちらもクライアントからは同じ 400）。決定と採用しなかった案は ADR `docs/adr/20260929-zod-for-backend-validation.md`。zod 4.6.5 の実測（2026-09-29）: `.min` / `.max` は `String#length` なのでコードポイント数は `refine` と `Array.from` で数える（`"🍎".repeat(100)` は length 200）。`z.uuid()` は RFC 9562 の形（版の桁 1〜8、variant 8 / 9 / a / b、nil と max）だけを受け付け、大文字も通す（Postgres の uuid 型より狭く、版の桁が 0 の値は拒否する。Todo の id は `randomUUID`（v4）なので影響しない。広い `z.guid()` は採らなかった）。

## application
- 読むだけ（副作用なし）は query、状態を変えるものは command に分ける。WHY: 副作用の有無をファイル名で見分ける。

## 永続化（Drizzle + Postgres）
- アプリは常に Postgres（Drizzle + node-postgres）。InMemory（`todo-repository.in-memory.ts`・`InMemoryTransactionRunner`）はテスト用。
  - `todoContainer` は常に `createPostgresTodoContainer(getDatabase().db)`。環境変数で InMemory に切り替える分岐は持たない（Issue #59）。WHY: 以前は `DATABASE_URL` が無いと InMemory に落ち、書き忘れでもデータが保存されないまま動いた。
  - そのため `pnpm dev` の前にも `pnpm db:up` と `pnpm db:migrate` が要る。`container.ts` を読み込むテストは `.env` が要る（プールは作るが、接続は最初のクエリまで張らない）。
- スキーマは feature ごとの `infra/schema.ts` に `pgTable` で宣言する（codebase-first）。SQL は `pnpm db:generate` で生成し、`pnpm db:migrate` で当てる。生成済みの SQL は手で直さない。`drizzle-kit push` は使わない（SQL が残らずレビューも記録もできない）。手順はスキル `db-migration`。
  - schema は infra に置く（テーブルの形は永続化の都合で、domain は知らない）。Entity との変換は Repository の実装が行う。
- `PostgresTodoRepository` は `Executor`（db かトランザクション）を受け取り、自分ではトランザクションを始めない（query は db、command は tx で同じ実装を使うため）。
- DB の行から Entity に戻すときは `Todo.reconstruct`（コンストラクタが不変条件で検証する。行の型は Drizzle のスキーマが保証するので Repository では zod で parse しない）、利用者の入力からは `Todo.create` / `rename`。
  - 不変条件を満たさない行が 1 件あると、一覧（findAll）とその id への GET / PUT / DELETE はすべて 500 になり、画面からは直せず消せない（reviewer の実測、Issue #94）。直すのは DB 側（規則を変えたときはスキル `db-migration` でデータを先に移行する。手で入れた行は SQL で直す）。ログの id と理由で行を特定する。
  - 不変条件を満たさない行（規則を変えたのに移行していない・手で入れた行）は、Repository（`toTodo`）が DomainError ではない `Error`（id と違反の理由を message に、元の DomainError を cause に）にして投げ、API は 500。WHY: DomainError のままだと 400 になり、クライアントに直せない誤りを「リクエストの誤り」と伝える。500 なら `toErrorResponse` がログに残す。行を読み飛ばさない（不整合に気づけない）。
- id 列は uuid。uuid の形でない id は DB に渡さず「無い」として扱う（Postgres のエラーで 500 になるのを防ぐ）。presentation も `z.uuid()` で弾くが、Repository の `isUuid` は自分の約束（無い id は undefined）を守る防御として残す。
- command は一律トランザクション: `createTodoContainer` がすべての command を `TransactionRunner#run` で包む（query は包まない）。run は正常終了で commit、例外で rollback して投げ直す。command / query の本体は Repository を受け取るだけ。
  - WHY: command は「全部成功するか、何も変えないか」。包む場所を 1 か所にして付け忘れを無くす。
  - トランザクションの外の Repository で書き込まない（command には `repositoryFor(tx)` のものしか渡さない）。
  - command の中で遅い処理（外部 API など）をしない（接続を 1 本占有する。接続待ちは `DATABASE_CONNECTION_TIMEOUT_MS` でエラーにする）。
  - 入れ子にしない（command の中から `runner.run` を呼ばない）。Drizzle の runner は db から新しいトランザクションを始めるので外側の rollback で戻らず、InMemory の runner は前の run を待って止まる。
  - 分離レベルは既定の READ COMMITTED（同時更新は後勝ち = lost update を許容）。防ぐ必要が出たら `SELECT ... FOR UPDATE` か分離レベルを Issue で検討する。
  - InMemory の runner は run を 1 つずつ実行する。query は待たないので、実行中の command の途中の状態が見えることがある（WHY は `in-memory-transaction-runner.ts`）。
- 接続とプール（`database.ts`）: `pg.Pool` を `env` の値で作る（変数の一覧は `.claude/rules/env.md`）。アイドル中の接続のエラーは `pool.on("error")` で `logger.error` に出すだけ。プールは `globalThis` に 1 つ（`next dev` の HMR で増やさない）。終了時は `closeDatabase()`。値は開発・CI・E2E 用の暫定で、本番用は Issue #58。
- テスト: 実 Postgres を使うテストは `createTestDatabase()` でファイルごとに別スキーマを使う（`.claude/rules/testing.md`）。

## ログ（`apps/shared/logger.ts`。Issue #85。Issue #90 で `apps/backend/shared/infra/` から移した）
- サーバ側のログは必ず `logger.info / warn / error(event)` を通す。`console.*` を書いてよいのは `logger.ts` だけ（テストは除く）。
  - 1 呼び出し = JSON 1 行（NDJSON）。先頭に `level` と `timestamp`（ISO 8601、UTC。event に `timestamp` があればそれ）。info は stdout（`console.log`）、warn / error は stderr（`console.warn` / `console.error`）。`Error` は `{ name, message }` にする（stack は出さない）。JSON にできない event（循環参照・BigInt）は例外にせず、失敗した旨だけの 1 行を出す。
  - WHY 1 か所に集める: 行の形を呼び出し側ごとにずらさない。出力先を変える（ファイル・外部のログ基盤）ときに直すのが `logger.ts` だけで済む。依存（pino など）は足さない。
  - 使ってよい場所: backend の `presentation`（`http-error.ts` の想定外の例外）・`infra`（`database.ts`）、frontend 直下の `proxy.ts`・`instrumentation-node.ts`（規則 `presentation`・`infra`・`frontend-to-shared-specifier`）。domain・application は使わない（`SHARED_MODULES_BY_LAYER`）。画面側（`app/`・`features/`・`shared/`）も使わない（規則 `screen-to-shared`）。
  - テストは `vi.spyOn(console, "error")` などで出力を抑え、渡された 1 行を `JSON.parse` して確かめる（`logger.test.ts`・`http-error.test.ts`）。
- 強制は 2 系統（`env.ts` の `process.env` と同じ設計）: Biome の `suspicious/noConsole`（`allow` なし。`overrides` で `logger.ts` とテストだけ off。`.claude/rules/lint.md`）と、`rule-tests/architecture.test.ts` の規則 `console-direct-access`（`.claude/rules/architecture-check.md`）。決定は ADR `docs/adr/20260929-logger-single-exit.md`、片方だけが拾う書き方と限界は `.claude/rules/architecture-check.md` と `rule-tests/architecture.test.ts` のテスト。

## 命名
- ディレクトリ・ファイルは kebab-case。型は PascalCase（`TodoDto`）。
- api ファイル・query・command は `<verb>-<noun>`（`list-todos`・`get-todo`・`create-todo`・`update-todo`・`delete-todo`）に役割の接尾辞（`.api.ts`・`.query.ts`・`.command.ts`・`.in-memory.ts`・`.postgres.ts`・`.test.ts`）。

## 後で別プロセスに分けるとき
`apps/backend` に起動口（`server.ts`）と script を足し、`apps/frontend/app/api/**` を消して Next の `rewrites` で `/api/*` を向ける。frontend の `@repo/backend` は型だけの依存になる。env・logger は `apps/shared` にあるので、両方のプロセスがそのまま使える（詳細は ADR `docs/adr/20260928-monorepo-apps-frontend-backend.md`）。
