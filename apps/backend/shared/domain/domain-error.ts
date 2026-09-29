import {
  describeErrorKey,
  type ErrorKey,
  type ErrorKeyParams,
  type ErrorParamsArgs,
} from "./error-key";

// ドメインのルール違反を表す例外。
// WHY Error を継承した専用クラスにする: presentation 層で「想定したルール違反（400 / 404）」と
//   「想定外の例外（500）」を instanceof で見分けるため。ただの Error だと区別できない。
// WHY code を持たせる: HTTP のステータスは機械可読な code で決める（http-error.ts の変換表）。
// WHY 文言ではなく key と params を持たせる（Issue #116）: 画面に出す文言は画面側が key を辞書で翻訳して決める。
//   domain は自然言語を持たず「何が起きたか」（key）と、文言に埋め込む値（params）だけを表す。
//   key と params の組はキーごとに型で縛る（error-key.ts の ErrorKeyParams）。
// WHY domain に置く: domain 層は HTTP を知らない。「何が起きたか」だけを表し、
//   HTTP のステータスへの変換は presentation 層（apps/backend/shared/presentation/http-error.ts）が行う。

// validation_error: 不変条件（例: タイトルの長さ）を満たさない。
// not_found: 指定された集約が存在しない。
// 新しい種類が必要になったらここに足し、http-error.ts の変換表にも対応するステータスを足す。
export type DomainErrorCode = "validation_error" | "not_found";

// WHY クラスを K で型引数にする: TypeScript のコンストラクタは自分の型引数を持てないので、key から params の型を
//   決める（ErrorParamsArgs<K>）にはクラスの型引数にする。既定値 ErrorKey により、型引数を書かない DomainError は
//   「どれかのキーの DomainError」を表す（instanceof の絞り込み・catch の引数）。
export class DomainError<K extends ErrorKey = ErrorKey> extends Error {
  readonly code: DomainErrorCode;
  readonly key: K;
  readonly params: ErrorKeyParams[K] | undefined;

  constructor(code: DomainErrorCode, key: K, ...rest: ErrorParamsArgs<K>) {
    // WHY as: rest は K が決まるまで [params?: undefined] か [params: ErrorKeyParams[K]] のどちらか分からない（型の分岐が
    //   遅延する）ので、先頭を取り出した値の型を TypeScript が導けない。どちらの場合も先頭は ErrorKeyParams[K] か undefined。
    const params = rest[0] as ErrorKeyParams[K] | undefined;
    super(describeErrorKey(key, params));
    // WHY name を上書きする: ログやスタックトレースで Error ではなく DomainError と表示させ、原因の切り分けを早くするため。
    this.name = "DomainError";
    this.code = code;
    this.key = key;
    this.params = params;
  }
}
