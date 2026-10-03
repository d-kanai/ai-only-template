import {
  type APIRequestContext,
  type APIResponse,
  expect,
} from "@playwright/test";
import { Fixture, Then, When } from "playwright-bdd/decorators";
import type { test } from "../support/fixtures";

// api-error.feature（入力エラー）の step（Issue #126 / #144 / #279。以前の api-error.spec.ts）。
// API のエラー応答が、本番ビルド（next start）を通っても RFC 9457 の Problem Details（application/problem+json）で返ることを確かめる。
//   本文の形は apps/backend の problem.test.ts と各 api のテストで固定しているので、ここでは Route Handler（app/api/**/route.ts の
//   re-export）から Next の応答までの結線だけを見る: Next が Content-Type を書き換えないこと、本文の type・status・key・errors の
//   pointer が届くこと。状態コード・本文の形は技術の検証なので、.feature には書かずここに閉じる（API ジャーニーと同じ）。
// WHY 画面ではなく request（Playwright の APIRequestContext）で呼ぶ: 画面は形の誤りの本文（未知の項目）を送らないので、
//   400 の errors を画面の操作では起こせない。
@Fixture<typeof test>("apiErrorSteps")
export class ApiErrorSteps {
  // When の応答。Then がこれを確かめる。
  private response: APIResponse | undefined;

  constructor(private readonly request: APIRequestContext) {}

  @When("タイトルを数値にして Todo を作ろうとする")
  async postNumberTitle(): Promise<void> {
    this.response = await this.request.post("/api/todos", {
      data: { title: 1 },
    });
  }

  @Then("タイトルの項目に、文字列でないというエラーが返る")
  async rejectedAsNotString(): Promise<void> {
    const response = this.lastResponse();
    expect(response.status()).toBe(400);
    expect(response.headers()["content-type"]).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({
      type: "/problems/validation-error",
      status: 400,
      instance: "/api/todos",
      key: "request.field.notString",
      errors: [{ pointer: "#/title", key: "request.field.notString" }],
    });
  }

  // Issue #144: presentation のリクエストのスキーマが、domain と同じ規則（必須・長さ）を同じキーで重ね、項目ごとの errors に載せる。
  @When("タイトルを空白だけにして Todo を作ろうとする")
  async postBlankTitle(): Promise<void> {
    this.response = await this.request.post("/api/todos", {
      data: { title: " " },
    });
  }

  @Then("タイトルの項目に、空だというエラーが返る")
  async rejectedAsEmpty(): Promise<void> {
    const response = this.lastResponse();
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "/problems/validation-error",
      key: "todo.title.empty",
      errors: [{ pointer: "#/title", key: "todo.title.empty" }],
    });
  }

  @When("タイトルを {int} 文字にして Todo を作ろうとする")
  async postLongTitle(length: number): Promise<void> {
    this.response = await this.request.post("/api/todos", {
      data: { title: "a".repeat(length) },
    });
  }

  // 上限は params に載る（画面が「100 文字まで」のように出すため）。
  @Then("タイトルの項目に、長すぎるというエラーが上限の {int} 文字とともに返る")
  async rejectedAsTooLong(max: number): Promise<void> {
    const response = this.lastResponse();
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({
      key: "todo.title.tooLong",
      params: { max },
      errors: [
        { pointer: "#/title", key: "todo.title.tooLong", params: { max } },
      ],
    });
  }

  // WHY When を通らずに Then だけが動いたら失敗にする: .feature の並びを変えて When が抜けたときに、前の値で通らないようにする。
  private lastResponse(): APIResponse {
    expect(this.response).toBeDefined();
    return this.response as APIResponse;
  }
}
