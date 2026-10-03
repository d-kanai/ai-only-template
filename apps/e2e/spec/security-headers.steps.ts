import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
} from "@playwright/test";
import { Fixture, Given, Then, When } from "playwright-bdd/decorators";
import { E2eDatabase } from "../support/database";
import type { test } from "../support/fixtures";

// security-headers.feature（ほかのサイトからの悪用を防ぐ）の step（Issue #106）。
// 値の正は apps/frontend_customer/shared/security/security-headers.ts（SecurityHeaders）と apps/backend/shared/http/same-origin.ts
//   の単体テスト。ここでは本番のビルドを通ったときに付いていること・効いていることだけを見る。状態コード・ヘッダの名前は技術の検証
//   なので、.feature には書かずここに閉じる（api-error.steps.ts と同じ）。
@Fixture<typeof test>("securityHeadersSteps")
export class SecurityHeadersSteps {
  // CSP で止められた読み込み（securitypolicyviolation）とコンソールの CSP の誤り。Given から数える。
  private readonly violations: string[] = [];
  // When の応答。Then がこれを確かめる。
  private response: APIResponse | undefined;

  constructor(
    private readonly page: Page,
    private readonly request: APIRequestContext,
  ) {}

  // WHY 画面を開く前に見張る: CSP が最初の読み込み（Next のスクリプト・Mantine の配色のスクリプト）を止めると、画面は描かれても
  //   hydration されず、操作が効かない。止めたことはブラウザのコンソールに出るので、開く前から拾う。
  // WHY securitypolicyviolation もページに仕込む: コンソールの文言はブラウザの版で変わりうる。イベントは CSP の仕様の決まった口。
  @Given("画面が止めた読み込みを数えておく")
  async watchViolations(): Promise<void> {
    this.page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) {
        this.violations.push(message.text());
      }
    });
    // WHY 失敗した読み込みも数える（Issue #379）: Cross-Origin-Embedder-Policy / Cross-Origin-Resource-Policy が止めた読み込みは
    //   CSP の違反ではなく、securitypolicyviolation にもコンソールの CSP の文言にも出ない（ネットワークの失敗
    //   net::ERR_BLOCKED_BY_RESPONSE になる）。
    this.page.on("requestfailed", (request) => {
      this.violations.push(`${request.failure()?.errorText} ${request.url()}`);
    });
    await this.page.exposeFunction("__recordCspViolation", (text: string) => {
      this.violations.push(text);
    });
    await this.page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        (
          window as unknown as { __recordCspViolation: (t: string) => void }
        ).__recordCspViolation(
          `${event.violatedDirective} ${event.blockedURI}`,
        );
      });
    });
  }

  // 画面（文書）・画面が読み込む JS（/_next/static）・API の 3 種類の応答のヘッダを見る。
  // WHY 開いている画面を読み直す（page.goto の応答を使わない）: 「Todo の一覧を開く」は共有の step（shared.steps.ts）で応答を
  //   返さない。同じ URL を同じブラウザの context で取り直し、ヘッダと本文の nonce を突き合わせる。
  @Then(
    "画面と、画面が読み込むファイルと、画面が使う窓口に、悪用を防ぐ守りが付いている",
  )
  async protectedResponses(): Promise<void> {
    const documentResponse = await this.page.request.get(this.page.url());
    const html = await documentResponse.text();
    const documentHeaders = documentResponse.headers();
    this.expectCommonHeaders(documentHeaders);

    // CSP: script-src に nonce があり、文書の <script> の nonce がすべてその値（Next が nonce を読んで付けた）。
    const policy = documentHeaders["content-security-policy"] ?? "";
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
    const scriptNonces = [...html.matchAll(/<script[^>]*\snonce="([^"]*)"/g)];
    expect(scriptNonces.length).toBeGreaterThan(0);
    expect(new Set(scriptNonces.map((match) => match[1]))).toEqual(
      new Set([nonce]),
    );
    // 末尾にドットを付けた URL も画面として描かれるので、同じく CSP が付く（Proxy の matcher が拡張子の付いたパスを除いていた
    //   ころは付かなかった。Issue #106 の reviewer の実測）。
    const dotted = await this.page.request.get("/todo/abc.x");
    expect(dotted.headers()["content-type"]).toContain("text/html");
    expect(dotted.headers()["content-security-policy"]).toContain("'nonce-");
    // /favicon.ico は Proxy の matcher の外なので、画面（404 の画面）として描かれると CSP が付かない。アイコンの実物
    //   （app/favicon.ico）を置き、画像として返ることを確かめる（Codex の指摘、PR #366）。
    const favicon = await this.page.request.get("/favicon.ico");
    expect(favicon.ok()).toBe(true);
    expect(favicon.headers()["content-type"]).toBe("image/x-icon");
    // 要求ごとに nonce が変わる（固定の値なら、一度見た値で差し込んだスクリプトが動く）。
    const again = await this.page.request.get(this.page.url());
    expect(again.headers()["content-security-policy"]).not.toBe(policy);

    // COOP と COEP がブラウザで効いている（両方が付いた文書だけが crossOriginIsolated になる。Issue #379）。
    //   WHY ヘッダの値に加えて見る: 値が正しくても、ブラウザが解さない書き方・付く応答の取り違えでは効かない。
    const isolated = await this.page.evaluate(() => window.crossOriginIsolated);
    expect(isolated).toBe(true);

    // JS（Proxy の matcher の外。next.config.ts の headers() だけが付ける）。
    const scriptPath = /src="(\/_next\/static\/[^"]+\.js)"/.exec(html)?.[1];
    expect(scriptPath).toBeDefined();
    const scriptResponse = await this.page.request.get(scriptPath as string);
    expect(scriptResponse.ok()).toBe(true);
    this.expectCommonHeaders(scriptResponse.headers());

    // API（CSP は付けない。共通のヘッダは付く）。
    const apiResponse = await this.page.request.get("/api/todos");
    expect(apiResponse.ok()).toBe(true);
    this.expectCommonHeaders(apiResponse.headers());
    expect(apiResponse.headers()["content-security-policy"]).toBeUndefined();
  }

  @Then("画面が止めた読み込みは 1 件も無い")
  async noViolations(): Promise<void> {
    expect(this.violations).toEqual([]);
  }

  // ブラウザが別のサイトのページから送る書き込みと同じく、Origin を別のオリジンにして送る（Host は baseURL のまま）。
  // WHY 画面ではなく request で送る: ほかのサイトのページを用意せずに、ブラウザが付ける Origin を再現する。
  @When("ほかのサイトのページから Todo {string} を作ろうとする")
  async postFromOtherSite(title: string): Promise<void> {
    this.response = await this.request.post("/api/todos", {
      data: { title },
      headers: { origin: "https://evil.example.com" },
    });
  }

  @Then("ほかのサイトからの操作は受け付けないと伝えられる")
  async rejectedAsOtherSite(): Promise<void> {
    const response = this.lastResponse();
    expect(response.status()).toBe(403);
    expect(response.headers()["content-type"]).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({
      type: "/problems/forbidden",
      status: 403,
      key: "request.origin.forbidden",
    });
  }

  @Then("{string} は保存されていない")
  async notSaved(title: string): Promise<void> {
    expect(await E2eDatabase.countTodosWithTitle(title)).toBe(0);
  }

  // すべての応答に付ける共通のヘッダ（next.config.ts の headers()。値の正は SecurityHeaders.common）と、付けないヘッダ。
  // WHY 値まで比べる: 名前だけでは、値を空や弱い値に変えても通る。
  private expectCommonHeaders(headers: Record<string, string>): void {
    expect(headers).toMatchObject({
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    expect(headers["x-powered-by"]).toBeUndefined();
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  }

  // WHY When を通らずに Then だけが動いたら失敗にする: .feature の並びを変えて When が抜けたときに、前の値で通らないようにする。
  private lastResponse(): APIResponse {
    expect(this.response).toBeDefined();
    return this.response as APIResponse;
  }
}
