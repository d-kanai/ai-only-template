import { z } from "zod";
import { OfrepResponse } from "../../../../shared/http/ofrep";
import { OfrepRequest } from "../../../../shared/http/ofrep-request";
import { EvaluateFeatureFlagQuery } from "../application/evaluate-feature-flag.query";
import {
  FEATURE_FLAGS,
  type FeatureFlagEvaluation,
} from "../domain/feature-flags";

// POST /api/ofrep/v1/evaluate/flags/{key}: key のフィーチャーフラグを 1 件評価する（OFREP の evaluateFlag。Issue #156）。
// 仕様の一次情報: https://github.com/open-feature/protocol の service/openapi.yaml（info.version 0.4.0。2026-10-02 に取得）。
//   - 200: { key, value, reason }（serverEvaluationSuccess）。variant・metadata は任意で、今は返さない。
//   - 400: { key, errorCode: PARSE_ERROR | INVALID_CONTEXT, errorDetails }（evaluationFailure。key は必須）
//   - 404: { key, errorCode: FLAG_NOT_FOUND, errorDetails }（flagNotFound）
//   - 500: { errorCode: GENERAL, errorDetails }（generalErrorResponse に errorCode を足した形。shared/http/ofrep.ts）
// WHY Problem Details にしない（この API と一括の評価の 2 本だけの例外）: shared/http/ofrep.ts の冒頭。
// WHY POST（読むだけなのに）: OFREP の仕様が POST に決めている（評価の文脈を本文で送るため）。

// 評価の reason（openapi.yaml の evaluationSuccess の reason の enum のうち、今返すもの）。
// WHY STATIC: 値は一覧に書いた固定の値で、属性による出し分け（TARGETING_MATCH）も割合（SPLIT）も無い。出し分けを足したら増やす。
export type EvaluateFeatureFlagResponse = {
  key: string;
  value: boolean;
  reason: "STATIC";
};

// Route Handler の第 2 引数。Next 16 では動的セグメントの params が Promise で渡される（get-todo.api.ts の Context と同じ）。
type Context = { params: Promise<{ key: string }> };

// POST /api/ofrep/v1/evaluate/flags/{key} の Route Handler を持つクラス。コンストラクタで query を受け取り、handle を Route Handler として
//   export する（WHY クラスにする・Pick で execute だけを受け取る・handle をアロー関数のプロパティにするは list-todos.api.ts の
//   ListTodosApi のコメント）。
// WHY ProblemResponse.wrap ではなく OfrepResponse.wrap で包む: 失敗を OFREP の形（errorCode）で返すため（shared/http/ofrep.ts）。
//   rule-tests/architecture.test.ts の presentation-with-problem-response が features/feature-flag の presentation だけに許す例外。
export class EvaluateFeatureFlagApi {
  constructor(
    private readonly evaluateFeatureFlag: Pick<
      EvaluateFeatureFlagQuery,
      "execute"
    >,
  ) {}

  readonly handle = OfrepResponse.wrap(
    async (request: Request, ctx: Context): Promise<Response> => {
      const { key } = await ctx.params;
      // WHY key を渡す: 400 の本文（evaluationFailure）は評価しようとした key が必須。
      const body = await OfrepRequest.parse(request, this.requestSchema(), key);
      // 一覧に無い key は query が DomainError(not_found) を投げ、OfrepResponse.wrap が 404（FLAG_NOT_FOUND）に変換する。
      const evaluation = await this.evaluateFeatureFlag.execute(
        key,
        body.context ?? {},
      );
      const response: EvaluateFeatureFlagResponse = this.toResponse(evaluation);
      return Response.json(response);
    },
  );

  // 要求の本文のスキーマ（openapi.yaml の evaluationRequest と context）。
  // WHY z.object（strictObject にしない）: OFREP の evaluationRequest は additionalProperties を閉じていない。仕様の版が上がって
  //   provider が項目を足しても、評価を失敗させない（ほかの API が strictObject で打ち間違いを止めるのとは逆。仕様の相手が外の provider）。
  // WHY z.looseObject（context の属性を残す）: context は任意の属性を持てる（additionalProperties: true）。属性ごとの出し分けを足すときに
  //   評価へ渡すため、捨てずに残す。
  // WHY メソッドにする（最上位の定数にしない）: json-body.ts の RequestBody.schema のコメント（static な変異になり mutation で数えない）。
  private requestSchema() {
    return z.object({
      // WHY 任意: openapi.yaml の evaluationRequest は context を required にしているが、@openfeature/ofrep-core 2.3.0 は context が
      //   無いと本文 {} を送る（JSON.stringify で undefined の項目が落ちる。2026-10-02 に npm の tarball で確認）。provider が送る本文を
      //   400 にしないため、無ければ空の文脈として評価する（Issue #156 のユーザー指示「無くてもよい」）。
      context: this.contextSchema().optional(),
    });
  }

  // 評価の文脈（openapi.yaml の context）。任意の属性を持てる（additionalProperties: true）ので z.looseObject で属性を残す。
  private contextSchema() {
    return z.looseObject({
      // WHY 任意: openapi.yaml の context で targetingKey は任意（properties にあるが required に無い）。誰に対する評価かを
      //   使う規則（利用者ごとの出し分け）はまだ無い。
      targetingKey: z.string().optional(),
    });
  }

  private toResponse(
    evaluation: FeatureFlagEvaluation,
  ): EvaluateFeatureFlagResponse {
    return { key: evaluation.key, value: evaluation.value, reason: "STATIC" };
  }
}

// app/api/ofrep/v1/evaluate/flags/[key]/route.ts が re-export する Route Handler。本番は domain の一覧（FEATURE_FLAGS）で組み立てる。
// WHY DB（AppDatabase）を使わない: 一覧はハードコードで、Repository を持たない（ADR docs/adr/architecture/20261002-feature-flag-ofrep-hardcoded.md）。
export const POST = new EvaluateFeatureFlagApi(
  new EvaluateFeatureFlagQuery(FEATURE_FLAGS),
).handle;
