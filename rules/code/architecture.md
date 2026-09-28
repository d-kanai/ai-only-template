# ディレクトリ構成ルール

Next.js（App Router）のコードを、機能（feature）単位で置く。画面側は `features/`、API 側は `backend/` に分け、`app/` はルーティングだけにする。

## 全体像
`src/` は使わず、ルート直下に `app/` `features/` `backend/` `shared/` を置く。tsconfig の `@/*` はルート直下（`./*`）のまま（例: `@/features/todo`、`@/backend/todo/presentation/list-todos.api`）。

| ディレクトリ | 役割 |
| --- | --- |
| `app/` | ルーティングだけ。`page.tsx` は screen を返すだけ、`app/api/**/route.ts` は `backend/` の api ファイルの関数を re-export するだけ |
| `features/<feature>/` | 画面側。screen（見た目 + hook）、feature 内の部品、`/api/...` を呼ぶラッパー |
| `backend/<feature>/` | API 側。DDD の 4 層（presentation / application / domain / infra） |
| `backend/shared/` | API 側で feature をまたぐ共通部品（DomainError、DomainError → HTTP ステータスの変換と `ErrorResponse` 型など） |
| `shared/` | 画面側で feature をまたぐ共通部品。**まだ無いので作らない**。必要になったら作る |

- 理由: Next.js はプロジェクトの構成について方針を持たない（unopinionated）。`app/` の外にコードを置き、`app/` をルーティング専用にする構成は公式の例の 1 つ（下の「一次情報」）。ルーティング（URL）と機能のコードを分けることで、URL を変えてもコードを動かさずに済む。

## 例（Todo）
ファイル名は例。実際のファイルはリポジトリを正とする。

```
app/
  layout.tsx                          # Next の規約ファイル（loading.tsx / error.tsx なども app/ に置く）
  page.tsx                            # return <TodoScreen />
  todo/
    [id]/
      page.tsx                        # await params で id を取り出し、return <TodoDetailScreen todoId={id} />
  api/
    todos/
      route.ts                        # export { GET } from "@/backend/todo/presentation/list-todos.api"
                                      # export { POST } from "@/backend/todo/presentation/create-todo.api"
      [id]/
        route.ts                      # get-todo.api の GET / update-todo.api の PUT / delete-todo.api の DELETE を re-export
features/
  todo/
    index.ts                          # 公開 API。外から import してよいのはここだけ
    api/
      todo-api.ts                     # /api/todos を fetch する薄いラッパー（型は backend の api ファイルから import type し、画面側に re-export）
      todo-api.test.ts
    components/
      todo-item.tsx                   # feature 内で画面をまたぐ部品
      todo-item.test.tsx
    hooks/                            # 画面をまたぐ hook（必要になったら作る）
    screens/
      todo-screen/
        todo-screen.tsx               # 見た目。"use client"。hook の戻り値を描くだけ
        todo-screen.hook.ts           # 状態・イベント・データ取得（useTodoScreen）
        todo-screen.test.tsx
        todo-screen.hook.test.ts
      todo-detail-screen/
        todo-detail-screen.tsx        # props は todoId（app/todo/[id]/page.tsx から受け取る）
        todo-detail-screen.hook.ts    # useTodoDetailScreen(todoId)
        todo-detail-screen.test.tsx
        todo-detail-screen.hook.test.ts
backend/
  shared/
    domain/
      domain-error.ts                 # DomainError（code: validation_error / not_found）
    presentation/
      http-error.ts                   # DomainError → HTTP ステータスの変換、ErrorResponse 型、InvalidRequestError
      http-error.test.ts
      json-body.ts                    # リクエスト本文を JSON のオブジェクトとして読む（readJsonObject）
      json-body.test.ts
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
      todo-repository.in-memory.ts    # Repository の実装（InMemory）
      todo-repository.in-memory.test.ts
      container.ts                    # 組み立て（DI）。createTodoContainer(repository) と、アプリ共有の todoContainer
```

