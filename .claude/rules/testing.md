---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "apps/e2e/**"
  - "vitest.config.mts"
  - "vitest.global-setup.ts"
  - "stryker.config.mjs"
---

# テスト

テストは仕様。仕様が黙って外れたり、壊れたコードを見逃したりしない状態を保つ。

## 基本
- テストを先に書き、**失敗することを確認してから**実装する（CLAUDE.md の Test Driven）。WHY: 先に失敗を見ないと、実装に関係なく通る（何も検査していない）テストに気づけない。
- テスト名は日本語の仕様文（「〜すると〜になる」「〜のときは〜しない」）。WHY: 一覧がそのまま仕様になり、失敗したときにどの仕様が破れたかが分かる。
- 分岐を通すだけのテストにしない。その分岐で起きること（返り値・状態・呼び出し・出力）を検証する。WHY: 何も検証しないテストでもカバレッジは上がる。
- `it.skip` / `it.only` を残さない（Biome の `noSkippedTests` / `noFocusedTests` で止まる。`.claude/rules/lint.md`）。WHY: skip は仕様を黙って外し、only はほかのテストを黙って止める。
- 失敗（reject / throw）の検証は `rejects.toEqual(new Error("..."))` のようにクラスと message を比べる（クラスが決まらなければ `rejects.toBeInstanceOf(Error)` と `rejects.toMatchObject({ message })`）。WHY: Vitest 5.0.1 の `rejects.toThrow("文字列")` / `toThrowError("文字列")`（同期の `toThrow("文字列")` も）は、値が `undefined` だと文字列を照合せずに通る（実測）。
- テストを足す・書き換えたら、そのテストが守るコードを 1 度壊して落ちることを確かめ、元に戻す（条件の反転・戻り値の変更・呼び出しの削除など）。WHY: 検証が弱いと壊しても緑のまま。書き換えで既存の検証が消えることもある。

## 置き方と環境
対象と同じディレクトリに `<対象>.test.ts(x)` で置く（`apps/frontend_customer/app/` には置かない）。E2E だけ workspace パッケージ `@repo/e2e` の `apps/e2e/<feature>.spec.ts`（画面・API・ルーティングをまたぐため）。

| 対象 | 方法 | 環境 |
| --- | --- | --- |
| `apps/backend/**/domain` | 純粋な単体テスト | Node |
| `apps/shared/`（`env.ts`・`logger.ts`・`now.ts`） | 純粋な単体テスト（一時ディレクトリの `.env`、`console` の spy、`now` の `vi.mock`） | Node |
| `apps/backend/**/application` | InMemory リポジトリ（`apps/backend/test-support/<feature>/*.in-memory.ts`）を渡して検証 | Node |
| `apps/backend/**/infra` の Postgres の実装（`*.postgres.ts`・`database.ts`） | 実 Postgres。`createTestDatabase()` でファイルごとの別スキーマ（`test_<UUID>`）にマイグレーションを当て、各テストの前に `TRUNCATE` | Node |
| `apps/backend/api-journeys/*.api-journey.test.ts`（API ジャーニー。対の Gherkin の `<name>.feature` の step の実装。下の「API ジャーニーテスト」） | 実 Postgres（`createTestDatabase()`）の db で本番と同じに組み立てた複数の handler に、業務の流れの順に `new Request()` を渡し、応答と（変更系の後は）DB の行で確かめる | Node |
| `apps/backend/**/presentation` | 空の InMemory（`apps/backend/test-support/<feature>/`）で組み立てた handler（`new ListTodosApi(new ListTodosQuery(new InMemoryTodoRepository())).handle`）に `new Request()`（と `ctx`）を渡し、`Response` を検証。本番の handler（`export const GET` など）は、Postgres の Repository の prototype を spy して結線だけを確かめる | Node |
| `apps/frontend_customer/features/**/*.hook.ts` | `renderHook` で状態とイベント | jsdom |
| `apps/frontend_customer/features/**/*-screen.tsx` | render して操作し、表示を検証 | jsdom |
| `apps/e2e/*.spec.ts` | Playwright で本番ビルドを起動し、Chromium で操作 | Chromium |

- `apps/backend/`・`apps/shared/` のテストは先頭に `// @vitest-environment node`（既定は jsdom）。WHY: サーバのコードは DOM の無い環境で検証する。
- 実 Postgres を別スキーマに分ける WHY: Vitest はファイルを並列に、Stryker はさらに複数プロセスで実行する。同じ `public.todos` を使うと互いの `TRUNCATE` でデータが消え、`pnpm dev` や E2E の表も消える。drizzle の migrator には同時実行の排他が無い（drizzle-orm 0.45.3 の `pg-core/dialect.js` の `migrate` を読んで確認）。
- `pnpm test` / `pnpm test:unit` / `pnpm test:api-journey` / `pnpm test:mutation` は Postgres が起動している前提（`pnpm db:up`）。接続先は `.env` の `DATABASE_URL`。

