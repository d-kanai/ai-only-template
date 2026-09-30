---
paths:
  - "apps/backend/**"
---

# backend（API 側。apps/backend）

`apps/backend/` は workspace パッケージ `@repo/backend`。Next・React に依存しない TypeScript で、サーバの起動口は持たない（Next の Route Handler から呼ばれる）。
依存の向きの規則はすべて `rule-tests/architecture.test.ts` が検査する（規則の一覧は `.claude/rules/architecture-check.md`）。決定と採用しなかった案は ADR（`docs/adr/README.md` の一覧）、実測は 2026-09-28 の work-logs。

## 置き場所（DDD 4 層）
- `apps/backend/` の直下は `features/` と `shared/` だけ（ほかは `package.json`・`tsconfig.json`）。ファイルは `apps/backend/features/<feature>/` か `apps/backend/shared/` の `domain/` `application/` `presentation/` `infra/` のどれかの下に置く。例外は `apps/backend/shared/drizzle/`（drizzle-kit の設定 `drizzle.config.ts` と、生成したマイグレーションの `*.sql`・`meta/`。ソースは `drizzle.config.ts` だけ）。
  - WHY: 層に属さない場所のファイルにはどの層の規則もかからず、依存の向きの検査を素通りする（規則 `backend-placement`）。
  - WHY `features/` と `shared/`（Issue #98。ユーザー判断）: frontend（`apps/frontend_customer/features/`・`shared/`）と同じ構成にし、feature を足すときの置き場所をそろえる。Drizzle は `shared/drizzle/`（`shared/infra/drizzle/` のように深くしない）に置き、直下の例外を無くす。決定と採用しなかった案は ADR `docs/adr/architecture/20260929-backend-features-and-shared-directories.md`。
- `apps/backend/shared/`: feature をまたぐもの。`domain/error-key.ts`（`ErrorKey`・`ErrorKeyParams`: エラーのキーとキーごとの params の形）、`domain/domain-error.ts`（DomainError: `validation_error` / `not_found` と key・params）、`domain/keyed-issue.ts`（`keyedIssue`・`keyedRefine`: zod の検査に ErrorKey と params を付ける。domain と presentation のスキーマが使う）、`domain/validate.ts`（`validate(schema, value)`: zod の safeParse の結果を `DomainError("validation_error", key, params)` に変換する。キーの無い issue は DomainError ではない Error（500）。Entity の完全コンストラクタが不変条件のスキーマと一緒に使う）、`presentation/problem.ts`（例外 → RFC 9457 の Problem Details の応答 `toProblemResponse` と、api の `handle` を包む `withProblemResponse`、`Problem`・`ProblemError`、`InvalidRequestError`。`ErrorKey`・`ErrorKeyParams` を再公開）、`presentation/problem-detail.en.ts`（`detail` の英語の文。英語の文言はここだけ）、`presentation/json-body.ts`（`requestBodySchema`・`parseJsonBody`）、`presentation/resource-id.ts`（`parseUuidParam`: 動的セグメントの id が uuid の形でなければ 404）、`infra/database.ts`（プールと Drizzle の db の型 `Database`）。
- 環境変数の唯一の入口 `env.ts`・ログの唯一の出口 `logger.ts`・現在時刻の唯一の出口 `now.ts` は、frontend と backend で共通の workspace パッケージ `apps/shared`（`@repo/shared`）にある（Issue #90。`.claude/rules/shared.md`）。backend からは `@repo/shared/env`・`@repo/shared/logger`・`@repo/shared/now` で使う。