## `app/`（ルーティング）
- 置くもの: `page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx` などの Next の規約ファイルと、`app/api/**/route.ts` だけ。
- `page.tsx` は screen を返すだけにする（`return <TodoScreen />`）。状態・データ取得・見た目は screen 側に書く。
- `app/api/**/route.ts` は `backend/<feature>/presentation` の api ファイルが export する HTTP メソッド名の関数を re-export するだけにする（`export { GET } from "@/backend/todo/presentation/list-todos.api";`）。入力検証やレスポンスの組み立ては書かない。
  - 同じ URL の複数のメソッド（`/api/todos` の GET と POST など）は、それぞれ別の api ファイルから re-export する。
  - re-export した関数が Route Handler として動くことは確認済み（公式ドキュメントには明記がないため実測。Next.js 16.3.6、2026-09-28）: `pnpm build` の出力で `/api/todos` と `/api/todos/[id]` が動的ルート（ƒ）として出力され、`next start` に curl して一覧・取得・作成・更新・削除（CRUD）が動いた。
  - 動的セグメント（`[id]`）の `params` は Promise で、`await` して取り出す（`15-route-handlers.md` の「Route Context Helper」の例 `await ctx.params`）。取り出しは api ファイル側で行う。
- `app/` にテストは置かない。
  - 理由: `app/` のファイルは screen / api ファイルを繋ぐだけで、仕様（テスト = 仕様）は screen と api ファイルのテストで固定する。ルーティングのファイルにロジックを置かせない狙いもある。

## `features/<feature>/`（画面側）
- `screens/<name>-screen/`: 1 画面 = 1 ディレクトリ。次の 2 ファイルとテストを同居（コロケーション）させる。
  - `<name>-screen.tsx`: 見た目。先頭に `"use client"`。hook の戻り値を描くだけで、状態やデータ取得を持たない。
  - `<name>-screen.hook.ts`: 状態・イベントハンドラ・データ取得（`use<Name>Screen`）。
  - テスト: `<name>-screen.test.tsx`（screen）、`<name>-screen.hook.test.ts`（hook）を隣に置く。
  - 理由: 見た目とロジックを分けると、ロジックは hook 単体（`renderHook`）で、見た目は操作ベースで、それぞれ小さくテストできる。1 画面のファイルを 1 か所にまとめ、画面を消すときはディレクトリごと消せるようにする。
- `components/`: feature 内で画面をまたぐ部品。
- `hooks/`: feature 内で画面をまたぐ hook。
- `api/`: `/api/...` を fetch する薄いラッパー。feature の中で backend を参照してよいのはここだけ。リクエスト / レスポンスの型は `backend/<feature>/presentation/<name>.api.ts`（エラー時の `ErrorResponse` は `backend/shared/presentation/`）から `import type` で参照し、画面側の他のコード（screens / components / hooks）が使う型は `api/` から re-export する（下の「画面側とサーバ側の境界」）。
- `index.ts`: feature の公開 API。feature の外（`app/`・他の feature）から import してよいのはここだけ。
  - 理由: feature の内部構成を変えても、外側の import を直さずに済むようにする。
- `components/` `hooks/` は、使うものが出てくるまで作らない（空のディレクトリを置かない）。

### SSR を前提にしない
- 画面にサーバロジックを書かない。Server Components でのデータ取得や Server Functions（Server Actions）は使わず、データは hook から `api/` 経由で `/api/...` を呼んで取る。
- 理由: 画面側のデータ取得の経路を「hook → `api/` → Route Handler」の 1 本に揃え、サーバの処理はすべて `backend/` の 4 層に集める。画面と API の境界が HTTP になり、それぞれ単独でテストできる。
- Next がビルド時に Client Components を静的 HTML に prerender すること自体は止めない。`output: "export"`（静的エクスポート）や `next/dynamic` の `ssr: false` は、ブラウザ専用 API（`window` / `localStorage` など）で困るまで使わない。
  - 理由: `output: "export"` にすると Route Handler は `GET` だけになり、ビルド時に静的なレスポンスとして固定される（`02-guides/static-exports.md` の「Route Handlers」。Request に依存する Route Handler は「Unsupported Features」）。API を Next で完結させる方針と合わない。ブラウザ専用 API は `useEffect` の中で触れば prerender と両立する（同ファイルの「Browser APIs」）。

