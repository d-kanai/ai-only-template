import { logger } from "@repo/shared/logger";
import { DomainError, type DomainErrorCode } from "../domain/domain-error";
import {
  describeErrorKey,
  type ErrorKey,
  type ErrorKeyParams,
  type ErrorParamsArgs,
} from "../domain/error-key";
import { problemDetail } from "./problem-detail.en";

// エラー応答を RFC 9457（Problem Details for HTTP APIs。https://www.rfc-editor.org/rfc/rfc9457.html ）の形にする（Issue #126）。
// WHY RFC 9457 に準拠する（ユーザー判断）: HTTP API のエラー本文の標準で、Spring の ProblemDetail・ASP.NET Core の
//   ProblemDetails が実装し、Zalando の API ガイドラインが MUST にしている（一次情報は 2026-09-29 の work-logs）。
//   独自の形（Issue #126 の前の、error の中に code・key・params と項目ごとの誤りを入れた形）だと、クライアントや汎用のツールが形を個別に知る必要がある。
//   決定と採用しなかった案は ADR docs/adr/architecture/20260929-error-response-rfc9457.md。

// WHY ここから再公開する: 画面（apps/frontend）が backend から import してよいのは apps/backend/package.json の exports に
//   書いたファイルだけで、shared/domain/error-key.ts は公開していない。画面の辞書はキーと params の形をこの型から作る
//   （キーを足すと画面の辞書が型エラーで追従を求める。Issue #116）。exports を増やさずに済むよう、Problem と同じ
//   このファイルから出す。
export type { ErrorKey, ErrorKeyParams };

// 文言に埋め込む値。JSON に載せて画面に渡すので string か number だけ（error-key.ts の ErrorKeyParams の各形もこれに収まる）。
type ErrorParams = Record<string, string | number>;

// エラーの種類（type）。RFC 9457 の 3.1.1 節: type は問題の種類を表す URI 参照（相対参照でもよい）で、クライアントは
//   これを種類の主な識別子に使う。
// WHY about:blank を使わない: about:blank は「HTTP ステータス以外に意味を持たない」ことを表す（4.2.1 節）。クライアントが
//   種類で分岐できるよう、種類ごとに固定の値にする。
// WHY 相対参照（/problems/...）: 3.1.1 節は絶対 URI を推奨するが、絶対 URI にするとドメインを決める必要があり、環境
//   （ローカル・本番）で変わる。相対参照にするときは完全なパス（"/types/123" のように / から）を含めることも推奨されて
//   おり、それに従う（パスの途中からの相対参照は、応答した URL ごとに別の URI に解決されてしまう）。
//   解決できる文書は今は置いていない（3.1.1 節: type は解決できない URI でもよい）。
export type ProblemType =
  | "/problems/validation-error"
  | "/problems/not-found"
  | "/problems/internal-error";

// 項目ごとの誤り 1 件（RFC 9457 の 3 節の例の errors の要素と同じ形。拡張メンバー）。
// WHY zod の issue をそのまま返さない: code・expected・keys などは zod の内部の語彙で、zod の版で変わりうる。
//   クライアントとの契約はどこが（pointer）・なぜ（key と params）に固定し、開発者向けの英語（detail）を添える。
export type ProblemError = {
  // 誤りのある項目を指す JSON Pointer（RFC 6901）の URI の fragment の形。例: "#/title"、入れ子は "#/tags/1"。
  //   本文全体の誤り（オブジェクトでない・未知の項目）は "#"（文書全体）。組み立ては json-body.ts の toPointer。
  pointer: string;
  key: ErrorKey;
  params?: ErrorParams;
  // 開発者向けの英語（problem-detail.en.ts）。画面には出さない（契約外）。
  detail: string;
};

// InvalidRequestError が持つ項目ごとの誤り。detail は toProblemResponse が足す。
// WHY detail を後で足す: 英語の文を作る場所を toProblemResponse の 1 か所にし、例外を作る側（json-body.ts）に
//   英語の文言の都合を持ち込まない。
export type ProblemErrorInput = Omit<ProblemError, "detail">;

