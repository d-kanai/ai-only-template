import { test as base } from "playwright-bdd";
import { ApiErrorSteps } from "../spec/api-error.steps";
import { I18nSteps } from "../spec/i18n.steps";
import { RequestLogSteps } from "../spec/request-log.steps";
import { SharedSteps } from "../spec/shared.steps";
import { TodoSteps } from "../spec/todo.steps";
import { E2eLogServer } from "./log-server";

// E2E の step（*.steps.ts）のクラスを Playwright の fixture として登録する（Issue #279。.claude/rules/testing.md の「E2E」）。
// WHY step をクラスのメソッドに書く（playwright-bdd のデコレータ @Given / @When / @Then と @Fixture）: テストの補助も最上位に関数を
//   置かない（ADR docs/adr/architecture/20261002-class-based-shared-and-test-support.md。rule-tests/architecture.test.ts の
//   class-based）。createBdd の Given(...) の呼び出しで書くと step の関数が最上位の呼び出しの引数に並ぶので、クラスに寄せる。
// WHY step の間の値（作った Todo・応答）をクラスのフィールドに持つ: fixture は既定でテスト（= 1 シナリオ）ごとに作り直されるので、
//   フィールドはそのシナリオの step だけが共有する（API ジャーニーのシナリオの関数の中の変数と同じ役割）。
// WHY クラスが使う Playwright の fixture（page・request など）をコンストラクタで渡す: デコレータの step は fixture の引数を受け取らず、
//   this（そのクラスの fixture）だけで動く（playwright-bdd 9.2.1 の src/steps/decorators/steps.ts の registerDecoratorStep）。
// playwright.config.ts の defineBddConfig の steps にこのファイルを入れ、生成されるテストがこの test を import する。
// ブラウザの言語を英語にするシナリオのタグ（下の locale）。rule-tests/e2e-feature.test.ts の許すタグと同じ文字列にする。
const ENGLISH_BROWSER_TAG = "@ブラウザの言語が英語";

export const test = base.extend<
  {
    sharedSteps: SharedSteps;
    todoSteps: TodoSteps;
    i18nSteps: I18nSteps;
    apiErrorSteps: ApiErrorSteps;
    requestLogSteps: RequestLogSteps;
  },
  { logServer: E2eLogServer }
>({
  // ブラウザの言語（navigator.language と Accept-Language）。シナリオにタグ @ブラウザの言語が英語 があれば en-US、無ければ
  //   playwright.config.ts の既定（ja-JP）のまま。
  // WHY タグで変える: ブラウザの context は step より前に作られるので、step からは locale を変えられない。Accept-Language のヘッダを
  //   setExtraHTTPHeaders で上書きしても、Chromium は locale から決めた値を送り、画面は日本語のままだった（2026-10-02 に実測）。
  //   playwright-bdd ではシナリオごとの test.use も無いので、シナリオのタグ（$tags）から fixture の値を決める。
  //   シナリオの Given「ブラウザの言語が英語である」が navigator.language を確かめるので、タグを付け忘れると Given で失敗する。
  // 使ってよいタグはこれだけ（rule-tests/e2e-feature.test.ts の e2e-feature-tag。@skip など playwright-bdd の特別なタグを止める）。
  locale: async ({ $tags, locale }, use) => {
    await use($tags.includes(ENGLISH_BROWSER_TAG) ? "en-US" : locale);
  },
  sharedSteps: async ({ page }, use) => {
    await use(new SharedSteps(page));
  },
  todoSteps: async ({ page }, use) => {
    await use(new TodoSteps(page));
  },
  i18nSteps: async ({ page, baseURL }, use) => {
    await use(new I18nSteps(page, baseURL ?? ""));
  },
  apiErrorSteps: async ({ request }, use) => {
    await use(new ApiErrorSteps(request));
  },
  // WHY 記録を取るサーバを worker の fixture にする: 起動（next start）に数秒かかるので、シナリオごとではなく worker で 1 回にする
  //   （以前の request-log.spec.ts の beforeAll / afterAll と同じ）。fixture は使う step があるときだけ作られるので、アクセスの記録
  //   以外の .feature だけを実行するときは起動しない。
  logServer: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright は fixture の第 1 引数の分割代入から依存を読む。依存が無いので空にする。
    async ({}, use) => {
      const server = await E2eLogServer.start();
      await use(server);
      server.stop();
    },
    { scope: "worker" },
  ],
  // WHY ここで記録を空にする: シナリオごとに、そのシナリオの操作の記録だけを見る（以前の beforeEach と同じ）。fixture はシナリオの
  //   step より前に作られる。Background の「Todo が 1 件も無い」は画面もサーバも通さないので、記録は増えない。
  requestLogSteps: async ({ page, request, logServer }, use) => {
    logServer.clearLines();
    await use(new RequestLogSteps(page, request, logServer));
  },
});
