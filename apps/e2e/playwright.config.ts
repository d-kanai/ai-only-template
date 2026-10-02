import { defineConfig, devices } from "@playwright/test";
import { env, toolEnv } from "@repo/shared/env";
import { defineBddConfig } from "playwright-bdd";

// Playwright（E2E テスト）の設定。最小構成で、Chromium だけで apps/e2e/ の .feature（playwright-bdd が生成したテスト）を実行する。
// 実行: リポジトリ直下の pnpm test:e2e（= pnpm --filter @repo/e2e test = apps/e2e をカレントディレクトリにした playwright test）。
//   Next の本番ビルドを webServer で起動し、ブラウザから画面を操作する。
// WHY apps/e2e を workspace パッケージ @repo/e2e にする（Issue #84）: apps/frontend_customer・apps/backend と同じ形にし、E2E だけが使う
//   依存（@playwright/test・pg・@types/pg）を apps/e2e/package.json に置いて、リポジトリ直下から外す（.claude/rules/testing.md の「E2E」）。
// WHY env.ts を "@repo/shared/..." で import する（Issue #68 の段階 2・Issue #90）: env.ts は frontend と backend で共通の workspace
//   パッケージ apps/shared にあり、公開の入口（apps/shared/package.json の exports）からだけ使う（rule-tests/architecture.test.ts の
//   frontend-to-shared-specifier）。apps/e2e/package.json の devDependencies に "@repo/shared": "workspace:*" があるので、Node の解決
//   （apps/e2e/node_modules/@repo/shared → apps/shared）で見つかる。tsconfig の paths には頼らない。
// .env: カレントディレクトリは apps/e2e だが、env.ts はカレントディレクトリから上にたどってリポジトリ直下の .env を 1 つだけ読む
//   （apps/shared/env.ts の DotEnvFile.findRepoRoot）。E2E_PORT・PLAYWRIGHT_CHROMIUM_EXECUTABLE・DATABASE_URL もそこから読む。

// E2E 用のサーバのポート（toolEnv.E2E_PORT。.env / 環境変数の E2E_PORT を env.ts が 1〜65535 の整数として検証した値。任意）。
// WHY 既定が 3100: pnpm dev の既定（3000）と重ならないようにし、開発サーバを起動したままでも E2E を実行できるようにする。
//   メインの作業ツリーは E2E_PORT が無くても（既存の .env のままでも）この値で動く。
// WHY .env から変えられるようにする（Issue #64）: worktree では WorktreeCreate フックが worktree の名前から 3101〜3900 の
//   値を導いて .env に書く（scripts/worktree-env.sh）。並列の worktree が同じポートを使うと、reuseExistingServer で
//   別の worktree のサーバを検証してしまうため（.claude/rules/worktree.md）。
// WHY Env（必須）ではなく toolEnv（任意）: E2E 専用の値で、アプリ（next start）は使わないため（.claude/rules/env.md）。
const port = toolEnv.E2E_PORT ?? 3100;
const baseURL = `http://localhost:${port}`;

// Chromium の実行ファイルのパス（toolEnv.PLAYWRIGHT_CHROMIUM_EXECUTABLE。env.ts のツール用の区画で、無いのが正常）。
// 未設定なら Playwright がインストールしたブラウザ（playwright install）を使う。
// WHY 環境変数で差し替える: Claude Code のクラウド VM には Playwright 同梱の Chromium（/opt/pw-browsers）が
//   あらかじめ入っているが、そのビルド（chromium-1194、Chromium 141）は @playwright/test 1.63.0 が要求するビルド
//   （playwright-core の browsers.json で chromium 1243）と一致せず、そのままでは起動できない。VM ではブラウザの
//   ダウンロードもしない前提のため、既存の Chromium をこの変数で渡す（例: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium）。
//   CI では未設定にし、playwright install で入れた、版の合ったブラウザを使う。
const chromiumExecutable = toolEnv.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

