import type { ErrorKey } from "@repo/backend/shared/presentation/problem";
import { commonMessages } from "@/shared/i18n/common.messages";
import {
  formatMessage,
  type MessageKey,
  type RuntimeParams,
} from "@/shared/i18n/i18n";
import type { Locale } from "@/shared/i18n/locale";

// API の失敗を表す例外と、失敗を画面の文言にする関数（Issue #116）。
// WHY todo-api.ts と別のファイルにする: 画面・hook のテストは vi.mock("@/features/todo/api/todo-api") でファイルごと自動モックする。
//   同じファイルに置くと ApiError のコンストラクタもモックされ、テストで key を持つ ApiError を作れない。

// 共通の辞書（shared/i18n/common.messages.ts）のキーであることを型引数の制約で確かめるだけの型。
// WHY: backend の ErrorKey にキーが足されて共通の辞書に無いと、ここがコンパイルエラーになる。
//   shared/i18n/ は backend を参照できない（rule-tests/architecture.test.ts の規則。型だけでも不可）ので、
//   ErrorKey と辞書を突き合わせるのは backend の型を参照してよい features/<f>/api/ のここで行う。
type TranslatedKey<K extends MessageKey<typeof commonMessages>> = K;

// ApiError が持つキー: サーバが返す ErrorKey と、画面側だけのキー error.unknown（本文が Problem Details でないとき）。
// WHY 共通の辞書のキー全体にしない: API の失敗ではないキー（error.unexpected。fetch そのものの失敗）を ApiError として作れないよう、
//   サーバが返しうるキーと error.unknown に絞る。
export type ApiErrorKey = TranslatedKey<ErrorKey | "error.unknown">;

// ApiError を作るときの値。
export type ApiErrorInit = {
  // HTTP の応答のステータス（本文の status ではない。todo-api.ts の toError）。
  status: number;
  // Problem Details（RFC 9457）の type（"/problems/not-found" など。apps/backend/shared/presentation/problem.ts）。
  //   本文が Problem Details でない失敗（error.unknown）では分からないので省く。
  type?: string;
  key: ApiErrorKey;
  params?: RuntimeParams;
};

// API が失敗したときに todo-api.ts が投げる例外。画面は key と params を辞書で翻訳して表示する（toErrorMessage）。
// WHY status と type を持つ（Issue #126）: 画面が文言以外で失敗の種類を見分けられるようにする（404 なら一覧へ戻す、など）。
//   type は文字列のまま持つ（backend の ProblemType の和にしない）: サーバの JSON から来る値で、実行時に和のどれかとは
//   確かめない（todo-api.ts の isProblem）。
// WHY Problem Details の detail を持たない: detail は開発者向けの英語で、画面には出さない（契約外。画面の文言は key の翻訳）。
// WHY message に文言を入れない: 文言はロケールで決まり、例外を作る時点（api/）ではロケールを知らない。message には key を入れ、
//   ログや開発者ツールで何のエラーかだけが分かるようにする。
// WHY params は実行時の値の型（RuntimeParams）: サーバの JSON から来るので、キーごとの params の型を実行時には保証できない。
//   キーと params の名前の対応は、backend の ErrorKeyParams と辞書の placeholder の型の突き合わせ（api-error.test.ts）で止める。
// WHY 引数をオブジェクト 1 つにする: status・type・key・params の 4 つを位置で渡すと、type を省くときに順序を取り違えやすい。
export class ApiError extends Error {
  readonly status: number;
  readonly type: string | undefined;
  readonly key: ApiErrorKey;
  readonly params: RuntimeParams;

  constructor({ status, type, key, params = {} }: ApiErrorInit) {
    super(key);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.key = key;
    this.params = params;
  }
}

// 失敗の理由（catch で受けた値）を、画面のロケールの文言にする。
// ApiError はキーと params を共通の辞書で翻訳する。それ以外（fetch そのものの失敗の TypeError など）は固定の文言（error.unexpected）。
// WHY ApiError 以外の Error の message を出さない: ブラウザが作る英語の message（"Failed to fetch"）は、ロケールに合わない。
// WHY formatMessage（型付きの t ではない）: key が実行時の値（サーバの JSON）なので、キーごとの params の型で呼べない。
export function toErrorMessage(reason: unknown, locale: Locale): string {
  return reason instanceof ApiError
    ? formatMessage(commonMessages, locale, reason.key, reason.params)
    : formatMessage(commonMessages, locale, "error.unexpected");
}