| 層 | 置くもの | 参照してよい先（許可の一覧。無いものは不可） |
| --- | --- | --- |
| `presentation/` | api ファイル（1 API = 1 ファイル `<verb>-<noun>.api.ts`）。クラス `<Verb><Noun>Api`（コンストラクタで query / command を受け取り、`handle` が Route Handler）、ファイルの最下部で組み立てた本番用の HTTP メソッド名の定数（`export const GET = new ListTodosApi(new ListTodosQuery(new PostgresTodoRepository(getDatabase().db))).handle`）、その API のリクエスト / レスポンスの型 | 自 feature と shared の `application`、`domain`（feature の domain は `import type` と、UPPER_SNAKE_CASE の名前の定数だけの値の import（`import { TODO_TITLE_MAX_LENGTH } from "../domain/todo"`。Issue #144）。shared の domain は値でも可）、`presentation`、組み立てに使う自 feature の `infra/<名前>-repository.postgres`（Postgres の Repository の実装）と `apps/backend/shared/infra/database`（feature の presentation だけ。InMemory の実装・`schema` は不可）、`@repo/shared/logger`・`@repo/shared/now`。パッケージは `next` / `react` / `react-dom` 以外 |
| `application/` | ユースケース 1 つ = 1 ファイル。読むだけは `<verb>-<noun>.query.ts`、状態を変えるものは `<verb>-<noun>.command.ts` | 自 feature と shared の `domain`・`application`、`@repo/shared/now`。パッケージは `next` / `react` / `react-dom` と DB（`drizzle-orm` とサブパス、`pg`。型だけでも不可）以外 |
| `domain/` | Entity / Value Object / Repository の interface | 自 feature と shared の `domain`、`@repo/shared/now` だけ。パッケージは application と同じ制限（`node:crypto` などは可） |
| `infra/` | Repository の実装（Postgres と、テスト用の InMemory）、Drizzle のスキーマ `schema.ts`、プール（`shared/infra/database.ts`） | 自 feature と shared の `domain`・`application`・`infra`、`@repo/shared/env`・`@repo/shared/logger`・`@repo/shared/now`。パッケージは `next` / `react` / `react-dom` 以外 |

- 向き: `apps/frontend_customer/app/api → presentation → application → domain`。infra は domain の interface を実装する（依存性の逆転）。他 feature・`apps/frontend_customer/`・層に属さない場所は参照しない。
  - WHY 許可の一覧にする: 禁止の一覧だと、書き忘れた参照先が黙って通る。
- `apps/backend/shared/` が参照してよい自前コードは shared の中と `apps/shared`（`@repo/shared`）だけ（層の許可にも従う）。`next` / `react` / `react-dom` も不可。
- `apps/shared` を使ってよい層: env は infra だけ、logger は presentation・infra、now はすべての層（`rule-tests/architecture.test.ts` の `SHARED_MODULES_BY_LAYER`）。WHY env・logger を domain・application に許さない: 外の世界（環境変数・stdout）に触る基盤で、domain・application から使うと infra を参照させない意味が無くなる。WHY now は許す: 現在時刻の Date を返すだけで環境変数・出力・DB に触らず、Entity の生成ルール（作成日時）は domain に置くため（`.claude/rules/shared.md` の「now」）。
- domain は Next・React・DB に依存させない。WHY: ビジネスルールを永続化やフレームワークから切り離し、純粋な単体テストで検証する。

## import の書き方と公開の範囲（exports）
- backend の中の import は相対パスだけ（`@/` と `@repo/backend/` は使わない。規則 `backend-relative-only`）。`apps/shared` は別のパッケージなので `@repo/shared/...` だけで書く（相対パスの `../../../shared/env` は違反。`apps/backend/package.json` に `"@repo/shared": "workspace:*"`。Issue #90）。
  - WHY `apps/shared` へ相対パスを使わない: exports を経由しない参照を許すと、`apps/shared` の公開範囲（exports。規則 `shared-exports`）が意味を持たなくなる（frontend・e2e と同じ扱い）。
  - WHY `@/` 不可: Next（Turbopack）は backend のファイルの `@/` にも frontend の paths を当て、ビルドが失敗する。
  - WHY `@repo/backend/` 不可: 自パッケージ名の参照は `exports` を通り、公開していない内部のファイルを指せなくなる。
- 外（apps/frontend_customer・apps/e2e/・リポジトリ直下の設定）が使ってよいのは `apps/backend/package.json` の `exports` に書いたファイルだけ。全ファイル（`"./*"`）は公開しない（ユーザー判断）。
  - 今のキー: `./features/todo/presentation/*.api`（Route Handler と画面側の型）、`./shared/presentation/problem`（`Problem`・`ErrorKey`・`ErrorKeyParams`。Issue #126 で `http-error` から改名）。env・logger は Issue #90 で `apps/shared` に移し、キーを消した（`@repo/shared` の exports）。
  - 値はキーのパスに `.ts` を付けた TS のソース（ビルドしない）。feature を足したら `./features/<feature>/presentation/*.api` を足す（Node の exports のパターンは `*` を 1 つしか持てないので、feature ごとにキーを分ける）。それ以外は 1 ファイルずつ。使わなくなったキーは消す（規則 `backend-exports` が過不足を止める）。
  - テスト基盤（`shared/infra/database.test-support`）は公開しない。`vitest.global-setup.ts` からだけ相対パスで読む（唯一の例外）。
