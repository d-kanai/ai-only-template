---
paths:
  - "apps/backend/**"
---

# backend（API 側。apps/backend）

`apps/backend/` は workspace パッケージ `@repo/backend`。Next・React に依存しない TypeScript で、サーバの起動口は持たない（Next の Route Handler から呼ばれる）。
依存の向きの規則はすべて `architecture.test.ts` が検査する（規則の一覧は `.claude/rules/architecture-check.md`）。経緯・採用しなかった案・実測は `docs/architecture-decisions.md`。

## 置き場所（DDD 4 層）
- ファイルは `apps/backend/<feature>/`（`apps/backend/shared/` を含む）の `domain/` `application/` `presentation/` `infra/` のどれかの下に置く。例外は `apps/backend/` 直下の設定ファイル `<name>.config.ts`（今は `drizzle.config.ts`）と `drizzle/`（生成したマイグレーション）。
  - WHY: 層に属さない場所のファイルにはどの層の規則もかからず、依存の向きの検査を素通りする（規則 `backend-placement`）。
- `apps/backend/shared/`: feature をまたぐもの。`domain/domain-error.ts`（DomainError: `validation_error` / `not_found`）、`domain/transaction-runner.ts`（TransactionRunner の interface）、`presentation/http-error.ts`（DomainError → HTTP ステータス、`ErrorResponse`、`InvalidRequestError`）、`presentation/json-body.ts`（`readJsonObject`）、`infra/env.ts`（環境変数の唯一の入口。`.claude/rules/env.md`）、`infra/database.ts`（プールと Drizzle の db、`Executor`）、`infra/drizzle-transaction-runner.ts`。

| 層 | 置くもの | 参照してよい先（許可の一覧。無いものは不可） |
| --- | --- | --- |
| `presentation/` | api ファイル（1 API = 1 ファイル `<verb>-<noun>.api.ts`）。コンテナを受け取って handler を返す関数（`listTodosApi(container)`）、本番用の HTTP メソッド名の定数（`export const GET = listTodosApi(todoContainer)`）、その API のリクエスト / レスポンスの型 | 自 feature と shared の `application`、`domain`（feature の domain は `import type` のみ。shared の domain は値でも可）、`presentation`、自 feature の `infra/container.ts`（コンテナの型と本番用のコンテナだけ）。パッケージは `next` / `react` / `react-dom` 以外 |
| `application/` | ユースケース 1 つ = 1 ファイル。読むだけは `<verb>-<noun>.query.ts`、状態を変えるものは `<verb>-<noun>.command.ts` | 自 feature と shared の `domain`・`application`。パッケージは `next` / `react` / `react-dom` と DB（`drizzle-orm` とサブパス、`pg`。型だけでも不可）以外 |
| `domain/` | Entity / Value Object / Repository の interface | 自 feature と shared の `domain` だけ。パッケージは application と同じ制限（`node:crypto` などは可） |
| `infra/` | Repository の実装、Drizzle のスキーマ `schema.ts`、TransactionRunner の実装、`container.ts`（DI） | 自 feature と shared の `domain`・`application`・`infra`。パッケージは `next` / `react` / `react-dom` 以外 |

- 向き: `apps/frontend/app/api → presentation → application → domain`。infra は domain の interface を実装する（依存性の逆転）。他 feature・`apps/frontend/`・層に属さない場所は参照しない。
  - WHY 許可の一覧にする: 禁止の一覧だと、書き忘れた参照先が黙って通る。
- `apps/backend/shared/` が参照してよい自前コードは shared の中だけ（層の許可にも従う）。`next` / `react` / `react-dom` も不可。
- domain は Next・React・DB に依存させない。WHY: ビジネスルールを永続化やフレームワークから切り離し、純粋な単体テストで検証する。

