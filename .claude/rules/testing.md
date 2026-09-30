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
| `apps/backend/**/application` | InMemory リポジトリを渡して検証 | Node |
| `apps/backend/**/infra` の Postgres の実装（`*.postgres.ts`・`database.ts`） | 実 Postgres。`createTestDatabase()` でファイルごとの別スキーマ（`test_<UUID>`）にマイグレーションを当て、各テストの前に `TRUNCATE` | Node |
| `apps/backend/journeys/*.journey.test.ts`（ジャーニー。下の「ジャーニーテスト」） | 実 Postgres（`createTestDatabase()`）の db で本番と同じに組み立てた複数の handler に、業務の流れの順に `new Request()` を渡し、応答で確かめる | Node |
| `apps/backend/**/presentation` | 空の InMemory で組み立てた handler（`new ListTodosApi(new ListTodosQuery(new InMemoryTodoRepository())).handle`）に `new Request()`（と `ctx`）を渡し、`Response` を検証。本番の handler（`export const GET` など）は、Postgres の Repository の prototype を spy して結線だけを確かめる | Node |
| `apps/frontend_customer/features/**/*.hook.ts` | `renderHook` で状態とイベント | jsdom |
| `apps/frontend_customer/features/**/*-screen.tsx` | render して操作し、表示を検証 | jsdom |
| `apps/e2e/*.spec.ts` | Playwright で本番ビルドを起動し、Chromium で操作 | Chromium |

- `apps/backend/`・`apps/shared/` のテストは先頭に `// @vitest-environment node`（既定は jsdom）。WHY: サーバのコードは DOM の無い環境で検証する。
- 実 Postgres を別スキーマに分ける WHY: Vitest はファイルを並列に、Stryker はさらに複数プロセスで実行する。同じ `public.todos` を使うと互いの `TRUNCATE` でデータが消え、`pnpm dev` や E2E の表も消える。drizzle の migrator には同時実行の排他が無い（drizzle-orm 0.45.3 の `pg-core/dialect.js` の `migrate` を読んで確認）。
- `pnpm test` / `pnpm test:unit` / `pnpm test:journey` / `pnpm test:mutation` は Postgres が起動している前提（`pnpm db:up`）。接続先は `.env` の `DATABASE_URL`。

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
- backend: InMemory リポジトリを query / command のコンストラクタに渡して組み立てる（Issue #123。`vi.mock` は使わない）。モックは最小限。WHY: モックは「こう呼ばれるはず」を書き込むので、実装とずれても緑のまま。（検査は `rule-tests/test-doubles.test.ts`: backend のテストの `vi.mock` は `@repo/shared/now` だけ（`vi.doMock` も違反。ほかは呼び出しの直前の行の `// WHY モック: <理由>` で通す）、`apps/backend/test-support/database` の import は infra のテスト・test-support 自身のテスト・ジャーニー・global-setup だけ）
  - Postgres の実装はモックせず実 Postgres で（SQL の組み立て・uuid は差し替えると検証できない）。例外は api ファイルの本番の handler の結線の確認だけ（`PostgresTodoRepository.prototype` の spy。Repository の振る舞いは確かめず、Postgres の実装が呼ばれることだけを見る）。
  - InMemory で起こせない失敗の経路だけ、必要な分を差し替える（例: `list-todos.api.test.ts` の 500 は常に reject する `failingRepository` と、`console.error` の `vi.spyOn`）。
- 時計（現在時刻）: `now`（`apps/shared/now.ts`。現在時刻の唯一の出口）を `vi.mock` で差し替え、`vi.mocked(now).mockReturnValue(date)` / `mockReturnValueOnce(date)` で時刻を決める（backend の「`vi.mock` は使わない」の例外）。backend のテストは `vi.mock("@repo/shared/now")`、`apps/shared` の中は `vi.mock("./now")`。`afterEach` で `vi.mocked(now).mockReset()` する。
  - 自動モックの `now` は既定で `undefined` を返す（`Todo.create` は作成日時の不変条件で validation_error になり、返させ忘れに気づける）。ファイルのほかのテストが実時刻のままでよいときは `vi.mock("@repo/shared/now", { spy: true })` で本物を残し、時刻を決めるテストだけ `mockReturnValueOnce` する（`todo-repository.postgres.test.ts`）。
  - WHY 時計だけ vi.mock: 時計はコンストラクタで渡す依存ではなく横断的な seam で、作成日時を引数で受け取ると Entity の生成ルールが呼び出し側に漏れる（`.claude/rules/shared.md` の「now」）。`vi.useFakeTimers` で `Date` を差し替えるのは `now.ts` 自身のテストだけ（本物が実時計を読むことを確かめる）。
