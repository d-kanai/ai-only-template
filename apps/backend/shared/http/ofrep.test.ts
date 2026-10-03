// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { DomainError } from "../error/domain-error";
import { OfrepError, OfrepRequest, OfrepResponse } from "./ofrep";

// OFREP（OpenFeature Remote Evaluation Protocol。https://github.com/open-feature/protocol の service/openapi.yaml、info.version 0.4.0）の
//   要求の読み取り（OfrepRequest.parse）と、失敗の応答（OfrepResponse.wrap）のテスト。
// 本文の形は openapi.yaml の components/schemas（evaluationFailure・bulkEvaluationFailure・flagNotFound・generalErrorResponse）に合わせる。

function request(body: string | undefined): Request {
  return new Request("http://localhost/api/ofrep/v1/evaluate/flags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// api ファイルが渡すのと同じ形のスキーマ（evaluate-feature-flag(s).api.ts の requestSchema）。
function evaluationRequestSchema() {
  return z.object({
    context: z.looseObject({ targetingKey: z.string().optional() }).optional(),
  });
}

// promise が reject した値（parse が投げた OfrepError）。resolve すれば undefined（toBeInstanceOf で落ちる）。
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("OfrepRequest.parse", () => {
  test("本文を schema で読んだ値を返す（context の属性もそのまま残す）", async () => {
    // given
    const body = JSON.stringify({
      context: { targetingKey: "user-123", plan: "premium" },
    });

    // when
    const parsed = OfrepRequest.parse(
      request(body),
      evaluationRequestSchema(),
      undefined,
    );

    // then
    await expect(parsed).resolves.toStrictEqual({
      context: { targetingKey: "user-123", plan: "premium" },
    });
  });

  // WHY {} を確かめる: @openfeature/ofrep-core 2.3.0 の OFREPApi は context が無いと JSON.stringify({ context: undefined }) で
  //   {} を送る（2026-10-02 に npm の tarball の index.esm.js で確認）。
  test("context の無い本文 {} も受け付ける", async () => {
    // given: 前提なし
    // when
    const parsed = OfrepRequest.parse(
      request("{}"),
      evaluationRequestSchema(),
      undefined,
    );

    // then
    await expect(parsed).resolves.toStrictEqual({});
  });

  test.each([
    ["JSON として読めない", "{"],
    ["空", undefined],
  ])(
    "本文が %s なら、400 の PARSE_ERROR の OfrepError を投げる",
    async (_label, body) => {
      // given: 前提なし
      // when
      const error = await rejectionOf(
        OfrepRequest.parse(request(body), evaluationRequestSchema(), "flag-a"),
      );

      // then
      expect(error).toBeInstanceOf(OfrepError);
      expect(error).toMatchObject({
        status: 400,
        errorCode: "PARSE_ERROR",
        errorDetails: "Request body must be valid JSON.",
        key: "flag-a",
      });
    },
  );

  test.each([
    ["配列", "[]"],
    ["null", "null"],
    ["文字列", '"x"'],
  ])(
    "本文が %s（オブジェクトでない）なら、400 の PARSE_ERROR の OfrepError を投げる",
    async (_label, body) => {
      // given: 前提なし
      // when
      const error = await rejectionOf(
        OfrepRequest.parse(request(body), evaluationRequestSchema(), undefined),
      );

      // then
      expect(error).toBeInstanceOf(OfrepError);
      expect(error).toMatchObject({
        status: 400,
        errorCode: "PARSE_ERROR",
        errorDetails: "Request body must be a JSON object.",
        key: undefined,
      });
    },
  );

  test.each([
    ["context が配列", { context: [] }, "context"],
    ["context が null", { context: null }, "context"],
    ["context が文字列", { context: "user-123" }, "context"],
    [
      "targetingKey が数値",
      { context: { targetingKey: 1 } },
      "context.targetingKey",
    ],
  ])(
    "%s なら、400 の INVALID_CONTEXT の OfrepError を、誤りの場所と zod の説明を errorDetails に入れて投げる",
    async (_label, body, path) => {
      // given: 前提なし
      // when
      const error = await rejectionOf(
        OfrepRequest.parse(
          request(JSON.stringify(body)),
          evaluationRequestSchema(),
          "flag-a",
        ),
      );

      // then
      expect(error).toBeInstanceOf(OfrepError);
      expect(error).toMatchObject({
        status: 400,
        errorCode: "INVALID_CONTEXT",
        key: "flag-a",
      });
      expect((error as OfrepError).errorDetails).toMatch(
        new RegExp(`^Invalid evaluation context at ${path}: .+\\.$`),
      );
    },
  );
});

describe("OfrepResponse.wrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Issue #106: OFREP の評価も POST なので、ProblemResponse.wrap と同じく別のオリジンのページからの要求を handler の前に拒否する
  //   （判定は same-origin.ts）。形は OFREP の失敗の本文（errorCode・errorDetails）にそろえる。
  test("別のオリジンのページからの要求は、handler を呼ばずに 403 と GENERAL の失敗を返す", async () => {
    // given
    const called: Request[] = [];
    const handle = OfrepResponse.wrap(async (req: Request) => {
      called.push(req);
      return Response.json({ flags: [] });
    });

    // when
    const response = await handle(
      new Request("http://app.example.com/api/ofrep/v1/evaluate/flags", {
        method: "POST",
        headers: {
          host: "app.example.com",
          origin: "https://evil.example.com",
        },
      }),
    );

    // then
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      errorCode: "GENERAL",
      errorDetails: "Requests from other origins are not allowed.",
    });
    expect(called).toEqual([]);
  });

  test("handler が返した Response を、そのまま（同じオブジェクトで）返し、引数もそのまま渡す", async () => {
    // given
    const ok = Response.json({ flags: [] });
    const received: unknown[] = [];
    const handle = OfrepResponse.wrap(
      async (req: Request, ctx: { params: Promise<{ key: string }> }) => {
        received.push(req, ctx);
        return ok;
      },
    );
    const req = request("{}");
    const ctx = { params: Promise.resolve({ key: "flag-a" }) };

    // when
    const response = await handle(req, ctx);

    // then
    expect(response).toBe(ok);
    expect(received).toStrictEqual([req, ctx]);
  });

  test("key のある OfrepError は、その status と { key, errorCode, errorDetails }（evaluationFailure の形）の JSON にする", async () => {
    // given
    const handle = OfrepResponse.wrap(async (_req: Request) => {
      throw new OfrepError(400, "INVALID_CONTEXT", "bad context", "flag-a");
    });

    // when
    const response = await handle(request("{}"));

    // then
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toStrictEqual({
      key: "flag-a",
      errorCode: "INVALID_CONTEXT",
      errorDetails: "bad context",
    });
  });

  test("key の無い OfrepError は、{ errorCode, errorDetails }（bulkEvaluationFailure の形）の JSON にする", async () => {
    // given
    const handle = OfrepResponse.wrap(async (_req: Request) => {
      throw new OfrepError(400, "PARSE_ERROR", "bad body", undefined);
    });

    // when
    const response = await handle(request("{}"));

    // then
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      errorCode: "PARSE_ERROR",
      errorDetails: "bad body",
    });
  });

  test("フラグが無い DomainError（featureFlag.notFound）は、404 の { key, errorCode: FLAG_NOT_FOUND, errorDetails }（flagNotFound の形）にする", async () => {
    // given
    const handle = OfrepResponse.wrap(async (_req: Request) => {
      throw new DomainError("not_found", "featureFlag.notFound", {
        key: "missing",
      });
    });

    // when
    const response = await handle(request("{}"));

    // then
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toStrictEqual({
      key: "missing",
      errorCode: "FLAG_NOT_FOUND",
      errorDetails: "Feature flag missing was not found.",
    });
  });

  // WHY ログを確かめる: 応答では詳細を隠すので、原因はサーバのログ（server_error）にだけ残る（problem.ts の ProblemResponse.from と同じ）。
  test.each([
    ["想定外の例外", new Error("boom")],
    // フラグ以外の DomainError（今の feature-flag は投げない）も、OFREP に対応する errorCode が無いので想定外として扱う。
    [
      "フラグ以外の DomainError",
      new DomainError("not_found", "todo.notFound", { id: "a" }),
    ],
  ])(
    "%s は 500 の { errorCode: GENERAL, errorDetails } にし、logger.emit（server_error）でサーバのログに残す",
    async (_label, thrown) => {
      // given
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const handle = OfrepResponse.wrap(async (_req: Request) => {
        throw thrown;
      });

      // when
      const response = await handle(request("{}"));

      // then
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("application/json");
      await expect(response.json()).resolves.toStrictEqual({
        errorCode: "GENERAL",
        errorDetails: "Internal server error.",
      });
      expect(consoleError).toHaveBeenCalledTimes(1);
      const [line] = consoleError.mock.calls[0] as [string];
      expect(JSON.parse(line)).toMatchObject({
        severity: "ERROR",
        message: "unexpected error",
        event: { name: "server_error" },
        error: { type: thrown.name },
      });
    },
  );

  test("handler が同期で throw しても、同じく変換する", async () => {
    // given
    const handle = OfrepResponse.wrap((_req: Request): Promise<Response> => {
      throw new OfrepError(400, "PARSE_ERROR", "bad body", undefined);
    });

    // when
    const response = await handle(request("{}"));

    // then
    expect(response.status).toBe(400);
  });

  test("クライアントの誤り（OfrepError・フラグの not_found）はログに残さない", async () => {
    // given
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handles = [
      OfrepResponse.wrap(async (_req: Request) => {
        throw new OfrepError(400, "PARSE_ERROR", "bad body", undefined);
      }),
      OfrepResponse.wrap(async (_req: Request) => {
        throw new DomainError("not_found", "featureFlag.notFound", {
          key: "missing",
        });
      }),
    ];

    // when
    for (const handle of handles) {
      await handle(request("{}"));
    }

    // then
    expect(consoleError).not.toHaveBeenCalled();
  });
});
