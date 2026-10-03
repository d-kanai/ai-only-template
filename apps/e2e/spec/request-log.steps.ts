import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
} from "@playwright/test";
import { env } from "@repo/shared/env";
import { Fixture, Given, Then, When } from "playwright-bdd/decorators";
import type { test } from "../support/fixtures";
import type { E2eLogServer } from "../support/log-server";

// request-log.feature（リクエストログ）の step（Issue #80 / #209 / #279。以前の request-log.spec.ts）。
// リクエストログ（apps/frontend_customer/proxy.ts）が、本番ビルドの next start の stdout に 1 リクエスト = JSON 1 行で出ることを
//   確かめる。1 行の中身の決め方は apps/frontend_customer/shared/request-log/request-log.test.ts で固定しているので、ここでは
//   proxy.ts の結線（規約の場所で呼ばれる・matcher・logger 経由で stdout への 1 行・応答ヘッダ x-request-id）だけを見る。
//   行の先頭の severity / time は logger（apps/shared/logger.ts。Issue #85・#90・#209）が付ける（形は logger.test.ts で固定）。
// サーバは webServer ではなく、stdout を読める E2eLogServer（log-server.ts）。画面もそのサーバの URL で開く。

// 画面（app/layout.tsx の FeatureFlagProvider）の OFREP の web provider が、画面を開いた直後に送るフィーチャーフラグの一括の評価
//   （Issue #156。features/feature-flag/api/feature-flag-api.ts）。/api/** なので api_request の 1 行になる。
const FLAGS_PATH = "/api/ofrep/v1/evaluate/flags";

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

@Fixture<typeof test>("requestLogSteps")
export class RequestLogSteps {
  // 呼び出し元が付ける追跡の値（x-request-id / traceparent）と、クエリに載せる秘密の値。
  private readonly traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  private readonly secretValue = "secret-value";

  // step の間で渡す値（作った Todo の id・x-request-id の値・応答）。
  private todoId = "";
  private requestId = "";
  private response: APIResponse | undefined;

  constructor(
    private readonly page: Page,
    private readonly request: APIRequestContext,
    private readonly server: E2eLogServer,
  ) {}

  // 一覧に Todo を 1 件置き、詳細へのリンク（next/link）のプリフェッチが起きる状態にする。
  @Given("ログ確認用のサーバで Todo {string} が作られている")
  async createTodo(title: string): Promise<void> {
    const created = await this.request.post(
      `${this.server.baseURL}/api/todos`,
      { data: { title } },
    );
    expect(created.status()).toBe(201);
    this.todoId = ((await created.json()) as { id: string }).id;
  }

  // WHY 一覧のリンクが出るまで待つ: 画面の hook が呼ぶ GET /api/todos のログが出そろってから Then で比べる。
  @When("ログ確認用のサーバで Todo の一覧を開く")
  async openList(): Promise<void> {
    await this.page.goto(`${this.server.baseURL}/`);
    await expect(this.page.getByRole("listitem")).toHaveCount(1);
  }

  // 作成の POST と、画面の表示（document の GET /）と、画面の hook が呼ぶ GET /api/todos と、フィーチャーフラグの POST。
  // WHY フィーチャーフラグの行を順番の比較から分ける: 一覧の取得（画面の hook の useEffect）とフィーチャーフラグの取得（root layout の
  //   FeatureFlagProvider の useEffect）は互いに待たずに送られ、サーバに届く順は決まらない。順番は残りの 3 行で比べ、
  //   フィーチャーフラグの行は 1 行だけあることを比べる。
  @Then(
    "Todo の作成・一覧のページ・一覧の取得のリクエストがこの順に 1 行ずつログに出て、フィーチャーフラグの取得も 1 行出る",
  )
  async listLogged(): Promise<void> {
    await expect
      .poll(() => {
        const summaries = this.loggedRequests().map((request) =>
          this.summary(request),
        );
        return {
          ordered: summaries.filter((summary) => summary.path !== FLAGS_PATH),
          flags: summaries.filter((summary) => summary.path === FLAGS_PATH),
        };
      })
      .toEqual({
        ordered: [
          { name: "api_request", method: "POST", path: "/api/todos" },
          { name: "page_request", method: "GET", path: "/" },
          { name: "api_request", method: "GET", path: "/api/todos" },
        ],
        flags: [{ name: "api_request", method: "POST", path: FLAGS_PATH }],
      });
  }

  // WHY referer は *** : ブラウザが付けた referer（画面の URL。クエリを含みうる）は logger がマスクする（Issue #216。
  //   apps/shared/log-event.ts）。値があったこと（null でないこと）だけが行に残る。
  @Then(
    "ページのログには Accept ヘッダが、一覧の取得のログにはマスクした Referer ヘッダが残る",
  )
  async headersLogged(): Promise<void> {
    // WHY フィーチャーフラグの行を除いてから取り出す: フィーチャーフラグの行がどこに入るかは決まらない（上の listLogged）。
    const [, pageLine, apiLine] = this.loggedRequests().filter(
      (request) => request.url.path !== FLAGS_PATH,
    );
    expect(pageLine?.http.request.header.accept).toContain("text/html");
    expect(apiLine?.http.request.header.referer).toBe("***");
  }

