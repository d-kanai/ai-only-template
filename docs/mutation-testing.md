# mutation testing（Stryker）の実測と経緯

規則（目標 100%・disable の条件と一覧）は `.claude/rules/testing.md`、実行と生き残りの直し方はスキル `mutation-testing`、各設定の WHY は `stryker.config.mjs`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。

## 経緯
- Issue #52 で導入。PR ごとには実行せず、main を日次で実行する（ユーザー判断「mutation テストは main branch でのアクションで日次で実行でよい」）。当初は `break` を入れず、日次の結果を見てから決めることにしていた。
- Issue #55 は当初「95% 以上を目標、`break` 90（100% は狙わない）」の方針だったが、生き残りを殺して 100% にできたため、ユーザー判断で `thresholds: { high: 100, low: 95, break: 100 }` にした（テストを 1 つ外して score を下げると「under breaking threshold 100」で exit 1 になることを確認）。理由: 等価な変異は disable で除外でき、Ignored は分母に入らないので、残りは全部殺せる。
- Issue #55 では `todo-screen.hook.ts` の effect の片付け（unmount 時に送信中の GET を古い扱いにする）を「unmount 後の setState は何もしないので観測できない」として除外していたが、React 19.2 の `<Activity mode="hidden">`（Next 16 の `cacheComponents` で画面遷移時に使われる）では、隠すときに片付けが走り、隠れている間の state 更新も反映されるため検出できた（reviewer 指摘。テストを足して除外をやめた）。
- `todo-api.ts` の `toError` が `undefined` を返す変異が、`rejects.toThrow("文字列")` の検証で生き残っていた（Vitest 5.0.1 は reject 値が `undefined` だと文字列を照合せずに通る。2026-09-28 実測）。判定まで `try` に入れていたのも生き残りの原因だった。
- 最上位の定数（正規表現・変換表・URL・接頭辞）が static になり、検査から外れていたものが 18 件あった（reviewer 指摘）。`isUuid`・`statusOf`・`todosPath`・`testSchemaPrefix` の関数の中に移した。

## 実測（2026-09-28、ローカル 4 コア）
- 実行時間: 約 3.3 分（576 変異、3 分 18 秒。Issue #55 の後）。`ignoreStatic` なしでは static な変異 124 件が実行時間の 83% を占めると Stryker が警告し、全体で約 5 分。
- score の推移:
  - Issue #55 の前: 85.52%（killed 502 / survived 85、static も全テストで実行）。`ignoreStatic` だけを有効にすると 89.86%（killed 505 / survived 57 / ignored 25）。
  - Issue #55 の後: 100.00%（killed 560 / survived 0 / ignored 16。ignored は `schema.ts` の static 10 件と disable コメント 6 件）。
  - Issue #68 の段階 2 の後: 100%（killed 570 / timeout 3 / survived 0 / ignored 16）。
- Ignored は score の分母に入らない（killed / (killed + survived)。実測で確認）。
- Stryker の実行後は、テスト用のスキーマ（`test_<UUID>`）が 1 回あたり 12 個残った。Stryker が worker のプロセスを afterAll の前に止めるためと推定しているが未確認。次の `pnpm test` の globalSetup が消す。

## static な変異（`ignoreStatic: true`）
- Stryker は static な変異を通るテストを選べず、全テストを読み込み直して実行する（公式 https://stryker-mutator.io/docs/stryker-js/configuration/ の `ignoreStatic`、https://stryker-mutator.io/docs/mutation-testing-elements/static-mutants/ ）。読み込み時の変異がテストファイルの読み込みを壊すと、テストが 1 件も動かないまま Survived と数えられる（`env.ts` の `export const env = readEnv(process.env)` で、readEnv の変異が testsCompleted 0 の Survived になっていた。Issue #59）。
- 読み込み時とテスト中の両方で実行される変異（hybrid。`env.ts` の `readEnv` など）は、テスト中の実行だけで判定される（数えなくなるわけではない）。`readEnv` の変異は `env.test.ts` で killed。
- 残る static は `apps/backend/todo/infra/schema.ts` の 10 件。`ignoreStatic` を外して `--mutate` した実測で 3 件は Killed、7 件は Survived で、Survived は次の理由で等価:
  - 列名 `"id"` / `"title"` / `"completed"` → `""`: drizzle は空の列名をキー名で補う（drizzle-orm 0.45.3 の `column-builder.js` の `setName`）。キー名と列名が同じなので同じ SQL になる（`"created_at"` → `""` はキー名 `createdAt` と違うので Killed）。
  - `completed` の `.default(false)` → `true`: Repository は保存時に `completed` を必ず渡すので使われない。
  - `timestamp` の設定（`{}`、`withTimezone: false`、`mode: ""`）: `mode` が `"string"` 以外なら Date の列で同じ。`withTimezone` は DDL の型名と、ドライバが文字列を返したときの変換にだけ使われ、node-postgres は timestamptz を Date で返す。

## disable コメントの効き方
- `next-line` は、コメントを直前（leading comment）に持つ文や式の開始行にだけ効く（@stryker-mutator/instrumenter 10.0.0 の `directive-bookkeeper.js`）。`}, []);` の形のままでは依存配列に置けないので、式を別の行に書いて直前にコメントを置く。

## vitest-runner の patch（Issue #52）
- `@stryker-mutator/vitest-runner` 10.0.0 は変異ごとの実行で describe 名とテスト名をスペースで連結するが、Vitest 5.0.1 は ` > ` 区切り（`task-utils.js` の `createTaskName`）で testNamePattern を照合するため、describe 内のテストが skip され survived 扱いになる。
- score は patch なし 26.82%（killed 103 / survived 281）→ patch あり 85.68%（killed 329 / survived 55）、実行時間 147 秒（当時）。
- 上流の master の `packages/vitest-runner/src/test-helpers.ts` もスペース区切りのまま（raw.githubusercontent.com で確認）。Issue / PR の有無は GitHub の Issue 検索がこの環境から使えず（API は 403）未確認。ユーザーの判断で `pnpm patch`（2 ファイル各 1 行）で対応した。patch ファイルを 1 文字変えると `pnpm install --frozen-lockfile` が `patchedDependencies` の不一致で失敗することを確認（改ざん検出）。

## 入れていないもの
- `@stryker-mutator/typescript-checker`: TypeScript の JS API（`ts.createSolutionBuilderWithWatch` / `ts.parseConfigFileTextToJson`。10.0.0 の `dist` で確認）を使うが、TypeScript 7.0.2 の `typescript` パッケージは `version` / `versionMajorMinor` しか export しない（`import("typescript")` で確認）ため動かないと判断した（入れて実行はしていない）。同じ理由で Stryker 本体の tsconfig の書き換えも `tsconfigFile` で止めている。型エラーになる変異は checker なしでも、実行時に失敗するか生き残るかで数えられる。
- Vitest のカバレッジのしきい値は Stryker の実行では効かない（vitest-runner が coverage を無効にし、Stryker のテストごとのカバレッジ分析で変異を通るテストだけを実行する。https://stryker-mutator.io/docs/stryker-js/vitest-runner/ ）。
