import type { ErrorKey } from "@repo/backend/shared/http/problem";
import type { commonMessages } from "@/shared/i18n/common.messages";
import type { MessageKey, RuntimeParams } from "@/shared/i18n/i18n";

// API の失敗を表す例外（ApiError）（Issue #116）。失敗を画面の文言にするクラス（ApiErrorMessage）は api-error-message.ts。
// WHY todo-api.ts と別のファイルにする: 画面・hook のテストは vi.mock("@/features/todo/api/todo-api") でファイルごと自動モックする。
//   同じファイルに置くと ApiError のコンストラクタもモックされ、テストで key を持つ ApiError を作れない。
// WHY ApiErrorMessage を別のファイルにする（Issue #384）: 1 ファイル 1 クラス（Biome の style/noExcessiveClassesPerFile）。

// 共通の辞書（shared/i18n/common.messages.ts）のキーであることを型引数の制約で確かめるだけの型。
// WHY: backend の ErrorKey にキーが足されて共通の辞書に無いと、ここがコンパイルエラーになる。
//   shared/i18n/ は backend を参照できない（rule-tests/architecture.test.ts の規則。型だけでも不可）ので、
//   ErrorKey と辞書を突き合わせるのは backend の型を参照してよい features/<f>/api/ のここで行う。
type TranslatedKey<K extends MessageKey<typeof commonMessages>> = K;

// ApiError が持つキー: サーバが返す ErrorKey と、画面側だけのキー error.unknown（本文が Problem Details でないとき）。
// WHY 共通の辞書のキー全体にしない: API の失敗ではないキー（error.unexpected。fetch そのものの失敗）を ApiError として作れないよう、
//   サーバが返しうるキーと error.unknown に絞る。
export type ApiErrorKey = TranslatedKey<ErrorKey | "error.unknown">;

// 400 の項目ごとの誤り 1 件（Problem Details の拡張メンバー errors の要素。apps/backend/shared/http/problem.ts の ProblemError）。
// pointer は誤りのある項目を指す JSON Pointer（RFC 6901）の URI の fragment の形（"#/title"。本文全体は "#"）。
// WHY key を ErrorKey に絞る（error.unknown を含めない）: 項目ごとの誤りはサーバが返すものだけで、画面側だけのキーは入らない。
// WHY detail を持たない: ApiError と同じく、開発者向けの英語で画面に出さない（契約外）。
export type ApiFieldError = {
  pointer: string;
  key: TranslatedKey<ErrorKey>;
  params: RuntimeParams;
};

// ApiError を作るときの値。
export type ApiErrorInit = {
  // HTTP の応答のステータス（本文の status ではない。todo-api.ts の toError）。
  status: number;
  // Problem Details（RFC 9457）の type（"/problems/not-found" など。apps/backend/shared/http/problem.ts）。
  //   本文が Problem Details でない失敗（error.unknown）では分からないので省く。
  type?: string;
  key: ApiErrorKey;
  params?: RuntimeParams;
  // 400 の項目ごとの誤り（本文の errors）。本文に無ければ省く。
  errors?: readonly ApiFieldErrorInit[];
};

// errors の要素を渡すときの形。params は本文と同じく省略できる（ApiError が空のオブジェクトにする）。
type ApiFieldErrorInit = Omit<ApiFieldError, "params"> & {
  params?: RuntimeParams;
};

// API が失敗したときに todo-api.ts が投げる例外。画面は key と params を辞書で翻訳して表示する（ApiErrorMessage.toMessage）。
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
  readonly errors: readonly ApiFieldError[];

  // WHY errors の要素を作り直す（渡された配列をそのまま持たない）: todo-api.ts は本文の errors（detail を含む JSON）を
  //   そのまま渡す。pointer・key・params だけを取り出して detail を持たず、params の省略を空のオブジェクトにそろえる
  //   （本文の params と同じ扱い）。
  constructor({ status, type, key, params = {}, errors = [] }: ApiErrorInit) {
    super(key);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.key = key;
    this.params = params;
    this.errors = errors.map((error) => ({
      pointer: error.pointer,
      key: error.key,
      params: error.params ?? {},
    }));
  }
}
