# テストコードルール

テストは仕様であり、仕様が黙って外れたり、壊れたコードを見逃したりしない状態を保つ。とくに「規則や設定が効いていること」を検査するテスト（下の「ルール検査テスト」）は、違反を見逃す（false negative）と存在する意味がないため、must pass / must reject の両方の例と、fault injection による確認を必須にする。

## 基本方針
- テスト = 仕様（`CLAUDE.md` の「2. Test Driven」）。テストを先に書き、**失敗することを確認してから**実装する。
  - 理由: 先に失敗を見ておかないと、そのテストが実装の有無に関係なく通る（何も検査していない）ことに気づけない。
- テスト名は日本語の仕様文で書く（「〜すると〜になる」「〜のときは〜しない」）。例: 「todoId が変わると、新しい todoId の Todo を取得し直す」、「201 と作成した TodoDto を返し、保存される」。
  - 理由: テスト一覧がそのまま仕様の一覧として読めるようにする。失敗したときに、どの仕様が破れたかがテスト名で分かる。
- 分岐を通すだけのテストにしない。その分岐で起きること（返り値・状態・呼び出し・出力）を検証する。
  - 理由: 実行しただけで何も検証しないテストでもカバレッジは上がる。数字だけが 100% になり、分岐の中身を壊しても気づけない。
- `it.skip` / `it.only` などを残さない。Biome の `noSkippedTests`（`biome.json` で error）と `noFocusedTests`（test domain の recommended、既定 severity は warn で `--error-on-warnings` により失敗。`biome explain noFocusedTests` で確認）で検出する（`rules/code/lint.md`）。
  - 理由: skip は仕様を黙って外し、only はそれ以外のテストを黙って止める。どちらもテストは緑のまま検査範囲が減る。
- カバレッジは 100%（`rules/code/architecture.md` の「カバレッジ」）。`/* v8 ignore */` などで計測から逃がさない。

## 置き方と環境
- `rules/code/architecture.md` の「テストの置き方」に従う（置き場所、`// @vitest-environment node`、層ごとのテスト方法）。ここには重複して書かない。

## テスト用スキーマの後始末（globalSetup）
- `vitest.config.mts` の `globalSetup`（`vitest.global-setup.ts`）が、Vitest の実行の最初（テストファイルを動かす前）に 1 回だけ、`test_` で始まるスキーマをすべて `DROP SCHEMA ... CASCADE` で消す（処理は `backend/shared/infra/database.test-support.ts` の `cleanupTestSchemas`）。
  - 理由: 実 Postgres を使うテストは、テストファイルごとの別スキーマ（`test_<UUID>`）を `afterAll` で消す（`database.test-support.ts` の `close()`）が、プロセスが `afterAll` の前に止まると（Stryker が worker を止める、Ctrl-C など）残る。テストの前なら消してよいのは前の実行の残りだけになる。`afterAll` での削除も残す（普段の実行で残さないため）。
  - 探し方は `starts_with(schema_name, 'test_')`。LIKE の `_` は任意の 1 文字に一致し、`testX...` のようなテスト用でないスキーマまで消すため使わない。
  - Postgres に接続できないときは、ここで「`pnpm db:up` で起動してから実行してください」というエラーにして止める（単体テストは Postgres が前提。各テストファイルの接続エラーが並ぶより原因が分かりやすい）。
  - Stryker の worker の中（環境変数 `STRYKER_MUTATOR_WORKER` がある。@stryker-mutator/core 10.0.0 の `child-process-proxy.js` が子プロセスに渡す）では消さない。Stryker は複数の worker（それぞれ 1 つの Vitest）を並行して動かし、途中で作り直しもするので、後から始まった worker の globalSetup が他の worker の使用中のスキーマを消してしまうため。
  - 同じ DB に対して `pnpm test` を 2 つ同時に動かすと、後から始まった方が先の方の使用中のスキーマを消しうる。同時には動かさない。
  - `cleanupTestSchemas` のテストは、`test_` ではなくテストごとの接頭辞（`test_cleanup_<UUID>_`）で行う。`test_` で呼ぶと並列に動いている他のテストファイルのスキーマを消すため。

