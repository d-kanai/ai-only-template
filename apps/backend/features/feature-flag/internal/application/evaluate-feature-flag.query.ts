import {
  type EvaluationContext,
  type FeatureFlagEvaluation,
  type FeatureFlagSet,
  FeatureFlags,
} from "../domain/feature-flags";

// key のフィーチャーフラグを 1 件評価する（query: 読むだけで状態を変えない）。OFREP の 1 件の評価
//   （POST /ofrep/v1/evaluate/flags/{key}）が使う。
// WHY コンストラクタで一覧（FeatureFlagSet）を受け取る: 本番は api ファイルの組み立てが domain の FEATURE_FLAGS を渡し、テストは
//   自分の一覧を渡す（vi.mock を使わない。.claude/rules/code/backend.md の「テスト」）。一覧を DB に移すときは、ここで一覧の
//   代わりに Repository を受け取る。
export class EvaluateFeatureFlagQuery {
  constructor(private readonly flags: FeatureFlagSet) {}

  // 一覧に無い key は FeatureFlags.evaluate が DomainError(not_found) を投げ、reject になる。
  // WHY async（Promise を返す）: 今は一覧がメモリにあり同期で済むが、ほかの query（Repository を読む）と同じ形にそろえ、
  //   一覧を DB に移したときに呼び出し側（api）を変えずに済ませる。
  async execute(
    key: string,
    context: EvaluationContext,
  ): Promise<FeatureFlagEvaluation> {
    return new FeatureFlags(this.flags).evaluate(key, context);
  }
}