## カバレッジ（100%）
- `pnpm test`（`vitest run --coverage`）は Statements / Branches / Functions / Lines のどれかが 100% 未満なら失敗する（CI でも止まる）。速く回すだけなら `pnpm test:unit`、完了前は必ず `pnpm test`。設定と WHY は `vitest.config.mts`。
- 計測対象: `apps/frontend_customer/features/`・`apps/frontend_customer/shared/`・`apps/frontend_customer/test-support/`（Issue #181）・`apps/backend/` の `.ts` / `.tsx`、`apps/shared/` の `.ts`（Issue #90）と `scripts/` の `.ts` / `.mjs`（テスト・`*.d.ts`・`apps/backend/` 直下の `*.config.ts` を除く。`.mjs` は Issue #178 の `work-log-sections.mjs`）。
- 計測しないもの（ユーザー判断、Issue #45）: `apps/frontend_customer/app/`（ルーティングだけ。E2E で確かめる）、設定ファイル、`instrumentation*.ts`（起動時だけ動く。中身は `env.ts` のテストで固定）、`apps/frontend_customer/proxy.ts`（Next がリクエストごとに呼ぶ結線だけ。1 行の中身は `shared/request-log/` のテスト、結線は E2E。Issue #80）、`.sh`（V8 は JS しか測れない）。
- 足りなければテストを足して埋める。`/* v8 ignore */` などで逃がさない。対象外を増やすときは上の方針に当てはまるか確かめ、`vitest.config.mts` とここに理由を書く。

## globalSetup（テスト用スキーマの後始末）
- `vitest.global-setup.ts` が実行の最初に 1 回、`test_` で始まるスキーマを `DROP SCHEMA ... CASCADE` で消す（`cleanupTestSchemas`）。`afterAll` での削除も残す。
  - WHY: プロセスが `afterAll` の前に止まる（Stryker が worker を止める・Ctrl-C）と残る。テストの前なら消してよいのは前の実行の残りだけ。
- 探し方は `starts_with(schema_name, 'test_')`（LIKE の `_` は任意の 1 文字に一致するため使わない）。
- Postgres に接続できなければ「cannot connect to Postgres … start it with pnpm db:up」のエラー（英語。Issue #116 で非テストコードの日本語を無くした）で止める。
- Stryker の worker の中（`STRYKER_MUTATOR_WORKER` がある）では消さない（並行する worker の使用中のスキーマを消すため）。同じ DB に `pnpm test` を 2 つ同時に動かさない。
- `cleanupTestSchemas` のテストはテストごとの接頭辞（`test_cleanup_<UUID>_`）で行う（`test_` だと並列の他のファイルのスキーマを消す）。

## テストダブル
- backend: InMemory リポジトリ（`apps/backend/test-support/<feature>/<名前>-repository.in-memory.ts`。テストだけが使うので test-support に置く。Issue #191。`rule-tests/test-support.test.ts` の `in-memory-placement`）を query / command のコンストラクタに渡して組み立てる（Issue #123。`vi.mock` は使わない）。書き込みの command には InMemory のトランザクションの runner（`apps/backend/test-support/transaction-runner.in-memory.ts` の `InMemoryTransactionRunner`。work を呼ぶだけで rollback は再現しない。Issue #215）も渡す。テストが Repository に直接 Todo を置くときは `repository.insert(todo, inMemoryTransaction)`。モックは最小限。WHY: モックは「こう呼ばれるはず」を書き込むので、実装とずれても緑のまま。（検査は `rule-tests/test-doubles.test.ts`: backend のテストの `vi.mock` は `@repo/shared/now` だけ（`vi.doMock` も違反。ほかは呼び出しの直前の行の `// WHY モック: <理由>` で通す）、`apps/backend/test-support/database` の import は infra のテスト・test-support 自身のテスト・API ジャーニー・global-setup だけ）
  - Postgres の実装はモックせず実 Postgres で（SQL の組み立て・uuid は差し替えると検証できない）。例外は api ファイルの本番の handler の結線の確認だけ（`PostgresTodoRepository.prototype` と `PostgresTransactionRunner.prototype.run`（work に `inMemoryTransaction` を渡すだけにして DB に接続しない。Issue #215）の spy。Repository の振る舞いは確かめず、Postgres の実装と runner が呼ばれることだけを見る）。
  - InMemory で起こせない失敗の経路だけ、必要な分を差し替える（例: `list-todos.api.test.ts` の 500 は常に reject する `failingRepository` と、`console.error` の `vi.spyOn`）。
