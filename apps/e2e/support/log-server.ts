import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "@playwright/test";

// アクセスの記録（request-log.feature）を確かめるための、標準出力を読める本番ビルドのサーバ（Issue #80 / #279。以前の
//   request-log.spec.ts の beforeAll / afterAll）。fixtures.ts が worker の fixture logServer として起動・停止する。
// WHY playwright.config.ts の webServer を使わず、next start を子プロセスで起動する:
//   webServer の stdout はテストから読めない（Playwright 1.63.0 の webServer.stdout は "pipe" にしてもランナーのプロセスの
//   stdout に流すだけ。types/test.d.ts の説明。テストは別の worker プロセスで動く）。ローカルの reuseExistingServer では、起動済みの
//   サーバ（別のプロセス）を使うので stdout を取る手段がない。
// 前提: webServer の command（pnpm build）が先に本番ビルド（apps/frontend_customer/.next）を作っていること。ローカルで起動済みの
//   サーバを使うときは、そのビルドが今のコードのものか注意する（.claude/rules/testing.md の E2E）。
// WHY ポート 0: OS に空いているポートを選ばせ、webServer（E2E_PORT）・開発サーバ・並列の worktree のサーバと重ならないようにする。
//   選ばれたポートは next start が出す「Local: http://localhost:<port>」の行から読む。
// WHY 環境変数を渡さない（親の環境を引き継ぐ。TZ だけ UTC にする）: next start は .env を読み、webServer と同じく apps/e2e/support/database.ts と
//   同じ DB を使う。コマンドの前に DATABASE_URL を付けて変えたときも、その値を引き継ぐので同じ DB になる。
export class E2eLogServer {
  // WHY __dirname（このファイルのある apps/e2e/support）から相対でたどる: カレントディレクトリ（pnpm --filter @repo/e2e test では apps/e2e）に
  //   左右されずに apps/frontend_customer を指すため。
  private static readonly frontendDir = resolve(
    __dirname,
    "..",
    "..",
    "frontend_customer",
  );

  // next start の stdout の行（リクエストログの JSON 行と Next の起動メッセージ）。
  readonly lines: string[] = [];
  baseURL = "";

  private constructor(private readonly child: ChildProcess) {
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      this.lines.push(...lines);
    });
  }

  // WHY next の JS を node で直接起動する（pnpm start を通さない）: pnpm を挟むと子プロセスが増え、kill で next が残りうる。
  // WHY env コマンドで TZ=UTC を付ける: サーバは UTC でなければ起動しない（apps/frontend_customer/instrumentation-node.ts。Issue #116）。
  //   pnpm start を通さないので package.json の TZ=UTC が付かない。env は TZ を足して node に exec する（プロセスは増えず、kill が
  //   next に届く）。spawn の env オプションで足すと process.env を直接読むことになり、env.ts 以外での直参照の禁止
  //   （Biome の noProcessEnv と rule-tests/architecture.test.ts の env-direct-access）に当たる。
  static async start(): Promise<E2eLogServer> {
    const server = new E2eLogServer(
      spawn(
        "env",
        [
          "TZ=UTC",
          process.execPath,
          resolve(E2eLogServer.frontendDir, "node_modules/next/dist/bin/next"),
          "start",
          "-p",
          "0",
        ],
        {
          cwd: E2eLogServer.frontendDir,
          stdio: ["ignore", "pipe", "inherit"],
        },
      ),
    );
    await expect
      .poll(() => server.localURL(), { timeout: 30_000 })
      .not.toBeUndefined();
    server.baseURL = server.localURL() ?? "";
    return server;
  }

  stop(): void {
    this.child.kill("SIGTERM");
  }

  // シナリオごとに、そのシナリオの操作の記録だけを見るために空にする。
  clearLines(): void {
    this.lines.length = 0;
  }

  private localURL(): string | undefined {
    return this.lines
      .map((line) => /Local:\s+(http:\/\/localhost:\d+)/.exec(line)?.[1])
      .find((url) => url !== undefined);
  }
}
