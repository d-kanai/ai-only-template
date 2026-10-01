import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { env } from "@repo/shared/env";
import { resetTodos } from "./database";

// リクエストログ（apps/frontend_customer/proxy.ts。Issue #80）が、本番ビルドの next start の stdout に 1 リクエスト = JSON 1 行で出ることを
// 確かめる E2E テスト。1 行の中身の決め方は apps/frontend_customer/shared/request-log/request-log.test.ts で固定しているので、ここでは
// proxy.ts の結線（規約の場所で呼ばれる・matcher・logger 経由で stdout への 1 行・応答ヘッダ x-request-id）だけを見る。
// 行の先頭の severity / time は logger（apps/shared/logger.ts。Issue #85・#90・#209）が付ける（形は logger.test.ts で固定）。
// WHY playwright.config.ts の webServer を使わず、このテストの中で next start を子プロセスで起動する:
//   webServer の stdout はテストから読めない（Playwright 1.63.0 の webServer.stdout は "pipe" にしてもランナーのプロセスの
//   stdout に流すだけ。types/test.d.ts の説明。テストは別の worker プロセスで動く）。ローカルの reuseExistingServer では、起動済みのサーバ（別のプロセス）を使うので stdout を取る手段がない。
// 前提: webServer の command（pnpm build）が先に本番ビルド（apps/frontend_customer/.next）を作っていること。ローカルで起動済みの
//   サーバを使うときは、そのビルドが今のコードのものか注意する（.claude/rules/testing.md の E2E）。
// WHY ポート 0: OS に空いているポートを選ばせ、webServer（E2E_PORT）・開発サーバ・並列の worktree のサーバと重ならないようにする。
//   選ばれたポートは next start が出す「Local: http://localhost:<port>」の行から読む。
// WHY 環境変数を渡さない（親の環境を引き継ぐ。TZ だけ UTC にする）: next start は .env を読み、webServer と同じく apps/e2e/database.ts と同じ DB を使う。
//   コマンドの前に DATABASE_URL を付けて変えたときも、その値を引き継ぐので同じ DB になる。

// WHY __dirname（このファイルのある apps/e2e）から相対でたどる: カレントディレクトリ（pnpm --filter @repo/e2e test では apps/e2e）に
//   左右されずに apps/frontend_customer を指すため。
const frontendDir = resolve(__dirname, "..", "frontend_customer");

let server: ChildProcess | undefined;
let baseURL = "";
// next start の stdout の行（リクエストログの JSON 行と Next の起動メッセージ）。
const stdoutLines: string[] = [];

// リクエストログの 1 行のうち、このテストが見る項目（キーの名前は Issue #209 の OTel semconv の入れ子の名前）。
type LoggedRequest = {
  severity: string;
  time: string;
  message: string;
  event: { name: string };
  http: {
    request: {
      id: string;
      method: string;
      header: { accept: string | null; referer: string | null };
    };
  };
  url: { path: string; query: Record<string, string> };
};

// stdout のうちリクエストログの行だけを取り出す。JSON でない行（Next の起動メッセージ）と、リクエストログ以外の JSON の行
//   （Repository の書き込みのログ。event.name が db_write。apps/backend/shared/infra/writer.ts。Issue #205・#215）は除く。
// WHY event.name で見分ける: logger（apps/shared/logger.ts）を通るログはどれも JSON 1 行で stdout に出るので、「JSON の行」では
//   リクエストログに絞れない。page_request / api_request はリクエストログ（request-log.ts）だけが出す種類（apps/shared/log-event.ts）。
function loggedRequests(): LoggedRequest[] {
  return stdoutLines.flatMap((line) => {
    if (!line.startsWith("{")) {
      return [];
    }
    const parsed = JSON.parse(line) as Partial<LoggedRequest>;
    return parsed.event?.name === "page_request" ||
      parsed.event?.name === "api_request"
      ? [parsed as LoggedRequest]
      : [];
  });
}

// 並びを比べるための要約（種類・メソッド・パス）。
function summary({ event, http, url }: LoggedRequest) {
  return { name: event.name, method: http.request.method, path: url.path };
}