// サーバ（next start）とテスト（apps/e2e/database.ts）が使う Postgres の接続先。env.ts が .env / 環境変数から読んで検証した値で、
// 欠けていれば env.ts の読み込み（この設定ファイルの読み込み）で、サーバを起動する前に失敗する。
// WHY webServer に明示的に渡す: next start は自分でも .env を読むが、コマンドの前に付けた DATABASE_URL（環境変数）で
//   E2E の接続先を変えたときに、テスト（apps/e2e/database.ts）とサーバが必ず同じ DB を指すようにする。
// 前提: Postgres が起動していて（pnpm db:up）、マイグレーションを当ててある（pnpm db:migrate）こと。
//   webServer の中では当てない（Issue #57 の方針。CI・クラウドのフックは E2E の前に db:migrate を実行する）。
const databaseUrl = env.DATABASE_URL;

// E2E は Gherkin の .feature（業務の流れ）と step のクラス（*.steps.ts）で書く（Issue #279。.claude/rules/testing.md の「E2E」、
//   ADR docs/adr/quality/20261002-e2e-in-gherkin-with-playwright-bdd.md）。playwright-bdd の bddgen が .feature から Playwright の
//   テスト（outputDir の .features-gen/ の *.spec.js）を生成し、playwright test がそれを実行する（package.json の test）。
// defineBddConfig の返り値は生成先のディレクトリで、testDir にそのまま渡す（Playwright は生成されたテストだけを探す）。
// features: apps/e2e の直下の .feature。steps: step のクラスを fixture にまとめる fixtures.ts と、step のクラスの *.steps.ts
//   （fixtures.ts が import するので、ここに無くても読まれるが、playwright-bdd が step を探す範囲として明示する）。
// outputDir: 既定（設定ファイルのディレクトリの .features-gen）と同じ値を明示する。.gitignore・rule-tests/architecture.test.ts の
//   EXCLUDED_DIRS・rule-tests/e2e-feature.test.ts の SKIPPED_DIRS が同じ名前を除くので、名前を変えるならそちらも変える。
//   生成物は *.spec.js で、tsconfig.json の include（*.ts / *.tsx / *.mts）に入らないので型チェックの対象にもならない。
// missingSteps: 既定の fail-on-gen（.feature の step に対応する実装が無ければ、生成の時点で失敗にする）。WHY 既定のまま: 書いた
//   流れが実装されないまま残らない（API ジャーニーの vitest-cucumber の「Missing steps」と同じ役割）。
const testDir = defineBddConfig({
  features: "*.feature",
  steps: ["fixtures.ts", "*.steps.ts"],
  outputDir: ".features-gen",
});

