import type { ErrorKey, ErrorKeyParams } from "../domain/error-key";

// Problem Details（RFC 9457）の detail に入れる、開発者向けの英語の文（Issue #126。ユーザー判断）。
// WHY 英語だけ・翻訳しない: detail は curl やログで API を読む開発者のためのもので、画面には出さない。画面に出す文言は
//   画面（apps/frontend）の辞書が key と params から翻訳する。backend に ja / en の辞書を持つと、画面の辞書と二重管理になる
//   （採用しなかった案。ADR docs/adr/architecture/20260929-error-response-rfc9457.md）。
// WHY detail はクライアントとの契約に含めない: 言い回しを変えても画面は壊れない（画面は detail を読まない）。分岐と翻訳には
//   key を使う。テスト（problem-detail.en.test.ts・各 api のテスト）は文言を固定するが、それは意図しない変更に気づくためで、
//   文言を変えるときはテストも一緒に直してよい。
// WHY 英語の文言はこのファイルだけに書く: 同じ key の文を複数の場所に書くと、片方だけ直してずれる。problem.ts は key と params を
//   ここに渡して detail を作る（toProblemResponse）。
// 網羅: 戻り値の型（ErrorKey ごとの関数）で、ErrorKeyParams にキーを足して文を書き忘れるとコンパイルエラーになる
//   （pnpm typecheck）。各関数の引数の型はそのキーの params（ErrorKeyParams[K]）なので、無い params の名前も書けない。
type DetailMessages = {
  [K in ErrorKey]: (params: ErrorKeyParams[K]) => string;
};

// WHY 関数の中で作る（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に作れば、文言の変異をテストで検出できる。
function detailMessages(): DetailMessages {
  return {
    "todo.title.empty": () => "Title must not be empty.",
    "todo.title.tooLong": ({ max }) =>
      `Title must be at most ${max} characters.`,
    "todo.title.invalid": () => "Title must be a string.",
    "todo.id.invalid": () => "Id must be a UUID.",
    "todo.completed.invalid": () => "Completed must be a boolean.",
    "todo.createdAt.invalid": () => "CreatedAt must be a valid date.",
    "todo.notFound": ({ id }) => `Todo ${id} was not found.`,
    "request.body.notJson": () => "Request body must be valid JSON.",
    "request.body.notObject": () => "Request body must be a JSON object.",
    "request.body.unknownKeys": ({ keys }) =>
      `Request body has unknown fields: ${keys}.`,
    "request.field.notString": ({ path }) => `${path} must be a string.`,
    "request.field.notBoolean": ({ path }) => `${path} must be a boolean.`,
    "server.internalError": () => "Internal server error.",
  };
}

// key と params から detail の英語の文を作る。
// WHY 引数の params を実行時の形（Record<string, string | number>）で受け取る: 呼び出し元（problem.ts）は DomainError・
//   InvalidRequestError の key と params を渡す。その組はそれぞれのコンストラクタがキーごとの型（ErrorParamsArgs）で縛って
//   作っているが、errors の各要素（ProblemErrorInput）は key と params の対応を型に持たない。ここでキーごとの型を
//   要求すると、呼び出し元に as が散らばる。
// WHY as: key が実行時の値なので、messages[key] はすべてのキーの関数の和になり、そのままでは呼べない。組は上のとおり
//   作る側が正しく作っている。params の無いキーの関数は引数を読まないので、undefined を渡しても壊れない。
export function problemDetail(
  key: ErrorKey,
  params: Readonly<Record<string, string | number>> | undefined,
): string {
  const format = detailMessages()[key] as (
    params: Readonly<Record<string, string | number>> | undefined,
  ) => string;
  return format(params);
}
