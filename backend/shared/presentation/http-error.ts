import {
  DomainError,
  type DomainErrorCode,
} from "@/backend/shared/domain/domain-error";

// エラー時のレスポンス本文。全 API で同じ形にする（画面側はこの形だけを見て分岐できる）。
export type ErrorResponse = {
  error: {
    // "validation_error" | "not_found" | "internal_error"。画面側で分岐できるよう機械可読なコードを持つ。
    code: string;
    // 人間向けの説明。画面側は表示に使ってよいが、分岐には code を使う。
    message: string;
  };
};

// リクエストの形の誤り（JSON でない、項目の型が違うなど）を表す例外。
// WHY DomainError と分ける: 形の誤りは HTTP の入力の問題で、ドメインのルール違反ではない。
//   domain 層にリクエストの都合を持ち込まないよう、presentation 層の中で閉じた例外にする。
//   クライアントから見れば「入力が不正」で同じなので、レスポンスは validation_error / 400 にそろえる。
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

// WHY Record<DomainErrorCode, number> にする: DomainErrorCode に種類を足したとき、
//   ここに対応するステータスを書き忘れると型エラーになり、変換漏れ（= 500 になる）を防げる。
// WHY 関数の中に置く（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる（Issue #55）。
function statusOf(code: DomainErrorCode): number {
  const statusByDomainErrorCode: Record<DomainErrorCode, number> = {
    validation_error: 400,
    not_found: 404,
  };
  return statusByDomainErrorCode[code];
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  const body: ErrorResponse = { error: { code, message } };
  return Response.json(body, { status });
}

// presentation 層の各 API が catch した例外を Response に変換する。変換の規則をここ 1 か所に集める。
export function toErrorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    return errorResponse(statusOf(error.code), error.code, error.message);
  }
  if (error instanceof InvalidRequestError) {
    return errorResponse(400, "validation_error", error.message);
  }
  // WHY ログに残す: 想定外の例外は原因を調べる必要がある。レスポンスでは詳細を隠すので、
  //   サーバのログにだけ残す（noConsole でも console.error は許可している。rules/code/lint.md）。
  console.error(error);
  // WHY 固定の文言にする: 例外の message には内部の情報（接続先、SQL など）が含まれうるため、クライアントに返さない。
  return errorResponse(500, "internal_error", "サーバでエラーが発生しました");
}