- 時計（現在時刻）: `now`（`apps/shared/now.ts`。現在時刻の唯一の出口）を `vi.mock` で差し替え、`vi.mocked(now).mockReturnValue(date)` / `mockReturnValueOnce(date)` で時刻を決める（backend の「`vi.mock` は使わない」の例外）。backend のテストは `vi.mock("@repo/shared/now")`、`apps/shared` の中は `vi.mock("./now")`。`afterEach` で `vi.mocked(now).mockReset()` する。
  - 自動モックの `now` は既定で `undefined` を返す（`Todo.create` は作成日時の不変条件で validation_error になり、返させ忘れに気づける）。ファイルのほかのテストが実時刻のままでよいときは `vi.mock("@repo/shared/now", { spy: true })` で本物を残し、時刻を決めるテストだけ `mockReturnValueOnce` する（`todo-repository.postgres.test.ts`）。
  - WHY 時計だけ vi.mock: 時計はコンストラクタで渡す依存ではなく横断的な seam で、作成日時を引数で受け取ると Entity の生成ルールが呼び出し側に漏れる（`.claude/rules/shared.md` の「now」）。`vi.useFakeTimers` で `Date` を差し替えるのは `now.ts` 自身のテストだけ（本物が実時計を読むことを確かめる）。
- 画面側の hook / screen: `vi.mock("@/features/todo/api/todo-api")` と `vi.mocked(listTodos).mockResolvedValue(...)`。WHY: 境界の `api/` で切ると HTTP やサーバの状態に依存しない。
- `api/`: `vi.stubGlobal("fetch", vi.fn<typeof fetch>())` で、送った URL・メソッド・本文と応答の扱いを検証する。
- 非同期の順序（古い応答が後から届く、画面を離れた後に失敗が届く）は、任意のタイミングで resolve できる `deferred()` で作る（各テストファイルの中に定義）。WHY: `mockResolvedValue` は即時に resolve し、タイマーは実行環境の速さに左右される。