  // リンクを押したときのクライアント遷移（RSC の取得）は page_request の行になる。表示されたリンクのプリフェッチ
  //   （next-router-prefetch ヘッダ付き）は proxy.ts の matcher の missing で除くので、/todo/<id> の行はクライアント遷移の 1 つだけ。
  // WHY 一覧の 4 行（作成・画面の表示・一覧の取得・フィーチャーフラグの取得）より後を丸ごと比べる: プリフェッチはリンクの表示後に
  //   非同期で飛ぶので、一覧の Then の時点ではまだ届いていないことがある。詳細の画面を開いた後の行の一覧を丸ごと比べ、
  //   プリフェッチの行が無いことを確かめる。4 行は一覧の Then（listLogged）が出そろうまで待ってから詳細を開くので、詳細の行より前に並ぶ。
  //   クライアント遷移では root layout が描き直されないので、フィーチャーフラグを取り直す行も出ない（出たらこの比較で落ちる）。
  @Then("詳細のページと詳細の取得だけがログに出て、プリフェッチは出ない")
  async detailLogged(): Promise<void> {
    await expect(this.page).toHaveURL(
      `${this.server.baseURL}/todo/${this.todoId}`,
    );
    await expect
      .poll(() =>
        this.loggedRequests()
          .slice(4)
          .map((request) => this.summary(request)),
      )
      .toEqual([
        { name: "page_request", method: "GET", path: `/todo/${this.todoId}` },
        {
          name: "api_request",
          method: "GET",
          path: `/api/todos/${this.todoId}`,
        },
      ]);
  }

  // WHY traceparent も付ける: trace の値のプロジェクト ID は proxy.ts が env.GCP_PROJECT_ID から渡す（Issue #209）。proxy.ts は
  //   カバレッジの対象外なので、その結線（env の値が行に入ること）はここで確かめる。解析の規則は request-log.test.ts が固定する。
  @When(
    "ログ確認用のサーバから、トレース用のヘッダと秘密のクエリパラメータを付けて Todo の一覧を取得する",
  )
  async getWithTrace(): Promise<void> {
    this.requestId = `e2e-${Date.now()}`;
    this.response = await this.request.get(
      `${this.server.baseURL}/api/todos?token=${this.secretValue}`,
      {
        headers: {
          "x-request-id": this.requestId,
          traceparent: `00-${this.traceId}-00f067aa0ba902b7-01`,
        },
      },
    );
  }

  @Then("一覧を取得でき、レスポンスのヘッダに同じトレースの値が返る")
  async tracedResponse(): Promise<void> {
    expect(this.response?.status()).toBe(200);
    expect(this.response?.headers()["x-request-id"]).toBe(this.requestId);
  }

  // logger を通っていること: 先頭が severity・time・message・event の順で、time は受信時刻の RFC 3339（UTC）のまま。
  @Then(
    "取得が 1 行でログに出て、トレースの値が入り、秘密のクエリパラメータはマスクされている",
  )
  async tracedLogged(): Promise<void> {
    await expect.poll(() => this.loggedRequests()).toHaveLength(1);
    const [line] = this.loggedRequests();
    expect(line).toMatchObject({
      severity: "INFO",
      message: "GET /api/todos",
      event: { name: "api_request" },
      http: { request: { id: this.requestId } },
      url: { path: "/api/todos", query: { token: "***" } },
      "logging.googleapis.com/trace": `projects/${env.GCP_PROJECT_ID}/traces/${this.traceId}`,
      "logging.googleapis.com/spanId": "00f067aa0ba902b7",
      "logging.googleapis.com/trace_sampled": true,
    });
    expect(Object.keys(line ?? {}).slice(0, 4)).toEqual([
      "severity",
      "time",
      "message",
      "event",
    ]);
    expect(new Date(line?.time ?? "").toISOString()).toBe(line?.time);
    expect(this.server.lines.join("\n")).not.toContain(this.secretValue);
  }

  // stdout のうちリクエストログの行だけを取り出す。JSON でない行（Next の起動メッセージ）と、リクエストログ以外の JSON の行
  //   （Repository の書き込みのログ。event.name が db_write。apps/backend/shared/drizzle/writer.ts。Issue #205・#215）は除く。
  // WHY event.name で見分ける: logger（apps/shared/logger.ts）を通るログはどれも JSON 1 行で stdout に出るので、「JSON の行」では
  //   リクエストログに絞れない。page_request / api_request はリクエストログ（request-log.ts）だけが出す種類（apps/shared/log-event.ts）。
  private loggedRequests(): LoggedRequest[] {
    return this.server.lines.flatMap((line) => {
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
  private summary({ event, http, url }: LoggedRequest) {
    return { name: event.name, method: http.request.method, path: url.path };
  }
}
