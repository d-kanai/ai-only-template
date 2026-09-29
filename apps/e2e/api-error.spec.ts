import { expect, test } from "@playwright/test";

// API のエラー応答が、本番ビルド（next start）を通っても RFC 9457 の Problem Details（application/problem+json）で返ることを
//   確かめる E2E テスト（Issue #126）。本文の形は apps/backend の problem.test.ts と各 api のテストで固定しているので、ここでは
//   Route Handler（app/api/**/route.ts の re-export）から Next の応答までの結線だけを見る: Next が Content-Type を
//   書き換えないこと、本文の type・status・key・errors の pointer が届くこと。
// WHY 画面ではなく request（Playwright の APIRequestContext）で呼ぶ: 画面は形の誤りの本文（未知の項目）を送らないので、
//   400 の errors を画面の操作では起こせない。
// WHY resetTodos しない: 400 は何も保存しない（create-todo.api.test.ts で固定）ので、DB の状態に依存しない。
test("形の誤った本文で POST /api/todos を呼ぶと、400 の application/problem+json で、errors の pointer が項目を指す", async ({
  request,
}) => {
  const response = await request.post("/api/todos", {
    data: { title: 1 },
  });

  expect(response.status()).toBe(400);
  expect(response.headers()["content-type"]).toBe("application/problem+json");
  const body = await response.json();
  expect(body).toMatchObject({
    type: "/problems/validation-error",
    status: 400,
    instance: "/api/todos",
    key: "request.field.notString",
    errors: [{ pointer: "#/title", key: "request.field.notString" }],
  });
});