## ルール検査テスト（規則・設定が効いていることを検査するテスト）
今あるもの: `rule-tests/architecture.test.ts`（`.claude/rules/architecture-check.md`）、`rule-tests/lint.test.ts`（`.claude/rules/lint.md`）、`rule-tests/package.test.ts`・`rule-tests/pnpm-workspace.test.ts`（`.claude/rules/dependencies.md`）、`rule-tests/typecheck.test.ts`（`pnpm typecheck` と CI の順序）、`rule-tests/schema.test.ts`（`apps/backend/**/infra/schema.ts` の列の型の既定。varchar / char・timezone 無しの timestamp・serial・json を、直前の行の `// WHY <見出し>:` が無ければ止める。`.claude/rules/backend.md` の「列の型」）、`rule-tests/api-request.test.ts`（`apps/backend/features/*/internal/presentation/*.api.ts` のリクエストの項目の `.optional()` を止める。同じユースケースの中で本当に任意の項目は、直前の行の `// WHY 任意:` で通す。`.claude/rules/backend.md` の「1 ユースケース = 1 API」）、`rule-tests/test-doubles.test.ts`（backend のテストの `vi.mock` / `vi.doMock` は `@repo/shared/now` だけ（例外は直前の行の `// WHY モック:`）、`apps/backend/test-support/database` の import は infra のテスト・test-support 自身のテスト・`apps/backend/api-journeys/*.api-journey.test.ts`・`vitest.global-setup.ts` だけ。「テストダブル」）、`rule-tests/api-journey.test.ts`（`apps/backend/api-journeys/` には直下の `*.api-journey.test.ts` と `*.feature` だけ（ほかの場所の `*.api-journey.test.*`・廃止した `*.journey.test.*`・`*.feature` も違反）、`<name>.feature` と `<name>.api-journey.test.ts` は対で置く（片方だけ・名前の違う組は違反。Issue #200）、`.feature` のコメント以外の行と仕切りの見出しに技術の言葉（`FORBIDDEN_WORDS_IN_FEATURE`）を書かない・シナリオの When の直前に仕切り `# ───── <業務の動作> ─────` を置く（`api-journey-business-language` / `api-journey-section-divider`。Issue #217）、各 API ジャーニーは `*.in-memory` を import しない（`import type` も）・`vitest` から `vi` を import しない・handler の名前を HTTP メソッドで始める・変更系の呼び出しの後に `db.select(` で DB を読む・異なる `*.api` を 2 つ以上と `test-support/database` を値で import する。Issue #187 / #200。「API ジャーニーテスト」）、`rule-tests/test-support.test.ts`（テストだけが使うコード `apps/*/test-support/` を本番に持ち込まない。`.dockerignore` の `**/test-support` の行、test-support/ の全ファイルと test-support を import するテストがそのパターンで除外されること、本番のコードが test-support を import しないこと、`apps/*/package.json` の exports に載せないこと、`apps/backend` の `*.in-memory.*`（InMemory の実装）は `apps/backend/test-support/` の下だけ（Issue #191）、`.github/workflows/deploy.yml` が runtime と migrate のイメージを find で確かめるステップを持つこと。Issue #181。`.claude/rules/backend.md` の「置き場所」）、`rule-tests/persistence.test.ts`（upsert の禁止、`*.postgres.ts` の update は `changed-props` を import（`update-uses-changed-props`。Issue #215 で `save-uses-changed-props` から改名）、`reconstruct` を持つ Entity は `origin` を持つ、`*.postgres.ts` で名前が `Changes` / `Events` / `Logs` で終わる insert のみの表を `.update(` / `.delete(` しない。`schema.ts`（features と shared/infra）の `pgTable("*_changes" | "*_events" | "*_logs")` を受ける変数名は `Changes` / `Events` / `Logs` で終わる（判定が変数名を見るため）。書き込みのある `*.postgres.ts` は書き込みの唯一の口 `shared/infra/writer` を値で import し、書き込みの受け手は `writerOf(` で得た Writer にし（`writes-through-writer`。Issue #215）、`change-log` を import せず（`no-change-log-in-repository`。Issue #215）、`transaction` と `recordChange` の名前を直接書かず、`db` を受け手にした書き込みをしない（`no-direct-transaction`（runner の `shared/infra/transaction.postgres.ts` は対象外） / `no-direct-record-change` / `no-direct-db-write`。Issue #205）。子表を import した `*.postgres.ts` は集約を子表の全件の `leftJoin` で読む（`limit(`・子表だけの `from(`・`where` の子表の列を止める。`aggregate-loads-all-children`。Issue #189）。`*.postgres.ts` のクラスのメソッドは、本体に行ロック `.for(` があれば名前を `ForUpdate` で終え、`ForUpdate` で終わる名前なら本体に `.for(` を持つ（`lock-method-name-for-update`。runner も対象。字句の推定で、本体は宣言から次のメソッドの宣言まで。`.for(` を別の関数に置いて呼ぶ書き方・プロパティで定義したメソッドは見ない。Issue #221）。`.claude/rules/backend.md` の「永続化」）、`rule-tests/domain-validation.test.ts`（domain で zod の `parse` / `safeParse`（`decode` / `spa` などの同じ働きのメソッドも）を直接呼ばず `validate` を通す。`validation_error` の DomainError を作るのは backend 全体で `validate.ts` だけ）、`rule-tests/use-case.test.ts`（application の `*Input` 型の任意の項目と `input.<x> !== undefined` の分岐を止める。`.claude/rules/backend.md` の「1 ユースケース = 1 API」。`*.command.ts` の `execute` の本体は `this.<依存>.run(` でトランザクションを張る（`command-runs-in-transaction`。DB に触らない command は直前の行の `// WHY トランザクション無し:` で通す。Issue #215。`.claude/rules/backend.md` の「application」））、`scripts/cloud-session-start.test.ts`（`.claude/rules/cloud-session.md`）、`rule-tests/instructions.test.ts`（CLAUDE.md の行数と @ import、`.claude/rules` の paths、ADR の形式（分類ディレクトリは 4 つの固定の集合・ファイル名・見出し・メタ・README の一覧。参照は `<分類>/<ファイル名>`）、スキルのフロントマター、旧 rules/ の参照）と、git ガード・作業ログ・worktree のフックのテスト（`scripts/hooks/*.test.ts` など）。テスト以外のゲート（カバレッジ・フック・CI の required check・型チェック）も同じ扱い。
- **must pass と must reject の両方**を持つ。WHY: must reject だけだと「何でも違反にする」壊れ方を、must pass だけだと「何も違反にしない」（常に緑）壊れ方を検出できない。「今のリポジトリで違反 0 件」は must pass の 1 例にすぎない。
- 判定は関数に切り出し、架空の入力で許可・拒否を固定したうえで、同じ関数で実ファイルを検査する。must reject は取り違えやすい境界を網羅する（import の書き方、版の書き方、設定のキーの有無・コメントアウト・ネスト、違反を単独で含むファイル、対象外のファイル）。
- 実ファイルで end-to-end に通す fixture を持つ（一時ディレクトリは `mkdtempSync(join(tmpdir(), "<name>-"))` で作り `afterAll` で消す）。違反の集合は `toEqual` で丸ごと比較する。WHY: 判定が正しくても、抽出・列挙が漏れれば見逃す。
- 列挙が空なら失敗させる（対象 0 件なら常に緑になる）。
- 規則を足す・変えるときは例と fixture も同じ変更で直し、規則の文書と突き合わせる。
- **fault injection** は必須。既定は最小セット（規則を破る 1 件 → そのテストだけが落ちる、判定を常に許可 → must reject が落ちる、判定を常に拒否 → must pass が落ちる）。列挙を空・設定を戻す・境界の網羅（数十件の変異）は、新しいルール検査テストやゲートを作るときだけ行う。元に戻して `git status --short` と `git diff` を確かめ、何を壊して何件落ちたかを報告・PR に書く。reviewer はロジックのある変更で別の壊し方を独立に行う。WHY 最小セット: 見逃しの検出に効くのは主に「常に許可」「常に拒否」で、数十件の変異は消費の大半を占めた（ADR `docs/adr/workflow/20260929-save-usage-limit.md`）。手順はスキル `rule-check-test`。

