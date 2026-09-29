import type { ErrorKey } from "@repo/backend/shared/presentation/http-error";
import type { Locale } from "@/shared/i18n/locale";
import {
  formatMessage,
  type MessageKey,
  type RuntimeParams,
} from "@/shared/i18n/messages";

// API の失敗を表す例外と、失敗を画面の文言にする関数（Issue #116）。
// WHY todo-api.ts と別のファイルにする: 画面・hook のテストは vi.mock("@/features/todo/api/todo-api") でファイルごと自動モックする。
//   同じファイルに置くと ApiError のコンストラクタもモックされ、テストで key を持つ ApiError を作れない。

// 辞書のキーであることを型引数の制約で確かめるだけの型。
// WHY: backend の ErrorKey にキーが足されて画面の辞書（shared/i18n/messages/ja.ts）に無いと、ここがコンパイルエラーになる。
//   shared/i18n/ は backend を参照できない（rule-tests/architecture.test.ts の規則。型だけでも不可）ので、
//   ErrorKey と辞書を突き合わせるのは backend の型を参照してよい features/<f>/api/ のここで行う。
type TranslatedKey<K extends MessageKey> = K;

// ApiError が持つキー: サーバが返す ErrorKey と、画面側だけのキー error.unknown（本文が ErrorResponse でないとき）。
// WHY MessageKey 全体にしない: 画面の文言（"todo.item.delete" など）を API のエラーとして作れないよう、失敗の意味を持つキーに絞る。
export type ApiErrorKey = TranslatedKey<ErrorKey | "error.unknown">;

// API が失敗したときに todo-api.ts が投げる例外。画面は key と params を辞書で翻訳して表示する（toErrorMessage）。
// WHY message に文言を入れない: 文言はロケールで決まり、例外を作る時点（api/）ではロケールを知らない。message には key を入れ、
//   ログや開発者ツールで何のエラーかだけが分かるようにする。
// WHY params は実行時の値の型（RuntimeParams）: サーバの JSON から来るので、キーごとの params の型を実行時には保証できない。
//   キーと params の名前の対応は、backend の ErrorKeyParams と辞書の placeholder の型の突き合わせ（api-error.test.ts）で止める。
export class ApiError extends Error {
  readonly key: ApiErrorKey;
  readonly params: RuntimeParams;

  constructor(key: ApiErrorKey, params: RuntimeParams = {}) {
    super(key);
    this.name = "ApiError";
    this.key = key;
    this.params = params;
  }
}

// 失敗の理由（catch で受けた値）を、画面のロケールの文言にする。
// ApiError はキーと params を翻訳する。それ以外（fetch そのものの失敗の TypeError など）は固定の文言（error.unexpected）。
// WHY ApiError 以外の Error の message を出さない: ブラウザが作る英語の message（"Failed to fetch"）は、ロケールに合わない。
// WHY formatMessage（型付きの t ではない）: key が実行時の値（サーバの JSON）なので、キーごとの params の型で呼べない。
export function toErrorMessage(reason: unknown, locale: Locale): string {
  return reason instanceof ApiError
    ? formatMessage(locale, reason.key, reason.params)
    : formatMessage(locale, "error.unexpected");
}
