// Stryker（mutation testing）の設定。`pnpm test:mutation`（= stryker run）で読み込まれる（Issue #52）。
// 位置づけと運用は .claude/rules/testing.md の「mutation testing（Stryker）」。
// JSON ではなく .mjs にしているのは、設定ごとの WHY をコメントで残すため（JSON にはコメントを書けない）。
// 型注釈（@type {import('@stryker-mutator/api/core').PartialStrykerOptions}）は付けない。
//   @stryker-mutator/api は core の依存で、直接の依存ではないためルートから解決できない（pnpm は直接の依存だけを
//   node_modules 直下に置く）。値は Stryker が起動時に JSON Schema で検証する（未知のキーは「Unknown stryker config option」の警告になる）。
export default {
  // testRunner: 既存の単体テスト（Vitest）をそのまま使って、変異ごとにテストが落ちるか（killed）を確かめる。
  //   @stryker-mutator/vitest-runner が必要（devDependencies）。
  testRunner: "vitest",

  // plugins: vitest-runner をパッケージ名で明示して読み込ませる。
  //   WHY: Stryker の既定（["@stryker-mutator/*"]）は、core の実体があるディレクトリの隣（pnpm では
  //   node_modules/.pnpm/@stryker-mutator+core@<版>/node_modules/@stryker-mutator/）を readdir して探す
  //   （@stryker-mutator/core 10.0.0 の dist/src/di/plugin-loader.js の globPluginModules）。pnpm はそこに core の
  //   依存（api / instrumenter / util）しか置かないため vitest-runner が見つからず、「Cannot find TestRunner plugin
  //   "vitest". In fact, no TestRunner plugins were loaded.」と「Unknown stryker config option "vitest"」で失敗した
  //   （2026-09-28 実測）。パッケージ名で書くと import("@stryker-mutator/vitest-runner") になり、Node の解決が
  //   ルート直下の node_modules（直接の依存）までさかのぼって見つける。
  //   既定を置き換えるので、ほかの Stryker プラグインを足すときはここにも書く。
  plugins: ["@stryker-mutator/vitest-runner"],
  // pnpm patch で直している不具合（Issue #52）: vitest-runner 10.0.0 は、そのままでは Vitest 5.0.1 と組み合わせると
  //   describe の中のテストで変異を検出できない（killed にならず Survived と数えられる）。
  //   原因: 変異ごとに「その変異を通るテスト」だけを実行するため、テスト名を describe 名とスペース区切りで連結した
  //   正規表現を testNamePattern に渡す（vitest-runner の dist/src/test-helpers.js の collectTestName）。Vitest 5.0.1 は
  //   testNamePattern をフルネーム（describe 名と " > " 区切り。dist/task-utils.js の createTaskName）と照合するため
  //   一致せず、対象のテストがすべて skip される（2026-09-28 実測）。describe の外に書いたテストだけが正しく動く。
  //   対応: patches/@stryker-mutator__vitest-runner@10.0.0.patch で、collectTestName の連結を " > " にしている
  //   （dist/src/test-helpers.js と dist/src/stryker-setup.js の各 1 行。pnpm-workspace.yaml の patchedDependencies）。
  //   実測: patch なしで score 26.82%（killed 103 / survived 281）、patch ありで 85.68%（killed 329 / survived 55）。
  //   patch を外す条件: 上流の vitest-runner が Vitest 5 の " > " 区切りに対応した版を出したら、その版に上げて patch を消す
  //   （.claude/rules/dependencies.md の「pnpm patch」）。2026-09-28 時点で上流の master の src/test-helpers.ts も
  //   スペース区切りのまま（devDependencies の vitest は 4.1.11）。

  vitest: {
    // configFile: pnpm test と同じ vitest.config.mts（jsdom、tsconfigPaths、apps/e2e/** の除外）を継承した
    //   vitest.stryker.config.mts でテストを動かす（Issue #200）。既定でも vitest.config.* を探すが、どの設定で動くかを明示する。
    //   WHY 継承した別の設定にする: vitest.config.mts との違いは、Gherkin の .feature の step を書いた API ジャーニー
    //   （apps/backend/api-journeys/*.api-journey.test.ts）を除くことだけ。step 1 つが Vitest の test 1 つになり、Stryker が変異を通る
    //   test だけに絞ると、前提の step 抜きで後の step が失敗して killed と数えられうる（詳細は vitest.stryker.config.mts）。
    //   Vitest の coverage（100% のしきい値）は Stryker の実行では効かない。vitest-runner が coverage.enabled: false を
    //   強制し、Stryker 自身の perTest カバレッジ分析を使うため（公式 https://stryker-mutator.io/docs/stryker-js/vitest-runner/
    //   の「Non overridable options」）。vitest.config.mts の coverage.enabled も既定の false のまま。
    configFile: "vitest.stryker.config.mts",
  },

  // tsconfigFile: 実在しないパスを指定して、Stryker の tsconfig の書き換え（TSConfigPreprocessor）を空振りさせる。
  //   WHY: Stryker 10.0.0 は既定で tsconfig.json を読み、サンドボックス（.stryker-tmp/sandbox-*）の外を指す
  //   extends / references のパスを書き換える。その読み込みに typescript の JS API（ts.parseConfigFileTextToJson）を
  //   使うが、TypeScript 7 の typescript パッケージは version / versionMajorMinor しか export しない
  //   （2026-09-28 に import("typescript") で確認）。既定のままだと「TypeError: ts.parseConfigFileTextToJson is not a function」で
  //   Stryker が起動直後に失敗した（2026-09-28 実測。@stryker-mutator/core 10.0.0 の
  //   dist/src/sandbox/ts-config-preprocessor.js）。この処理は、指定したパスが
  //   サンドボックスにコピーするファイルの中に無ければ何もしない（同ファイルの rewriteTSConfigFile）。
  //   書き換えを止めても問題ない理由: tsconfig（リポジトリ直下・apps/frontend_customer・apps/backend・apps/shared）に extends / references が無く、
  //   include / exclude / paths にもサンドボックスの外を指すパスが無いため、書き換える対象がそもそも無い
  //   （paths は "@/*" だけで、apps/frontend_customer の中を指す。Issue #68）。extends / references を足すときはこの設定を見直す。
  //   typescript-checker（型エラーになる変異を除く checker）も同じ JS API を使うため、TS 7 では動かないと判断して
  //   入れていない（.claude/rules/testing.md の「mutation testing（Stryker）」）。
  tsconfigFile: "stryker-skips-tsconfig-rewrite.json",

  // coverageAnalysis は書かない。vitest-runner はこの値を無視し、常に perTest（変異を通るテストだけを実行する）で動く
  //   （公式ドキュメントの「Limitations」）。

  // mutate: 変異を入れるファイル。vitest.config.mts の coverage.include のうち、TypeScript の実装がある
  //   apps/frontend_customer/features/ apps/frontend_customer/shared/ apps/frontend_customer/test-support/ apps/backend/ apps/shared/ と同じ範囲にする（カバレッジ 100% で「実行されている」
  //   ことを担保した範囲に対して、「テストが結果を検証している」かを確かめる）。
  //   含めないもの:
  //   - テスト（*.test.ts / *.test.tsx）と型宣言（*.d.ts）: 変異させる対象（実装）ではない。
  //   - scripts/: いまある実装は cloud-session-start.sh（シェル）だけで、Stryker は JS / TS しか変異させられない。
  //     scripts/ の .ts はテストだけなので、coverage.include の scripts/**/*.ts は入れていない。
  //   - apps/frontend_customer/app/: ルーティングだけで単体テストを置かない方針（.claude/rules/frontend.md）。変異させても単体テストで
  //     落とせないため、生き残りとして数えるだけになる。
  //   - 設定ファイル（リポジトリ直下のもの、apps/frontend_customer/next.config.ts・instrumentation*.ts、apps/backend/shared/drizzle/drizzle.config.ts）、
  //     ルール検査テスト（rule-tests/architecture.test.ts など）、apps/e2e/: 実装ではない（vitest.config.mts の coverage.include と同じ）。
  //   apps/frontend_customer/shared/ は request-log（Issue #80）から使い始めた（.claude/rules/frontend.md）。
  //   apps/shared/（frontend と backend で共通の env.ts・logger.ts。Issue #90）も coverage.include と同じく対象にする。
  //   env.test.ts・logger.test.ts は同じディレクトリのファイルを相対パスで import するので、サンドボックスの変異したファイルを読む
  //   （下の注意の "@repo/shared/..." で読むのは backend・frontend 側で、その変異はここのテストで殺す）。
  // 注意（Issue #68 の段階 2。workspace パッケージ @repo/backend。Issue #90 の @repo/shared も同じ）: "@repo/backend/..." で import したファイルは、サンドボックスの
  //   中でも変異していない元の apps/backend を読む。Stryker はサンドボックスの中に、元のリポジトリの node_modules（リポジトリ直下・
  //   apps/frontend_customer・apps/backend）を指す symlink を作り（@stryker-mutator/core 10.0.0 の sandbox.js の symlinkNodeModulesIfNeeded
  //   の symlinkJunction(path.resolve(nodeModules), path.join(this.workingDirectory, nodeModules)) と file-utils.js の
  //   findNodeModulesList）、その先の @repo/backend は pnpm が作った相対の symlink（../../../backend など）で、
  //   元のリポジトリの apps/backend に解決されるため（2026-09-28、実行中のサンドボックスで readlink -f して確認）。
  //   今は影響しない: backend のテストは backend の中を相対パスで import する（サンドボックスの変異したファイルを読む）。
  //   "@repo/backend/..." を使うのは、frontend の型だけの import（実行時に消える）、テストの無い app/api と instrumentation-node.ts、
  //   globalSetup（vitest.global-setup.ts。Stryker の worker の中では何もしない）だけで、mutation score は 100% のまま
  //   （killed 570 / timeout 3 / survived 0 / ignored 16。2026-09-28 実測）。
  //   将来、テストが "@repo/backend/..." から backend の値を import すると、その変異はテストに届かず survived になる。
  //   backend の振る舞いは backend の中のテスト（相対パスの import）で確かめる。
  mutate: [
    "apps/frontend_customer/features/**/*.{ts,tsx}",
    "apps/frontend_customer/shared/**/*.{ts,tsx}",
    // テストだけが使うコード（Issue #181 で apps/frontend_customer/shared/i18n/ から移した）。apps/backend/test-support/ は
    //   apps/backend/** に含まれる。
    "apps/frontend_customer/test-support/**/*.{ts,tsx}",
    "apps/backend/**/*.{ts,tsx}",
    "apps/shared/**/*.ts",
    "!apps/backend/shared/drizzle/*.config.ts",
    "!**/*.test.{ts,tsx}",
    "!**/*.d.ts",
  ],

  // reporters:
  //   - clear-text: 終了時に、生き残った変異の一覧と、ファイルごとの mutation score の表を標準出力に出す。
  //   - progress: 実行中の進み具合（件数と残り時間の見込み）を出す。
  //   - html: ブラウザで開けるレポート。GitHub Actions では artifact として保存する（.github/workflows/mutation.yml）。
  //   - json: 機械可読なレポート（mutation-testing-report-schema）。しきい値を決めるときの集計や、実行ごとの比較に使う。
  reporters: ["clear-text", "progress", "html", "json"],

  // レポートの出力先。reports/ は .gitignore 済み（実行のたびに生成される）。値は Stryker の既定と同じだが、
  // ワークフローが artifact に保存するパス（reports/mutation/）と対応していることを明示するために書く。
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },

  // ignoreStatic: static な変異（モジュールの読み込み時にだけ実行される変異）を数えない（status が Ignored になる）。
  //   static な変異とは、モジュールの最上位で評価される式（apps/backend/features/todo/internal/infra/schema.ts の列定義など）の変異。
  //   Stryker はテストごとのカバレッジで「その変異を通るテスト」を選べないため、既定（false）では環境を読み込み直して
  //   全テストを実行する（公式 https://stryker-mutator.io/docs/stryker-js/configuration/ の ignoreStatic、
  //   https://stryker-mutator.io/docs/mutation-testing-elements/static-mutants/ ）。
  //   WHY 有効にする（Issue #55）:
  //   - 読み込み時の変異は、その結果を読み込むテストファイル自体の読み込みを壊すことがある。env.ts の
  //     `export const env = readEnv(process.env)` は読み込み時に readEnv を実行するので、readEnv の中の変異で
  //     読み込みが失敗し、テストが 1 件も実行されないまま Survived と数えられていた（testsCompleted 0。Issue #59 で判明）。
  //   - 読み込み時とテスト中の両方で実行される変異（hybrid。env.ts の readEnv、api ファイル最下部の Route Handler の組み立てなど）は、
  //     ignoreStatic を有効にするとテスト中の実行だけを対象に、その変異を通るテストだけで判定される（上の static-mutants の
  //     「What Stryker does」。@stryker-mutator/core 10.0.0 の dist/src/mutants/mutant-test-planner.js の planMutant）。
  //     そのため readEnv の変異は env.test.ts で正しく killed になる。
  //   - 実行時間: 既定では static な変異 124 件（全体の 21%）が実行時間の 83% を占めると警告され、全体で約 5 分かかった。
  //     有効にすると約 3.3 分（2026-09-28、ローカル 4 コアで実測。576 変異、3 分 18 秒）。
  //   ロジックの定数は static にしない: 読み込み時に固定される定数（正規表現・変換表・URL・接頭辞など）は、呼び出し時に
  //   評価する関数の中に置く（todo-repository.postgres.ts の isUuid、problem.ts の problemKindOf、todo-api.ts の todosPath、
  //   apps/backend/test-support/database.ts の testSchemaPrefix）。最上位の定数のままだと、既定の実行では killed になる変異も
  //   ignoreStatic で数えなくなるため（reviewer 指摘。Issue #55 で 18 件が該当した）。
  //   残る static（数えないもの）: features/todo/internal/infra/schema.ts の todos の 10 件（下の実測）と、Issue #188 / #189 で加わった
  //   todo_status_changes の宣言（11 件）・shared/infra/schema.ts（change_logs。14 件）・shared/domain/change-operation.ts
  //   （操作の一覧の定数）。件数は Issue #202 の --mutate の実測（change-operation.ts は未計測）。後者の等価の確認は未実施
  //   （.claude/rules/testing.md）。
  //   static のままにする条件: テスト本体（test / it の中）で schema.ts を読み込まない。vitest-runner は beforeEach でテスト id を
  //   立てるので、テスト本体での読み込み時の実行はそのテストに覆われた hybrid と記録され、Ignored にならずそのテストだけで判定される
  //   （Issue #202 で route-handlers-share-database.test.ts が test の中で api ファイルを読み込み、schema.ts の 35 件が Survived に
  //   なった。読み込みを beforeAll に移して直した）。ignoreStatic を false にして schema.ts を --mutate した実測で、
  //   表名 "todos" → ""、pgTable に渡す列の定義のオブジェクト → {}、"created_at" → "" の 3 件は Killed、次の 7 件は Survived だった:
  //   - uuid("id") / text("title") / boolean("completed") の列名 → "": drizzle は空の列名をキー名で補う
  //     （drizzle-orm 0.45.3 の column-builder.js の setName は、名前が "" のときだけキー名を入れる）。キー名が列名と同じ
  //     なので同じ SQL になる（"created_at" はキー名 createdAt と違うので Killed になる）。
  //   - completed の .default(false) → true: Repository は保存時に completed を必ず渡すので、drizzle の既定値は使われない
  //     （表の既定値は apps/backend/shared/drizzle/ の生成済み SQL で決まる）。
  //   - timestamp の { withTimezone: true, mode: "date" } → {}、withTimezone → false、mode → "": mode が "string" で
  //     なければ Date の列になる点は同じ（pg-core/columns/timestamp.js）。withTimezone は型名（DDL）と、ドライバが
  //     文字列を返したときの変換にだけ使われ、node-postgres は timestamptz を Date で返すので実行時の結果は変わらない。
  //   schema.ts はテーブルの形の宣言で、DDL は drizzle-kit が apps/backend/shared/drizzle/ に生成した SQL で当てる（.claude/rules/backend.md）。
  //   Ignored は score の分母に入らない（mutation score = killed / (killed + survived)。ignoreStatic だけを有効にした実行で
  //   killed 505・survived 57・ignored 25 → 89.86% となり、505 / 562 と一致することを確認した）。
  ignoreStatic: true,

  // thresholds: レポートでの色分け（high 以上が緑、low 以上 high 未満が黄、low 未満が赤）と、失敗ライン（break）。
  //   break 100: survived が 1 件でもあれば score が 100 を下回り、stryker run が非 0 で終わって日次のジョブ
  //     （.github/workflows/mutation.yml）が失敗する。
  //   WHY 100: 等価な変異（変えても振る舞いが変わらず、どのテストでも検出できないもの）は `// Stryker disable` で理由を書いて
  //     除外できる（Ignored は score の分母に入らない）。除外できないものは殺せる変異なので、残りは全部テストで殺す前提にする
  //     （ユーザー判断、Issue #55）。survived が出たら、テストを足して殺すか、等価な変異なら理由付きで disable する
  //     （.claude/rules/testing.md の「mutation testing（Stryker）」。disable の一覧もそこで管理する）。
  //   high 100 / low 95: レポートの色分け。100% だけを緑にする。
  //   経緯: Issue #52 では break を入れず、日次のレポートで実際の score を見てから決めることにしていた（ユーザー判断）。
  //     Issue #55 は当初「95% 以上・break 90（100% は狙わない）」の方針だったが、生き残りを殺して 100% にできたため、
  //     ユーザー判断で break を 100 にした。
  thresholds: { high: 100, low: 95, break: 100 },

  // concurrency / tempDirName（.stryker-tmp、.gitignore 済み）は既定のまま。
  //   concurrency の既定は「論理コア数 n が 4 以下なら n、それより多ければ n-1」（Stryker の JSON Schema の説明）。
};