## API ジャーニーテスト（Issue #187 / #200）
実 Postgres で、複数の API の handler（`XxxApi.handle`）を業務ユースケースに沿って順に呼ぶテスト。業務の流れを Gherkin（`@amiceli/vitest-cucumber`）の `.feature` に日本語の step で書き、step の実装を対の TypeScript に書く（例: `apps/backend/api-journeys/todo-lifecycle.feature` と `todo-lifecycle.api-journey.test.ts`）。この対が唯一の形（TS だけのジャーニーは Issue #200 で廃止）。決定と採用しなかった案は ADR `docs/adr/quality/20260930-backend-journey-tests.md`（ジャーニーテストを足す）と `docs/adr/quality/20260930-gherkin-journeys-with-vitest-cucumber.md`（`.feature` の対だけにする・API ジャーニーへの改名）。形は `rule-tests/api-journey.test.ts` が検査する。
- 呼び名: 一般には Mike Cohn のテストピラミッドの「サービステスト」、Martin Fowler の「Subcutaneous test」、実務では「API テスト / API 統合テスト」と呼ばれる層で、この repo では E2E（Playwright、画面込み）と区別するため「API ジャーニー」と呼ぶ（Issue #200 のユーザー判断）。
- 役割の分担: 単体（層ごと・InMemory。分岐と失敗の網羅）/ API ジャーニー（実 DB・本番と同じ組み立て・API をまたぐ業務の流れ）/ E2E（画面・ビルド・ルーティングを通した利用者の操作）。WHY: 単体は Postgres の Repository を通した API 同士のつながりを見ず、E2E は遅く失敗の原因を切り分けにくい。分岐の網羅は API ジャーニーに持ち込まない（単体で行う）。
- 対の命名と置き場所: `<ユースケース>.feature` と `<ユースケース>.api-journey.test.ts` を `apps/backend/api-journeys/` の直下に置く（`rule-tests/api-journey.test.ts` の `api-journey-feature-pair`。片方だけ・名前の違う組は違反）。1 対 = 1 業務ユースケース、1 シナリオ = 1 つの流れ（E2E と同じく順序で状態を担保する）。step のファイルは `loadFeature("./<name>.feature")` で対の `.feature` を読む（読むパスが対かは検査しない）。
  - 置き場所は `apps/backend/api-journeys/` の直下だけ（feature をまたぐ流れを置くため `features/<f>/` の下にしない）。`api-journeys/` の外の `.feature`（`features/<f>/`・`apps/e2e/` など）と `*.api-journey.test.*` / `*.journey.test.*` も違反（`api-journey-placement`）。WHY: `.feature` を実行するのは対の step のファイルだけで、外に置くと対の検査にかからず何も実行されないまま残る。共通の補助が要るようになったら `apps/backend/test-support/` に置く。
