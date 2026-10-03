import {
  type EvaluationContext,
  type FeatureFlagEvaluation,
  type FeatureFlagSet,
  FeatureFlags,
} from "../domain/feature-flags";

// すべてのフィーチャーフラグを評価する（query: 読むだけで状態を変えない）。OFREP の一括評価
//   （POST /ofrep/v1/evaluate/flags）が使う。画面（OFREP の web provider）は起動時にこれで全フラグを読み、手元に持つ。
// WHY コンストラクタで一覧を受け取る・async にする: evaluate-feature-flag.query.ts の EvaluateFeatureFlagQuery と同じ。
export class EvaluateFeatureFlagsQuery {
  constructor(private readonly flags: FeatureFlagSet) {}

  async execute(context: EvaluationContext): Promise<FeatureFlagEvaluation[]> {
    return new FeatureFlags(this.flags).evaluateAll(context);
  }
}
