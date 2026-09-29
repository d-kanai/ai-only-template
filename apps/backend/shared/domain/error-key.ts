// エラーの種類を表す安定したキーと、キーごとの params の形（Issue #116。設計 (a)）。
// WHY 自然言語の文言ではなくキーで表す: 文言を決めるのは画面（言語・言い回し）の仕事で、domain / API は「何が起きたか」だけを
//   機械可読に返す。画面側（apps/frontend）はキーを辞書で翻訳する。言語を足しても backend は変わらない。
// WHY domain に置く: DomainError（domain）が使うため。presentation の ErrorResponse も同じ型を使い、http-error.ts から
//   export type で再公開する（画面は @repo/backend/shared/presentation/http-error だけを import できる。exports は変えない）。
// キーの形: "<領域>.<対象>.<理由>" の dot 区切り（領域 = todo / request / server）。一度公開したキーは画面の辞書が
//   参照するので、名前を変えない（変えるときは画面の辞書と同じ変更で）。
// params: 各キーで形を固定する。文言に埋め込む値（上限の文字数・id・項目名）だけを持つ。値は JSON に載せて画面に渡すので
//   string か number だけにする（ErrorResponse の params の型）。params の無いキーは Record<string, never>（空）にする。
// キーを足すときはこの型に足す。画面の辞書はこの型から作るので、訳の書き忘れは画面側の型エラーで止まる。
export type ErrorKeyParams = {
  // Todo の不変条件（todo.ts の todoPropsSchema）。
  "todo.title.empty": Record<string, never>;
  "todo.title.tooLong": { max: number };
  // title が文字列でない。presentation が z.string で弾くので、型を as で偽ったときだけ通る。
  "todo.title.invalid": Record<string, never>;
  "todo.id.invalid": Record<string, never>;
  "todo.completed.invalid": Record<string, never>;
  "todo.createdAt.invalid": Record<string, never>;
  // 指定した id の Todo が無い（uuid の形でない id も同じ。resource-id.ts）。
  "todo.notFound": { id: string };
  // リクエストの形の誤り（presentation の json-body.ts）。
  "request.body.notJson": Record<string, never>;
  "request.body.notObject": Record<string, never>;
  // keys: 定義されていない項目名を ", " で連結した文字列（例 "a, b"）。WHY 配列にしない: params の値は string か number
  //   だけにして、画面の辞書の埋め込み（{keys}）をそのまま使えるようにする。
  "request.body.unknownKeys": { keys: string };
  // path: 誤りのある項目（入れ子は . 区切り。ErrorIssue の path と同じ）。
  "request.field.notString": { path: string };
  "request.field.notBoolean": { path: string };
  // 想定外の例外（500）。内部の情報は返さない（http-error.ts）。
  "server.internalError": Record<string, never>;
};

export type ErrorKey = keyof ErrorKeyParams;

// キー K に渡す params の残り引数の型。params の無いキー（Record<string, never>）は省略でき、あるキーは必須にする。
//   例: new DomainError("not_found", "todo.notFound", { id }) / new DomainError("validation_error", "todo.title.empty")
// WHY [params?: undefined] にする（[] にしない）: params の後ろに引数を続ける InvalidRequestError（key, params, issues）で、
//   params の無いキーにも位置を空けて issues を渡せるようにする（new InvalidRequestError(key, undefined, issues)）。
//   params の要るキーには undefined を渡せない。
// WHY K で分配する（K extends ErrorKey ? ...）: キーが 1 つに決まる呼び出し（リテラル）は、そのキーの形だけを受け付ける。
//   キーが ErrorKey（和）のとき（zod の issue から戻すとき）は、どれかのキーの形なら通る（実行時の値からキーを決めるので、
//   その組が正しいことは組を作った側（スキーマの宣言）の型が守る）。
export type ErrorParamsArgs<K extends ErrorKey> = K extends ErrorKey
  ? ErrorKeyParams[K] extends Record<string, never>
    ? [params?: undefined]
    : [params: ErrorKeyParams[K]]
  : never;

// Error#message に入れる開発者向けの文字列（ログ・スタックトレース用）。例: todo.notFound {"id":"..."}
// WHY 自然言語にしない: 画面に出す文言は画面の辞書が決める。message は原因の切り分けに使うだけなので、キーと params を
//   そのまま読める形にする（ログから画面の辞書を引ける）。
export function describeErrorKey(
  key: ErrorKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  return params === undefined ? key : `${key} ${JSON.stringify(params)}`;
}