- 組み立ては本番の api ファイルの最下部と同じ（Postgres の Repository → command / query → Api）で、db だけ `createTestDatabase()` のものにする。本番の `export const GET` などは使わない（`getDatabase()` の `.env` の DB を指し、テスト用のスキーマに向けられない）。準備は `beforeAll` で `createTestDatabase()` と `migrate()`、`Background` の step で `TRUNCATE`（各シナリオの前に実行される）、`afterAll` で `close()`。
- `.feature` は業務の言葉だけで書く（Issue #217。ユーザー判断）。`#` のコメント行を除くすべての行（見出し・step・説明・表。仕切り `# ───── <業務の動作> ─────` の見出しは見る）に、技術の言葉（DB・SQL・テーブル・レコード・返り値・リクエスト・レスポンス・ステータス・バリデーション・状態コード（`状態 201`・`状態コード`、3 桁の 1xx〜5xx の数。後ろに「文字」「件」「行」が続く業務の数は可）・Problem Details・JSON・null・insert / update / delete・表名・id・uuid・not found（`not-found`・`not_found` も）・title・completed・API・HTTP とメソッド名・エンドポイント。大文字小文字を区別しない）を書かない。禁止語の一覧は `rule-tests/api-journey.test.ts` の `FORBIDDEN_WORDS_IN_FEATURE`（`api-journey-business-language`）。技術の検証（状態コード・応答の本文・DB の行）は step の実装に閉じる（状態コードは `{int}` で受けず step の中に書く）。例: 「状態 201 で、未完了の Todo "牛乳を買う" が返る」→「未完了の Todo "牛乳を買う" が作られる」、「DB の todos は "牛乳を買う" の 1 行になる」→「Todo は "牛乳を買う" の 1 件だけになる」、「状態 404 で … not found の Problem Details が返る」→「… は存在しないと伝えられる」。
  - WHY: `.feature` は業務の仕様として開発者でない人も読む。技術の言葉が混ざると読める人が絞られ、業務の流れが検証の細部に埋もれる。コメント行（ファイル冒頭の技術の説明）は Gherkin の実行にも仕様にも含まれないので対象外。ただし仕切りの見出しは読者が拾い読みする行なので見る（見ないと技術の言葉を見出しに移すだけで逃れられる。reviewer の指摘）。
  - WHY 3 桁の数は後ろの助数詞で分ける: 状態コードは数だけで書かれ（`201 で`）、業務の数（`100 文字`・`200 件`）には助数詞が付く。許す助数詞は今使うものだけにし、要るようになったら足す。
- シナリオの中の API を呼ぶ step（When）の直前（空行を挟まない）に、業務の動作を名前にした仕切りのコメント行 `# ───── <業務の動作> ─────`（`#`・空白・`─` 5 つ・空白・見出し・空白・`─` 5 つ。例 `# ───── Todo を作る ─────`・`# ───── 一覧を見る ─────`）を置く。Background には置かない（Background の When は検査しない）。形が違う（`─` の数・見出しが空・`#` の後に空白が無い）ものも違反（`api-journey-section-divider`）。
  - WHY: 長いシナリオでも、どこで何をしているかを見出しで拾い読みできる。形を 1 つに固定して見た目をそろえ、検査も 1 つの正規表現で決める。
  - 限界: 仕切りを要るのは When の直前だけ（API を呼ぶ step を Given・And・`*` で書くと要求されない。仕切りが When 以外の前にあっても止めない）。禁止語は一覧にある語だけで、複数形（ids・APIs）・全角の数字・英字（`２０１`・`ＤＢ`）・一覧に無い技術の言葉は見ない。行ごとに見るので docstring（`"""`）の中も行の種類を区別しない（中の `#` の行はコメント、`When` で始まる行は When として扱う）。
- `.feature` の書き方: キーワードは英語（`Feature` / `Background` / `Scenario` / `Given` / `When` / `Then` / `And`）、step の文は日本語。値は `{string}`（`"..."` で囲む）・`{int}` で受け、step の関数の引数に型を注釈する（`(_ctx: TestContext, title: string)`）。変更系の step（When）の後に DB を読む step（Then / And）を置き、step の関数は `.feature` と同じ順にソースに書く（検査はソースの順で見る）。
  - 同じシナリオの中で、同じ種類（Given / When / Then / And）の step が同じ式に一致しないように文を変える。WHY: vitest-cucumber 8.0.0 は式の step を、同じ種類で最初に一致した行に割り当てるので、2 つ目の行は「Missing steps」で読み込み時に失敗する（2026-09-30 実測）。
  - step の過不足・文の違いは、vitest-cucumber が読み込み時に失敗にする（`.feature` の step に実装が無ければ「Missing steps in Scenario」）。
  - step 間の値（作った Todo・応答・改名した名前）はシナリオの関数の中の変数で渡す。`.feature` に書いた値を step の実装に固定値で書かず、`{string}` で受け取った値を変数に入れて後続の step が使う。WHY: step 1 つが Vitest の test 1 つで、シナリオの中で `.feature` の順に実行される。固定値で持つと `.feature` の値を変えたときに後続の step が落ちる。