// エラー時のレスポンス本文（Content-Type: application/problem+json）。全 API で同じ形にする。
// 標準のメンバー（type・title・status・detail・instance）と、このアプリの拡張メンバー（key・params・errors）。
// WHY 画面は key と params だけで分岐・翻訳する（detail を読まない）: detail は開発者向けの英語で、言い回しを変えても
//   画面が壊れないよう契約に含めない（Issue #126。画面の文言は画面の辞書だけが持つ。Issue #116）。
export type Problem = {
  type: ProblemType;
  // 種類ごとに固定の英語の短い要約。RFC 9457 の 3.1.3 節: 発生ごとに変えない（翻訳を除く）。翻訳はしない。
  title: string;
  // HTTP のステータスと同じ値（RFC 9457 の 3.1.2 節: 生成側は実際のステータスと同じ値にしなければならない）。
  status: number;
  // この発生に固有の説明（RFC 9457 の 3.1.4 節）。key と params から作る英語（problem-detail.en.ts）。
  detail: string;
  // この発生を指す URI 参照。リクエストの URL のパス。クエリは含めない（リクエストログと同じ方針でクエリの値は出さない。Issue #85。
  //   パスの id は params.id と detail にも出るので、パスを隠す理由にはならない）。
  instance: string;
  // 何が起きたかを表す安定したキー（error-key.ts）。画面はこれを辞書で翻訳し、分岐にも使う。
  //   errors があるときは、その最初の 1 件の key と同じ（errors を読まない画面も 1 つの文言を出せる）。
  key: ErrorKey;
  // 文言に埋め込む値（上限の文字数・id など）。params の無いキーでは本文にキーごと出さない。
  params?: ErrorParams;
  // リクエストの形（presentation の zod スキーマ）の誤りのときだけ付く、項目ごとの誤りの一覧（Issue #88）。
  // WHY 形の誤りだけ: 値の規則（domain の不変条件。タイトルの長さなど）の誤りは DomainError の key 1 つで、
  //   domain はリクエストの項目名を知らない（domain にリクエストの都合を持ち込まない）。JSON として読めない誤りも
  //   項目が無いので付けない。
  // WHY 省略可能にする（空配列にしない）: 誤りが項目に結び付かないとき（404・500・JSON でない）は一覧自体が無い。
  errors?: ProblemError[];
};

// InvalidRequestError のコンストラクタの key の後ろの引数: キーごとの params（無いキーは省略）と、項目ごとの誤り。
//   例: new InvalidRequestError("request.body.notJson") / new InvalidRequestError("request.field.notString", { path }, errors)
// WHY export する: key が実行時に決まるとき（json-body.ts が zod の issue から作るとき）に、この型へ as で合わせるため。
export type InvalidRequestArgs<K extends ErrorKey> = [
  ...ErrorParamsArgs<K>,
  errors?: ProblemErrorInput[],
];

// リクエストの形の誤り（JSON でない、項目の型が違う、未知の項目があるなど）を表す例外。
// WHY DomainError と分ける: 形の誤りは HTTP の入力の問題で、ドメインのルール違反ではない。
//   domain 層にリクエストの都合を持ち込まないよう、presentation 層の中で閉じた例外にする。
//   クライアントから見れば「入力が不正」で同じなので、レスポンスは /problems/validation-error・400 にそろえる。
// WHY errors を持てるようにする（zod の ZodError をそのまま投げない）: toProblemResponse が zod を知らずに済み、
//   JSON として読めない誤り（zod を通らない）も同じ例外で表せる。
// WHY K を型引数にする: DomainError と同じく、key から params の型を決める（domain-error.ts のコメント）。
export class InvalidRequestError<K extends ErrorKey = ErrorKey> extends Error {
  readonly key: K;
  readonly params: ErrorKeyParams[K] | undefined;
  readonly errors: ProblemErrorInput[] | undefined;