## テストダブル
- backend（`backend/**`）: InMemory リポジトリ（`InMemoryTodoRepository`。本番でも使う実装）を `createTodoContainer` に渡して組み立てる。モックは最小限にする。
  - 理由: モックは「こう呼ばれるはず」という前提をテストに書き込むため、実装と前提がずれても緑のままになる。本物の実装を通せば、層をまたいだ振る舞い（command で保存したものが query で読めるなど）まで検証できる。
  - Postgres の実装（`*.postgres.ts`、`drizzle-transaction-runner.ts`、`database.ts`）は、モックせず実 Postgres（compose.yaml）に対してテストする。`createTestDatabase()`（`backend/shared/infra/database.test-support.ts`）でテストファイルごとに別のスキーマを作ってマイグレーションを当て、各テストの前に `TRUNCATE` する（詳細と WHY は `rules/code/architecture.md` の「永続化（Drizzle + Postgres）」の「テスト」）。
    - 理由: SQL の組み立て（upsert・並び順・uuid 型）やトランザクションの commit / rollback は、DB を差し替えると何も検証できない。
    - そのため `pnpm test` / `pnpm test:unit` / `pnpm test:mutation` は Postgres が起動している前提（`pnpm db:up`）。接続先は `.env` の `DATABASE_URL`（`backend/shared/infra/env.ts`。既定値は無い）。
  - 例外: InMemory では起こせない失敗の経路は、その経路に必要な分だけ差し替える。例: `backend/todo/presentation/list-todos.api.test.ts` は 500 の経路のために、常に reject する `TodoRepository`（`failingRepository`）で `createTodoContainer` を組み立て、`console.error` を `vi.spyOn` で抑制しつつ呼ばれたことを検証する。
- 画面側の hook / screen（`features/**/screens/**`）: `vi.mock("@/features/todo/api/todo-api")` で `api/` を差し替え、`vi.mocked(listTodos).mockResolvedValue(...)` で応答を与える。
  - 理由: 画面側と API 側の境界は `api/` の 1 ファイル（`rules/code/architecture.md` の「画面側とサーバ側の境界」）なので、そこで切るとテストが HTTP やサーバの状態に依存しない。
- `api/`（`features/**/api/*.ts`）: `vi.stubGlobal("fetch", vi.fn<typeof fetch>())` で `fetch` を差し替え、送った URL・メソッド・本文と、応答の扱いを検証する（`features/todo/api/todo-api.test.ts`）。
- 非同期の順序（古い応答が後から届く、画面を離れた後に失敗が届く、など）は、テストから任意のタイミングで resolve できる Promise（`deferred()`）で順序を作って検証する（`features/todo/screens/todo-screen/todo-screen.hook.test.ts`、`features/todo/screens/todo-detail-screen/todo-detail-screen.hook.test.ts`）。
  - 理由: `mockResolvedValue` は即時に resolve するため、「新しい応答の後に古い応答が届く」順序を再現できない。タイマー（`setTimeout` での遅延）に頼ると順序が実行環境の速さに左右される。
  - `deferred()` は各テストファイルの中に定義している（共通化はしていない）。

## ルール検査テスト
コード（Todo の振る舞いなど）ではなく、「規則や設定が効いていること」を検査するテスト。例:

| テスト | 検査する規則・設定 |
| --- | --- |
| `lint.test.ts` | Biome の違反が `--error-on-warnings` で失敗になること（代表ルールごとに違反の例と許可される書き方の例）、`pnpm lint` / `pnpm check` / pre-commit の引数（判定 `runsBiomeCheckWithErrorOnWarnings`。失敗を無効化するつなぎやフラグも拒否）、`noProcessEnv` が `env.ts` とテスト以外で効くこと（`rules/code/lint.md`） |
| `package.test.ts` | `package.json` の `dependencies` / `devDependencies` の版が完全固定であること（判定 `isPinnedVersion`、列挙 `listDependencies`。`rules/code/dependencies.md`） |
| `pnpm-workspace.test.ts` | `minimumReleaseAge` / `minimumReleaseAgeStrict` / `savePrefix` / `allowBuilds` の値（読み取り `readTopLevelSettings`、判定 `findWorkspaceSettingViolations`。`rules/code/dependencies.md`） |
| `scripts/cloud-session-start.test.ts` | クラウドセッションのスクリプトが `.tool-versions` どおりの版を、検証付きで入れること（`rules/code/env.md`） |
| `architecture.test.ts`（Issue #47 で追加） | 依存の向き（`rules/code/architecture.md` の「依存の向き（全体）」）と、環境変数の直参照の禁止（規則 `env-direct-access`。Issue #59。`rules/code/env.md` の「環境変数」） |

テスト以外のゲート（カバレッジのしきい値、pre-commit のフック、CI の required status check、型チェック）も、「違反があれば止まる」ことを検査する仕組みなので、下の「fault injection」は同じように行う。

### must pass と must reject を両方入れる
- 規則ごとに、**許可される例が通る（must pass）**ことと、**違反が検出される（must reject）**ことの両方をテストにする。
  - 理由: must reject だけだと「何でも違反にする」壊れ方（誤検知でリポジトリ全体が落ちる。直すために規則を緩めたくなる）を、must pass だけだと「何も違反にしない」壊れ方（常に緑）を検出できない。後者は緑のまま気づかれないので、とくに危ない。
  - 「今のリポジトリで違反が 0 件」（`expect(violations).toEqual([])`）だけでは must pass の 1 例にすぎない。判定が常に「違反なし」を返しても通るため、must reject の例を必ず別に持つ。
  - 既存の例: `lint.test.ts` は「未使用変数と == を含むファイルは非 0 で終わる」（must reject）と「違反のないファイルは 0 で終わる」（must pass）を両方持つ。
  - `package.test.ts` / `pnpm-workspace.test.ts` / `lint.test.ts` も must pass と must reject の両方を持つ（Issue #50 で揃えた）。判定を関数に切り出し、架空の入力（版の文字列、YAML の文字列、コマンドの文字列）で許可・拒否を固定したうえで、同じ関数で実ファイル（リポジトリの設定と、一時ディレクトリに置いた違反入りの fixture）を検査する。
- must reject は、その検査が取り違えやすい境界のケースを網羅する。検査の種類ごとに列挙し、許可か違反かを決めてテストで固定する。
  - import の検査: alias（`@/...`）と相対パス（`../...`）、値の import と `import type` / inline の `type`、`index` と深いパス、自 feature と他 feature、`export ... from`（re-export）と dynamic `import()`、複数行にまたがる import、拡張子の違い（`.ts` / `.tsx` / `.js` / `.jsx`）、パッケージとそのサブパス（`next` と `next/link`）。コメントや文字列の中の import の例示は must pass（誤検知しない）側に入れる。
  - 版の検査: `^` / `~` / `>=` / `*` / `x` / `latest` / `workspace:` / `npm:` の別名、プレリリース（`1.2.3-beta.1`）など（`package.test.ts`。プレリリースとビルドメタは拒否に決めている。`rules/code/dependencies.md`）。
  - 設定値の検査: 値の違い、キーが無い、コメントアウトされた行、同名のキーがネストの中にある場合（`pnpm-workspace.test.ts`）。
  - lint / フックの検査: 違反を単独で含むファイル（他の違反に巻き込まれて落ちているのではないことを示す）、違反のないファイル、対象外のファイル（`.md` のみのコミットなど）。
