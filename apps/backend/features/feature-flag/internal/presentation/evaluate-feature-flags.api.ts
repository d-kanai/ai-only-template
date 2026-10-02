import { createHash } from "node:crypto";
import { z } from "zod";
import { OfrepRequest, OfrepResponse } from "../../../../shared/http/ofrep";
import { EvaluateFeatureFlagsQuery } from "../application/evaluate-feature-flags.query";
import {
  FEATURE_FLAGS,
  type FeatureFlagEvaluation,
} from "../domain/feature-flags";

// POST /api/ofrep/v1/evaluate/flags: すべてのフィーチャーフラグを評価する（OFREP の evaluateFlagsBulk。Issue #156）。画面の
//   OFREP の web provider（@openfeature/ofrep-web-provider）は起動時と定期的な再取得でこれを呼び、結果を手元に持つ。
// 仕様の一次情報: https://github.com/open-feature/protocol の service/openapi.yaml（info.version 0.4.0。2026-10-02 に取得）。
//   - 200: { flags: [{ key, value, reason }] }（bulkEvaluationSuccess）と ETag ヘッダ。metadata・eventStreams は任意で、今は返さない。
//   - 304: 本文なし（If-None-Match が今の ETag と一致したとき）
//   - 400: { errorCode: PARSE_ERROR | INVALID_CONTEXT, errorDetails }（bulkEvaluationFailure。key を持たない）
//   - 500: { errorCode: GENERAL, errorDetails }（shared/http/ofrep.ts）
// WHY Problem Details にしない・POST にする: evaluate-feature-flag.api.ts の冒頭と同じ。

// WHY 各要素の型を 1 件の評価の応答と別に書く: 1 API = 1 ファイルで契約をそのファイルだけで読めるようにする（共通の型を置かない。
//   .claude/rules/code/backend.md の「ファイルの形」）。reason の WHY は evaluate-feature-flag.api.ts の EvaluateFeatureFlagResponse。
export type EvaluateFeatureFlagsResponse = {
  flags: { key: string; value: boolean; reason: "STATIC" }[];
};

// POST /api/ofrep/v1/evaluate/flags の Route Handler を持つクラス（形の WHY は evaluate-feature-flag.api.ts の EvaluateFeatureFlagApi）。
export class EvaluateFeatureFlagsApi {
  constructor(
    private readonly evaluateFeatureFlags: Pick<
      EvaluateFeatureFlagsQuery,
      "execute"
    >,
  ) {}

  readonly handle = OfrepResponse.wrap(
    async (request: Request): Promise<Response> => {
      // WHY key に undefined を渡す: 一括の評価の 400 の本文（bulkEvaluationFailure）は key を持たない。
      const body = await OfrepRequest.parse(
        request,
        this.requestSchema(),
        undefined,
      );
      const evaluations = await this.evaluateFeatureFlags.execute(
        body.context ?? {},
      );
      const response: EvaluateFeatureFlagsResponse =
        this.toResponse(evaluations);
      const etag = this.entityTagOf(response);
      // WHY 304 で本文を返さない・ETag は付ける: openapi.yaml の 304 は本文なし。RFC 9110 の 15.4.5 は、200 なら付けた ETag を
      //   304 にも付けるよう求める。provider は 304 なら手元の結果をそのまま使う。
      if (this.matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return Response.json(response, { headers: { etag } });
    },
  );

  // 要求の本文のスキーマ（evaluate-feature-flag.api.ts の requestSchema と同じ形。WHY もそちら）。
  // WHY 同じスキーマを 2 つのファイルに書く: 1 API = 1 ファイルで、その API の契約をファイルだけで読めるようにする。
  private requestSchema() {
    return z.object({
      // WHY 任意: openapi.yaml の bulkEvaluationRequest は context を required にしているが、@openfeature/ofrep-core 2.3.0 は context が
      //   無いと本文 {} を送る（2026-10-02 に npm の tarball で確認）。provider が送る本文を 400 にしない（Issue #156 のユーザー指示）。
      context: this.contextSchema().optional(),
    });
  }

  // 評価の文脈（openapi.yaml の context）。任意の属性を持てる（additionalProperties: true）ので z.looseObject で属性を残す。
  private contextSchema() {
    return z.looseObject({
      // WHY 任意: openapi.yaml の context で targetingKey は任意。誰に対する評価かを使う規則はまだ無い。
      targetingKey: z.string().optional(),
    });
  }

  private toResponse(
    evaluations: FeatureFlagEvaluation[],
  ): EvaluateFeatureFlagsResponse {
    return {
      flags: evaluations.map(({ key, value }) => ({
        key,
        value,
        reason: "STATIC",
      })),
    };
  }

  // 応答の本文の内容から作る ETag（強い ETag。SHA-256 の 16 進を二重引用符で囲む。RFC 9110 の 8.8.3 の entity-tag の形）。
  // WHY 本文のハッシュ: 一覧はハードコードで版の番号を持たないので、評価の結果そのものから作れば、一覧を変えたデプロイの後だけ
  //   値が変わる（Issue #156 のユーザー指示「一覧の内容のハッシュ」）。一覧ではなく評価の結果から作るのは、属性ごとの出し分けを
  //   足したときに、同じ一覧でも文脈ごとに結果が変わるため。
  private entityTagOf(response: EvaluateFeatureFlagsResponse): string {
    const hash = createHash("sha256")
      .update(JSON.stringify(response))
      .digest("hex");
    return `"${hash}"`;
  }

  // If-None-Match（RFC 9110 の 13.1.2）が今の ETag に一致するか。値は * か、カンマ区切りの entity-tag の一覧。
  // WHY 弱い比較（W/ を外して比べる）: 13.1.2 は If-None-Match を弱い比較で評価すると決めている。
  // WHY ヘッダが無ければ一致しない: 初回の要求（provider は前回の ETag が無ければ If-None-Match を送らない）は本文を返す。
  private matchesIfNoneMatch(header: string | null, etag: string): boolean {
    if (header === null) {
      return false;
    }
    return header
      .split(",")
      .map((candidate) => candidate.trim())
      .some(
        (candidate) =>
          candidate === "*" || candidate.replace(/^W\//, "") === etag,
      );
  }
}

// app/api/ofrep/v1/evaluate/flags/route.ts が re-export する Route Handler。本番は domain の一覧（FEATURE_FLAGS）で組み立てる
//   （WHY DB を使わない: evaluate-feature-flag.api.ts の POST のコメント）。
export const POST = new EvaluateFeatureFlagsApi(
  new EvaluateFeatureFlagsQuery(FEATURE_FLAGS),
).handle;
