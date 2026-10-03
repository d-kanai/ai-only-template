import {
  type ErrorKey,
  type ErrorKeyParams,
  ErrorKeys,
  type ErrorParamsArgs,
} from "../error/error-key";
import type { ProblemErrorInput } from "./problem";

// リクエストの誤りの例外（Problem Details の 400 になる。変換は problem.ts の ProblemResponse.from）。
// WHY problem.ts と分ける（Issue #384。Biome の style/noExcessiveClassesPerFile）: 1 ファイル 1 クラス。応答の形の型
//   （ProblemErrorInput など）は problem.ts に残し、ここからは型だけを参照する。

// InvalidRequestError のコンストラクタの key の後ろの引数: キーごとの params（無いキーは省略）と、項目ごとの誤り。
//   例: new InvalidRequestError("request.body.notJson") / new InvalidRequestError("request.field.notString", { path }, errors)
// WHY export する: key が実行時に決まるとき（json-body.ts が zod の issue から作るとき）に、この型へ as で合わせるため。
export type InvalidRequestArgs<K extends ErrorKey> = [
  ...ErrorParamsArgs<K>,
  errors?: ProblemErrorInput[],
];

// リクエストの誤り（JSON でない、項目の型が違う、未知の項目がある、presentation で重ねた必須・長さの違反など）を表す例外。
// WHY DomainError と分ける: 形の誤りは HTTP の入力の問題で、ドメインのルール違反ではない。
//   domain 層にリクエストの都合を持ち込まないよう、presentation 層の中で閉じた例外にする。
//   クライアントから見れば「入力が不正」で同じなので、レスポンスは /problems/validation-error・400 にそろえる。
// WHY errors を持てるようにする（zod の ZodError をそのまま投げない）: ProblemResponse.from が zod を知らずに済み、
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
    super(ErrorKeys.describe(key, params));
    this.name = "InvalidRequestError";
    this.key = key;
    this.params = params;
    this.errors = errors;
  }
}