- 検査の対象を列挙する処理（glob、ディレクトリの走査など）が空を返したら失敗させる。
  - 理由: 対象が 0 件なら違反も 0 件になり、常に緑になる。パスの変更や glob の書き間違いで起きやすい。

### 判定だけでなく、実ファイルで end-to-end に通す
- 判定関数（「この参照は違反か」など）の単体テストに加えて、実ファイルを一時ディレクトリに置き、抽出 → 判定 → 違反の一覧までを通す fixture を持つ。
  - 一時ディレクトリは `mkdtempSync(join(tmpdir(), "<name>-"))` で作り、`afterAll` で消す（`lint.test.ts` と同じ）。リポジトリの中に置くと、テストが途中で落ちたときに作業ツリーに残る。
  - 検出される違反の集合は `toEqual` で丸ごと比較する（`toContain` や件数だけの比較にしない）。
  - 理由: 判定が正しくても、抽出（ファイルの列挙・import の読み取り・パスの解決）が漏れれば違反は見逃される。丸ごと比較すれば、見逃し（期待した違反が無い）も余分な検出（誤検知）も失敗になる。
- 規則を足す・変えるときは、must pass / must reject の例と fixture も同じ変更で更新する。ルール文書（`rules/**/*.md`）に規則を書いたら、対応するテストがあるかを突き合わせる。

### fault injection（確認プロセスで必須）
ルール検査テストを書く・変えるたびに、次を行う。テストが緑であることは、検査が効いていることの証拠にならないため。

1. **規則を破る**: 規則に違反するコード・ファイル・設定を一時的に置き、**そのテストだけが**失敗することを確認する（関係のない規則のテストが巻き添えで落ちるなら、規則ごとの判定が分離できていない）。規則が複数あれば 1 規則ずつ行う。
2. **検査を壊す**: 検査側を意図的に壊し、テストが失敗することを確認する。
   - 判定を常に「違反なし」にする（`return false`）→ must reject のテストが落ちること（見逃しの検出）。
   - 判定を常に「違反」にする（`return true`）→ must pass のテストが落ちること（誤検知の検出）。
   - 抽出や列挙を空にする（`return []`）→ 落ちること（対象 0 件で緑にならないこと）。
   - 設定を戻す（例: `--error-on-warnings` を外す、しきい値を下げる、フックからコマンドを消す）→ 落ちること。
3. **元に戻す**: 確認が終わったら必ず元に戻し、`git status --short` と `git diff` に何も残っていないことを確かめてから、もう一度テストを通す。
   - 一時ファイルはできるだけリポジトリの外（scratchpad や OS の一時ディレクトリ）に置く。リポジトリを走査する検査のためにリポジトリ内に置く必要があるときは、置いたパスを控えておき、消したことを `git status` で確かめる。
4. **記録する**: 何を壊し（どのファイルのどの行を、どう変えたか）、どのテストが何件失敗し、戻して通ったかを、worker は報告に、オーケストレータは PR の「検証内容」に書く。
5. **reviewer も独立に行う**: reviewer は worker の報告を鵜呑みにせず、worker と別の壊し方を含めて自分で fault injection を行い、見逃しを探す（reviewer はファイルを変更しないため、クローンや scratchpad のコピーで行う）。

## 通常のテストでの確認（ミューテーション）
- ルール検査テスト以外でも、カバレッジを埋めるためにテストを足したときや、既存のテストを書き換えたときは、「そのテストが守っているコードを壊すと落ちる」ことを 1 度は確かめる（分岐の条件を反転する、戻り値を変える、呼び出しを消す、など）。確かめたら元に戻す。
  - 理由: テストを足すとカバレッジは上がるが、検証が弱い（呼び出すだけ・値を見ていない）と、コードを壊しても緑のままになる。書き換えで既存の検証が消えることもある（下の Issue #36 の例）。

### mutation testing（Stryker）
Stryker でコードに変異（条件の反転、戻り値の差し替え、文字列を空にする、など）を自動で入れ、単体テスト（Vitest）が失敗する（killed）か、緑のまま（survived）かを数える（Issue #52）。設定は `stryker.config.mjs`（各設定の WHY はファイル内のコメント）。

