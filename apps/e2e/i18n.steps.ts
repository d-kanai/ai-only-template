import { expect, type Page } from "@playwright/test";
import { Fixture, Given, Then, When } from "playwright-bdd/decorators";
import type { test } from "./fixtures";

// i18n.feature（画面の言語）の step（Issue #116 / #279。以前の i18n.spec.ts）。決め方（Cookie → Accept-Language → 既定の ja）は
//   apps/frontend_customer/shared/i18n/locale.test.ts で固定しているので、ここでは結線（proxy.ts が x-locale を載せる →
//   app/layout.tsx が <html lang> と LocaleProvider に渡す → 画面が t で出す）だけを見る。
// WHY <html lang> で見る: layout が x-locale から決めてサーバの HTML に書く値で、Proxy が決めたロケールがそのまま出る。
// WHY ブラウザの言語を step で変えず、シナリオのタグ @ブラウザの言語が英語 で変える（以前は test.use({ locale: "en-US" })）:
//   ブラウザの context は step より前に作られるので、step からは Playwright の locale を変えられない（fixtures.ts の locale）。
//   Given「ブラウザの言語が◯◯である」は前提を確かめる step にし、タグの付け忘れ・既定の locale の変更をそこで止める。
@Fixture<typeof test>("i18nSteps")
export class I18nSteps {
  constructor(
    private readonly page: Page,
    private readonly baseURL: string,
  ) {}

  // 日本語は playwright.config.ts の既定（locale: "ja-JP"）、英語はシナリオのタグ（fixtures.ts の locale）で決まる。
  // WHY ページを開く前に navigator.language を読める: about:blank でも context の locale が効く。
  @Given("ブラウザの言語が日本語である")
  async japaneseBrowser(): Promise<void> {
    expect(await this.browserLanguage()).toBe("ja-JP");
  }

  @Given("ブラウザの言語が英語である")
  async englishBrowser(): Promise<void> {
    expect(await this.browserLanguage()).toBe("en-US");
  }

  // x-locale は Proxy が layout に渡すためのリクエストヘッダ（shared/i18n/locale.ts の LOCALE_HEADER）。クライアントが同名のヘッダを
  //   送っても、Proxy が Cookie と Accept-Language から決めた値で上書きする（proxy.ts の withLocale）。上書きしないと、ヘッダ 1 つで
  //   Accept-Language と Cookie の決め方を迂回できる。ヘッダはページのナビゲーションを含むすべてのリクエストに付く。
  @Given("画面の言語の受け渡しを英語に偽って送る")
  async spoofLocaleHeader(): Promise<void> {
    await this.page.context().setExtraHTTPHeaders({ "x-locale": "en" });
  }

  // Cookie NEXT_LOCALE（shared/i18n/locale.ts の LOCALE_COOKIE）は Accept-Language より優先する（利用者が選んだ言語）。
  @Given("利用者が英語を選んである")
  async chooseEnglish(): Promise<void> {
    await this.page
      .context()
      .addCookies([{ name: "NEXT_LOCALE", value: "en", url: this.baseURL }]);
  }

  @Then("画面が日本語で表示される")
  async japanese(): Promise<void> {
    await expect(this.page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(this.page.getByRole("button", { name: "追加" })).toBeVisible();
  }

  @Then("画面が英語で表示される")
  async english(): Promise<void> {
    await expect(this.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      this.page.getByRole("heading", { name: "Todo", level: 1 }),
    ).toBeVisible();
    await expect(this.page.getByRole("button", { name: "Add" })).toBeVisible();
    await expect(this.page.getByText("Loading…")).toHaveCount(0);
  }

  @When("英語の画面で Todo {string} を追加する")
  async addInEnglish(title: string): Promise<void> {
    await this.page.getByLabel("New todo").fill(title);
    await this.page.getByRole("button", { name: "Add" }).click();
  }

  @Then("一覧に {string} が英語の完了の操作とともに表示される")
  async addedInEnglish(title: string): Promise<void> {
    await expect(
      this.page.getByRole("checkbox", { name: `Mark “${title}” as completed` }),
    ).toBeVisible();
  }

  // 作成日時は、ブラウザのタイムゾーン（playwright.config.ts の timezoneId: "Asia/Tokyo"。サーバは UTC）で出る。
  // WHY datetime 属性から期待値を作る: 作成した時刻は実行のたびに変わるので、表示の元の値（API の createdAt）を読んで
  //   同じ書式・タイムゾーンで組み立てた文字列と比べる。サーバのタイムゾーン（UTC）で出していれば 9 時間ずれて一致しない。
  @Then("{string} の作成日時がブラウザの地域の時刻で表示される")
  async createdAtInBrowserTimeZone(title: string): Promise<void> {
    const time = this.page
      .getByRole("listitem")
      .filter({ hasText: title })
      .locator("time");
    const createdAt = await time.getAttribute("datetime");
    expect(createdAt).not.toBeNull();
    await expect(time).toHaveText(
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Tokyo",
      }).format(new Date(createdAt ?? "")),
    );
  }

  // クライアント遷移（リンクを押す）でも英語のまま（root layout の LocaleProvider が残る）。
  @Then("詳細の画面も英語で表示される")
  async detailInEnglish(): Promise<void> {
    await expect(
      this.page.getByRole("link", { name: "Back to list" }),
    ).toBeVisible();
    await expect(this.page.getByRole("button", { name: "Save" })).toBeVisible();
  }

  private browserLanguage(): Promise<string> {
    return this.page.evaluate(() => navigator.language);
  }
}
