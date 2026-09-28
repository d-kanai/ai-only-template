// ドメインのルール違反を表す例外。
// WHY Error を継承した専用クラスにする: presentation 層で「想定したルール違反（400 / 404）」と
//   「想定外の例外（500）」を instanceof で見分けるため。ただの Error だと区別できない。
// WHY code を持たせる: HTTP のステータスや画面側の分岐は message（人間向けの文言）ではなく、
//   機械可読な code で決める。文言を変えても挙動が変わらないようにするため。
// WHY domain に置く: domain 層は HTTP を知らない。「何が起きたか」だけを表し、
//   HTTP のステータスへの変換は presentation 層（apps/backend/shared/presentation/http-error.ts）が行う。

// validation_error: 不変条件（例: タイトルの長さ）を満たさない。
// not_found: 指定された集約が存在しない。
// 新しい種類が必要になったらここに足し、http-error.ts の変換表にも対応するステータスを足す。
export type DomainErrorCode = "validation_error" | "not_found";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    // WHY name を上書きする: ログやスタックトレースで Error ではなく DomainError と表示させ、原因の切り分けを早くするため。
    this.name = "DomainError";
    this.code = code;
  }
}