- 依存（`package.json`）: backend のコードが import するもの（`drizzle-orm` / `pg` / `zod` / `@repo/shared`、devDependencies に `drizzle-kit` / `@types/pg`）を `apps/backend/package.json` に置く（`.claude/rules/dependencies.md`）。
- `apps/backend/tsconfig.json` は Next の plugin・jsx・DOM の型を持たない（backend 単体の型チェック。`Response#json()` は `unknown` なのでテストでは `as` で型を付ける）。`pnpm typecheck` が検査する。

## presentation（api ファイル）
- 1 API = 1 ファイルにし、その API のリクエスト / レスポンスの型（DTO）もそのファイルで定義して export する。複数の API が同じ形の Todo を返しても各ファイルの Response 型に直接書く（共通の型ファイルや別名の型を置かない。domain の `Todo` を `toResponse` で各 API の Response に直接写す。Issue #139）。
  - WHY: api ファイルを 1 つ開けば契約と処理がすべて見える（ユーザー判断）。形を変えるときに複数ファイルを直す手間より優先する。
- handler は `(request: Request) => Promise<Response>`。動的セグメントがあれば `(request, ctx: { params: Promise<{ id: string }> })` で、`await ctx.params` は api ファイル側で行う。
- 各 api ファイルはクラス `<Verb><Noun>Api`（`ListTodosApi`・`GetTodoApi`・`CreateTodoApi`・`UpdateTodoApi`・`DeleteTodoApi`）を export する。コンストラクタで query / command を受け取り（型は `Pick<CreateTodoCommand, "execute">` のように execute だけ）、`handle` を Route Handler にする（Issue #123。ユーザー判断）。
  - `handle` は `withProblemResponse`（`problem.ts`）で包んだアロー関数のプロパティ（`readonly handle = withProblemResponse(async (request[, ctx]) => { ... })`）にする。try / catch は書かない。
    - WHY アロー関数: `export const POST = new CreateTodoApi(...).handle` のようにインスタンスから取り出して渡すと、メソッドでは `this` が外れる。
    - WHY `withProblemResponse`（Issue #141）: handler が投げた例外を `toProblemResponse` で Problem Details にする。Next の Route Handler には共通の catch が無く（Proxy は handler の例外を捕まえず、`onRequestError` は記録だけ）、包み忘れると Next の素の 500 が漏れる。以前は 5 本の api が同じ try / catch を手書きしていた。包み忘れは規則 `presentation-with-problem-response`（`rule-tests/architecture.test.ts`）が止める。
    - `parseJsonBody` と `await ctx.params` + `parseUuidParam` は handler の中に書く（共通化しない。ユーザー判断）。WHY: 本文・動的セグメントの有無と確かめる順番（update は id を先に見て 404 を優先）が api ごとに違い、handler の中にあればその api の処理を 1 か所で読める。
  - 組み立てはファイルの最下部: `export const POST = new CreateTodoApi(new CreateTodoCommand(new PostgresTodoRepository(getDatabase().db))).handle;`。本番は常に Postgres（下の「永続化」）。
    - WHY api ファイルで組み立てる（DI コンテナを置かない）: コンテナ（以前の `infra/container.ts`）は分かりにくい（ユーザー判断）。その API が何で動くかを、api ファイル 1 つで読める。
    - WHY api ファイルごとに `new PostgresTodoRepository(getDatabase().db)` してよい: プールは `getDatabase` が `globalThis` に 1 つだけ持つので、Repository を api ファイルの数だけ作ってもプールは 1 つ。
  - WHY クラス + コンストラクタ injection: application の query / command と同じ形にそろえる。テストは `new CreateTodoApi(new CreateTodoCommand(new InMemoryTodoRepository())).handle(request)` のように、空の InMemory のリポジトリで組み立てる（前のテストのデータに依存しない）。差し替えはコンストラクタで行い `vi.mock` は使わない（型で縛られ、query / command の形が変わればテストがコンパイルエラーになる）。