## `backend/<feature>/`（API 側、DDD 4 層）
| 層 | 置くもの | 依存してよい先 |
| --- | --- | --- |
| `presentation/` | api ファイル。1 API = 1 ファイル `<verb>-<noun>.api.ts`（例: `list-todos.api.ts`、`create-todo.api.ts`）。コンテナを受け取って handler（Request → 入力の形の検証 → query / command → Response）を返す関数（`listTodosApi(container)`）、それを本番用のコンテナで組み立てた HTTP メソッド名の定数（`export const GET = listTodosApi(todoContainer)`）、その API のリクエスト / レスポンスの型を export する | `application`、`domain`（Entity の型の参照のみ。query / command が返す Entity を DTO に変換するため `import type { Todo }` する）、`infra/container.ts`（コンテナの型と本番用のコンテナの受け取りだけ）、`backend/shared` |
| `application/` | ユースケース。1 ユースケース = 1 ファイルで、読むだけ（副作用なし）のものは `<verb>-<noun>.query.ts`、状態を変えるものは `<verb>-<noun>.command.ts`（例: `list-todos.query.ts`、`create-todo.command.ts`） | `domain`、`backend/shared` |
| `domain/` | Entity / Value Object / Repository の interface（DomainError は feature をまたいで使うため `backend/shared/domain/` に置く） | `backend/shared` だけ（Next・React・DB に依存しない） |
| `infra/` | Repository の実装、`container.ts`（組み立て = DI。リポジトリを受け取ってコンテナを作る `createTodoContainer(repository)` と、アプリで共有する `todoContainer`） | `domain`（interface を実装する）、`application`（container で組み立てる） |

- 依存の向き: `app/api → presentation → application → domain`。`infra` は `domain` の interface を実装する（依存性の逆転）。
- presentation は 1 API = 1 ファイルにし、その API のリクエスト / レスポンスの型（DTO）もそのファイルの中で定義して export する。feature で共通の型ファイルは置かない。
  - 例: `list-todos.api.ts` は `listTodosApi(container)`（handler は `(request: Request) => Promise<Response>`）と `export const GET = listTodosApi(todoContainer)` を export する。動的セグメントがある `get-todo.api.ts` の handler は `(request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>`。
  - 複数の API が同じ形を返す場合（`list-todos` / `get-todo` / `create-todo` / `update-todo` が返す `TodoDto` など）も、各ファイルで定義する（共通化しない）。
  - 理由: api ファイルを 1 つ開けば、その API の契約（リクエスト / レスポンスの型）と処理がすべて見えるようにする（ユーザーの判断）。同じ形を複数回書くことになり、形を変えるときは該当する api ファイルをすべて直す必要があるが、その手間よりも 1 ファイルで契約が完結することを優先する。
- application は、読むだけで副作用のない query（`.query.ts`）と、状態を変える command（`.command.ts`）に分ける。
  - 理由: 副作用の有無をファイル名で区別し、読むだけの処理が状態を変えていないか、状態を変える処理がどれかを、開かずに見分けられるようにする。
- api ファイルは「コンテナを受け取って handler を返す関数」（`listTodosApi(container)`）を export し、本番の Route Handler はそれに `infra/container.ts` の共有コンテナ `todoContainer` を渡して作る（`export const GET = listTodosApi(todoContainer)`）。
  - 理由: テストでは `listTodosApi(createTodoContainer(new InMemoryTodoRepository()))` のように空のリポジトリで組み立てた handler を使い、共有のコンテナ（`todoContainer`）に依存しないようにするため。共有のコンテナをテストで使うと、前のテストが作った Todo が残り、結果がテストの実行順に左右される。handler の中身は本番と同じものをテストする。
  - 受け取るコンテナの型は `Pick<TodoContainer, "listTodos">` のように、その API が使う query / command だけに絞る（何に依存しているかを型で読めるようにするため）。
- `presentation` は query / command を `infra/container.ts` で組み立てたコンテナからだけ受け取る。Repository の実装を直接 new しない（テストで `createTodoContainer` に InMemory リポジトリを渡すのは除く）。
  - 理由: 実装の差し替え（InMemory → DB）を `container.ts` の 1 か所で済ませるため。
