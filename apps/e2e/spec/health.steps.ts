import {
  type APIRequestContext,
  type APIResponse,
  expect,
} from "@playwright/test";
import { Fixture, Then, When } from "playwright-bdd/decorators";
import type { test } from "../support/fixtures";

// health.feature（サービスの稼働の確認）の step（Issue #107）。
// GET /api/health が、本番ビルド（next start）を通っても 200 と { status: "ok", checks: { database: "ok" } } を返すことを確かめる。
//   本文の形と 503 の経路は apps/backend の get-health.api.test.ts と API 仕様で固定しているので、ここでは Route Handler（app/api/health/route.ts
//   の re-export）から Next の応答までの結線と、Next が応答のヘッダ（cache-control）を書き換えないことだけを見る。状態コード・本文は
//   技術の検証なので、.feature には書かずここに閉じる（api-error.steps.ts と同じ）。
// WHY 画面ではなく request（Playwright の APIRequestContext）で呼ぶ: ヘルスチェックを呼ぶのは画面ではなく外からの監視。
@Fixture<typeof test>("healthSteps")
export class HealthSteps {
  // When の応答。Then がこれを確かめる。
  private response: APIResponse | undefined;

  constructor(private readonly request: APIRequestContext) {}

  @When("サービスが使えるかを確かめる")
  async getHealth(): Promise<void> {
    this.response = await this.request.get("/api/health");
  }

  // WHY cache-control も見る: Next のビルドが Route Handler を静的に prerender すると、ビルド時の結果が固定され、Next が自分の
  //   cache-control（s-maxage など）を付ける。no-store のまま届くことで、毎回実行されていることも確かめる。
  @Then("サービスは使えると返り、確かめた結果は途中に残さないよう伝えられる")
  async available(): Promise<void> {
    const response = this.lastResponse();
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toStrictEqual({
      status: "ok",
      checks: { database: "ok" },
    });
  }

  // WHY When を通らずに Then だけが動いたら失敗にする: api-error.steps.ts の lastResponse と同じ。
  private lastResponse(): APIResponse {
    expect(this.response).toBeDefined();
    return this.response as APIResponse;
  }
}