- 画面側の hook / screen: `vi.mock("@/features/todo/api/todo-api")` と `vi.mocked(listTodos).mockResolvedValue(...)`。WHY: 境界の `api/` で切ると HTTP やサーバの状態に依存しない。
- `api/`: `vi.stubGlobal("fetch", vi.fn<typeof fetch>())` で、送った URL・メソッド・本文と応答の扱いを検証する。
- 非同期の順序（古い応答が後から届く、画面を離れた後に失敗が届く）は、任意のタイミングで resolve できる `deferred()` で作る（各テストファイルの中に定義）。WHY: `mockResolvedValue` は即時に resolve し、タイマーは実行環境の速さに左右される。

## ルール検査テスト（規則・設定が効いていることを検査するテスト）
今あるもの: `rule-tests/architecture.test.ts`（`.claude/rules/architecture-check.md`）、`rule-tests/lint.test.ts`（`.claude/rules/lint.md`）、`rule-tests/package.test.ts`・`rule-tests/pnpm-workspace.test.ts`（`.claude/rules/dependencies.md`）、`rule-tests/typecheck.test.ts`（`pnpm typecheck` と CI の順序）、`rule-tests/schema.test.ts`（`apps/backend/**/infra/schema.ts` の列の型の既定。varchar / char・timezone 無しの timestamp・serial・json を、直前の行の `// WHY <見出し>:` が無ければ止める。`.claude/rules/backend.md` の「列の型」）、`rule-tests/api-request.test.ts`（`apps/backend/features/*/presentation/*.api.ts` のリクエストの項目の `.optional()` を止める。同じユースケースの中で本当に任意の項目は、直前の行の `// WHY 任意:` で通す。`.claude/rules/backend.md` の「1 ユースケース = 1 API」）、`rule-tests/test-doubles.test.ts`（backend のテストの `vi.mock` / `vi.doMock` は `@repo/shared/now` だけ（例外は直前の行の `// WHY モック:`）、`apps/backend/test-support/database` の import は infra のテスト・test-support 自身のテスト・`apps/backend/journeys/*.journey.test.ts`・`vitest.global-setup.ts` だけ。「テストダブル」）、`rule-tests/journey.test.ts`（`apps/backend/journeys/` には直下の `*.journey.test.ts` だけ（ほかの場所の `*.journey.test.*` も違反）、各ジャーニーは `*.in-memory` を import しない（`import type` も）・`vi.mock` / `vi.doMock` を使わない・異なる `*.api` を 2 つ以上と `test-support/database` を値で import する。Issue #187。「ジャーニーテスト」）、`rule-tests/test-support.test.ts`（テストだけが使うコード `apps/*/test-support/` を本番に持ち込まない。`.dockerignore` の `**/test-support` の行、test-support/ の全ファイルと test-support を import するテストがそのパターンで除外されること、本番のコードが test-support を import しないこと、`apps/*/package.json` の exports に載せないこと、`.github/workflows/deploy.yml` が runtime と migrate のイメージを find で確かめるステップを持つこと。Issue #181。`.claude/rules/backend.md` の「置き場所」）、`rule-tests/persistence.test.ts`（upsert の禁止、`*.postgres.ts` の save は `changed-props` を import、`reconstruct` を持つ Entity は `origin` を持つ。`.claude/rules/backend.md` の「永続化」）、`rule-tests/domain-validation.test.ts`（domain で zod の `parse` / `safeParse`（`decode` / `spa` などの同じ働きのメソッドも）を直接呼ばず `validate` を通す。`validation_error` の DomainError を作るのは backend 全体で `validate.ts` だけ）、`rule-tests/use-case.test.ts`（application の `*Input` 型の任意の項目と `input.<x> !== undefined` の分岐を止める。`.claude/rules/backend.md` の「1 ユースケース = 1 API」）、`scripts/cloud-session-start.test.ts`（`.claude/rules/cloud-session.md`）、`rule-tests/instructions.test.ts`（CLAUDE.md の行数と @ import、`.claude/rules` の paths、ADR の形式（分類ディレクトリは 4 つの固定の集合・ファイル名・見出し・メタ・README の一覧。参照は `<分類>/<ファイル名>`）、スキルのフロントマター、旧 rules/ の参照）と、git ガード・作業ログ・worktree のフックのテスト（`scripts/hooks/*.test.ts` など）。テスト以外のゲート（カバレッジ・フック・CI の required check・型チェック）も同じ扱い。
- **must pass と must reject の両方**を持つ。WHY: must reject だけだと「何でも違反にする」壊れ方を、must pass だけだと「何も違反にしない」（常に緑）壊れ方を検出できない。「今のリポジトリで違反 0 件」は must pass の 1 例にすぎない。
- 判定は関数に切り出し、架空の入力で許可・拒否を固定したうえで、同じ関数で実ファイルを検査する。must reject は取り違えやすい境界を網羅する（import の書き方、版の書き方、設定のキーの有無・コメントアウト・ネスト、違反を単独で含むファイル、対象外のファイル）。
- 実ファイルで end-to-end に通す fixture を持つ（一時ディレクトリは `mkdtempSync(join(tmpdir(), "<name>-"))` で作り `afterAll` で消す）。違反の集合は `toEqual` で丸ごと比較する。WHY: 判定が正しくても、抽出・列挙が漏れれば見逃す。
- 列挙が空なら失敗させる（対象 0 件なら常に緑になる）。
- 規則を足す・変えるときは例と fixture も同じ変更で直し、規則の文書と突き合わせる。
- **fault injection** は必須。既定は最小セット（規則を破る 1 件 → そのテストだけが落ちる、判定を常に許可 → must reject が落ちる、判定を常に拒否 → must pass が落ちる）。列挙を空・設定を戻す・境界の網羅（数十件の変異）は、新しいルール検査テストやゲートを作るときだけ行う。元に戻して `git status --short` と `git diff` を確かめ、何を壊して何件落ちたかを報告・PR に書く。reviewer はロジックのある変更で別の壊し方を独立に行う。WHY 最小セット: 見逃しの検出に効くのは主に「常に許可」「常に拒否」で、数十件の変異は消費の大半を占めた（ADR `docs/adr/workflow/20260929-save-usage-limit.md`）。手順はスキル `rule-check-test`。

