import {
  type APIRequestContext,
  expect,
  type Page,
  type Response,
} from "@playwright/test";
import { Fixture, Given, Then, When } from "playwright-bdd/decorators";
import type { test } from "../support/fixtures";

// feature-flag.feature（フィーチャーフラグ）の step（Issue #156）。
// 画面（app/layout.tsx の FeatureFlagProvider）の OFREP の web provider が、本番ビルドの backend の OFREP の API
//   （app/api/ofrep/v1/evaluate/flags）から評価を受け取り、その値で一覧の詳細へのリンクを出すことを確かめる。
// WHY 画面が受け取った応答そのものを見る（API を別に呼んで比べない）: 確かめたいのは「画面の provider が backend と会話した」こと。
//   テストが自分で API を呼んでも、画面が呼んだことにはならない。

// 画面の provider が一括の評価を送る先（@openfeature/ofrep-core 2.3.0 の OFREPApi.postBulkEvaluateFlags が baseUrl の後ろに付けるパス。
//   baseUrl は features/feature-flag/api/feature-flag-api.ts の "/api"）。
const BULK_EVALUATION_PATH = "/api/ofrep/v1/evaluate/flags";

@Fixture<typeof test>("featureFlagSteps")
export class FeatureFlagSteps {
  // step の間で渡す値（作った Todo の id・画面が受け取った一括の評価の応答）。
  private todoId = "";
  private evaluation: Response | undefined;

  constructor(
    private readonly page: Page,
    private readonly request: APIRequestContext,
  ) {}

  // WHY 画面を通さずに作る: 確かめたいのは一覧の表示で、作る操作は todo.feature が見ている。
  @Given("Todo {string} が作られている")
  async createTodo(title: string): Promise<void> {
    const created = await this.request.post("/api/todos", { data: { title } });
    expect(created.status()).toBe(201);
    this.todoId = ((await created.json()) as { id: string }).id;
  }

  // WHY 開く前に待ち受ける: provider は画面を開いた直後（FeatureFlagProvider の useEffect）に 1 回だけ一括の評価を送る。
  //   開いた後に待ち始めると、応答がもう届いていて見逃す。
  @When("フィーチャーフラグを受け取りながら Todo の一覧を開く")
  async openListReceivingFlags(): Promise<void> {
    const evaluation = this.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === BULK_EVALUATION_PATH &&
        response.request().method() === "POST",
    );
    await this.page.goto("/");
    this.evaluation = await evaluation;
  }

  // WHY 一覧の全体ではなく todo-detail-screen の 1 件を見る（toContainEqual）: フラグが増えてもこのシナリオを直さずに済む。
  //   一覧の全体の形は API 仕様（apps/backend/spec/api/feature-flag/）が固定している。
  @Then("詳細画面は使えるとサーバから受け取る")
  async receivedDetailScreenEnabled(): Promise<void> {
    expect(this.evaluation?.status()).toBe(200);
    const body = (await this.evaluation?.json()) as {
      flags: { key: string; value: boolean; reason: string }[];
    };
    expect(body.flags).toContainEqual({
      key: "todo-detail-screen",
      value: true,
      reason: "STATIC",
    });
  }

  // WHY href まで見る: 出し分けが off のときは title を文字だけで出す（リンクにしない）。on の値が画面に届いたことを、
  //   その Todo の詳細の URL へのリンクで確かめる。provider の準備ができるまでは off で描くので、toBeVisible の自動リトライで待つ。
  @Then("一覧の {string} は詳細へのリンクになる")
  async linkedToDetail(title: string): Promise<void> {
    const link = this.page.getByRole("link", { name: title });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute(
      "href",
      `/todo/${encodeURIComponent(this.todoId)}`,
    );
  }
}