- 各 step は status と本文で確かめる。変更系の API（POST / PUT / PATCH / DELETE）を実行した step の後は、応答に加えて DB の行も検証する（`database.db.select().from(todos)` で読み、`toStrictEqual` で期待の行全体と比べる。失敗した要求（400 / 404）の後は「行が変わっていない」を確かめる）。読み取り系（GET）の後は不要。WHY: 応答が正しくても永続化がずれる誤り（差分 UPDATE の漏れ・`where` の欠落・削除の取り違え）は、次の API の応答だけでは見逃しうる。API ジャーニーは実 DB を使う唯一の複数 API のテストなので、ここで行を見る（ユーザー判断。Issue #187 の当初は「DB を SQL で覗かず次の API の応答で確かめる」だった）。
  - handler を入れる変数（オブジェクトのキーも）の名前は HTTP メソッドで始める（変更系は `postTodo` / `putTitle` / `putCompletion` / `deleteTodo`、読み取りは `getTodo` / `listTodos`）。WHY: 検査は呼び出しの名前（`post` / `put` / `patch` / `delete` で始まる。大文字小文字を区別しない）で変更系を見分ける。`renameTodo` のような名前は見分けられないので、名前の規約そのものも検査する（`new XxxApi(` の定義の名前）。
  - `db.select(` は変更系の呼び出しごとにその後に書く（補助の関数にまとめない）。検査はソースの順で、変更系の呼び出しから次の変更系の呼び出し（またはファイル末尾）までに `db.select(` があるかを見る。
  - 検査の限界（`rule-tests/api-journey.test.ts` の冒頭）: 文字列の一致と行の順序で推定する。`db.select(` があっても内容を検証しているかは見ない（reviewer が見る）。コメント・文字列の中の `db.select(` は数えない。`await` の無い呼び出し・別の変数への入れ直し・Api のクラスの別名の import は見分けない。名前の HTTP メソッドと Api の実際のメソッドが合っているかは見ない（変更系の Api を get / list で始まる名前に入れると DB の検査を素通りする）。クラス名が `Api` で終わらない handler は命名の検査の対象外。step の関数を `.feature` と違う順に書くと、実行の順と検査の順（ソースの順）がずれる。
- テストダブルは使わない（`vitest` から `vi` を import しない。`vi.mock`・`vi.spyOn`・`vi.useFakeTimers`・`vi.stubGlobal` も、`@repo/shared/now` の差し替えも無し。InMemory も無し）。検査は `vi` の import（別名・名前空間・dynamic `import("vitest")`・同じものの別名 `vitest` も）で止める（vitest の globals は無効なので、import しなければ `vi` は使えない）。WHY 使い方ではなく import で止める: 以前は `vi.mock` / `vi.doMock` の呼び出しだけを見ていて、ほかのメソッドが通った。時刻に依存する並び（作成順）は、実時計が進むのを待って作る（`waitUntilAfter`）。
- 実行: `pnpm test:api-journey`（`vitest run apps/backend/api-journeys`）。`pnpm test` にも含まれる（Vitest の include `apps/**/*.test.{ts,tsx}`）。
- Stryker では実行しない（`vitest.stryker.config.mts` の `exclude`。Stryker は `vitest.config.mts` を継承したこの設定で動く）。WHY: step 1 つが Vitest の test 1 つになり、Stryker が変異を通る test だけに `testNamePattern` で絞ると、前提の step 抜きで後の step が失敗して killed と数えられうる。vitest-cucumber 8.0.0 に「シナリオを 1 つの test にする」設定は無い。代償として、API ジャーニーの流れは変異を殺すテストに数えない（変異は層ごとの単体テストと `*.postgres.test.ts` が殺す）。

## mutation testing（Stryker）
実行手順・生き残りの直し方・日次ジョブはスキル `mutation-testing`、決定は ADR `docs/adr/quality/20260928-mutation-testing-daily-with-score-100.md`、score の実測は 2026-09-28 の work-logs、各設定の WHY は `stryker.config.mjs`。
- 目標は score 100%（`thresholds.break: 100`。survived が 1 件でも日次ジョブが失敗する。ユーザー判断、Issue #55）。
- Vitest のカバレッジのしきい値（`vitest.config.mts`）は Stryker の実行では効かない。WHY: vitest-runner が coverage を無効にし、Stryker が変異ごとに、その変異を通るテストだけを実行するため（https://stryker-mutator.io/docs/stryker-js/vitest-runner/ ）。カバレッジ 100% のゲートは `pnpm test` が担う。
- ロジックの変異はテストを足して殺す。API のエラーの本文（Problem Details の `title`・`detail` など。`apps/backend/shared/presentation/problem.ts`・`problem-detail.en.ts`）は検証して殺す。
- `// Stryker disable next-line <Mutator>: <理由>` で除いてよいのは、**等価な変異**と**検証しない文言**（内部のログなど）だけ。理由を必ず書く。殺せるのに手間を省くために使わない。「等価」と決める前にほかの実行経路を探す（React の `<Activity mode="hidden">` では隠すときに effect の片付けが走り、state 更新も反映される）。
- 等価な変異を生む書き方をしない: 結果を変えない検査（`"error" in value` の後の型の確認）は書かない、例外を握りつぶす `try` は握りつぶしたい呼び出しだけを囲む、ロジックの定数（正規表現・変換表・URL・接頭辞）は最上位に置かず関数の中に置く（最上位は static な変異になり `ignoreStatic` で検査から外れる）。
- 今の disable の一覧（すべて等価。足す・消すときはここを直す）:
  - `apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.hook.ts` の依存配列 5 か所（`reloadTodos` は依存の無い useCallback で作り直されず、それを依存に持つ effect・`mutateAndReload`・`toggleTodo`・`removeTodo` も作り直されない）。
  - `apps/frontend_customer/features/todo/screens/todo-detail-screen/todo-detail-screen.hook.ts` の世代の `+=`（`-=` でも毎回別の値になる）。
  - `apps/backend/test-support/todo/todo-repository.in-memory.ts` の findAll の id の比較 `<`（id は Map のキーで一意なので `<=` でも同じ順）。
