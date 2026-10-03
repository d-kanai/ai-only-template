// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { EvaluateFeatureFlagResponse } from "../../../features/feature-flag/internal/presentation/evaluate-feature-flag.api";
import {
  EvaluateFeatureFlagApiAssembly,
  FeatureFlagSpecRequests,
} from "./support";

// API 仕様（Issue #156）: evaluate-feature-flag.feature の `*` の step を、本番と同じ組み立ての handler（EvaluateFeatureFlagApi.handle）を
//   呼んで確かめる。WHY（テストダブル無し・`*` を And で定義）は ../todo/list-todos.api-spec.test.ts の冒頭。前提（フラグの一覧）は
//   step ごとに組み立てに渡す（support.ts の EvaluateFeatureFlagApiAssembly）。DB は使わない（support.ts の冒頭）。
// 応答の形は OFREP の service/openapi.yaml（info.version 0.4.0）の evaluateFlag（200 は serverEvaluationSuccess、400 は
//   evaluationFailure、404 は flagNotFound）。

async function evaluate(
  flags: Record<string, boolean>,
  key: string,
  body: string,
): Promise<Response> {
  return EvaluateFeatureFlagApiAssembly.handler(flags)(
    FeatureFlagSpecRequests.post(`/api/ofrep/v1/evaluate/flags/${key}`, body),
    FeatureFlagSpecRequests.context(key),
  );
}

const feature = await loadFeature("./evaluate-feature-flag.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    // WHY 別のフラグを 1 つ置く: 指定した key を評価すること（一覧の先頭を返す誤り）を見分ける。
    And("オンにしたフィーチャーフラグは、オンと返る", async () => {
      // given
      const flags = { "other-flag": false, "detail-screen": true };

      // when
      const response = await evaluate(flags, "detail-screen", "{}");

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        key: "detail-screen",
        value: true,
        reason: "STATIC",
      } satisfies EvaluateFeatureFlagResponse);
    });

    And("オフにしたフィーチャーフラグは、オフと返る", async () => {
      // given
      const flags = { "other-flag": true, "detail-screen": false };

      // when
      const response = await evaluate(flags, "detail-screen", "{}");

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        key: "detail-screen",
        value: false,
        reason: "STATIC",
      } satisfies EvaluateFeatureFlagResponse);
    });

    // 評価コンテキスト = OFREP の評価の文脈（targetingKey と属性）。今は属性ごとの出し分けをしない（Issue #156）。
    And("評価コンテキストを付けても、設定どおりに返る", async () => {
      // given
      const flags = { "detail-screen": false };
      const body = JSON.stringify({
        context: { targetingKey: "user-123", plan: "premium" },
      });

      // when
      const response = await evaluate(flags, "detail-screen", body);

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        key: "detail-screen",
        value: false,
        reason: "STATIC",
      } satisfies EvaluateFeatureFlagResponse);
    });
  });

  Scenario("異常系", ({ And }) => {
    And(
      "定義されていないフィーチャーフラグは、存在しないと伝えられる",
      async () => {
        // given
        const flags = { "detail-screen": true };

        // when
        const response = await evaluate(flags, "missing", "{}");

        // then
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toStrictEqual({
          key: "missing",
          errorCode: "FLAG_NOT_FOUND",
          errorDetails: "Feature flag missing was not found.",
        });
      },
    );

    And("送った内容が読めないときは、読めないと伝えられる", async () => {
      // given
      const flags = { "detail-screen": true };

      // when
      const response = await evaluate(flags, "detail-screen", "{");

      // then
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        key: "detail-screen",
        errorCode: "PARSE_ERROR",
        errorDetails: "Request body must be valid JSON.",
      });
    });

    And(
      "評価コンテキストの形が正しくないときは、正しくないと伝えられる",
      async () => {
        // given
        const flags = { "detail-screen": true };
        const body = JSON.stringify({ context: "user-123" });

        // when
        const response = await evaluate(flags, "detail-screen", body);

        // then
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toStrictEqual({
          key: "detail-screen",
          errorCode: "INVALID_CONTEXT",
          errorDetails: expect.stringMatching(
            /^Invalid evaluation context at context: .+\.$/,
          ),
        });
      },
    );
  });
});