export default defineConfig({
  // testDir: playwright-bdd が .feature から生成したテストの置き場所（上の defineBddConfig の outputDir。apps/e2e/.features-gen）。
  //   WHY E2E を別のパッケージ（apps/e2e）に置く: Vitest の単体テスト（対象の隣の *.test.ts(x)）と分けるため（Vitest は
  //   vitest.config.mts の exclude で apps/e2e/** を読まない）。
  //   testMatch は既定（**/*.@(spec|test).?(c|m)[jt]s?(x)）で、生成された *.spec.js がテストになる。
  //   outputDir（失敗時のトレースなど。playwright-bdd の outputDir とは別のもの）は既定のまま、この package.json のディレクトリの
  //   test-results（apps/e2e/test-results。.gitignore 済み）になる（playwright 1.63.0 の lib/common/index.js の packageJsonDir）。
  testDir,
  // fullyParallel / workers: テストを 1 つずつ順番に実行する。
  //   WHY: webServer の 1 プロセスと 1 つの Postgres を全テストが共有し、各シナリオの前に todos を空にする（apps/e2e/shared.steps.ts の Background の step）。
  //   並列に動かすと、別のテストのリセットや作った Todo が混ざり、結果が実行のタイミングで変わるため。
  fullyParallel: false,
  workers: 1,
  // retries: 失敗したテストを再実行しない。WHY: 再実行で通ると不安定なテストが隠れるため、失敗はそのまま失敗にする。
  retries: 0,
  // reporter: 各テストの結果を 1 行ずつ出す。WHY: ローカルと CI のログでそのまま読めるようにし、
  //   既定の html レポーター（playwright-report/ を生成し、失敗時にブラウザで開こうとする）を使わない。
  reporter: "list",
  use: {
    // baseURL: page.goto("/") などの相対パスの基準。webServer と同じ URL にする。
    baseURL,
    // locale: ブラウザの言語（navigator.language と、リクエストの Accept-Language）。
    //   WHY ja-JP に固定する: 画面の言語は Accept-Language で決まる（apps/frontend_customer/proxy.ts・shared/i18n/locale.ts。Issue #116）。
    //   固定しないと、実行する環境（CI の Chromium の既定は en-US）で画面の言語が変わり、日本語の文言を探すテストが落ちる。
    //   英語の表示は、step で Accept-Language のヘッダを en-US にして確かめる（apps/e2e/i18n.steps.ts）。
    locale: "ja-JP",
    // timezoneId: ブラウザのタイムゾーン。
    //   WHY サーバ（UTC）と違う Asia/Tokyo にする: 日時はブラウザのタイムゾーンで表示する（todo-item.tsx）。サーバと同じ UTC だと、
    //   サーバのタイムゾーンで表示してしまう誤りを見逃す。
    timezoneId: "Asia/Tokyo",
  },
  projects: [
    {
      // Chromium だけで実行する。WHY: 最小構成。ブラウザを増やすと CI のインストール時間と実行時間が増えるため、
      //   ブラウザ差異の検証が必要になったら firefox / webkit を足す。
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // executablePath を渡すのは PLAYWRIGHT_CHROMIUM_EXECUTABLE があるときだけ（上の WHY）。
        //   未設定のときは launchOptions 自体を付けず、Playwright の既定（インストール済みブラウザ）のままにする。
        ...(chromiumExecutable === undefined
          ? {}
          : { launchOptions: { executablePath: chromiumExecutable } }),
      },
    },
  ],
  webServer: {
    // command: 本番ビルドを作ってから起動する。
    //   WHY dev ではなく build + start: 利用者に届く本番ビルドの挙動を検証するため。dev はページを初回アクセス時に
    //   コンパイルし、本番ビルドとは動き方が異なる。
    //   WHY pnpm -w: webServer の command はこの設定ファイルのディレクトリ（apps/e2e）をカレントディレクトリにして動く。
    //   -w（--workspace-root）でリポジトリ直下の package.json の build / start（= pnpm --filter @repo/frontend-customer build / start）を
    //   呼ぶ。-p <port> は start の後ろに渡した引数として next start まで届く（pnpm 12.7.0 で実測。Issue #84）。
    command: `pnpm -w build && pnpm -w start -p ${port}`,
    // url: この URL が応答するまで待ってからテストを始める。
    url: baseURL,
    // reuseExistingServer: ローカルでは既に起動しているサーバがあればそれを使い、CI では必ず新しく起動する。
    //   WHY: ローカルでは build を毎回待たずに繰り返し実行できるようにする。CI では古いサーバを使うと、
    //   その PR のコードを検証したことにならないため。
    //   注意: ローカルで E2E_PORT 番（未設定なら 3100）に古いサーバが残っていると、今のコードではなくそのサーバを検証してしまう。
    //   コードを変えた後は、起動したままのサーバを止めてから実行する。
    reuseExistingServer: !toolEnv.CI,
    // timeout: build を含めて起動を待つ上限（ミリ秒）。WHY 180 秒: 既定の 60 秒では next build の時間を含めると足りない
    //   おそれがあるため、余裕を持たせる。
    timeout: 180_000,
    // env: next start に渡す環境変数（Playwright の既定では process.env を引き継いだうえで、ここに書いたものを上書きする）。
    //   DATABASE_URL を渡して Postgres で動かす（上の databaseUrl）。
    //   注意: reuseExistingServer で起動済みのサーバを使うときは、そのサーバの環境変数のままになる。別の DATABASE_URL で
    //   起動したサーバが E2E_PORT 番に残っていると、テストと違う DB を検証してしまう（テストの DB の確認で失敗する）。
    //   TZ: サーバは UTC で動かす（apps/frontend_customer/instrumentation-node.ts が UTC でなければ起動を止める。Issue #116）。
    //   command の pnpm -w start も TZ=UTC を付けるが（リポジトリ直下の package.json）、build を含む command 全体を UTC にそろえる。
    env: { DATABASE_URL: databaseUrl, TZ: "UTC" },
  },
});
