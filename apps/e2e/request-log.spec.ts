import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { resetTodos } from "./database";

// リクエストログ（apps/frontend/proxy.ts。Issue #80）が、本番ビルドの next start の stdout に 1 リクエスト = JSON 1 行で出ることを
// 確かめる E2E テスト。1 行の中身の決め方は apps/frontend/shared/request-log/request-log.test.ts で固定しているので、ここでは
// proxy.ts の結線（規約の場所で呼ばれる・matcher・logger 経由で stdout への 1 行・応答ヘッダ x-request-id）だけを見る。
// 行の先頭の level / timestamp は logger（apps/backend/shared/infra/logger.ts。Issue #85）が付ける（形は logger.test.ts で固定）。
// WHY playwright.config.ts の webServer を使わず、このテストの中で next start を子プロセスで起動する:
//   webServer の stdout はテストから読めない（Playwright 1.63.0 の webServer.stdout は "pipe" にしてもランナーのプロセスの
//   stdout に流すだけ。types/test.d.ts の説明。テストは別の worker プロセスで動く）。ローカルの reuseExistingServer では、起動済みのサーバ（別のプロセス）を使うので stdout を取る手段がない。
// 前提: webServer の command（pnpm build）が先に本番ビルド（apps/frontend/.next）を作っていること。ローカルで起動済みの
//   サーバを使うときは、そのビルドが今のコードのものか注意する（.claude/rules/testing.md の E2E）。
// WHY ポート 0: OS に空いているポートを選ばせ、webServer（E2E_PORT）・開発サーバ・並列の worktree のサーバと重ならないようにする。
//   選ばれたポートは next start が出す「Local: http://localhost:<port>」の行から読む。
// WHY 環境変数を渡さない（親の環境を引き継ぐ）: next start は .env を読み、webServer と同じく apps/e2e/database.ts と同じ DB を使う。
//   コマンドの前に DATABASE_URL を付けて変えたときも、その値を引き継ぐので同じ DB になる。

// WHY __dirname（このファイルのある apps/e2e）から相対でたどる: カレントディレクトリ（pnpm --filter @repo/e2e test では apps/e2e）に
//   左右されずに apps/frontend を指すため。
const frontendDir = resolve(__dirname, "..", "frontend");

let server: ChildProcess | undefined;
let baseURL = "";
// next start の stdout の行（リクエストログの JSON 行と Next の起動メッセージ）。
const stdoutLines: string[] = [];

type LoggedRequest = {
  level: string;
  timestamp: string;
  requestId: string;
  kind: string;
  method: string;
  path: string;
  queryKeys: string[];
  accept: string | null;
  referer: string | null;
};

// stdout のうち JSON として読める行（リクエストログ）だけを取り出す。起動メッセージなどは除く。
function loggedRequests(): LoggedRequest[] {
  return stdoutLines.flatMap((line) => {
    if (!line.startsWith("{")) {
      return [];
    }
    return [JSON.parse(line) as LoggedRequest];
  });
}

test.beforeAll(async () => {
  // WHY next の JS を node で直接起動する（pnpm start を通さない）: pnpm を挟むと子プロセスが増え、kill で next が残りうる。
  const child = spawn(
    process.execPath,
    [
      resolve(frontendDir, "node_modules/next/dist/bin/next"),
      "start",
      "-p",
      "0",
    ],
    { cwd: frontendDir, stdio: ["ignore", "pipe", "inherit"] },
  );
  server = child;
  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    stdoutLines.push(...lines);
  });
  await expect
    .poll(
      () =>
        stdoutLines.some((line) =>
          /Local:\s+http:\/\/localhost:\d+/.test(line),
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  const local = stdoutLines
    .map((line) => /Local:\s+(http:\/\/localhost:\d+)/.exec(line)?.[1])
    .find((url) => url !== undefined);
  baseURL = local ?? "";
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

test.beforeEach(async () => {
  await resetTodos();
  stdoutLines.length = 0;
});

test("画面を開くと page の行が 1 つ、画面が呼ぶ /api/todos で api の行が 1 つ出て、プリフェッチは出ない", async ({
  page,
  request,
}) => {
  // 一覧に Todo を 1 件置き、詳細へのリンク（next/link）のプリフェッチが起きる状態にする。
  const title = `ログ確認 ${Date.now()}`;
  const created = await request.post(`${baseURL}/api/todos`, {
    data: { title },
  });
  expect(created.status()).toBe(201);
  const todo = (await created.json()) as { id: string };

  await page.goto(`${baseURL}/`);
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  // 画面の表示（document の GET /）と、画面の hook が呼ぶ GET /api/todos。
  await expect
    .poll(() =>
      loggedRequests().map(({ kind, method, path }) => ({
        kind,
        method,
        path,
      })),
    )
    .toEqual([
      { kind: "api", method: "POST", path: "/api/todos" },
      { kind: "page", method: "GET", path: "/" },
      { kind: "api", method: "GET", path: "/api/todos" },
    ]);
  const [, pageLine, apiLine] = loggedRequests();
  expect(pageLine.accept).toContain("text/html");
  expect(apiLine.referer).toBe(`${baseURL}/`);

  // リンクを押したときのクライアント遷移（RSC の取得）は page の行になる。表示されたリンクのプリフェッチ
  //   （next-router-prefetch ヘッダ付き）は proxy.ts の matcher の missing で除くので、押す前に /todo/<id> の行は無い。
  // WHY 押す前の行を数え直す: プリフェッチはリンクの表示後に非同期で飛ぶので、上の poll の時点ではまだ届いていないことがある。
  //   詳細の画面を開いた後の行の一覧を丸ごと比べ、/todo/<id> の page の行がクライアント遷移の 1 つだけであることを確かめる。
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(`${baseURL}/todo/${todo.id}`);
  await expect(
    page.getByRole("heading", { name: title, level: 1 }),
  ).toBeVisible();
  await expect
    .poll(() =>
      loggedRequests()
        .slice(3)
        .map(({ kind, method, path }) => ({ kind, method, path })),
    )
    .toEqual([
      { kind: "page", method: "GET", path: `/todo/${todo.id}` },
      { kind: "api", method: "GET", path: `/api/todos/${todo.id}` },
    ]);
});

test("x-request-id を付けて呼ぶと、その値が行の requestId と応答ヘッダに入り、クエリは値を出さない", async ({
  request,
}) => {
  const requestId = `e2e-${Date.now()}`;
  const response = await request.get(
    `${baseURL}/api/todos?token=secret-value`,
    {
      headers: { "x-request-id": requestId },
    },
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["x-request-id"]).toBe(requestId);

  await expect.poll(() => loggedRequests()).toHaveLength(1);
  const [line] = loggedRequests();
  expect(line).toMatchObject({
    level: "info",
    requestId,
    kind: "api",
    path: "/api/todos",
    queryKeys: ["token"],
  });
  // logger を通っていること: 先頭が level・timestamp の順で、timestamp は受信時刻の ISO 8601（UTC）のまま。
  expect(Object.keys(line).slice(0, 2)).toEqual(["level", "timestamp"]);
  expect(new Date(line.timestamp).toISOString()).toBe(line.timestamp);
  expect(stdoutLines.join("\n")).not.toContain("secret-value");
});
