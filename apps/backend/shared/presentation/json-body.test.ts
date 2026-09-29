// @vitest-environment node
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type ErrorIssue, InvalidRequestError } from "./http-error";
import { parseJsonBody, requestBodySchema } from "./json-body";

function postRequest(body: string): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// 各 API のリクエストの形と同じ書き方（requestBodySchema に項目ごとの型と message を渡す）の架空のスキーマ。
function testBodySchema() {
  return requestBodySchema({
    name: z.string({ error: "name は文字列で指定してください" }),
    tags: z
      .array(z.string({ error: "tags の要素は文字列で指定してください" }))
      .optional(),
  });
}

// message と issues は API の ErrorResponse として画面に出る（クライアントとの契約）ので、文言まで検証する。
// WHY rejects.toEqual(new InvalidRequestError(...)) だけにしない: toEqual は Error の name / message は比べるが、
//   独自のプロパティ（issues）まで比べるとは限らない（未確認）。クラス・message・issues を別々に確かめる。
async function expectInvalidRequest(
  promise: Promise<unknown>,
  message: string,
  issues: ErrorIssue[] | undefined,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(InvalidRequestError);
  expect((error as InvalidRequestError).message).toBe(message);
  expect((error as InvalidRequestError).issues).toEqual(issues);
}

const NOT_OBJECT_MESSAGE =
  "リクエスト本文は JSON のオブジェクトで指定してください";

describe("parseJsonBody", () => {
  test("形が合えば、スキーマで parse した値を返す", async () => {
    await expect(
      parseJsonBody(
        postRequest(JSON.stringify({ name: "牛乳", tags: ["買い物"] })),
        testBodySchema(),
      ),
    ).resolves.toEqual({ name: "牛乳", tags: ["買い物"] });
  });

  test("JSON として読めなければ、JSON でないことを伝える InvalidRequestError を投げる（issues は無い）", async () => {
    await expectInvalidRequest(
      parseJsonBody(postRequest("{name:"), testBodySchema()),
      "リクエスト本文が JSON ではありません",
      undefined,
    );
  });

  test.each([
    ["配列", "[]"],
    ["null", "null"],
    ["文字列", '"name"'],
    ["数値", "1"],
  ])(
    "JSON でもオブジェクトでない（%s）なら、オブジェクトで指定するよう伝え、issues の path は本文全体（空文字）",
    async (_label, body) => {
      await expectInvalidRequest(
        parseJsonBody(postRequest(body), testBodySchema()),
        NOT_OBJECT_MESSAGE,
        [{ path: "", message: NOT_OBJECT_MESSAGE }],
      );
    },
  );

  test("定義されていない項目があれば、その項目名を message に挙げる（未知のキーを拒否する）", async () => {
    await expectInvalidRequest(
      parseJsonBody(
        postRequest(JSON.stringify({ name: "牛乳", extra: 1, other: true })),
        testBodySchema(),
      ),
      "定義されていない項目は指定できません（extra, other）",
      [
        {
          path: "",
          message: "定義されていない項目は指定できません（extra, other）",
        },
      ],
    );
  });

  test("入れ子の項目の誤りは、path を . 区切りの文字列にする", async () => {
    await expectInvalidRequest(
      parseJsonBody(
        postRequest(JSON.stringify({ name: "牛乳", tags: ["a", 1] })),
        testBodySchema(),
      ),
      "tags の要素は文字列で指定してください",
      [{ path: "tags.1", message: "tags の要素は文字列で指定してください" }],
    );
  });

  test("誤りが複数あれば、message は最初の 1 つ、issues はすべてを順に持つ", async () => {
    await expectInvalidRequest(
      parseJsonBody(
        postRequest(JSON.stringify({ name: 1, extra: 1 })),
        testBodySchema(),
      ),
      "name は文字列で指定してください",
      [
        { path: "name", message: "name は文字列で指定してください" },
        {
          path: "",
          message: "定義されていない項目は指定できません（extra）",
        },
      ],
    );
  });
});
