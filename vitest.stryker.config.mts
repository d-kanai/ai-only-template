import { defineConfig, mergeConfig } from "vitest/config";
// WHY 拡張子を .mjs と書く（実体は vitest.config.mts）: tsc（pnpm typecheck）は ".mts" で終わる import を
//   allowImportingTsExtensions なしでは TS5097 のエラーにする。".mjs" と書くと、tsc は .mts の型を読み（TypeScript の
//   拡張子の対応）、Vitest（Vite の設定の読み込み）も vitest.config.mts を読む（2026-09-30 に `vitest list --config` で確認）。
import baseConfig from "./vitest.config.mjs";

// Stryker（pnpm test:mutation）だけが使う Vitest の設定（stryker.config.mjs の vitest.configFile。Issue #200）。
// pnpm test と同じ vitest.config.mts を mergeConfig で継承し、差分だけをここに書く（jsdom・tsconfigPaths・globalSetup・
//   include / exclude などはすべて vitest.config.mts のまま）。
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // exclude: Gherkin の .feature の step を書いた API ジャーニー（apps/backend/spec/journey/*.api-journey.test.ts）を Stryker では
      //   実行しない。mergeConfig は配列を連結するので、vitest.config.mts の exclude（node_modules・apps/e2e/**・.stryker-tmp/**）に
      //   この 1 行が足される。
      //   WHY: vitest-cucumber 8.0.0 は step 1 つを Vitest の test 1 つにし、前の step の結果（作った Todo・応答）を後の step が使う
      //   （node_modules/@amiceli/vitest-cucumber の describe-feature の test.for。「シナリオを 1 つの test にする」設定は無い）。
      //   Stryker は変異ごとに、その変異を通る test だけを testNamePattern で絞って実行する（vitest-runner。stryker.config.mjs の
      //   pnpm patch の説明）。後の step だけが選ばれると、前提の step が skip されて値が undefined のまま失敗し、変異の検出と
      //   関係なく killed と数えられうる（`vitest run <file> -t "<後の step の名前>"` で TypeError になることを 2026-09-30 に実測。
      //   同日の work-logs）。
      //   代償: TS だけのジャーニー（1 シナリオ = 1 test）は廃止した（Issue #200 のユーザー判断）ので、API ジャーニーの流れは Stryker
      //   では検証しない。変異は層ごとの単体テストと *.postgres.test.ts が殺す。pnpm test（vitest.config.mts）では API ジャーニーも
      //   実行する。
      exclude: ["apps/backend/spec/journey/*.api-journey.test.ts"],
    },
  }),
);
