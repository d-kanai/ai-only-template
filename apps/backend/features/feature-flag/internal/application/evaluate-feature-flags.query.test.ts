// @vitest-environment node
import { describe, expect, test } from "vitest";
import { EvaluateFeatureFlagsQuery } from "./evaluate-feature-flags.query";

describe("EvaluateFeatureFlagsQuery", () => {
  test("コンストラクタで受け取った一覧のすべてのフラグを、一覧の順に評価して返す", async () => {
    // given
    const query = new EvaluateFeatureFlagsQuery({ b: false, a: true });

    // when
    const evaluations = query.execute({ targetingKey: "user-123" });

    // then
    await expect(evaluations).resolves.toStrictEqual([
      { key: "b", value: false },
      { key: "a", value: true },
    ]);
  });

  test("一覧が空なら空の配列を返す", async () => {
    // given
    const query = new EvaluateFeatureFlagsQuery({});

    // when
    const evaluations = query.execute({});

    // then
    await expect(evaluations).resolves.toStrictEqual([]);
  });
});
