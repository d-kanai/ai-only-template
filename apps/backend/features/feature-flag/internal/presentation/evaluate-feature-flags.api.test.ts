// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EvaluateFeatureFlagsQuery } from "../application/evaluate-feature-flags.query";
import type { EvaluationContext } from "../domain/feature-flags";
import {
  EvaluateFeatureFlagsApi,
  type EvaluateFeatureFlagsResponse,
  POST as productionPost,
} from "./evaluate-feature-flags.api";

// POST /api/ofrep/v1/evaluate/flags（OFREP の一括評価。https://github.com/open-feature/protocol の service/openapi.yaml、
//   info.version 0.4.0 の evaluateFlagsBulk）。応答の本文は openapi.yaml の形（200 は bulkEvaluationSuccess と ETag、304 は本文なし、
//   400 は bulkEvaluationFailure、500 は generalErrorResponse）を toStrictEqual で丸ごと固定する（Issue #156 のコメント）。

function setup(flags: Record<string, boolean>) {
  return new EvaluateFeatureFlagsApi(new EvaluateFeatureFlagsQuery(flags))
    .handle;
}

function postRequest(
  body: string | undefined,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/ofrep/v1/evaluate/flags", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

// 応答の本文の SHA-256 を 16 進にして二重引用符で囲んだもの（実装と同じ作り方）。
// WHY テストでも作り方を書く: ETag の値が「本文の内容のハッシュ」であることを固定する（定数の文字列にすると、何から作った値か読めない）。
function entityTagOf(body: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/ofrep/v1/evaluate/flags", () => {
  test("200 と { flags: [{ key, value, reason: STATIC }] }（一覧の順）を JSON で返し、本文のハッシュを ETag に付ける", async () => {
    // given
    const POST = setup({ b: false, a: true });

    // when
    const response = await POST(postRequest(JSON.stringify({ context: {} })));

    // then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as EvaluateFeatureFlagsResponse;
    expect(body).toStrictEqual({
      flags: [
        { key: "b", value: false, reason: "STATIC" },
        { key: "a", value: true, reason: "STATIC" },
      ],
    });
    expect(response.headers.get("etag")).toBe(entityTagOf(body));
  });

  test("ETag は一覧の内容で決まる（同じ一覧なら同じ値、値が 1 つ違えば違う値）", async () => {
    // given
    const body = JSON.stringify({ context: {} });

    // when
    const first = await setup({ a: true })(postRequest(body));
    const same = await setup({ a: true })(postRequest(body));
    const changed = await setup({ a: false })(postRequest(body));

    // then
    expect(first.headers.get("etag")).toBe(same.headers.get("etag"));
    expect(first.headers.get("etag")).not.toBe(changed.headers.get("etag"));
  });

  // WHY 渡った context を記録して確かめる: evaluate-feature-flag.api.test.ts の同じテストと同じ。
  test.each<[string, string, EvaluationContext]>([
    [
      "targetingKey と属性",
      JSON.stringify({
        context: { targetingKey: "user-123", plan: "premium" },
      }),
      { targetingKey: "user-123", plan: "premium" },
    ],
    ["context の無い本文 {}", "{}", {}],
  ])("本文の context（%s）を query に渡す", async (_label, body, expected) => {
    // given
    const received: EvaluationContext[] = [];
    const POST = new EvaluateFeatureFlagsApi({
      execute: async (ctx) => {
        received.push(ctx);
        return [];
      },
    }).handle;

    // when
    const response = await POST(postRequest(body));

    // then
    expect(response.status).toBe(200);
    expect(received).toStrictEqual([expected]);
  });

  // If-None-Match は RFC 9110 の 13.1.2 で弱い比較（W/ の有無を問わず不透明な部分が同じなら一致）、値はカンマ区切りの一覧か *。
  // provider（@openfeature/ofrep-core 2.3.0）は前回の応答の ETag の値をそのまま If-None-Match に入れる（2026-10-02 に npm の
  //   tarball の buildHeaders で確認）。
  test.each([
    ["前回の ETag と同じ", (etag: string) => etag],
    ["一覧の中に前回の ETag がある", (etag: string) => `"other", ${etag}`],
    ["弱い ETag（W/）で同じ", (etag: string) => `W/${etag}`],
    ["*", (_etag: string) => "*"],
  ])(
    "If-None-Match が %s なら、304 と本文なしを返す（ETag は付ける）",
    async (_label, ifNoneMatch) => {
      // given
      const POST = setup({ a: true });
      const body = JSON.stringify({ context: {} });
      const etag = (await POST(postRequest(body))).headers.get(
        "etag",
      ) as string;

      // when
      const response = await POST(
        postRequest(body, { "if-none-match": ifNoneMatch(etag) }),
      );

      // then
      expect(response.status).toBe(304);
      await expect(response.text()).resolves.toBe("");
      expect(response.headers.get("etag")).toBe(etag);
    },
  );

  test.each([
    ["違う ETag", '"other"'],
    ["引用符の無い同じハッシュ", "HASH"],
    ["空", ""],
  ])(
    "If-None-Match が %s なら、200 と本文を返す",
    async (_label, ifNoneMatch) => {
      // given
      const POST = setup({ a: true });
      const body = JSON.stringify({ context: {} });
      const etag = (await POST(postRequest(body))).headers.get(
        "etag",
      ) as string;
      const header = ifNoneMatch.replace("HASH", etag.slice(1, -1));

      // when
      const response = await POST(
        postRequest(body, { "if-none-match": header }),
      );

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        flags: [{ key: "a", value: true, reason: "STATIC" }],
      });
    },
  );

  test("本文が JSON として読めなければ、400 と { errorCode: PARSE_ERROR, errorDetails }（key なし）を返す", async () => {
    // given
    const POST = setup({ a: true });

    // when
    const response = await POST(postRequest("{"));

    // then
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toStrictEqual({
      errorCode: "PARSE_ERROR",
      errorDetails: "Request body must be valid JSON.",
    });
  });

  test("context がオブジェクトでなければ、400 と { errorCode: INVALID_CONTEXT, errorDetails }（key なし）を返す", async () => {
    // given
    const POST = setup({ a: true });

    // when
    const response = await POST(postRequest(JSON.stringify({ context: [] })));

    // then
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      errorCode: "INVALID_CONTEXT",
      errorDetails: expect.stringMatching(
        /^Invalid evaluation context at context: .+\.$/,
      ),
    });
  });

  test("query が想定外の例外で reject すれば、500 と { errorCode: GENERAL, errorDetails } を返す", async () => {
    // given
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const POST = new EvaluateFeatureFlagsApi({
      execute: async () => {
        throw new Error("boom");
      },
    }).handle;

    // when
    const response = await POST(postRequest(JSON.stringify({ context: {} })));

    // then
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      errorCode: "GENERAL",
      errorDetails: "Internal server error.",
    });
  });

  // WHY 本番の POST を確かめる: evaluate-feature-flag.api.test.ts の同じテストと同じ（本番の一覧で組み立てていることの固定）。
  test("本番の POST は domain の一覧（FEATURE_FLAGS）を評価する", async () => {
    // given: 本番の一覧（todo-detail-screen が on）
    // when
    const response = await productionPost(postRequest("{}"));

    // then
    await expect(response.json()).resolves.toStrictEqual({
      flags: [{ key: "todo-detail-screen", value: true, reason: "STATIC" }],
    });
  });
});