## import の書き方と公開の範囲（exports）
- backend の中の import は相対パスだけ（`@/` と `@repo/backend/` は使わない。規則 `backend-relative-only`）。
  - WHY `@/` 不可: Next（Turbopack）は backend のファイルの `@/` にも frontend の paths を当て、ビルドが失敗する。
  - WHY `@repo/backend/` 不可: 自パッケージ名の参照は `exports` を通り、公開していない内部のファイルを指せなくなる。
- 外（apps/frontend・e2e/・リポジトリ直下の設定）が使ってよいのは `apps/backend/package.json` の `exports` に書いたファイルだけ。全ファイル（`"./*"`）は公開しない（ユーザー判断）。
  - 今のキー: `./todo/presentation/*.api`（Route Handler と画面側の型）、`./shared/presentation/http-error`（`ErrorResponse`）、`./shared/infra/env`（起動時の検証・Playwright・E2E・globalSetup）。
  - 値はキーのパスに `.ts` を付けた TS のソース（ビルドしない）。feature を足したら `./<feature>/presentation/*.api` を足す。それ以外は 1 ファイルずつ。使わなくなったキーは消す（規則 `backend-exports` が過不足を止める）。
  - テスト基盤（`shared/infra/database.test-support`）は公開しない。`vitest.global-setup.ts` からだけ相対パスで読む（唯一の例外）。
- 依存（`package.json`）: backend のコードが import するもの（`drizzle-orm` / `pg`、devDependencies に `drizzle-kit` / `@types/pg`）を `apps/backend/package.json` に置く（`.claude/rules/dependencies.md`）。
- `apps/backend/tsconfig.json` は Next の plugin・jsx・DOM の型を持たない（backend 単体の型チェック。`Response#json()` は `unknown` なのでテストでは `as` で型を付ける）。`pnpm typecheck` が検査する。

## presentation（api ファイル）
- 1 API = 1 ファイルにし、その API のリクエスト / レスポンスの型（DTO）もそのファイルで定義して export する。複数の API が同じ形（`TodoDto` など）を返しても各ファイルで定義する（共通の型ファイルを置かない）。
  - WHY: api ファイルを 1 つ開けば契約と処理がすべて見える（ユーザー判断）。形を変えるときに複数ファイルを直す手間より優先する。
- handler は `(request: Request) => Promise<Response>`。動的セグメントがあれば `(request, ctx: { params: Promise<{ id: string }> })` で、`await ctx.params` は api ファイル側で行う。
- 「コンテナを受け取って handler を返す関数」を export し、本番は共有の `todoContainer` を渡して作る。受け取る型は `Pick<TodoContainer, "listTodos">` のように使うものだけに絞る。
  - WHY: テストでは `listTodosApi(createInMemoryTodoContainer())` で組み立て、共有のコンテナ（前のテストのデータが残る）に依存しない。
- query / command は `infra/container.ts` で組み立てたコンテナからだけ受け取る。Repository を直接 new しない（テストで `createInMemoryTodoContainer` を使うのは除く）。WHY: 実装の切り替えとトランザクションの張り方を 1 か所で決める。
- 入力検証は手書き（ライブラリは入れない。規模が大きくなったら Issue で検討）。分担:
  - presentation は「形」だけ: 本文が JSON のオブジェクトか（`readJsonObject`）、項目の型。違反は `InvalidRequestError` → 400（`validation_error`）。
  - 値の中身の規則（例: `title` は前後の空白を除いて 1〜100 文字）は domain の不変条件（`Todo.create` / `Todo#rename`）に一本化。違反は `DomainError("validation_error")` → 400。
  - WHY: 同じ規則を 2 か所に書くと片方だけ直してずれる。どちらもクライアントからは同じ 400 に見える。

## application
- 読むだけ（副作用なし）は query、状態を変えるものは command に分ける。WHY: 副作用の有無をファイル名で見分ける。

