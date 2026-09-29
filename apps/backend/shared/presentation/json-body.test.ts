// @vitest-environment node
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ErrorKey } from "../domain/error-key";
import { type ErrorIssue, InvalidRequestError } from "./http-error";
import { parseJsonBody, requestBodySchema } from "./json-body";

function postRequest(body: string): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// 各 API のリクエストの形と同じ書き方（requestBodySchema に項目ごとの型だけを渡す。error は書かない）の架空のスキーマ。
function testBodySchema() {
  return requestBodySchema({
    name: z.string(),
    tags: z.array(z.string()).optional(),
    done: z.boolean().optional(),
  });
}

// key・params・issues は API の ErrorResponse として画面に渡る（画面が翻訳するクライアントとの契約）ので、すべて検証する。
// WHY rejects.toEqual(new InvalidRequestError(...)) だけにしない: toEqual は Error の name / message は比べるが、
//   独自のプロパティ（key・params・issues）まで比べるとは限らない（未確認）。クラスと各プロパティを別々に確かめる。
async function expectInvalidRequest(
  promise: Promise<unknown>,
  expected: {
    key: ErrorKey;
    params: Record<string, string | number> | undefined;
    issues: ErrorIssue[] | undefined;
  },
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(InvalidRequestError);
  const { key, params, issues } = error as InvalidRequestError;
  expect({ key, params, issues }).toEqual(expected);
}

describe("parseJsonBody", () => {
  test("形が合えば、スキーマで parse した値を返す", async () => {
    await expect(
      parseJsonBody(
        postRequest(JSON.stringify({ name: "牛乳", tags: ["買い物"] })),
        testBodySchema(),
      ),
    ).resolves.toEqual({ name: "牛乳", tags: ["買い物"] });
  });

  test("JSON として読めなければ、request.body.notJson の InvalidRequestError を投げる（params と issues は無い）", async () => {
    await expectInvalidRequest(
      parseJsonBody(postRequest("{name:"), testBodySchema()),
      { key: "request.body.notJson", params: undefined, issues: undefined },
    );
  });

  test.each([
    ["配列", "[]"],
    ["null", "null"],
    ["文字列", '"name"'],
    ["数値", "1"],
  ])(
    "JSON でもオブジェクトでない（%s）なら request.body.notObject にし、issues の path は本文全体（空文字）",
    async (_label, body) => {
      await expectInvalidRequest(
        parseJsonBody(postRequest(body), testBodySchema()),
        {
          key: "request.body.notObject",
          params: undefined,
          issues: [{ path: "", key: "request.body.notObject" }],
        },
      );
    },
  );

  test("定義されていない項目があれば request.body.unknownKeys にし、params.keys に項目名を ', ' で連結して挙げる", async () => {
    await expectInvalidRequest(
      parseJsonBody(
        postRequest(JSON.stringify({ name: "牛乳", extra: 1, other: true })),
        testBodySchema(),
      ),
      {
        key: "request.body.unknownKeys",
        params: { keys: "extra, other" },
        issues: [
          {
            path: "",
            key: "request.body.unknownKeys",
            params: { keys: "extra, other" },
          },
        ],
      },
    );
  });

  test.each([
    ["数値", 1],
    ["無い", undefined],
    ["null", null],
  ])(
    "文字列の項目が%sなら request.field.notString にし、params.path に項目を挙げる",
    async (_label, name) => {
      await expectInvalidRequest(
        parseJsonBody(postRequest(JSON.stringify({ name })), testBodySchema()),
        {
          key: "request.field.notString",
          params: { path: "name" },
          issues: [
            {
              path: "name",
              key: "request.field.notString",
              params: { path: "name" },
            },
          ],
        },
      );
    },
  );

  test("真偽値の項目が真偽値でなければ request.field.notBoolean にし、params.path に項目を挙げる", async () => {
    await expectInvalidRequest(
      parseJsonBody(
        postRequest(JSON.stringify({ name: "牛乳", done: "true" })),
        testBodySchema(),
      ),
      {
        key: "request.field.notBoolean",
        params: { path: "done" },
        issues: [
          {
            path: "done",
            key: "request.field.notBoolean",
            params: { path: "done" },
          },
        ],
      },
    );
  });

  test("入れ子の項目の誤りは、path と params.path を . 区切りの文字列にする", async () => {
    await expectInvalidRequest(
      parseJsonBody(
        postRequest(JSON.stringify({ name: "牛乳", tags: ["a", 1] })),
        testBodySchema(),
      ),
      {
        key: "request.field.notString",
        params: { path: "tags.1" },
        issues: [
          {
            path: "tags.1",
            key: "request.field.notString",
            params: { path: "tags.1" },
          },
        ],
      },
    );
  });

  test("誤りが複数あれば、key と params は最初の 1 つ、issues はすべてを順に持つ", async () => {
    await expectInvalidRequest(
      parseJsonBody(
        postRequest(JSON.stringify({ name: 1, extra: 1 })),
        testBodySchema(),
      ),
      {
        key: "request.field.notString",
        params: { path: "name" },
        issues: [
          {
            path: "name",
            key: "request.field.notString",
            params: { path: "name" },
          },
          {
            path: "",
            key: "request.body.unknownKeys",
            params: { keys: "extra" },
          },
        ],
      },
    );
  });

  // キーの集合（error-key.ts）は画面の辞書と共有する閉じた集合。対応の無い zod の issue（今のスキーマでは起きない。
  //   数値の項目を足したときなど）を黙って別のキーにすると、画面が誤った文言を出す。開発者の誤りとして 500 にし、
  //   キーを足すよう気づかせる（json-body.ts の toErrorIssue のコメント）。
  test.each([
    [
      "数値の項目の invalid_type",
      requestBodySchema({ count: z.number() }),
      '{"code":"invalid_type","path":"count"}',
    ],
    // 本文全体（path が空）でも invalid_type でなければ request.body.notObject にしない。
    [
      "本文全体の refine（custom）",
      requestBodySchema({}).refine(() => false),
      '{"code":"custom","path":""}',
    ],
  ])(
    "キーの対応が無い zod の issue（%s）は、InvalidRequestError ではない Error を投げる（API は 500）",
    async (_label, schema, described) => {
      await expect(parseJsonBody(postRequest("{}"), schema)).rejects.toEqual(
        new Error(`no ErrorKey for zod issue: ${described}`),
      );
    },
  );
});