- presentation の本番コードが参照してよい infra は、組み立てに使う自 feature の `infra/<名前>-repository.postgres` と `apps/backend/shared/infra/database` だけ（規則 `presentation`）。InMemory の実装（`*.in-memory`）と `schema` は参照しない。WHY: 本番の handler が InMemory で動くと、データが保存されないまま気づけない（Issue #59）。
- エラーは安定したキー（`ErrorKey`）と params で表す（Issue #116。設計 (a)）。画面に出す文言は画面（apps/frontend_customer）の辞書が key と params から翻訳する。`apps/backend` の非テストコードに日本語のリテラルを置かない（規則 `server-hardcoded-text` が止めるのは日本語だけ。ログ・開発者向けの Error の message・`detail` は英語）。
  - WHY: 文言（言語・言い回し）は画面の関心で、backend が持つと言語を足すたび・言い回しを変えるたびに API を変えることになる。key は分岐にも翻訳にも使える機械可読な契約になる。
  - キーは `"<領域>.<対象>.<理由>"`（`todo.title.tooLong`・`request.field.notString` など）。キーを足すときは `apps/backend/shared/domain/error-key.ts` の `ErrorKeyParams` に足す（params の形も一緒に決める。値は string か number だけ）。画面の辞書はこの型から作るので、訳の書き忘れは画面側の型エラーで止まる。公開したキーの名前は変えない（変えるなら画面の辞書と同じ変更で）。
  - `new DomainError(code, key, params)` / `new InvalidRequestError(key, params, errors)` / `parseUuidParam(id, key, params)` は、キーごとに params を型で縛る（params の要るキーに渡し忘れる・形を間違える・要らないキーに渡すとコンパイルエラー。`error-key.ts` の `ErrorParamsArgs`）。検査は `domain-error.test.ts` などの `@ts-expect-error`（`pnpm typecheck`）。
  - Error の `message` は開発者向けの `<key> <params の JSON>`（`describeErrorKey`。例 `todo.notFound {"id":"..."}`）。ログから画面の辞書を引ける。
- エラー応答は RFC 9457（Problem Details for HTTP APIs。https://www.rfc-editor.org/rfc/rfc9457.html ）の形で、`Content-Type: application/problem+json`（Issue #126。ユーザー判断）。作るのは `problem.ts` の `toProblemResponse(error, request)` だけ（各 api の `handle` を包む `withProblemResponse` から呼ぶ。api から直接は呼ばない）。
  - 標準のメンバー: `type`（`/problems/validation-error` / `not-found` / `internal-error`。相対参照。`about:blank` は使わない）、`title`（種類ごとに固定の英語）、`status`（HTTP のステータスと同じ 400 / 404 / 500）、`detail`（この発生に固有の英語）、`instance`（リクエストの URL のパス。クエリは含めない）。
  - 拡張メンバー: `key`（辞書のキー。画面の翻訳と分岐に使う）、`params`（無ければ省略）、`errors`（presentation のスキーマの誤り（形と、重ねた必須・長さ）のときだけ。各要素は `{ pointer, key, params?, detail }`、`pointer` は JSON Pointer（RFC 6901）の fragment の形 `#/title`、本文全体の誤りは `#`）。
  - `DomainErrorCode`（と想定外の例外）→ `{ type, title, status }` の対応は `problem.ts` の `problemKindOf`（`Record` で網羅。種類を足して書き忘れると型エラー）。
  - `detail` は開発者向けの英語で、契約に含めない（画面は読まない・出さない。言い回しを変えても画面は壊れない）。文は `problem-detail.en.ts` の 1 か所（`ErrorKey` ごとの関数。キーを足して文を書き忘れると型エラー）。ほかの場所に `detail` の英語を書かない。翻訳はしない（backend に辞書を持つと画面の辞書と二重管理になる）。
  - WHY RFC 9457: HTTP API のエラー本文の標準で、Spring の `ProblemDetail`・ASP.NET Core の `ProblemDetails` が実装し、Zalando の API ガイドラインが MUST にしている。汎用のクライアント・ツールが形を個別に知らずに読める。WHY key を残す: `type` は大分類で、画面の文言は細かいキー（`todo.title.tooLong`）で決まる。決定と採用しなかった案は ADR `docs/adr/architecture/20260929-error-response-rfc9457.md`。
