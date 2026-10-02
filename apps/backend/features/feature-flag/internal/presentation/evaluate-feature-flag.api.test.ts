// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { EvaluateFeatureFlagQuery } from "../application/evaluate-feature-flag.query";
import type { EvaluationContext } from "../domain/feature-flags";
import {
  EvaluateFeatureFlagApi,
  type EvaluateFeatureFlagResponse,
  POST as productionPost,
} from "./evaluate-feature-flag.api";

// POST /api/ofrep/v1/evaluate/flags/{key}（OFREP の 1 件の評価。https://github.com/open-feature/protocol の service/openapi.yaml、
//   info.version 0.4.0 の evaluateFlag）。応答の本文は openapi.yaml の形（200 は serverEvaluationSuccess、400 は evaluationFailure、
//   404 は flagNotFound、500 は generalErrorResponse）を toStrictEqual で丸ごと固定する（Issue #156 のコメント「OpenAPI の形との一致は
//   api のテストで固定する」）。

// テストごとに自分の一覧で組み立てる（本番の POST は domain の FEATURE_FLAGS を使い、その中身に依存させないため）。
function setup(flags: Record<string, boolean>) {
  return new EvaluateFeatureFlagApi(new EvaluateFeatureFlagQuery(flags)).handle;
}

function postRequest(key: string, body: string | undefined): Request {
  return new Request(`http://localhost/api/ofrep/v1/evaluate/flags/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// Next 16 では Route Handler の第 2 引数の params が Promise で渡される。本番と同じ形で渡す。
function context(key: string) {
  return { params: Promise.resolve({ key }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/ofrep/v1/evaluate/flags/{key}", () => {
  test.each([
    ["on", true],
    ["off", false],
  ])(
    "一覧にある %s のフラグなら、200 と { key, value, reason: STATIC } を JSON で返す",
    async (_label, value) => {
      // given
      const POST = setup({ "flag-a": value });

      // when
      const response = await POST(
        postRequest("flag-a", JSON.stringify({ context: {} })),
        context("flag-a"),
      );

      // then
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      const body = (await response.json()) as EvaluateFeatureFlagResponse;
      expect(body).toStrictEqual({ key: "flag-a", value, reason: "STATIC" });
    },
  );

  // WHY 渡った context を記録して確かめる: 今の評価は context で値を変えないので、応答だけでは「受け取って渡している」ことが
  //   分からない。将来の属性ごとの出し分け（evaluate(key, context)）のために、要求の context をそのまま query に渡すことを固定する。
  test.each<[string, string, EvaluationContext]>([
    [
      "targetingKey と属性",
      JSON.stringify({
        context: { targetingKey: "user-123", plan: "premium" },
      }),
      { targetingKey: "user-123", plan: "premium" },
    ],
    // @openfeature/ofrep-core 2.3.0 は context が無いと本文 {} を送る（2026-10-02 に npm の tarball で確認）。
    ["context の無い本文 {}", "{}", {}],
  ])("本文の context（%s）を query に渡す", async (_label, body, expected) => {
    // given
    const received: [string, EvaluationContext][] = [];
    const POST = new EvaluateFeatureFlagApi({
      execute: async (key, ctx) => {
        received.push([key, ctx]);
        return { key, value: true };
      },
    }).handle;

    // when
    const response = await POST(postRequest("flag-a", body), context("flag-a"));

    // then
    expect(response.status).toBe(200);
    expect(received).toStrictEqual([["flag-a", expected]]);
  });

  test("一覧に無い key なら、404 と { key, errorCode: FLAG_NOT_FOUND, errorDetails } を返す", async () => {
    // given
    const POST = setup({ "flag-a": true });

    // when
    const response = await POST(
      postRequest("missing", JSON.stringify({ context: {} })),
      context("missing"),
    );

    // then
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toStrictEqual({
      key: "missing",
      errorCode: "FLAG_NOT_FOUND",
      errorDetails: "Feature flag missing was not found.",
    });
  });

  test("本文が JSON として読めなければ、400 と { key, errorCode: PARSE_ERROR, errorDetails } を返す", async () => {
    // given
    const POST = setup({ "flag-a": true });

    // when
    const response = await POST(postRequest("flag-a", "{"), context("flag-a"));

    // then
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      key: "flag-a",
      errorCode: "PARSE_ERROR",
      errorDetails: "Request body must be valid JSON.",
    });
  });

  test("context がオブジェクトでなければ、400 と { key, errorCode: INVALID_CONTEXT, errorDetails } を返す", async () => {
    // given
    const POST = setup({ "flag-a": true });

    // when
    const response = await POST(
      postRequest("flag-a", JSON.stringify({ context: "user-123" })),
      context("flag-a"),
    );

    // then
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      key: "flag-a",
      errorCode: "INVALID_CONTEXT",
      errorDetails: expect.stringMatching(
        /^Invalid evaluation context at context: .+\.$/,
      ),
    });
  });

  test("targetingKey が文字列でなければ、400 の INVALID_CONTEXT を返す", async () => {
    // given
    const POST = setup({ "flag-a": true });

    // when
    const response = await POST(
      postRequest("flag-a", JSON.stringify({ context: { targetingKey: 1 } })),
      context("flag-a"),
    );

    // then
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      key: "flag-a",
      errorCode: "INVALID_CONTEXT",
    });
  });

  test("query が想定外の例外で reject すれば、500 と { errorCode: GENERAL, errorDetails } を返す", async () => {
    // given
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const POST = new EvaluateFeatureFlagApi({
      execute: async () => {
        throw new Error("boom");
      },
    }).handle;

    // when
    const response = await POST(
      postRequest("flag-a", JSON.stringify({ context: {} })),
      context("flag-a"),
    );

    // then
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      errorCode: "GENERAL",
      errorDetails: "Internal server error.",
    });
  });

  // WHY 本番の POST（モジュールの最下部で組み立てたもの）を確かめる: 本番の一覧（domain の FEATURE_FLAGS）で組み立てていることを、
  //   本番の一覧にある key と無い key で固定する。DB を使わないので差し替えは要らない。
  test("本番の POST は domain の一覧（FEATURE_FLAGS）で評価する", async () => {
    // given: 本番の一覧（todo-detail-screen が on）
    // when
    const found = await productionPost(
      postRequest("todo-detail-screen", "{}"),
      context("todo-detail-screen"),
    );
    const missing = await productionPost(
      postRequest("missing", "{}"),
      context("missing"),
    );

    // then
    await expect(found.json()).resolves.toStrictEqual({
      key: "todo-detail-screen",
      value: true,
      reason: "STATIC",
    });
    expect(missing.status).toBe(404);
  });
});