## 永続化（Drizzle + Postgres）
- アプリは常に Postgres（Drizzle + node-postgres）。InMemory（`todo-repository.in-memory.ts`・`InMemoryTransactionRunner`）はテスト用。
  - `todoContainer` は常に `createPostgresTodoContainer(getDatabase().db)`。環境変数で InMemory に切り替える分岐は持たない（Issue #59）。WHY: 以前は `DATABASE_URL` が無いと InMemory に落ち、書き忘れでもデータが保存されないまま動いた。
  - そのため `pnpm dev` の前にも `pnpm db:up` と `pnpm db:migrate` が要る。`container.ts` を読み込むテストは `.env` が要る（プールは作るが、接続は最初のクエリまで張らない）。
- スキーマは feature ごとの `infra/schema.ts` に `pgTable` で宣言する（codebase-first）。SQL は `pnpm db:generate` で生成し、`pnpm db:migrate` で当てる。生成済みの SQL は手で直さない。`drizzle-kit push` は使わない（SQL が残らずレビューも記録もできない）。手順はスキル `db-migration`。
  - schema は infra に置く（テーブルの形は永続化の都合で、domain は知らない）。Entity との変換は Repository の実装が行う。
- `PostgresTodoRepository` は `Executor`（db かトランザクション）を受け取り、自分ではトランザクションを始めない（query は db、command は tx で同じ実装を使うため）。
- DB の行から Entity に戻すときは `Todo.restore`（不変条件で検査しない）、利用者の入力からは `Todo.create` / `rename`。
- id 列は uuid。uuid の形でない id は DB に渡さず「無い」として扱う（Postgres のエラーで 500 になるのを防ぐ）。
- command は一律トランザクション: `createTodoContainer` がすべての command を `TransactionRunner#run` で包む（query は包まない）。run は正常終了で commit、例外で rollback して投げ直す。command / query の本体は Repository を受け取るだけ。
  - WHY: command は「全部成功するか、何も変えないか」。包む場所を 1 か所にして付け忘れを無くす。
  - トランザクションの外の Repository で書き込まない（command には `repositoryFor(tx)` のものしか渡さない）。
  - command の中で遅い処理（外部 API など）をしない（接続を 1 本占有する。接続待ちは `DATABASE_CONNECTION_TIMEOUT_MS` でエラーにする）。
  - 入れ子にしない（command の中から `runner.run` を呼ばない）。Drizzle の runner は db から新しいトランザクションを始めるので外側の rollback で戻らず、InMemory の runner は前の run を待って止まる。
  - 分離レベルは既定の READ COMMITTED（同時更新は後勝ち = lost update を許容）。防ぐ必要が出たら `SELECT ... FOR UPDATE` か分離レベルを Issue で検討する。
  - InMemory の runner は run を 1 つずつ実行する。query は待たないので、実行中の command の途中の状態が見えることがある（WHY は `in-memory-transaction-runner.ts`）。
- 接続とプール（`database.ts`）: `pg.Pool` を `env` の値で作る（変数の一覧は `.claude/rules/env.md`）。アイドル中の接続のエラーは `pool.on("error")` でログに出すだけ。プールは `globalThis` に 1 つ（`next dev` の HMR で増やさない）。終了時は `closeDatabase()`。値は開発・CI・E2E 用の暫定で、本番用は Issue #58。
- テスト: 実 Postgres を使うテストは `createTestDatabase()` でファイルごとに別スキーマを使う（`.claude/rules/testing.md`）。

## 命名
- ディレクトリ・ファイルは kebab-case。型は PascalCase（`TodoDto`）。
- api ファイル・query・command は `<verb>-<noun>`（`list-todos`・`get-todo`・`create-todo`・`update-todo`・`delete-todo`）に役割の接尾辞（`.api.ts`・`.query.ts`・`.command.ts`・`.in-memory.ts`・`.postgres.ts`・`.test.ts`）。

## 後で別プロセスに分けるとき
`apps/backend` に起動口（`server.ts`）と script を足し、`apps/frontend/app/api/**` を消して Next の `rewrites` で `/api/*` を向ける。frontend の `@repo/backend` は型だけの依存になり、`instrumentation-node.ts` の env の検証は backend のサーバ側に移す（詳細は `docs/architecture-decisions.md`）。
