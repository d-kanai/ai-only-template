import { defineConfig, devices } from "@playwright/test";

// Playwright（E2E テスト）の設定。最小構成で、Chromium だけで e2e/ のテストを実行する。
// 実行: pnpm test:e2e（= playwright test）。Next の本番ビルドを webServer で起動し、ブラウザから画面を操作する。

// E2E 用のサーバのポート。
// WHY 3100: pnpm dev の既定（3000）と重ならないようにし、開発サーバを起動したままでも E2E を実行できるようにする。
const port = 3100;
const baseURL = `http://localhost:${port}`;

// Chromium の実行ファイルのパス。未設定なら Playwright がインストールしたブラウザ（playwright install）を使う。
// WHY 環境変数で差し替える: Claude Code のクラウド VM には Playwright 同梱の Chromium（/opt/pw-browsers）が
//   あらかじめ入っているが、そのビルド（chromium-1194、Chromium 141）は @playwright/test 1.63.0 が要求するビルド
//   （playwright-core の browsers.json で chromium 1243）と一致せず、そのままでは起動できない。VM ではブラウザの
//   ダウンロードもしない前提のため、既存の Chromium をこの変数で渡す（例: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium）。
//   CI では未設定にし、playwright install で入れた、版の合ったブラウザを使う。
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  // testDir: E2E テストの置き場所。Vitest の単体テスト（対象の隣の *.test.ts(x)）と分けるため、ルート直下の e2e/ に置く。
  testDir: "e2e",
  // fullyParallel / workers: テストを 1 つずつ順番に実行する。
  //   WHY: API は InMemory で、webServer の 1 プロセスを全テストが共有する。並列に動かすと、別のテストが作った Todo が
  //   一覧に混ざり、結果が実行のタイミングで変わるため。
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
    command: `pnpm build && pnpm start -p ${port}`,
    // url: この URL が応答するまで待ってからテストを始める。
    url: baseURL,
    // reuseExistingServer: ローカルでは既に起動しているサーバがあればそれを使い、CI では必ず新しく起動する。
    //   WHY: ローカルでは build を毎回待たずに繰り返し実行できるようにする。CI では古いサーバを使うと、
    //   その PR のコードを検証したことにならないため。
    reuseExistingServer: !process.env.CI,
    // timeout: build を含めて起動を待つ上限（ミリ秒）。WHY 180 秒: 既定の 60 秒では next build の時間を含めると足りない
    //   おそれがあるため、余裕を持たせる。
    timeout: 180_000,
  },
});
