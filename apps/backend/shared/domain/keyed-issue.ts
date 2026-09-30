import type { ErrorKey, ErrorKeyParams, ParamlessErrorKey } from "./error-key";

// zod のスキーマ・refine の引数（{ error } / { error, params }）を、ErrorKey（と params）から作る（Issue #116）。
// WHY error にキーを入れる: zod は error の文字列を issue の message にする。domain の validate（features/todo/internal/domain/todo.ts）は
//   それを DomainError の key に、presentation の toProblemError（shared/presentation/json-body.ts）は Problem の errors の key に戻す。
//   domain は自然言語の文言を持たない（画面がキーを辞書で翻訳する）。
// WHY shared/domain に置く（Issue #144 で todo.ts から移した）: presentation のリクエストのスキーマも、domain と同じ規則
//   （必須・長さ）を同じキーで重ねる（.claude/rules/backend.md の presentation）。feature の domain は presentation から値で
//   import できない（定数を除く。規則 presentation）が、shared の domain は値で import できる。
// WHY この関数を通す（{ error: "todo.title.empty" } と直接書かない）: zod の error は任意の文字列を受け付けるので、
//   キーの打ち間違いを型で止めるため。
// WHY 2 つに分ける（keyedIssue は params の無いキーだけ、keyedRefine は params の要るキーだけ）: 型の検査（z.string など）の
//   issue は params を運ばず、refine の issue（code: "custom"）だけが params をそのまま載せる（zod 4.6.5 の $ZodCustomParams。
//   実測）。1 つの関数で両方を受け付けると、params の要るキーを型の検査に付けても型は通り、実行時に params が落ちる
//   （Issue #116 の reviewer の実測）。keyedIssue は params の無いキーしか受け付けないので、型の検査にも refine にも使える。
//   params の要るキーは keyedRefine でしか作れないので、refine に付ける。
// 残る穴: keyedRefine の結果を型の検査に渡すことは型では止められない（zod の型の検査の引数は、変数・関数の戻り値の
//   余分なプロパティ（params）を拒まない）。keyedRefine は refine の引数にだけ書く。
// WHY params を zod の params で運ぶ（キーと params を JSON にして error に詰めない）: 文字列に詰めて戻すより、
//   文字列の組み立て・解析の誤りが入らない。
export function keyedIssue<K extends ParamlessErrorKey>(key: K) {
  return { error: key };
}

export function keyedRefine<K extends Exclude<ErrorKey, ParamlessErrorKey>>(
  key: K,
  params: ErrorKeyParams[K],
) {
  return { error: key, params };
}
