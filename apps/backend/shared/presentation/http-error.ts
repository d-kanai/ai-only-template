import { logger } from "@repo/shared/logger";
import { DomainError, type DomainErrorCode } from "../domain/domain-error";
import {
  describeErrorKey,
  type ErrorKey,
  type ErrorKeyParams,
  type ErrorParamsArgs,
} from "../domain/error-key";

// WHY ここから再公開する: 画面（apps/frontend）が backend から import してよいのは apps/backend/package.json の exports に
//   書いたファイルだけで、shared/domain/error-key.ts は公開していない。画面の辞書はキーと params の形をこの型から作る
//   （キーを足すと画面の辞書が型エラーで追従を求める。Issue #116）。exports を増やさずに済むよう、ErrorResponse と同じ
//   このファイルから出す。
export type { ErrorKey, ErrorKeyParams };

// 文言に埋め込む値。JSON に載せて画面に渡すので string か number だけ（error-key.ts の ErrorKeyParams の各形もこれに収まる）。
type ErrorParams = Record<string, string | number>;

// リクエストの形の誤り 1 件。zod の issue を、クライアントに見せる 3 項目に絞ったもの（json-body.ts の toErrorIssue）。
// WHY zod の issue をそのまま返さない: code・expected・keys などは zod の内部の語彙で、zod の版で変わりうる。
//   クライアントとの契約はどの項目が（path）・なぜ（key と params）に固定する。
export type ErrorIssue = {
  // 誤りのある項目。入れ子は . 区切り（"tags.1"）。本文全体の誤り（オブジェクトでない・未知の項目）は空文字。
  path: string;
  key: ErrorKey;
  params?: ErrorParams;
};

// エラー時のレスポンス本文。全 API で同じ形にする（画面側はこの形だけを見て分岐・翻訳できる）。
// WHY 文言（message）を返さない（Issue #116 で削除）: 画面に出す文言は画面側が key と params を辞書で翻訳して決める。
//   backend が文言を返すと、言語や言い回しを変えるたびに API を変えることになる。
export type ErrorResponse = {
  error: {
    // "validation_error" | "not_found" | "internal_error"。HTTP のステータスに対応する大分類。
    code: string;
    // 何が起きたかを表す安定したキー（error-key.ts）。画面はこれを翻訳する。
    //   issues があるときは、その最初の 1 件の key と同じ（issues を読まない画面も 1 つの文言を出せる）。
    key: ErrorKey;
    // 文言に埋め込む値（上限の文字数・id など）。params の無いキーでは本文にキーごと出さない。
    params?: ErrorParams;
    // リクエストの形（presentation の zod スキーマ）の誤りのときだけ付く、項目ごとの誤りの一覧（Issue #88）。
    // WHY 形の誤りだけ: 値の規則（domain の不変条件。タイトルの長さなど）の誤りは DomainError の key 1 つで、
    //   domain はリクエストの項目名を知らない（domain にリクエストの都合を持ち込まない）。JSON として読めない誤りも
    //   項目が無いので付けない。
    // WHY 省略可能にする（空配列にしない）: 誤りが項目に結び付かないとき（404・500・JSON でない）は一覧自体が無い。
    issues?: ErrorIssue[];
  };
};

// InvalidRequestError のコンストラクタの key の後ろの引数: キーごとの params（無いキーは省略）と、項目ごとの誤り。
//   例: new InvalidRequestError("request.body.notJson") / new InvalidRequestError("request.field.notString", { path }, issues)
// WHY export する: key が実行時に決まるとき（json-body.ts が zod の issue から作るとき）に、この型へ as で合わせるため。
export type InvalidRequestArgs<K extends ErrorKey> = [
  ...ErrorParamsArgs<K>,
  issues?: ErrorIssue[],
];

// リクエストの形の誤り（JSON でない、項目の型が違う、未知の項目があるなど）を表す例外。
// WHY DomainError と分ける: 形の誤りは HTTP の入力の問題で、ドメインのルール違反ではない。
//   domain 層にリクエストの都合を持ち込まないよう、presentation 層の中で閉じた例外にする。
//   クライアントから見れば「入力が不正」で同じなので、レスポンスは validation_error / 400 にそろえる。
// WHY issues を持てるようにする（zod の ZodError をそのまま投げない）: toErrorResponse が zod を知らずに済み、
//   JSON として読めない誤り（zod を通らない）も同じ例外で表せる。
// WHY K を型引数にする: DomainError と同じく、key から params の型を決める（domain-error.ts のコメント）。
export class InvalidRequestError<K extends ErrorKey = ErrorKey> extends Error {
  readonly key: K;
  readonly params: ErrorKeyParams[K] | undefined;
  readonly issues: ErrorIssue[] | undefined;

  constructor(key: K, ...rest: InvalidRequestArgs<K>) {
    // WHY as: rest の形は K が決まるまで分からない（domain-error.ts と同じ）。先頭は params か undefined、2 番目は issues。
    const params = rest[0] as ErrorKeyParams[K] | undefined;
    const issues = rest[1] as ErrorIssue[] | undefined;
    super(describeErrorKey(key, params));
    this.name = "InvalidRequestError";
    this.key = key;
    this.params = params;
    this.issues = issues;
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

// WHY params・issues が undefined でも分岐しない: JSON.stringify は値が undefined のプロパティを出力しないので、
//   本文に params・issues のキーが出ない（http-error.test.ts・各 api のテストで「キーが無い」ことを確かめている）。
function errorResponse(
  status: number,
  error: ErrorResponse["error"],
): Response {
  const body: ErrorResponse = { error };
  return Response.json(body, { status });
}

// presentation 層の各 API が catch した例外を Response に変換する。変換の規則をここ 1 か所に集める。
export function toErrorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    return errorResponse(statusOf(error.code), {
      code: error.code,
      key: error.key,
      params: error.params,
    });
  }
  if (error instanceof InvalidRequestError) {
    return errorResponse(400, {
      code: "validation_error",
      key: error.key,
      params: error.params,
      issues: error.issues,
    });
  }
  // WHY ログに残す: 想定外の例外は原因を調べる必要がある。レスポンスでは詳細を隠すので、
  //   サーバのログ（stderr の 1 行の JSON）にだけ残す。ログはすべて logger を通す（.claude/rules/backend.md の「ログ」）。
  //   Error は logger が { name, message } にする（stack は出さない）。
  // WHY 英語の固定の文言: ログは開発者が読むもので、apps/backend の非テストコードには自然言語の文言（日本語）を置かない
  //   （Issue #116。画面に出す文言は画面の辞書だけが持つ）。
  logger.error({ message: "unexpected error", error });
  // WHY 固定のキーにする: 例外の message には内部の情報（接続先、SQL など）が含まれうるため、クライアントに返さない。
  return errorResponse(500, {
    code: "internal_error",
    key: "server.internalError",
  });
}