## ジャーニーテスト（Issue #187）
実 Postgres で、複数の API の handler（`XxxApi.handle`）を業務ユースケースに沿って順に呼ぶテスト（例: `apps/backend/journeys/todo-lifecycle.journey.test.ts`）。決定と採用しなかった案は ADR `docs/adr/quality/20260930-backend-journey-tests.md`。形は `rule-tests/journey.test.ts` が検査する。
- 役割の分担: 単体（層ごと・InMemory。分岐と失敗の網羅）/ ジャーニー（実 DB・本番と同じ組み立て・API をまたぐ業務の流れ）/ E2E（画面・ビルド・ルーティングを通した利用者の操作）。WHY: 単体は Postgres の Repository を通した API 同士のつながりを見ず、E2E は遅く失敗の原因を切り分けにくい。分岐の網羅はジャーニーに持ち込まない（単体で行う）。
- 1 ファイル = 1 業務ユースケース（名前は `<ユースケース>.journey.test.ts`）、1 テスト = 1 つの流れ（E2E と同じく順序で状態を担保する）。テスト名は流れ全体を日本語の仕様文で書く。
- 組み立ては本番の api ファイルの最下部と同じ（Postgres の Repository → command / query → Api）で、db だけ `createTestDatabase()` のものにする。本番の `export const GET` などは使わない（`getDatabase()` の `.env` の DB を指し、テスト用のスキーマに向けられない）。準備は `beforeAll` で `createTestDatabase()` と `migrate()`、`beforeEach` で `TRUNCATE`、`afterAll` で `close()`（Postgres の Repository のテストと同じ）。
- 各ステップは status と本文で確かめ、保存されたことは次の API の応答（一覧・詳細）で確かめる。DB を SQL で覗かない。WHY: 利用者が見るのは API の応答だけ。
- テストダブルは使わない（`vi.mock` は `@repo/shared/now` も含めて無し、InMemory も無し）。時刻に依存する並び（作成順）は、実時計が進むのを待って作る（`waitUntilAfter`）。
- 置き場所は `apps/backend/journeys/` の直下だけ（feature をまたぐ流れを置くため `features/<f>/` の下にしない）。共通の補助が要るようになったら `apps/backend/test-support/` に置く。
- 実行: `pnpm test:journey`（`vitest run apps/backend/journeys`）。`pnpm test` にも含まれる（Vitest の include `apps/**/*.test.{ts,tsx}`）。Stryker も同じ設定（`stryker.config.mjs` の `vitest.configFile`）で動くので、ジャーニーは変異を殺すテストにも数えられる（`mutate` はテストを除くので、ジャーニー自身は変異させない）。

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
  - `apps/backend/features/todo/infra/todo-repository.in-memory.ts` の findAll の id の比較 `<`（id は Map のキーで一意なので `<=` でも同じ順）。
