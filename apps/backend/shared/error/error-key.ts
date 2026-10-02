// エラーの種類を表す安定したキーと、キーごとの params の形（Issue #116。設計 (a)）。
// WHY 自然言語の文言ではなくキーで表す: 文言を決めるのは画面（言語・言い回し）の仕事で、domain / API は「何が起きたか」だけを
//   機械可読に返す。画面側（apps/frontend_customer）はキーを辞書で翻訳する。言語を足しても backend は変わらない。
// WHY domain に置く: DomainError（domain）が使うため。presentation の Problem（problem.ts）も同じ型を使い、problem.ts から
//   export type で再公開する（画面は @repo/backend/shared/http/problem だけを import できる。exports は増やさない）。
// キーの形: "<領域>.<対象>.<理由>" の dot 区切り（領域 = todo / featureFlag / request / server）。一度公開したキーは画面の辞書が
//   参照するので、名前を変えない（変えるときは画面の辞書と同じ変更で）。
// params: 各キーで形を固定する。文言に埋め込む値（上限の文字数・id・項目名）だけを持つ。値は JSON に載せて画面に渡すので
//   string か number だけにする（Problem の params の型）。params の無いキーは Record<string, never>（空）にする。
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
  // 完了の履歴（statusChanges）が不変条件（1 件以上・日時の昇順・最初は作成日時以上・最後の completed が今の completed と同じ）を
  //   満たさない（Issue #188）。利用者の入力からは作れず、DB の行（reconstruct）を読んだときだけ起きる（Repository が 500 にする）。
  "todo.statusChanges.invalid": Record<string, never>;
  // 指定した id の Todo が無い（uuid の形でない id も同じ。resource-id.ts）。
  "todo.notFound": { id: string };
  // 指定した key のフィーチャーフラグが一覧に無い（Issue #156。features/feature-flag/internal/domain/feature-flags.ts）。
  //   API は Problem Details ではなく OFREP の FLAG_NOT_FOUND（404）で返す（shared/http/ofrep-response.ts）。
  "featureFlag.notFound": { key: string };
  // リクエストの形の誤り（presentation の json-body.ts）。
  "request.body.notJson": Record<string, never>;
  "request.body.notObject": Record<string, never>;
  // keys: 定義されていない項目名を ", " で連結した文字列（例 "a, b"）。WHY 配列にしない: params の値は string か number
  //   だけにして、画面の辞書の埋め込み（{keys}）をそのまま使えるようにする。
  "request.body.unknownKeys": { keys: string };
  // path: 誤りのある項目（入れ子は . 区切り。json-body.ts が組み立てる。機械が項目を指すのは Problem の errors の pointer）。
  "request.field.notString": { path: string };
  "request.field.notBoolean": { path: string };
  // 想定外の例外（500）。内部の情報は返さない（problem.ts）。
  "server.internalError": Record<string, never>;
};

export type ErrorKey = keyof ErrorKeyParams;

// params を持たないキー（ErrorKeyParams の値が Record<string, never>）。
// WHY 分ける: zod の型の検査（z.string など）の issue は params を運ばない（refine の custom の issue だけが載せる。zod 4.6.5）。
//   型の検査に付けられるキーをこれに限り、params の要るキーを付けて実行時に params が落ちるのを型で止める（shared/error/keyed-issue.ts の KeyedIssue.of）。
export type ParamlessErrorKey = {
  [K in ErrorKey]: ErrorKeyParams[K] extends Record<string, never> ? K : never;
}[ErrorKey];

// ErrorKey の実行時の一覧（ErrorKeys.includes が使う）。型の ErrorKeyParams は実行時に残らないので、同じ集合を値でも持つ。
// WHY satisfies readonly ErrorKey[]: ErrorKeyParams に無いキー（打ち間違い）を型エラーにする。
// 足し忘れ（ErrorKeyParams にあって、ここに無いキー）は error-key.test.ts の型の検査（toEqualTypeOf）が pnpm typecheck で止める。
//   WHY テストで検査する: satisfies は「要素がどれも ErrorKey」だけを見て、網羅は見ない。網羅を型で書くには使われない
//   型エイリアスが要るので、テスト（expectTypeOf）に置く。
// キーを足すときは ErrorKeyParams とここの両方に足す。
export const ERROR_KEYS = [
  "todo.title.empty",
  "todo.title.tooLong",
  "todo.title.invalid",
  "todo.id.invalid",
  "todo.completed.invalid",
  "todo.createdAt.invalid",
  "todo.statusChanges.invalid",
  "todo.notFound",
  "featureFlag.notFound",
  "request.body.notJson",
  "request.body.notObject",
  "request.body.unknownKeys",
  "request.field.notString",
  "request.field.notBoolean",
  "server.internalError",
] as const satisfies readonly ErrorKey[];

// キー K に渡す params の残り引数の型。params の無いキー（Record<string, never>）は省略でき、あるキーは必須にする。
//   例: new DomainError("not_found", "todo.notFound", { id }) / new DomainError("validation_error", "todo.title.empty")
// WHY [params?: undefined] にする（[] にしない）: params の後ろに引数を続ける InvalidRequestError（key, params, errors）で、
//   params の無いキーにも位置を空けて errors を渡せるようにする（new InvalidRequestError(key, undefined, errors)）。
//   params の要るキーには undefined を渡せない。
// WHY K で分配する（K extends ErrorKey ? ...）: キーが 1 つに決まる呼び出し（リテラル）は、そのキーの形だけを受け付ける。
//   キーが ErrorKey（和）のとき（zod の issue から戻すとき）は、どれかのキーの形なら通る（実行時の値からキーを決めるので、
//   その組が正しいことは組を作った側（スキーマの宣言）の型が守る）。
export type ErrorParamsArgs<K extends ErrorKey> = K extends ErrorKey
  ? ErrorKeyParams[K] extends Record<string, never>
    ? [params?: undefined]
    : [params: ErrorKeyParams[K]]
  : never;

// ErrorKey を実行時に扱う処理（実行時の文字列がキーかの判定と、開発者向けの文字列）。
// WHY クラスの static メソッドにする: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。状態を持たない変換なので static にする。
export class ErrorKeys {
  // 実行時の文字列が ErrorKey かを確かめる。zod の issue の message（キーを付け忘れた項目では zod の英語の文言）を
  //   DomainError の key に戻す前に使う（shared/error/validate.ts の DomainValidation.validated・json-body.ts）。
  // WHY 配列の includes で判定する（オブジェクトのプロパティで引かない）: "constructor" など Object.prototype の名前を
  //   キーと取り違えない。
  static includes(value: string): value is ErrorKey {
    return (ERROR_KEYS as readonly string[]).includes(value);
  }

  // Error#message に入れる開発者向けの文字列（ログ・スタックトレース用）。例: todo.notFound {"id":"..."}
  // WHY 自然言語にしない: 画面に出す文言は画面の辞書が決める。message は原因の切り分けに使うだけなので、キーと params を
  //   そのまま読める形にする（ログから画面の辞書を引ける）。
  static describe(
    key: ErrorKey,
    params?: Readonly<Record<string, string | number>>,
  ): string {
    return params === undefined ? key : `${key} ${JSON.stringify(params)}`;
  }
}