- 入力検証は zod で統一する（Issue #88。以前の「手書き」は撤回）。presentation と domain の分担（Issue #144。ユーザー判断、presentation ⊆ domain）:
  1. domain は常に完全: 値の規則の正は domain のスキーマで、presentation を通った値も含めて毎回すべてを検証する（下の「完全コンストラクタ」）。
  2. presentation は domain より厳しくしない: domain が通す値（前後の空白付き・100 文字ちょうど・絵文字など）を presentation で弾かない。
  3. 数値は domain の定数を presentation が参照する（`TODO_TITLE_MAX_LENGTH`。2 か所に書かない）。presentation が feature の domain から値で import してよいのは UPPER_SNAKE_CASE の定数だけ（規則 `presentation`）。
  4. presentation は「形」（JSON・オブジェクト・未知の項目・型）を必ず検査し、そのうえで必須・長さを domain と同じキー・同じ数え方・同じ定数で重ねてよい。誤りは項目ごとの `errors[]` にまとめて返す。
  - WHY 重ねる: domain の DomainError はキー 1 つで、どの項目の誤りかを持たない（domain はリクエストの項目名を知らない）。presentation で重ねると、形の誤りと値の誤りを項目ごと（`pointer`）に 1 回の応答で返せ、画面が項目の横に出せる。WHY domain を正に残す: presentation を通らない口（DB の行の `reconstruct`・application から直接の呼び出し）でも不変条件が守られる。
  - presentation: 各 api ファイルにリクエストの zod スキーマを置き（`requestBodySchema({ 項目: z.string() })`。型の検査に `error` は書かない。必須・長さは `refine` に `keyedIssue` / `keyedRefine`（`apps/backend/shared/domain/keyed-issue.ts`）で domain と同じキーを付ける）、`parseJsonBody(request, schema)` で読む。違反は `InvalidRequestError`（`errors` 付き）→ 400（`/problems/validation-error`、Problem の `errors` に `{ pointer, key, params, detail }` の一覧、`key`・`params` は最初の 1 件）。型は `z.infer` でスキーマから導出する。
    - zod の issue からキーと `pointer` を決める対応は `json-body.ts` の `toProblemError` 1 か所だけに書く（message が ErrorKey（`keyedIssue` / `keyedRefine` で付けた）→ そのキーと refine の params、未知の項目 → `request.body.unknownKeys`、本文がオブジェクトでない → `request.body.notObject`、文字列・真偽値の項目の型違い → `request.field.notString` / `notBoolean`）。対応の無い issue（数値の項目を足したときなど）は InvalidRequestError ではない Error（500）にする。
      - WHY 各 api ファイルの型の検査の `error` にキーを書かない: 同じ対応（文字列の項目 → notString）を項目ごとに重ねて書くことになる。WHY 対応の無い issue を 500 にする: キーの集合は画面の辞書と共有する閉じた集合で、近いキーに寄せると画面が誤った文言を出す。キーと対応を足し忘れたことをテストで気づかせる。
    - 未知のキーは拒否する（`z.strictObject`）。WHY: 部分更新で項目名を打ち間違えた本文が「何も変えない」200 に化ける。画面と API は同時に変えるので互換性の心配は無い。
    - 動的セグメントの `id` は `z.uuid()` で確かめ、形が違えば 404（`not_found`。無い Todo と同じ契約）。本文より先に確かめる。
  - domain: 値の中身の規則（例: `title` は前後の空白を除いて 1〜`TODO_TITLE_MAX_LENGTH`（100）文字。文字数はコードポイント数で、zod の `.min` / `.max`（`String#length`）は使わない）の正は domain の zod スキーマ（`todo.ts` の `todoPropsSchema` の `title`）。`Todo` のコンストラクタがそれで検証し、違反は `DomainError("validation_error", key, params)` → 400（`errors` は付かない。presentation で重ねた規則は先に presentation の `errors` 付きの 400 になる）。
    - domain の zod スキーマ・refine の `error` にはキーだけを書く（キー以外の文字列は書かない）。`keyedIssue(key)` / `keyedRefine(key, params)`（`apps/backend/shared/domain/keyed-issue.ts`）を通して `{ error: key }` / `{ error: key, params }` を作り、キーと params を型で縛る。params は zod の refine の `params` で運ぶ（zod 4.6.5 は refine の `params` を失敗した custom の issue にそのまま載せる。実測 2026-09-29）。`validate` が最初の issue の message（= キー）と params を DomainError に戻す。
    - WHY キーと params を JSON にして `error` の文字列に詰めない: 文字列の組み立て・解析の誤りが入る。WHY `{ error: "todo.title.empty" }` と直接書かない: zod の `error` は任意の文字列を受け付け、打ち間違い・params の渡し忘れを型で止められない。
  - Entity の生成（`Todo.create(title)`）は id・作成日時（`now()`）・初期状態を自分で決め、作成日時を引数で受け取らない。WHY: 「作ったときの時刻が入る」は生成ルールで、呼び出し側が渡せるとルールが漏れる。テストで時刻を決めるときは `now` を `vi.mock` で差し替える（`.claude/rules/testing.md` の「テストダブル」）。DB の行から戻す `reconstruct` は保存済みの作成日時を受け取る。
  - 完全コンストラクタ: `Todo` の private コンストラクタが毎回、値のすべてを `todoPropsSchema`（Todo の不変条件）で検証する。`create` / `reconstruct`（DB の行）/ `rename` / `changeCompletion` はコンストラクタに値を渡すだけで、口ごとに検証の範囲を分けない（Issue #94。Issue #88 の「restore は検証しない」を撤回）。WHY: 「Todo 型の値 = 不変条件を満たす値」が常に成り立つ。規則を変えるときは既存のデータを移行（スキル `db-migration`）して追従する。branded 型は使わない（Todo 型そのものが不変条件を満たす値を表すため。`todo.ts` のコメント）。
  - スキーマは関数の中で作る（最上位の定数にしない）。WHY: static な変異になり mutation testing で数えない（`stryker.config.mjs` の `ignoreStatic`）。
  - WHY zod: 規則の宣言と型の導出を 1 か所にし、項目ごとの誤り（Problem の `errors`）をレスポンスに出せる。規則の正は domain で、presentation が重ねるときはキーと数値（定数）を domain と共有し、ずれを数値の二重管理で起こさない（Issue #144 より前は「presentation に値の規則は書かない」だった）。決定と採用しなかった案は ADR `docs/adr/architecture/20260929-zod-for-backend-validation.md`。zod 4.6.5 の実測（2026-09-29）: `.min` / `.max` は `String#length` なのでコードポイント数は `refine` と `Array.from` で数える（`"🍎".repeat(100)` は length 200）。`z.uuid()` は RFC 9562 の形（版の桁 1〜8、variant 8 / 9 / a / b、nil と max）だけを受け付け、大文字も通す（Postgres の uuid 型より狭く、版の桁が 0 の値は拒否する。Todo の id は `randomUUID`（v4）なので影響しない。広い `z.guid()` は採らなかった）。（presentation に domain の規則を重ねる方針と採用しなかった案は `docs/adr/architecture/20260930-presentation-overlaps-domain-validation.md`）

