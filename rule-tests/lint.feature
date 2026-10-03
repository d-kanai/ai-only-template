# Biome と Lefthook の導入（.claude/rules/quality/lint.md）が効いていることを検査するルール検査テストの仕様（Issue #282）。step の実装は対の lint.test.ts。
# 規則の WHY と限界は lint.test.ts の冒頭。
Feature: Biome と Lefthook
  Scenario: biome check（pnpm lint と同じ引数）
    * 未使用変数と == を含むファイルは非 0 で終わり、ルール名が出力される
    * 既定 severity が warn・info の recommended ルールと recommended 外で追加したルールは、その違反だけでも非 0 で終わる（noUnusedVariables・useTemplate・noConsole）
    * env.ts 以外のファイル・リポジトリの外の env.ts という名前のファイル・E2E の spec で process.env を読むと非 0 で終わり、noProcessEnv が出力される
    * テスト（x.test.ts・x.test.tsx）では process.env を読んでも 0 で終わる（子プロセスに PATH を渡すなどで使う）
    * apps/shared/env.ts は process.env を読んでいても 0 で終わる（環境変数の唯一の入口）
    * console.log・console.error・console.warn を logger.ts 以外のファイル（リポジトリの外の logger.ts という名前のファイル・E2E の spec を含む）に書くと非 0 で終わり、noConsole が出力される
    * テスト（x.test.ts・x.test.tsx）では console を書いても 0 で終わる（vi.spyOn(console, ...) で出力を抑える・確かめる）
    * apps/shared/logger.ts は console を書いていても 0 で終わる（ログの唯一の出口）
    * 代表ルールの許可される書き方は 0 で終わる（noUnusedVariables: 宣言した変数を使う・useTemplate: テンプレートリテラルで連結する）
    * 違反のないファイルは 0 で終わる
  Scenario: biome check の noStaticOnlyClass は apps/backend・apps/shared・apps/e2e と frontend の React 以外のモジュールだけで off（Issue #262）
    * apps/backend・apps/shared・apps/e2e・frontend の React 以外のモジュールでは static だけのクラスが 0 で終わる（backend の shared/error・features の infra・test-support、apps/shared、apps/e2e、frontend の features・shared・test-support の .ts と .mts）
    * apps/backend・apps/shared・apps/e2e・frontend の React 以外のモジュールの外では static だけのクラスが非 0 で終わり、noStaticOnlyClass が出力される（前方一致だけが同じ別ディレクトリ・frontend の component と hook とテスト・frontend の app/ と直下・リポジトリ直下）
    * apps/frontend_customer の app/ でもインスタンスのメンバーを持つクラスは 0 で終わる
    * リポジトリの apps/backend/shared/drizzle/drizzle.config.ts（static だけのクラス DrizzleConfigPath）は 0 で終わる
  Scenario: biome check の noRestrictedImports は apps/frontend_customer の ../ の import を拒否する（Issue #340）
    * apps/frontend_customer で ../ を指す import・export は非 0 で終わり、noRestrictedImports が出力される（../ と ../../・.. と ../ だけ・import type・export from と全部の re-export・dynamic import()・副作用だけの import・拡張子付き・.tsx と app/ とテスト）
    * apps/frontend_customer の ./・@/・パッケージ（react・next/link・@repo/shared/logger）の import と、コメントと文字列の中の ../ は 0 で終わる
    * apps/frontend_customer の外の ../ の import は 0 で終わる（backend と e2e は相対パスを使う・前方一致だけが同じ別ディレクトリ・リポジトリ直下）
  Scenario: biome check は本番コードの関数の行数・引数の数・ファイルの行数・1 ファイルのクラス数を縛り、テストは対象外にする（Issue #384）
    * 本番コードで 51 行の関数・引数 5 個の関数・301 行のファイル・クラス 2 つのファイルは非 0 で終わり、noExcessiveLinesPerFunction・useMaxParams・noExcessiveLinesPerFile・noExcessiveClassesPerFile が出力される（backend・shared・frontend の .ts と .tsx と hook・前方一致だけがテストの置き場所と同じ別ディレクトリ・リポジトリ直下）
    * 本番コードでも 50 行の関数・引数 4 個の関数・300 行のファイル・クラス 1 つのファイルは 0 で終わる
    * テスト（x.test.ts・x.test.tsx・rule-tests・apps/e2e・backend の spec と test-support・frontend の test-support）では 51 行の関数・引数 5 個の関数・301 行のファイル・クラス 2 つのファイルでも 0 で終わる
  Scenario: --error-on-warnings 付きの biome check かの判定（runsBiomeCheckWithErrorOnWarnings）
    * --error-on-warnings 付きの biome check は許可する（フラグの位置・--write・pnpm exec と lefthook の引数・&& でつなぐ）
    * --error-on-warnings が無い・check でない・別のコマンドの引数・npx・失敗を打ち消すつなぎ・warn を効かなくするフラグ・空文字は拒否する（||・;・改行・|・&・--diagnostic-level・--only・--skip）
  Scenario: package.json scripts
    * lint と check は --error-on-warnings 付きで biome check を実行する
  Scenario: lefthook.yml
    * pre-commit で --error-on-warnings 付きの biome check を実行するコマンドが定義されている