- `domain` は Next・React・DB に依存させない。
  - 理由: ビジネスルールをフレームワークや永続化の都合から切り離し、純粋な単体テストで検証できるようにする。
- `backend/shared/`: feature をまたいで使う型や処理。`DomainError` は `backend/shared/domain/domain-error.ts`、DomainError → HTTP ステータスの変換・エラー時のレスポンスの型 `ErrorResponse`・リクエストの形の誤りを表す `InvalidRequestError` は `backend/shared/presentation/http-error.ts`、リクエスト本文を JSON のオブジェクトとして読む `readJsonObject` は `backend/shared/presentation/json-body.ts` に置く。
- 永続化は当面 InMemory（`todo-repository.in-memory.ts`）。プロセスの再起動でデータは消える。DB を決めたら `infra/` に実装を足し、`container.ts` で切り替える。
- 入力検証は手書きにする（バリデーションライブラリは入れない）。
  - 理由: 現状の規模では依存を増やすほどの必要がない。入力が複雑になったら Issue で導入を検討する。
- 入力検証の分担: presentation は入力の「形」だけを検査し、値の中身の規則は domain の不変条件に一本化する。
  - presentation（api ファイル）: 本文が JSON のオブジェクトか（`readJsonObject`）、項目の型（`title` が string か、`completed` が boolean か）。違反は `InvalidRequestError` → 400（`validation_error`）。
  - domain: 値の中身の規則（例: `title` は前後の空白を除いて 1〜100 文字。`Todo.create` / `Todo#rename`）。違反は `DomainError("validation_error")` → 400。
  - 理由: 同じ規則を presentation と domain の 2 か所に書くと、片方だけ直してずれる。どちらの違反もレスポンスは同じ 400 / `validation_error` になるので、クライアントから見た結果は変わらない。

## 画面側とサーバ側の境界
- 画面側で backend を参照してよいのは `features/<feature>/api/` だけ。参照先は `backend/<feature>/presentation/<name>.api.ts`（リクエスト / レスポンスの型）と `backend/shared/presentation/`（エラー時の `ErrorResponse`）で、いずれも `import type` のみ。api ファイルの関数や、application・domain・infra の実装は import しない。
  - 理由: 画面とサーバで同じ契約（型）を使い、ずれを型チェックで検出する。`import type` はビルド時に消えるので、サーバ専用のコードが画面のバンドルに入らない。
- 画面側の他のコード（screens / components / hooks）は backend を直接参照せず、`api/` が re-export した型を使う（例: `import type { TodoDto } from "@/features/todo/api/todo-api"`）。
  - 理由: 画面とサーバの境界を `api/` の 1 ファイルに集約し、契約（型）が変わったときの影響と変更点を 1 か所で追えるようにする。
- 型で担保されること: リクエスト / レスポンスの「形」。api ファイルの型を変えると、それを使う画面側のコードの不一致が `pnpm build` の型チェックで検出される。
- 型で担保されないこと（画面側に文字列で書く）:
  - URL と HTTP メソッド（`fetch("/api/todos", { method: "POST" })` の `"/api/todos"` と `"POST"`）。`app/api/**/route.ts` の置き場所や re-export するメソッドを変えても、型チェックでは検出されない。
  - 実行時の JSON の形。`response.json()` の結果を型に当てはめるだけで、実際に返ってきた値がその形かは検査しない。
  - URL を型で担保したくなったら、各 api ファイルから path の定数を export して画面側で使う案を検討する（今回は入れない）。