## application
- 読むだけ（副作用なし）は query、状態を変えるものは command に分ける。WHY: 副作用の有無をファイル名で見分ける。

## 永続化（Drizzle + Postgres）
- アプリは常に Postgres（Drizzle + node-postgres）。InMemory（`todo-repository.in-memory.ts`）はテスト用で、query / command のコンストラクタに渡す。
  - api ファイルの本番の handler は常に `new PostgresTodoRepository(getDatabase().db)` で組み立てる。環境変数で InMemory に切り替える分岐は持たない（Issue #59）。WHY: 以前は `DATABASE_URL` が無いと InMemory に落ち、書き忘れでもデータが保存されないまま動いた。各 api ファイルのテストが、本番の handler が Postgres の Repository を呼ぶことを確かめる（prototype の spy。DB には接続しない）。
  - そのため `pnpm dev` の前にも `pnpm db:up` と `pnpm db:migrate` が要る。api ファイルを読み込むテストは `.env` が要る（プールは作るが、接続は最初のクエリまで張らない）。
- スキーマは feature ごとの `infra/schema.ts`（`apps/backend/features/<feature>/infra/schema.ts`。drizzle-kit の設定 `shared/drizzle/drizzle.config.ts` が glob で読む）に `pgTable` で宣言する（codebase-first）。SQL は `pnpm db:generate` で `apps/backend/shared/drizzle/` に生成し、`pnpm db:migrate` で当てる。生成済みの SQL は手で直さない。`drizzle-kit push` は使わない（SQL が残らずレビューも記録もできない）。手順はスキル `db-migration`。
  - schema は infra に置く（テーブルの形は永続化の都合で、domain は知らない）。Entity との変換は Repository の実装が行う。
- `PostgresTodoRepository` はコンストラクタで `Database`（Drizzle の db）を受け取る。自分ではトランザクションを始めない。
- Repository の `findById` は無ければ `undefined`、`findByIdOrThrow` は無ければ `DomainError("not_found", "todo.notFound", { id })`（API で 404）。「無ければ not_found」のユースケース（get / update / delete）は `findByIdOrThrow` を呼び、自分で throw を書かない。各実装は domain の `requireTodo(await this.findById(id), id)` を使う。WHY: 例外の code・key・params を 1 か所に決め、ユースケースごと・実装（本番の Postgres とテストの InMemory）ごとのずれを無くす。
- DB の行から Entity に戻すときは `Todo.reconstruct`（コンストラクタが不変条件で検証する。行の型は Drizzle のスキーマが保証するので Repository では zod で parse しない）、利用者の入力からは `Todo.create` / `rename`。
  - 不変条件を満たさない行が 1 件あると、一覧（findAll）とその id への GET / PUT / DELETE はすべて 500 になり、画面からは直せず消せない（reviewer の実測、Issue #94）。直すのは DB 側（規則を変えたときはスキル `db-migration` でデータを先に移行する。手で入れた行は SQL で直す）。ログの id と理由で行を特定する。
  - 不変条件を満たさない行（規則を変えたのに移行していない・手で入れた行）は、Repository（`toTodo`）が DomainError ではない `Error`（id と違反の理由を message に、元の DomainError を cause に）にして投げ、API は 500。WHY: DomainError のままだと 400 になり、クライアントに直せない誤りを「リクエストの誤り」と伝える。500 なら `toProblemResponse` がログに残す。行を読み飛ばさない（不整合に気づけない）。