- 残る static は `apps/backend/features/todo/infra/schema.ts` のテーブル宣言だけ（等価の理由は `stryker.config.mjs`）。
- テストで `@repo/backend/...`・`@repo/shared/...` から値を import すると、その変異はテストに届かない。backend・apps/shared の振る舞いはそれぞれの中のテスト（相対 import）で確かめる。

## E2E（Playwright）
- `apps/e2e` は workspace パッケージ `@repo/e2e`（Issue #84）。`@playwright/test`・`pg`・`@types/pg`・`"@repo/shared": "workspace:*"`（`env.ts`。Issue #90）は `apps/e2e/package.json` に置く。
  - WHY: `apps/frontend_customer`・`apps/backend` と同じ形（依存は使うパッケージの `package.json`）にし、E2E だけが使う Playwright と `pg` をリポジトリ直下から外す。`.env` はリポジトリ直下の 1 つを `env.ts` が上にたどって読むので、カレントディレクトリが `apps/e2e` でも同じ値になる。
- `pnpm test:e2e`（= `pnpm --filter @repo/e2e test` = `apps/e2e` で `playwright test`。設定は `apps/e2e/playwright.config.ts`）。`webServer` が `pnpm -w build && pnpm -w start -p <E2E_PORT>`（`-w` でリポジトリ直下の script を呼ぶ）（`.env` の `E2E_PORT`。メインの作業ツリーは 3100）で本番ビルドを起動する（ローカルで起動済みならそれを使う）。`pnpm test`（Vitest）には含めない。
- Postgres で動かす。サーバ（`webServer.env`）とテスト（`apps/e2e/database.ts`）は同じ `env.DATABASE_URL` を使う。前提は `pnpm db:up && pnpm db:migrate`（`webServer.command` では当てない）。
  - ローカルの `reuseExistingServer` で起動済みのサーバを使うときは、そのサーバの環境変数のまま動く（別の DB・古いコードのサーバが残っていないか注意）。
- 各テストの前に `TRUNCATE todos`（`resetTodos()`）。title に実行時刻を付けるのは補助。WHY: Postgres のデータはサーバを起動し直しても残る。
- 1 テストで CRUD を一周する（`workers: 1`。1 本の中の順序で状態を担保する）。
- サーバの stdout を検証するテスト（`apps/e2e/request-log.spec.ts`。リクエストログ）は、webServer ではなくテストの中で `next start -p 0` を子プロセスで起動し、その stdout を読む。WHY: webServer の stdout はテストから読めず（`webServer.stdout: "pipe"` はランナーのプロセスの stdout に流すだけ。テストは別の worker プロセスで動く）、ローカルの `reuseExistingServer` では別のプロセスになる。ポート 0 で空きポートを選ばせ、webServer・並列の worktree と重ならないようにする。本番ビルド（`.next`）は webServer の `pnpm build` が作ったものを使う。
- Chromium のビルドが合わないとき（クラウド VM）は `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e`。CI は `pnpm --filter @repo/e2e exec playwright install --with-deps chromium`、ローカルは `pnpm --filter @repo/e2e exec playwright install chromium`（OS の依存も入れるなら `pnpm --filter @repo/e2e install-browser`）。