test.beforeAll(async () => {
  // WHY next の JS を node で直接起動する（pnpm start を通さない）: pnpm を挟むと子プロセスが増え、kill で next が残りうる。
  // WHY env コマンドで TZ=UTC を付ける: サーバは UTC でなければ起動しない（apps/frontend_customer/instrumentation-node.ts。Issue #116）。
  //   pnpm start を通さないので package.json の TZ=UTC が付かない。env は TZ を足して node に exec する（プロセスは増えず、kill が
  //   next に届く）。spawn の env オプションで足すと process.env を直接読むことになり、env.ts 以外での直参照の禁止
  //   （Biome の noProcessEnv と rule-tests/architecture.test.ts の env-direct-access）に当たる。
  const child = spawn(
    "env",
    [
      "TZ=UTC",
      process.execPath,
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

test("画面を開くと page_request の行が 1 つ、画面が呼ぶ /api/todos で api_request の行が 1 つ出て、プリフェッチは出ない", async ({
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
    .poll(() => loggedRequests().map(summary))
    .toEqual([
      { name: "api_request", method: "POST", path: "/api/todos" },
      { name: "page_request", method: "GET", path: "/" },
      { name: "api_request", method: "GET", path: "/api/todos" },
    ]);
  const [, pageLine, apiLine] = loggedRequests();
  expect(pageLine.http.request.header.accept).toContain("text/html");
  // WHY referer は *** : ブラウザが付けた referer（画面の URL。クエリを含みうる）は logger がマスクする（Issue #216。
  //   apps/shared/log-event.ts）。値があったこと（null でないこと）だけが行に残る。
  expect(apiLine.http.request.header.referer).toBe("***");

  // リンクを押したときのクライアント遷移（RSC の取得）は page_request の行になる。表示されたリンクのプリフェッチ
  //   （next-router-prefetch ヘッダ付き）は proxy.ts の matcher の missing で除くので、押す前に /todo/<id> の行は無い。
  // WHY 押す前の行を数え直す: プリフェッチはリンクの表示後に非同期で飛ぶので、上の poll の時点ではまだ届いていないことがある。
  //   詳細の画面を開いた後の行の一覧を丸ごと比べ、/todo/<id> の page_request の行がクライアント遷移の 1 つだけであることを確かめる。
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(`${baseURL}/todo/${todo.id}`);
  await expect(
    page.getByRole("heading", { name: title, level: 1 }),
  ).toBeVisible();
  await expect
    .poll(() => loggedRequests().slice(3).map(summary))
    .toEqual([
      { name: "page_request", method: "GET", path: `/todo/${todo.id}` },
      { name: "api_request", method: "GET", path: `/api/todos/${todo.id}` },
    ]);
});

// WHY traceparent も付ける: trace の値のプロジェクト ID は proxy.ts が env.GCP_PROJECT_ID から渡す（Issue #209）。proxy.ts は
//   カバレッジの対象外なので、その結線（env の値が行に入ること）はここで確かめる。解析の規則は request-log.test.ts が固定する。
test("x-request-id と traceparent を付けて呼ぶと、その値が行の http.request.id・trace と応答ヘッダに入り、クエリの値は *** にマスクして出す", async ({
  request,
}) => {
  const requestId = `e2e-${Date.now()}`;
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const response = await request.get(
    `${baseURL}/api/todos?token=secret-value`,
    {
      headers: {
        "x-request-id": requestId,
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      },
    },
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["x-request-id"]).toBe(requestId);

  await expect.poll(() => loggedRequests()).toHaveLength(1);
  const [line] = loggedRequests();
  expect(line).toMatchObject({
    severity: "INFO",
    message: "GET /api/todos",
    event: { name: "api_request" },
    http: { request: { id: requestId } },
    url: { path: "/api/todos", query: { token: "***" } },
    "logging.googleapis.com/trace": `projects/${env.GCP_PROJECT_ID}/traces/${traceId}`,
    "logging.googleapis.com/spanId": "00f067aa0ba902b7",
    "logging.googleapis.com/trace_sampled": true,
  });
  // logger を通っていること: 先頭が severity・time・message・event の順で、time は受信時刻の RFC 3339（UTC）のまま。
  expect(Object.keys(line).slice(0, 4)).toEqual([
    "severity",
    "time",
    "message",
    "event",
  ]);
  expect(new Date(line.time).toISOString()).toBe(line.time);
  expect(stdoutLines.join("\n")).not.toContain("secret-value");
});