  constructor(key: K, ...rest: InvalidRequestArgs<K>) {
    // WHY as: rest の形は K が決まるまで分からない（domain-error.ts と同じ）。先頭は params か undefined、2 番目は errors。
    const params = rest[0] as ErrorKeyParams[K] | undefined;
    const errors = rest[1] as ProblemErrorInput[] | undefined;
    super(describeErrorKey(key, params));
    this.name = "InvalidRequestError";
    this.key = key;
    this.params = params;
    this.errors = errors;
  }
}

// 応答の種類。DomainError の code と、想定外の例外（internal_error）。
type ProblemCategory = DomainErrorCode | "internal_error";

// WHY Record<ProblemCategory, ...> にする: DomainErrorCode に種類を足したとき、ここに type・title・status を書き忘れると
//   型エラーになり、変換漏れを防げる。
// WHY 関数の中に置く（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる（Issue #55）。
function problemKindOf(
  category: ProblemCategory,
): Pick<Problem, "type" | "title" | "status"> {
  const problemKinds: Record<
    ProblemCategory,
    Pick<Problem, "type" | "title" | "status">
  > = {
    validation_error: {
      type: "/problems/validation-error",
      title: "Validation error",
      status: 400,
    },
    not_found: { type: "/problems/not-found", title: "Not found", status: 404 },
    internal_error: {
      type: "/problems/internal-error",
      title: "Internal error",
      status: 500,
    },
  };
  return problemKinds[category];
}

// WHY params・errors が undefined でも分岐しない: JSON.stringify は値が undefined のプロパティを出力しないので、
//   本文に params・errors のキーが出ない（problem.test.ts・各 api のテストで toStrictEqual により確かめている）。
// WHY Content-Type を application/problem+json にする: RFC 9457 の 3 節が定めるメディア型で、汎用の HTTP クライアントや
//   ツールが Problem Details と見分ける手がかりになる（Response.json の既定は application/json）。画面の fetch は
//   Content-Type を見ずに response.json() で読むので、変えても読める。
function problemResponse(
  category: ProblemCategory,
  request: Request,
  key: ErrorKey,
  params: ErrorParams | undefined,
  errors: ProblemErrorInput[] | undefined,
): Response {
  const kind = problemKindOf(category);
  const problem: Problem = {
    ...kind,
    detail: problemDetail(key, params),
    instance: new URL(request.url).pathname,
    key,
    params,
    errors: errors?.map((error) => ({
      ...error,
      detail: problemDetail(error.key, error.params),
    })),
  };
  return Response.json(problem, {
    status: kind.status,
    headers: { "content-type": "application/problem+json" },
  });
}

// presentation の各 API が catch した例外を Problem Details の Response に変換する。変換の規則をここ 1 か所に集める。
// WHY request を受け取る: instance（この発生を指す URI 参照）にリクエストのパスを入れるため。
export function toProblemResponse(error: unknown, request: Request): Response {
  if (error instanceof DomainError) {
    return problemResponse(
      error.code,
      request,
      error.key,
      error.params,
      undefined,
    );
  }
  if (error instanceof InvalidRequestError) {
    return problemResponse(
      "validation_error",
      request,
      error.key,
      error.params,
      error.errors,
    );
  }
  // WHY ログに残す: 想定外の例外は原因を調べる必要がある。レスポンスでは詳細を隠すので、
  //   サーバのログ（stderr の 1 行の JSON）にだけ残す。ログはすべて logger を通す（.claude/rules/backend.md の「ログ」）。
  //   Error は logger が { name, message } にする（stack は出さない）。
  // WHY 英語の固定の文言: ログは開発者が読むもので、apps/backend の非テストコードには日本語を置かない（Issue #116）。
  logger.error({ message: "unexpected error", error });
  // WHY 固定のキーと detail にする: 例外の message には内部の情報（接続先、SQL など）が含まれうるため、クライアントに返さない。
  return problemResponse(
    "internal_error",
    request,
    "server.internalError",
    undefined,
    undefined,
  );
}