- id 列は uuid。uuid の形でない id は DB に渡さず「無い」として扱う（Postgres のエラーで 500 になるのを防ぐ）。presentation も `z.uuid()` で弾くが、Repository の `isUuid` は自分の約束（無い id は undefined）を守る防御として残す。
- トランザクション: command を一律に包む仕組み（以前のトランザクションの runner と DI コンテナ）は持たない（Issue #123。ADR `docs/adr/architecture/20260929-constructor-injection-without-container.md`）。command はトランザクションを意識せずに書く。
  - WHY 今は要らない: 今の command は書き込みが 1 文だけ（`save` の `INSERT ... ON CONFLICT DO UPDATE` か `delete`）で、Postgres は 1 文を原子的に実行する（途中まで書かれた状態は残らない）。
  - 複数の書き込みが要る command が出たら、その command にトランザクションを扱う依存をコンストラクタで注入し、command の中で `db.transaction(async (tx) => ...)` の範囲を書く（包む場所を command ごとに明示する）。ただし今の規則では application から `Database`（`apps/backend/shared/infra/database`）と `drizzle-orm` を参照できない（規則 `application`・`core-to-persistence`）ので、依存の形（domain に interface を置くか、規則を変えるか）はその Issue で決める。
  - command の中で遅い処理（外部 API など）をしない（トランザクションを張ったときに接続を 1 本占有する。接続待ちは `DATABASE_CONNECTION_TIMEOUT_MS` でエラーにする）。
  - 分離レベルは既定の READ COMMITTED（読んでから書くまでの同時更新は後勝ち = lost update を許容。update / delete の command は findByIdOrThrow と save / delete が別の文）。同じ理由で、PUT の findByIdOrThrow と save（upsert）の間に DELETE が commit されると消した Todo が戻る（トランザクションで包んでいた頃も同じ。Issue #123 の reviewer の指摘。推論で未実測）。防ぐ必要が出たら `SELECT ... FOR UPDATE` か分離レベルを Issue で検討する。
- 接続とプール（`database.ts`）: `pg.Pool` を `env` の値で作る（変数の一覧は `.claude/rules/env.md`）。アイドル中の接続のエラーは `pool.on("error")` で `logger.error` に出すだけ。プールは `globalThis` に 1 つ（`next dev` の HMR で増やさない）。終了時は `closeDatabase()`。値は開発・CI・E2E 用の暫定で、本番用は Issue #58。
- テスト: 実 Postgres を使うテストは `createTestDatabase()` でファイルごとに別スキーマを使う（`.claude/rules/testing.md`）。

### 列の型（Issue #145）
列の型は下の既定に従い、長さ・精度は意味があるときだけ書く。`rule-tests/schema.test.ts` が `apps/backend/**/infra/schema.ts` を検査する。決定と採用しなかった案は ADR `docs/adr/quality/20260930-db-column-types-default-text-and-integer.md`。

| 用途 | 既定 | 長さ・精度を書くとき |
| --- | --- | --- |
| 文字列 | `text`（長さ無し） | 長さそのものを DB で保証する必要があるとき（外部システムの固定長コード、CHECK で守りたい不変条件）だけ `varchar(n)` / `char(n)` か CHECK。文字数の上限は domain（zod）が持つ |
| 整数 | `integer`。連番の id・件数・金額の最小単位など 21 億（2^31 - 1）を超えうるものは `bigint` | 書かない（Postgres の整数に長さは無い。`int(10)` は MySQL の表示幅） |
| 小数・金額 | `numeric(p, s)` | 常に書く（精度は意味そのもの） |
| 真偽 | `boolean` | — |
| 日時 | `timestamp` の `withTimezone: true`（timestamptz） | — |
| id | `uuid` | — |
| JSON | `jsonb` | — |

