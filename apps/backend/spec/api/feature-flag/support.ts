import { EvaluateFeatureFlagQuery } from "../../../features/feature-flag/internal/application/evaluate-feature-flag.query";
import { EvaluateFeatureFlagsQuery } from "../../../features/feature-flag/internal/application/evaluate-feature-flags.query";
import type { FeatureFlagSet } from "../../../features/feature-flag/internal/domain/feature-flags";
import { EvaluateFeatureFlagApi } from "../../../features/feature-flag/internal/presentation/evaluate-feature-flag.api";
import { EvaluateFeatureFlagsApi } from "../../../features/feature-flag/internal/presentation/evaluate-feature-flags.api";

// フィーチャーフラグの API 仕様（spec/api/feature-flag/*.api-spec.test.ts。Issue #156）が共有する補助: API ごとの組み立て
//   （<Api>Assembly）と要求（FeatureFlagSpecRequests）。形と WHY（spec/api の中に置く・クラスの static メソッド・用途ごとにクラスを
//   分ける・組み立てを Api ごとのクラスにする）は ../todo/support.ts の冒頭と同じ。
// WHY 実 DB（TestDatabase）を使わない: feature-flag はフラグの一覧をコードにハードコードし、DB を持たない（rule-tests/api-spec.test.ts の
//   api-spec-uses-real-database の例外 FEATURES_WITHOUT_DATABASE。ADR docs/adr/architecture/20261002-feature-flag-ofrep-hardcoded.md）。

// API ごとの組み立て。本番の api ファイルの最下部と同じ組み立て（一覧 → query → Api）で、渡した一覧を使う handler を返す。
// WHY 一覧を受け取る（本番の FEATURE_FLAGS を使わない）: 一覧は Todo の仕様の表の行と同じく「前提」で、step ごとに用意する。本番の
//   一覧（今は on の 1 件だけ）に依存すると、off のフラグの振る舞いを確かめられず、一覧を変えるたびに仕様が落ちる。本番の一覧で
//   組み立てていることは、各 api ファイルの単体テスト（本番の POST）が確かめる。
export class EvaluateFeatureFlagApiAssembly {
  static handler(flags: FeatureFlagSet) {
    return new EvaluateFeatureFlagApi(new EvaluateFeatureFlagQuery(flags))
      .handle;
  }
}

export class EvaluateFeatureFlagsApiAssembly {
  static handler(flags: FeatureFlagSet) {
    return new EvaluateFeatureFlagsApi(new EvaluateFeatureFlagsQuery(flags))
      .handle;
  }
}

// OFREP の評価の要求（POST と JSON の本文）。
export class FeatureFlagSpecRequests {
  // body は送る本文の文字列そのもの（JSON として読めない本文も送れるように、組み立てずに受け取る）。
  static post(
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ): Request {
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  // Next 16 の Route Handler の第 2 引数（動的セグメントの key が Promise で渡される）。
  static context(key: string) {
    return { params: Promise.resolve({ key }) };
  }
}