## 依存の向き（全体）
- 画面側: `app → features → shared`
- API 側: `app/api → backend`
- 画面側 → API 側: `features/<feature>/api → backend/<feature>/presentation/<name>.api.ts` と `backend/shared/presentation/` の `import type` だけ（上の「画面側とサーバ側の境界」）。`features/<feature>/` の `api/` 以外は backend を参照せず、`api/` が re-export した型を使う。
- feature 同士は原則 import しない。必要なときは相手の `index.ts` だけを import する。
- `shared/` は `features/` を import しない（逆向きの依存を作らない）。
- 検査: 現状はこのルール文書だけで、機械的な検査（Biome の `noRestrictedImports` など）は入れていない。検査できるかは未確認で、別 Issue で検討する。
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
| `backend/**/domain` | 純粋な単体テスト | Node |
| `backend/**/application`（`.query.ts` / `.command.ts`） | InMemory リポジトリを渡して検証 | Node |
| `backend/**/presentation`（`.api.ts`） | 空の InMemory リポジトリで組み立てた handler（`listTodosApi(createTodoContainer(new InMemoryTodoRepository()))`）に `new Request()` を渡し（動的セグメントがあれば `ctx` も）、返る `Response` を検証。共有の `todoContainer` は使わない（上の「`backend/<feature>/`」）。Next の起動は不要 | Node |
| `features/**/*.hook.ts` | `renderHook` で状態とイベントを検証 | jsdom |
| `features/**/*-screen.tsx` | render して操作（クリック・入力）し、表示を検証 | jsdom |
| 画面から API まで通した動作（`e2e/*.spec.ts`） | Playwright で本番ビルドを起動し、ブラウザ（Chromium）で画面を操作して表示を検証 | Chromium |

- `backend/` のテストはファイル先頭に `// @vitest-environment node` を書き、Node 環境で実行する。画面側のテストは `vitest.config.mts` の既定（jsdom）で実行する。
  - 理由: サーバのコードはブラウザ上では動かないため、DOM のない Node 環境で検証する。ファイル単位のコメントで環境を切り替えられることは、Vitest 5.0.1 で実測済み（既定を jsdom にした状態で、このコメントを付けたテストでは `document` が undefined、付けないテストでは object になった）。
- Route Handler は Web 標準の `Request` / `Response` で書ける（`15-route-handlers.md` の「Route Handlers」）ため、api ファイルの handler は Next を起動せずに `Request` → `Response` の関数としてテストできる。

### カバレッジ
- `pnpm test`（`vitest run --coverage`）は単体テストのカバレッジを計測し、Statements / Branches / Functions / Lines のいずれかが 100% を下回ると失敗する。CI の `ci` ジョブもこの `pnpm test` を実行するので、100% 未満では PR をマージできない。設定は `vitest.config.mts` の `coverage`（WHY はファイル内のコメント）。
- カバレッジなしで速く回したいときは `pnpm test:unit`（`vitest run`）。完了前には必ず `pnpm test` を通す。
- 計測対象: `features/` `backend/` `shared/` の `.ts` / `.tsx` と `scripts/` の `.ts`（テスト `*.test.ts(x)` と型宣言 `*.d.ts` は除く）。
- 計測しないもの（ユーザー判断、Issue #45）:
  - `app/`: ルーティングだけで、テストを置かない方針（上の「`app/`（ルーティング）」）。結線は E2E で確かめる。
  - ルート直下の設定ファイル（`next.config.ts` / `playwright.config.ts` など）: ツールに渡す値を並べるだけで、単体テストで検証する振る舞いを持たない。
  - `scripts/` のシェルスクリプト（`.sh`）: V8 のカバレッジは JS しか計測できない（include に入れても解析に失敗して自動で外される）。
- 100% に満たないときは、テストを足して埋める。`/* v8 ignore */` などのコメントで計測から外すことはしない。
  - 理由: テスト = 仕様なので、テストが通らないコードは仕様のないコードになる。ignore で逃がすと数字だけが 100% になり、仕様の抜けが見えなくなる。
  - 分岐を通すだけのテストにしない。その分岐で起きること（返り値・状態・呼び出し）を検証する。
  - 計測の対象外を増やすときは、上の方針に当てはまることを確かめ、`vitest.config.mts` とこの節に理由を書く。

### E2E テスト（Playwright）
- 置き場所: ルート直下の `e2e/` に `<feature>.spec.ts` で置く（例: `e2e/todo.spec.ts`）。対象の隣には置かない。
  - 理由: E2E は画面・API・ルーティングをまたいで 1 つの操作の流れを検証するもので、特定のファイルに対応しない。
