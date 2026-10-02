// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "../../../../shared/error/domain-error";
import { EvaluateFeatureFlagQuery } from "./evaluate-feature-flag.query";

describe("EvaluateFeatureFlagQuery", () => {
  test("コンストラクタで受け取った一覧から、key のフラグを評価して返す", async () => {
    // given
    const query = new EvaluateFeatureFlagQuery({
      "flag-on": true,
      "flag-off": false,
    });

    // when
    const on = query.execute("flag-on", { targetingKey: "user-123" });
    const off = query.execute("flag-off", {});

    // then
    await expect(on).resolves.toStrictEqual({ key: "flag-on", value: true });
    await expect(off).resolves.toStrictEqual({ key: "flag-off", value: false });
  });

  test("一覧に無い key なら、その key を params に持つ DomainError(not_found, featureFlag.notFound) で reject する", async () => {
    // given
    const query = new EvaluateFeatureFlagQuery({ "flag-on": true });

    // when
    const evaluation = query.execute("missing", {});

    // then
    await expect(evaluation).rejects.toBeInstanceOf(DomainError);
    await expect(query.execute("missing", {})).rejects.toMatchObject({
      code: "not_found",
      key: "featureFlag.notFound",
      params: { key: "missing" },
    });
  });
});
