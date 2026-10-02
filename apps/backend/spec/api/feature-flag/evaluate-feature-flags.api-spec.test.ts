// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { EvaluateFeatureFlagsResponse } from "../../../features/feature-flag/internal/presentation/evaluate-feature-flags.api";
import {
  EvaluateFeatureFlagsApiAssembly,
  FeatureFlagSpecRequests,
} from "./support";

// API 仕様（Issue #156）: evaluate-feature-flags.feature の `*` の step を、本番と同じ組み立ての handler（EvaluateFeatureFlagsApi.handle）を
//   呼んで確かめる。WHY と前提の渡し方は evaluate-feature-flag.api-spec.test.ts の冒頭と同じ。
// 応答の形は OFREP の service/openapi.yaml（info.version 0.4.0）の evaluateFlagsBulk（200 は bulkEvaluationSuccess と ETag、304 は
//   本文なし、400 は bulkEvaluationFailure）。

const PATH = "/api/ofrep/v1/evaluate/flags";

async function evaluateAll(
  flags: Record<string, boolean>,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return EvaluateFeatureFlagsApiAssembly.handler(flags)(
    FeatureFlagSpecRequests.post(PATH, body, headers),
  );
}

const feature = await loadFeature("./evaluate-feature-flags.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    And(
      "用意したすべての機能が、使えるかどうかと一緒に、用意した順に返る",
      async () => {
        // given
        const flags = { "detail-screen": true, "new-list": false };

        // when
        const response = await evaluateAll(flags, "{}");

        // then
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
          flags: [
            { key: "detail-screen", value: true, reason: "STATIC" },
            { key: "new-list", value: false, reason: "STATIC" },
          ],
        } satisfies EvaluateFeatureFlagsResponse);
      },
    );

    // 目印 = ETag。画面（OFREP の web provider）は前回の ETag を If-None-Match に入れて確かめ直す。
    And(
      "前回と同じ目印を添えて確かめ直すと、変わっていないと伝えられる",
      async () => {
        // given
        const flags = { "detail-screen": true };
        const etag = (await evaluateAll(flags, "{}")).headers.get("etag");

        // when
        const response = await evaluateAll(flags, "{}", {
          "if-none-match": etag as string,
        });

        // then
        expect(response.status).toBe(304);
        await expect(response.text()).resolves.toBe("");
        expect(response.headers.get("etag")).toBe(etag);
      },
    );

    And(
      "前回と違う目印を添えて確かめ直すと、改めてすべての機能が返る",
      async () => {
        // given
        const flags = { "detail-screen": true };

        // when
        const response = await evaluateAll(flags, "{}", {
          "if-none-match": '"previous"',
        });

        // then
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
          flags: [{ key: "detail-screen", value: true, reason: "STATIC" }],
        } satisfies EvaluateFeatureFlagsResponse);
      },
    );

    And("用意した機能が変わると、目印も変わる", async () => {
      // given
      const before = (
        await evaluateAll({ "detail-screen": true }, "{}")
      ).headers.get("etag");

      // when
      const after = (
        await evaluateAll({ "detail-screen": false }, "{}")
      ).headers.get("etag");

      // then
      expect(before).toMatch(/^"[0-9a-f]{64}"$/);
      expect(after).toMatch(/^"[0-9a-f]{64}"$/);
      expect(after).not.toBe(before);
    });
  });

  Scenario("異常系", ({ And }) => {
    And("送った内容が読めないときは、読めないと伝えられる", async () => {
      // given
      const flags = { "detail-screen": true };

      // when
      const response = await evaluateAll(flags, "{");

      // then
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        errorCode: "PARSE_ERROR",
        errorDetails: "Request body must be valid JSON.",
      });
    });

    And(
      "利用者の情報の形が正しくないときは、正しくないと伝えられる",
      async () => {
        // given
        const flags = { "detail-screen": true };

        // when
        const response = await evaluateAll(
          flags,
          JSON.stringify({ context: [] }),
        );

        // then
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toStrictEqual({
          errorCode: "INVALID_CONTEXT",
          errorDetails: expect.stringMatching(
            /^Invalid evaluation context at context: .+\.$/,
          ),
        });
      },
    );
  });
});