- 長さは domain が持ち、DB は型だけにする。WHY: 2 か所に上限を書くと片方だけ直してずれる。DB の制約違反は 500 になり、domain の 400（`errors[]` 付き。ADR `docs/adr/architecture/20260930-presentation-overlaps-domain-validation.md`）に負ける。
- WHY `varchar(255)` を既定にしない: Postgres では `text` / `varchar(n)` / `char(n)` に性能の差は無く、長さ制約は保存時の検査だけ（公式: https://www.postgresql.org/docs/current/datatype-character.html 「There is no performance difference among these three types ... In most situations text or character varying should be used instead.」）。長さを書くと上限を変えるたびにマイグレーションが要る。
- WHY timezone 無しの `timestamp` を使わない: サーバ・DB のタイムゾーン設定で時刻の意味が変わる（TZ=UTC 前提。Issue #116）。
- WHY `serial` / `bigserial` を使わない: id は `uuid`（アプリが `randomUUID` で作る）。WHY `json` を使わない: `json` は入力の文字列をそのまま保持して処理のたびに解析し直す。`jsonb` は分解した形で保持して処理が速く、インデックスも張れる（https://www.postgresql.org/docs/current/datatype-json.html ）。
- インデックスは、検索するクエリが決まってから足す。
- 検査が違反にするもの: `varchar(` / `char(`、`timestamp(` で `withTimezone: true` が無いもの、`serial(` / `bigserial(` / `smallserial(`、`json(`。既定から外れる理由があるときは、その列の直前の行（空行を挟まない `//` の連続）に `// WHY 長さ: <理由>`（varchar / char）・`// WHY タイムゾーン: <理由>`・`// WHY 連番: <理由>`・`// WHY json: <理由>` を書くと通る。見出しは規則ごとに分け、別の理由の WHY では通らない。

## ログ（`apps/shared/logger.ts`。Issue #85。Issue #90 で `apps/backend/shared/infra/` から移した）
- サーバ側のログは必ず `logger.info / warn / error(event)` を通す。`console.*` を書いてよいのは `logger.ts` だけ（テストは除く）。
  - 1 呼び出し = JSON 1 行（NDJSON）。先頭に `level` と `timestamp`（ISO 8601、UTC。event に `timestamp` があればそれ）。info は stdout（`console.log`）、warn / error は stderr（`console.warn` / `console.error`）。`Error` は `{ name, message }` にする（stack は出さない）。JSON にできない event（循環参照・BigInt）は例外にせず、失敗した旨だけの 1 行を出す。
  - WHY 1 か所に集める: 行の形を呼び出し側ごとにずらさない。出力先を変える（ファイル・外部のログ基盤）ときに直すのが `logger.ts` だけで済む。依存（pino など）は足さない。
  - 使ってよい場所: backend の `presentation`（`problem.ts` の想定外の例外）・`infra`（`database.ts`）、frontend 直下の `proxy.ts`・`instrumentation-node.ts`（規則 `presentation`・`infra`・`frontend-to-shared-specifier`）。domain・application は使わない（`SHARED_MODULES_BY_LAYER`）。画面側（`app/`・`features/`・`shared/`）も使わない（規則 `screen-to-shared`）。
  - テストは `vi.spyOn(console, "error")` などで出力を抑え、渡された 1 行を `JSON.parse` して確かめる（`logger.test.ts`・`problem.test.ts`）。
- 強制は 2 系統（`env.ts` の `process.env` と同じ設計）: Biome の `suspicious/noConsole`（`allow` なし。`overrides` で `logger.ts` とテストだけ off。`.claude/rules/lint.md`）と、`rule-tests/architecture.test.ts` の規則 `console-direct-access`（`.claude/rules/architecture-check.md`）。決定は ADR `docs/adr/architecture/20260929-logger-single-exit.md`、片方だけが拾う書き方と限界は `.claude/rules/architecture-check.md` と `rule-tests/architecture.test.ts` のテスト。

## 命名
- ディレクトリ・ファイルは kebab-case。型は PascalCase（`ListTodosResponse`）。
- api ファイル・query・command は `<verb>-<noun>`（`list-todos`・`get-todo`・`create-todo`・`update-todo`・`delete-todo`）に役割の接尾辞（`.api.ts`・`.query.ts`・`.command.ts`・`.in-memory.ts`・`.postgres.ts`・`.test.ts`）。クラス名は `<Verb><Noun>` に役割（`ListTodosApi`・`ListTodosQuery`・`CreateTodoCommand`）。Repository の実装は `<名前>-repository.<実装>.ts`（規則 `presentation` がファイル名 `*-repository.postgres` で組み立てに使う実装を見分ける）。

## 後で別プロセスに分けるとき
`apps/backend` に起動口（`server.ts`）と script を足し、`apps/frontend_customer/app/api/**` を消して Next の `rewrites` で `/api/*` を向ける。frontend の `@repo/backend` は型だけの依存になる。env・logger は `apps/shared` にあるので、両方のプロセスがそのまま使える（詳細は ADR `docs/adr/architecture/20260928-monorepo-apps-frontend-backend.md`）。
