// OFREP（OpenFeature Remote Evaluation Protocol）の失敗の errorCode と、クライアントの誤りを表す例外（Issue #156）。
//   全体の WHY（Problem Details にしない理由・一次情報）は ofrep.ts の冒頭。

// OFREP の失敗の errorCode（openapi.yaml の evaluationFailure の enum と、flagNotFound の FLAG_NOT_FOUND）のうち、この API が返すもの。
// WHY TARGETING_KEY_MISSING を持たない: targetingKey の要る規則（利用者ごとの出し分け）がまだ無い。足すときに増やす。
export type OfrepErrorCode =
  | "PARSE_ERROR"
  | "INVALID_CONTEXT"
  | "FLAG_NOT_FOUND"
  | "GENERAL";

// クライアントの誤りによる OFREP の失敗（400）。OfrepResponse.wrap が本文にする。
// key: 1 件の評価（evaluationFailure は key が必須）なら評価しようとした key、一括の評価（bulkEvaluationFailure は key を持たない）
//   なら undefined。
// WHY 404（FLAG_NOT_FOUND）をここで作らない: フラグが無いことは domain が DomainError(not_found, featureFlag.notFound) で表し、
//   wrap が OFREP の形に変える（domain は OFREP を知らない）。
export class OfrepError extends Error {
  constructor(
    readonly status: 400,
    readonly errorCode: Exclude<OfrepErrorCode, "FLAG_NOT_FOUND" | "GENERAL">,
    readonly errorDetails: string,
    readonly key: string | undefined,
  ) {
    super(`${errorCode} ${errorDetails}`);
    this.name = "OfrepError";
  }
}
