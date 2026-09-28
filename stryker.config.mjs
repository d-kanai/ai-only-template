// Stryker（mutation testing）の設定。`pnpm test:mutation`（= stryker run）で読み込まれる（Issue #52）。
// 位置づけと運用は rules/code/test.md の「mutation testing（Stryker）」。
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
  // 既知の問題（未解決。Issue #52 で対応を判断する）: vitest-runner 10.0.0 は Vitest 5.0.1 と組み合わせると、
  //   describe の中のテストで変異を検出できない（killed にならず Survived と数えられる）。
  //   原因: 変異ごとに「その変異を通るテスト」だけを実行するため、テスト名を describe 名とスペース区切りで連結した
  //   正規表現を testNamePattern に渡す（vitest-runner の dist/src/test-helpers.js の collectTestName）。Vitest 5.0.1 は
  //   testNamePattern をフルネーム（describe 名と " > " 区切り。dist/task-utils.js の createTaskName）と照合するため
  //   一致せず、対象のテストがすべて skip される（2026-09-28 実測）。describe の外に書いたテストだけが正しく動く。
  //   実測: そのままだと score 26.82%。連結を " > " に直した vitest-runner の一時コピーで同じ設定を動かすと 85.68%。

  vitest: {
    // configFile: pnpm test と同じ vitest.config.mts（jsdom、tsconfigPaths、e2e/** の除外）でテストを動かす。
    //   既定でも vitest.config.* を探すが、どの設定で動くかを明示する。
    //   Vitest の coverage（100% のしきい値）は Stryker の実行では効かない。vitest-runner が coverage.enabled: false を
    //   強制し、Stryker 自身の perTest カバレッジ分析を使うため（公式 https://stryker-mutator.io/docs/stryker-js/vitest-runner/
    //   の「Non overridable options」）。vitest.config.mts の coverage.enabled も既定の false のまま。
    configFile: "vitest.config.mts",
  },

  // tsconfigFile: 実在しないパスを指定して、Stryker の tsconfig の書き換え（TSConfigPreprocessor）を空振りさせる。
  //   WHY: Stryker 10.0.0 は既定で tsconfig.json を読み、サンドボックス（.stryker-tmp/sandbox-*）の外を指す
  //   extends / references のパスを書き換える。その読み込みに typescript の JS API（ts.parseConfigFileTextToJson）を
  //   使うが、TypeScript 7 の typescript パッケージは version / versionMajorMinor しか export しない
  //   （2026-09-28 に import("typescript") で確認）。既定のままだと「TypeError: ts.parseConfigFileTextToJson is not a function」で
  //   Stryker が起動直後に失敗した（2026-09-28 実測。@stryker-mutator/core 10.0.0 の
  //   dist/src/sandbox/ts-config-preprocessor.js）。この処理は、指定したパスが
  //   サンドボックスにコピーするファイルの中に無ければ何もしない（同ファイルの rewriteTSConfigFile）。
  //   書き換えを止めても問題ない理由: tsconfig.json に extends / references が無く、include / exclude にも
  //   サンドボックスの外（../）を指すパスが無いため、書き換える対象がそもそも無い。extends / references を足すときは
  //   この設定を見直す。
  //   typescript-checker（型エラーになる変異を除く checker）も同じ JS API を使うため、TS 7 では動かないと判断して
  //   入れていない（rules/code/test.md の「mutation testing（Stryker）」）。
  tsconfigFile: "stryker-skips-tsconfig-rewrite.json",

  // coverageAnalysis は書かない。vitest-runner はこの値を無視し、常に perTest（変異を通るテストだけを実行する）で動く
  //   （公式ドキュメントの「Limitations」）。

  // mutate: 変異を入れるファイル。vitest.config.mts の coverage.include のうち、TypeScript の実装がある
  //   features/ backend/ shared/ と同じ範囲にする（カバレッジ 100% で「実行されている」ことを担保した範囲に対して、
  //   「テストが結果を検証している」かを確かめる）。
  //   含めないもの:
  //   - テスト（*.test.ts / *.test.tsx）と型宣言（*.d.ts）: 変異させる対象（実装）ではない。
  //   - scripts/: いまある実装は cloud-session-start.sh（シェル）だけで、Stryker は JS / TS しか変異させられない。
  //     scripts/ の .ts はテストだけなので、coverage.include の scripts/**/*.ts は入れていない。
  //   - app/: ルーティングだけで単体テストを置かない方針（rules/code/architecture.md）。変異させても単体テストで
  //     落とせないため、生き残りとして数えるだけになる。
  //   - ルート直下の設定ファイルやルール検査テスト（architecture.test.ts など）、e2e/: 実装ではない。
  //   shared/ はまだ無い（rules/code/architecture.md）が、作ったときに自動で対象になるよう入れておく。
  mutate: [
    "features/**/*.{ts,tsx}",
    "backend/**/*.{ts,tsx}",
    "shared/**/*.{ts,tsx}",
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

  // thresholds: レポートでの色分け（high 以上が緑、low 以上 high 未満が黄、low 未満が赤）。値は Stryker の既定と同じ。
  //   break（これを下回ると非 0 で終わる）は書かない。初回は日次でレポートを出すだけにして、実際の score を見てから
  //   しきい値を決める（ユーザー判断、Issue #52）。break を先に入れると、根拠のない値で日次のジョブが赤になり続けるか、
  //   低すぎて何も止めないかのどちらかになるため。
  thresholds: { high: 80, low: 60 },

  // concurrency / tempDirName（.stryker-tmp、.gitignore 済み）は既定のまま。
  //   concurrency の既定は「論理コア数 n が 4 以下なら n、それより多ければ n-1」（Stryker の JSON Schema の説明）。
};