- 位置づけ: 上の「通常のテストでの確認（ミューテーション）」を自動化し、検証の弱いテスト（呼び出すだけ・値を見ていない）を日次でまとめて拾う。手作業の確認を置き換えるものではない。
  - ルール検査テストの fault injection は引き続き手作業で行う。Stryker が変異させるのは `mutate` の実装コードだけで、ルール検査テストが検査する規則・設定（`biome.json`、`package.json`、import の向きなど）は変異させないため。
  - テストを足す・書き換えるときの確認（上の節）も、その場で行う。日次の結果を待たずに、書いたテストが守っているコードを壊すと落ちることを確かめる。
- Postgres が要る（Issue #57。単体テストに実 Postgres を使うテストがあるため。先に `pnpm db:up`）。日次実行（`mutation.yml`）も `ci.yml` と同じく Postgres を起動し、`pnpm db:migrate` を当ててから実行する。
- Stryker の実行後は、テスト用のスキーマ（`test_<UUID>`）が後始末されずに残る（2026-09-28 のローカル実行で 1 回あたり 12 個残った。原因は、Stryker が worker のプロセスを afterAll の前に止めるためと推定しているが未確認）。Stryker の中では globalSetup が消さない（上の「テスト用スキーマの後始末（globalSetup）」）ので、次の `pnpm test` の最初に消える。
- 実行: `pnpm test:mutation`（`stryker run`）。レポートは `reports/mutation/mutation.html`（ブラウザで開く）と `mutation.json`。`reports/` と作業用の `.stryker-tmp/` は `.gitignore` 済み。ローカル（4 コア）で約 2.5 分（384 変異、147 秒。2026-09-28 実測）。
- 対象: `features/` `backend/` `shared/` の `.ts` / `.tsx`（テスト `*.test.ts(x)` と `*.d.ts` を除く）。`vitest.config.mts` の coverage.include のうち TypeScript の実装がある範囲と同じにしている。`app/`、`scripts/`（実装はシェルスクリプトだけ）、ルート直下の設定ファイル・ルール検査テスト、`e2e/` は対象外。
- Vitest のカバレッジ（100% のしきい値）は Stryker の実行では効かない。vitest-runner が coverage を無効にして、Stryker 自身のテストごとのカバレッジ分析で「変異を通るテスト」だけを実行するため（https://stryker-mutator.io/docs/stryker-js/vitest-runner/ ）。
- 日次実行: `.github/workflows/mutation.yml` が main を毎日 08:55 JST（UTC 23:55）に実行し、`reports/mutation/` を artifact（`mutation-report`、30 日保存）に残す。Actions の画面から手動でも実行できる（`workflow_dispatch`）。PR ごとには実行しない（ユーザー判断、Issue #52）。
- しきい値: 当面は設定しない（`thresholds.break` なし）。score が低くてもジョブは失敗せず、レポートを出すだけ。日次の結果を見てから値を決める（Issue #52）。
- 入れていないもの: `@stryker-mutator/typescript-checker`（型エラーになる変異を実行前に除く checker）。TypeScript の JS API（`ts.createSolutionBuilderWithWatch` / `ts.parseConfigFileTextToJson`。typescript-checker 10.0.0 の `dist` で確認）を使うが、TypeScript 7.0.2 の `typescript` パッケージは `version` / `versionMajorMinor` しか export しない（2026-09-28 に `import("typescript")` で確認）ため、動かないと判断した（入れて実行はしていない）。同じ理由で、Stryker 本体の tsconfig の書き換えも `stryker.config.mjs` の `tsconfigFile` で止めている。型エラーになる変異は checker なしでも、実行時に失敗するか生き残るかで数えられる（Vitest は型を検査しない）。
- vitest-runner の patch: `@stryker-mutator/vitest-runner` 10.0.0 は、そのままでは Vitest 5.0.1 と組み合わせると `describe` の中のテストで変異を検出できず、survived と数えられる（テスト名の連結の区切りが、vitest-runner はスペース、Vitest 5.0.1 の testNamePattern の照合は ` > ` で合わず、変異を通るテストが skip されるため）。`pnpm patch` で連結を ` > ` に直して対応している（`patches/`。2026-09-28 実測で score は patch なし 26.82% → patch あり 85.68%）。上流が直ったら patch を外す（`rules/code/dependencies.md` の「pnpm patch」）。詳細は `stryker.config.mjs` のコメント。