- 残る static は `apps/backend/features/todo/internal/infra/schema.ts` のテーブル宣言だけ（等価の理由は `stryker.config.mjs`）。Issue #189 で `apps/backend/shared/infra/schema.ts`（`change_logs` の宣言）と `apps/backend/shared/domain/change-operation.ts`（操作の一覧の定数）も加わった（件数と等価の確認は未実施）。
- テストで `@repo/backend/...`・`@repo/shared/...` から値を import すると、その変異はテストに届かない。backend・apps/shared の振る舞いはそれぞれの中のテスト（相対 import）で確かめる。

## E2E（Playwright）
- `apps/e2e` は workspace パッケージ `@repo/e2e`（Issue #84）。`@playwright/test`・`pg`・`@types/pg`・`"@repo/shared": "workspace:*"`（`env.ts`。Issue #90）は `apps/e2e/package.json` に置く。
  - WHY: `apps/frontend_customer`・`apps/backend` と同じ形（依存は使うパッケージの `package.json`）にし、E2E だけが使う Playwright と `pg` をリポジトリ直下から外す。`.env` はリポジトリ直下の 1 つを `env.ts` が上にたどって読むので、カレントディレクトリが `apps/e2e` でも同じ値になる。
- `pnpm test:e2e`（= `pnpm --filter @repo/e2e test` = `apps/e2e` で `playwright test`。設定は `apps/e2e/playwright.config.ts`）。`webServer` が `pnpm -w build && pnpm -w start -p <E2E_PORT>`（`-w` でリポジトリ直下の script を呼ぶ）（`.env` の `E2E_PORT`。メインの作業ツリーは 3100）で本番ビルドを起動する（ローカルで起動済みならそれを使う）。`pnpm test`（Vitest）には含めない。
- Postgres で動かす。サーバ（`webServer.env`）とテスト（`apps/e2e/database.ts`）は同じ `env.DATABASE_URL` を使う。前提は `pnpm db:up && pnpm db:migrate`（`webServer.command` では当てない）。
  - ローカルの `reuseExistingServer` で起動済みのサーバを使うときは、そのサーバの環境変数のまま動く（別の DB・古いコードのサーバが残っていないか注意）。
- 各テストの前に `TRUNCATE change_logs, todo_status_changes, todos`（`resetTodos()`。履歴の表は todos を外部キーで参照するので同じ文で消す。変更履歴も一緒に消す。Issue #189）。title に実行時刻を付けるのは補助。WHY: Postgres のデータはサーバを起動し直しても残る。
- 1 テストで CRUD を一周する（`workers: 1`。1 本の中の順序で状態を担保する）。
- サーバの stdout を検証するテスト（`apps/e2e/request-log.spec.ts`。リクエストログ）は、webServer ではなくテストの中で `next start -p 0` を子プロセスで起動し、その stdout を読む。WHY: webServer の stdout はテストから読めず（`webServer.stdout: "pipe"` はランナーのプロセスの stdout に流すだけ。テストは別の worker プロセスで動く）、ローカルの `reuseExistingServer` では別のプロセスになる。ポート 0 で空きポートを選ばせ、webServer・並列の worktree と重ならないようにする。本番ビルド（`.next`）は webServer の `pnpm build` が作ったものを使う。
- Chromium のビルドが合わないとき（クラウド VM）は `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e`。CI は `pnpm --filter @repo/e2e exec playwright install --with-deps chromium`、ローカルは `pnpm --filter @repo/e2e exec playwright install chromium`（OS の依存も入れるなら `pnpm --filter @repo/e2e install-browser`）。