- 実行: `pnpm test:e2e`（`playwright test`）。設定は `playwright.config.ts`。`webServer` が `pnpm build && pnpm start -p 3100` で本番ビルドを起動してからテストする（ローカルで 3100 番にサーバが起動済みなら、それを使う）。`pnpm test`（Vitest）には含めない（`vitest.config.mts` で `e2e/**` を除外）。
- 1 テストで CRUD を一周する（追加 → 完了 → 詳細で title を変更 → 一覧から削除）。テストを増やすときも、1 テストの中で作ったデータはそのテストの中で消す。
  - 理由: API は InMemory で、`webServer` の 1 プロセスを全テストが共有する（`workers: 1` で順番に実行）。テスト間でデータが残ると結果が実行順に依存するため、テスト間の独立性ではなく 1 本の中の操作の順序で状態を担保する。
- Chromium のビルド: `@playwright/test` が要求するビルドと、環境に入っているブラウザが一致しないときは、環境変数 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` に Chromium の実行ファイルを渡す（例: クラウド VM では `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e`）。CI では `pnpm exec playwright install --with-deps chromium`（OS の依存ライブラリも入れる）、ローカルでは `pnpm exec playwright install chromium` で版の合ったブラウザを入れ、この変数は使わない。
  - 理由: クラウド VM の `/opt/pw-browsers` にある Chromium はビルド 1194 で、`@playwright/test@1.63.0` の要求（1243）と一致しない。変数なしで実行すると、Playwright が 1243 の実行ファイル（`/opt/pw-browsers/chromium_headless_shell-1243/...`）を探して `Executable doesn't exist` で失敗し、この変数で 1194 の Chromium（141）を渡すと通った（2026-09-28 実測）。

## 採用しなかった案
- `app/` 内に `_components` などの private folder を置き、ルート単位でコードを分ける構成（公式の「Split project files by feature or route」）: URL とコードの置き場所が結びつき、ルートを移動・改名するとコードも動かすことになる。
- `components/` `hooks/` `lib/` を最上位に並べる層別の構成: 1 つの機能のコードが層をまたいで散り、機能の追加・削除で複数のディレクトリを触ることになる。
- `src/` の下に置く構成: ユーザーの判断で不要。ルート直下に置く。
- `features/<feature>/` の中に `client/` と `server/` を並べる構成: 同じ feature ディレクトリに `"use client"` のコードとサーバ専用のコードが混在し、画面からサーバの実装を import する誤りが起きやすい。API 側は `backend/` として最上位で分離する。
- 旧案（Issue #39 の最初の案）: API 側のディレクトリ名を `server/` にし、presentation に feature 共通の型ファイル `dto.ts` と、複数の API をまとめたコントローラを置き、application のユースケースを `.use-case.ts` の 1 種類にする構成。ユーザーの判断で、ディレクトリ名は `backend/`、presentation は 1 API = 1 ファイル（型もその中で定義）、application は query / command に分ける形に変えた。

## 一次情報
- Next.js 16.3.6 同梱ドキュメント `node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md`
  - 「Organizing your project」: Next.js はプロジェクトの構成について unopinionated。
  - 「Store project files outside of `app`」（「Examples」の中）: コードをルート直下の共有フォルダに置き、`app/` をルーティング専用にする構成。本リポジトリはこれを feature 単位にしたもの。
  - 「Private folders」: `_folderName` はルーティングから外れる。本リポジトリでは `app/` の外にコードを置くため使わない。
  - 「Route groups」: `(folderName)` は URL に含まれない。ルーティングの整理の仕組みで `app/` の中で完結し、コードの置き場所には関係しない。
  - 「Split project files by feature or route」（「Examples」の中）: 採用しなかった案の 1 つ目。
- 同 `15-route-handlers.md`
  - 「Route Handlers」: Web 標準の Request / Response API で書く。Route Handler は `app/` の中でだけ使える（api ファイルの関数を `app/api/**/route.ts` で re-export する理由）。
  - 「Route Context Helper」: 動的セグメントの `params` は `await ctx.params` で取り出す。
- 同 `node_modules/next/dist/docs/01-app/02-guides/static-exports.md` の「Route Handlers」「Unsupported Features」「Browser APIs」、`02-guides/lazy-loading.md` の「Skipping SSR」（`ssr: false`）。