## E2E テスト
- `rules/code/architecture.md` の「E2E テスト（Playwright）」に従う。ここには重複して書かない。

## 一次情報 / 実測（このリポジトリの実例）
上のルールは、次の実例で見逃しや確認の有効性が実際に示されたことを根拠にしている。

- must reject の不足で規則が検査されていなかった例（Issue #47、`chore/47-dependency-direction-check` のコミット「reviewer 指摘: infra の規則追加、…」）: 依存の向きの検査（`architecture.test.ts`）で、reviewer の検証により `architecture.md` にある規則のうち infra 層、画面側 `shared/` からの backend 参照、presentation → domain の型限定などがテストに無く、規則の判定そのものを固定するテストも無いことが分かった。追加後、infra の判定（`isViolation`）を常に false にすると違反例 6 件が失敗することを確認している。
- 規則ごとの fault injection の例（Issue #47、同ブランチのコミット「依存の向きを architecture.test.ts で機械的に検査する」）: 規則ごとに違反ファイルを一時的に置いて（13 ケース）その規則だけが失敗すること、抽出関数を空にすると抽出の自己テスト 9 件が失敗することを worker が確認した。
- 書き換えで検証が消えていた例（Issue #36 / PR #38、コミット「reviewer 指摘: 既存インストール検出のテストを --install-only に追加し、…」と `logs/2026-09-28.md` の「SessionStart フックの導入を一時停止する PR #38 / Issue #36 を、#37 に置き換わったためクローズ」）: フックの経路を書き換えた結果、既存インストールの検出を確かめるテストが消え、検出を壊しても緑のままになっていた。reviewer の変異（`ensure_node` の検出を `NODE_DIR=""` に変える）で見つかり、テストを 2 件追加して同じ変異で 2 件失敗することを確認した（PR #38 はブランチごと破棄）。
- ゲートの must reject / must pass を実際のコミットで確かめた例（Issue #26 / PR #33、コミット「Biome と Lefthook を導入し、…」）: reviewer が 6 種の変異でテストが失敗することを確認し、使い捨てリポジトリで違反を含むコミットが拒否され、`.md` だけのコミットは通ることを確かめた。
- 変異でテストの強さを確かめた例（Issue #23 / PR #30、コミット「クラウドセッション用に Node / pnpm を用意する setup script と SessionStart フックを追加」）: reviewer が 8 種の変異でテストが失敗することを確認した。
- ゲートが実際に止まることを先に確かめた例（Issue #45、コミット「単体テストのカバレッジゲートを 100% にし、不足分のテストを追加」）: しきい値だけを入れた状態で `pnpm test` がしきい値未達（lines 98.78% など）で失敗することを確認してからテストを足し、足したテストが分岐を通すだけでないことを、分岐を 1 つずつ壊して失敗することで確認した（worker）。
- 型チェックが実際に動いていることを確かめた例（Issue #17、`logs/2026-09-28.md` の「TypeScript を 7.0.2 に更新」）: 型エラーのファイルを一時的に置くと `next build` が `Failed to type check` で exit 1 になることを worker と reviewer が確認した。同じく「`vite-tsconfig-paths` を削除し …」では、`resolve.tsconfigPaths` を外すと import の解決エラーでテストが失敗することを確認した。
