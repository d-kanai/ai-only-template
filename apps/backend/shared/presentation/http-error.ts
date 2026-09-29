import { logger } from "@repo/shared/logger";
import { DomainError, type DomainErrorCode } from "../domain/domain-error";

// リクエストの形の誤り 1 件。zod の issue を、クライアントに見せる 2 項目に絞ったもの（json-body.ts の toErrorIssues）。
// WHY zod の issue をそのまま返さない: code・expected・keys などは zod の内部の語彙で、zod の版で変わりうる。
//   クライアントとの契約はどの項目が（path）・なぜ（message）の 2 つに固定する。
export type ErrorIssue = {
  // 誤りのある項目。入れ子は . 区切り（"tags.1"）。本文全体の誤り（オブジェクトでない・未知の項目）は空文字。
  path: string;
  message: string;
};

// エラー時のレスポンス本文。全 API で同じ形にする（画面側はこの形だけを見て分岐できる）。
export type ErrorResponse = {
  error: {
    // "validation_error" | "not_found" | "internal_error"。画面側で分岐できるよう機械可読なコードを持つ。
    code: string;
    // 人間向けの説明。画面側は表示に使ってよいが、分岐には code を使う。
    //   issues があるときは、その最初の 1 件の message と同じ（issues を読まない画面もそのまま表示に使える）。
    message: string;
    // リクエストの形（presentation の zod スキーマ）の誤りのときだけ付く、項目ごとの誤りの一覧（Issue #88）。
    // WHY 形の誤りだけ: 値の規則（domain の不変条件。タイトルの長さなど）の誤りは DomainError の message 1 つで、
    //   domain はリクエストの項目名を知らない（domain にリクエストの都合を持ち込まない）。JSON として読めない誤りも
    //   項目が無いので付けない。
    // WHY 省略可能にする（空配列にしない）: 既存の message だけを見る画面（apps/frontend/features/todo/api/todo-api.ts）の
    //   契約を変えずに足すため。
    issues?: ErrorIssue[];
  };
};

// リクエストの形の誤り（JSON でない、項目の型が違う、未知の項目があるなど）を表す例外。
// WHY DomainError と分ける: 形の誤りは HTTP の入力の問題で、ドメインのルール違反ではない。
//   domain 層にリクエストの都合を持ち込まないよう、presentation 層の中で閉じた例外にする。
//   クライアントから見れば「入力が不正」で同じなので、レスポンスは validation_error / 400 にそろえる。
// WHY issues を持てるようにする（zod の ZodError をそのまま投げない）: toErrorResponse が zod を知らずに済み、
//   JSON として読めない誤り（zod を通らない）も同じ例外で表せる。
export class InvalidRequestError extends Error {
  constructor(
    message: string,
    readonly issues?: ErrorIssue[],
  ) {
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

// WHY issues が undefined でも分岐しない: JSON.stringify は値が undefined のプロパティを出力しないので、
//   本文に issues のキーが出ない（http-error.test.ts・各 api のテストで「キーが無い」ことを確かめている）。
function errorResponse(
  status: number,
  code: string,
  message: string,
  issues?: ErrorIssue[],
): Response {
  const body: ErrorResponse = { error: { code, message, issues } };
  return Response.json(body, { status });
}

// presentation 層の各 API が catch した例外を Response に変換する。変換の規則をここ 1 か所に集める。
export function toErrorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    return errorResponse(statusOf(error.code), error.code, error.message);
  }
  if (error instanceof InvalidRequestError) {
    return errorResponse(400, "validation_error", error.message, error.issues);
  }
  // WHY ログに残す: 想定外の例外は原因を調べる必要がある。レスポンスでは詳細を隠すので、
  //   サーバのログ（stderr の 1 行の JSON）にだけ残す。ログはすべて logger を通す（.claude/rules/backend.md の「ログ」）。
  //   Error は logger が { name, message } にする（stack は出さない）。
  logger.error({ message: "想定外の例外", error });
  // WHY 固定の文言にする: 例外の message には内部の情報（接続先、SQL など）が含まれうるため、クライアントに返さない。
  return errorResponse(500, "internal_error", "サーバでエラーが発生しました");
}
