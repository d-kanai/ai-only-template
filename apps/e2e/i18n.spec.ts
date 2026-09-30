import { expect, test } from "@playwright/test";
import { resetTodos } from "./database";

// 画面の言語（Issue #116）が、ブラウザの言語（Accept-Language）と Cookie NEXT_LOCALE で決まり、クライアントが送った
//   x-locale では変わらないことを本番ビルドで確かめる E2E テスト。
// 決め方（Cookie → Accept-Language → 既定の ja）は apps/frontend_customer/shared/i18n/locale.test.ts で固定しているので、ここでは結線
// （proxy.ts が x-locale を載せる → app/layout.tsx が <html lang> と LocaleProvider に渡す → 画面が t で出す）だけを見る。
// 日本語の表示は apps/e2e/todo.spec.ts（playwright.config.ts の既定の locale: "ja-JP"）で見ている。

// データは Postgres に残るので、テストごとに空にする（todo.spec.ts と同じ理由）。
test.beforeEach(async () => {
  await resetTodos();
});

// ブラウザの言語が ja-JP（playwright.config.ts の既定）のまま、Accept-Language 以外の口で言語が変わるか・変わらないかを見る。
// WHY <html lang> で見る: layout が x-locale から決めてサーバの HTML に書く値で、Proxy が決めたロケールがそのまま出る。
test.describe("ブラウザの言語が ja-JP", () => {
  test.use({ locale: "ja-JP" });

  // x-locale は Proxy が layout に渡すためのリクエストヘッダ（shared/i18n/locale.ts の LOCALE_HEADER）。クライアントが
  //   同名のヘッダを送っても、Proxy が Cookie と Accept-Language から決めた値で上書きする（proxy.ts の withLocale）。
  //   上書きしないと、ヘッダ 1 つで Accept-Language と Cookie の決め方を迂回できる。
  test.describe("クライアントが x-locale: en を送る", () => {
    // extraHTTPHeaders: このブラウザの context が送るすべてのリクエスト（ページのナビゲーションを含む）に付ける。
    test.use({ extraHTTPHeaders: { "x-locale": "en" } });

    test("Proxy が上書きして、日本語（lang=ja）で表示する", async ({
      page,
    }) => {
      await page.goto("/");

      await expect(page.locator("html")).toHaveAttribute("lang", "ja");
      await expect(page.getByRole("button", { name: "追加" })).toBeVisible();
    });
  });

  // Cookie NEXT_LOCALE（shared/i18n/locale.ts の LOCALE_COOKIE）は Accept-Language より優先する（利用者が選んだ言語）。
  test("Cookie NEXT_LOCALE=en があれば、Accept-Language が ja でも英語（lang=en）で表示する", async ({
    context,
    page,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL ?? "" },
    ]);

    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
  });
});

// locale: Playwright が navigator.language と、リクエストの Accept-Language（en-US）をこの値にする。
test.describe("ブラウザの言語が en-US", () => {
  test.use({ locale: "en-US" });

  test("Accept-Language が en のブラウザで開くと、英語で表示し、日時はブラウザのタイムゾーンで出す", async ({
    page,
  }) => {
    const title = `Buy milk ${Date.now()}`;

    await page.goto("/");

    // <html lang> はサーバの HTML で決まる（layout が x-locale から決める）。
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("heading", { name: "Todo", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    await page.getByLabel("New todo").fill(title);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(
      page.getByRole("checkbox", { name: `Mark “${title}” as completed` }),
    ).toBeVisible();

    // 作成日時は、ブラウザのタイムゾーン（playwright.config.ts の timezoneId: "Asia/Tokyo"。サーバは UTC）で出る。
    // WHY datetime 属性から期待値を作る: 作成した時刻は実行のたびに変わるので、表示の元の値（API の createdAt）を読んで
    //   同じ書式・タイムゾーンで組み立てた文字列と比べる。サーバのタイムゾーン（UTC）で出していれば 9 時間ずれて一致しない。
    const time = page.getByRole("listitem").locator("time");
    const createdAt = await time.getAttribute("datetime");
    expect(createdAt).not.toBeNull();
    await expect(time).toHaveText(
      new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Tokyo",
      }).format(new Date(createdAt ?? "")),
    );

    // クライアント遷移（リンクを押す）でも英語のまま（root layout の LocaleProvider が残る）。
    await page.getByRole("link", { name: title }).click();
    await expect(
      page.getByRole("link", { name: "Back to list" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();

    // 後片付け（todo.spec.ts と同じく、作ったデータを残さない。次のテストの beforeEach でも消える）。
    await resetTodos();
  });
});
