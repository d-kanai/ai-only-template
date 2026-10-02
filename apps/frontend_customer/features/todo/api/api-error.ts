import type { ErrorKey } from "@repo/backend/shared/http/problem";
import { commonMessages } from "@/shared/i18n/common.messages";
import {
  formatMessage,
  type MessageKey,
  type RuntimeParams,
} from "@/shared/i18n/i18n";
import type { Locale } from "@/shared/i18n/locale";

// API の失敗を表す例外（ApiError）と、失敗を画面の文言にするクラス（ApiErrorMessage）（Issue #116）。
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

// ApiErrorMessage.toMessages の戻り値（フォーム全体の文言 form と、項目ごとの文言 fields）。
export type ErrorMessages<F extends string> = {
  form: string | null;
  fields: Partial<Record<F, string>>;
};

// 失敗の理由を画面の文言にする（toMessage・toMessages）。
// WHY クラスの static メソッドにする（最上位の関数にしない）: frontend の React 以外のモジュールもクラスを基本にする（規則 class-based。
//   ADR docs/adr/architecture/20261002-class-based-frontend-modules.md）。状態を持たないのでインスタンスは作らない。
// WHY ApiError の static にしない: ApiError は例外の値で、文言にするのは画面の都合（ロケール）。ApiError 以外の失敗（fetch の
//   TypeError）も受けるので、例外のクラスの外に置く。
export class ApiErrorMessage {
  // 失敗の理由（catch で受けた値）を、画面のロケールの文言にする。
  // ApiError はキーと params を共通の辞書で翻訳する。それ以外（fetch そのものの失敗の TypeError など）は固定の文言（error.unexpected）。
  // WHY ApiError 以外の Error の message を出さない: ブラウザが作る英語の message（"Failed to fetch"）は、ロケールに合わない。
  // WHY formatMessage（型付きの t ではない）: key が実行時の値（サーバの JSON）なので、キーごとの params の型で呼べない。
  static toMessage(reason: unknown, locale: Locale): string {
    return reason instanceof ApiError
      ? formatMessage(commonMessages, locale, reason.key, reason.params)
      : formatMessage(commonMessages, locale, "error.unexpected");
  }

  // 失敗の理由を、フォーム全体に出す文言（form）と、入力の下に出す項目ごとの文言（fields）に分けて、画面のロケールで翻訳する。
  // fields には、その画面が入力を描く項目の名前（リクエストの本文の最上位のキー。"title" など）を渡す。
  // - errors の無い失敗（404・500・JSON でない応答・fetch の失敗）: form に toMessage の文言、fields は空。
  // - errors のある失敗（400 の形・値の誤り）: pointer が "#/<項目名>" の誤りはその項目の文言に、それ以外
  //   （本文全体の "#"、描いていない項目、入れ子の位置）は form に出す。
  // WHY 項目の文言があるときに本文の key（全体の文言）を重ねない: 本文の key は errors の最初の 1 件と同じ（problem.ts の
  //   Problem の key）で、両方を出すと同じ文言が入力の下とフォームの上に 2 回出る。form には項目に結び付かない誤りだけを出す。
  // WHY 項目に結び付かない誤りを捨てない: 画面に入力の無い項目の誤りを捨てると、何も表示されないまま送信に失敗したように見える。
  // WHY pointer を "#/" + 項目名と完全一致で比べる（JSON Pointer を解析しない）: 画面の入力は本文の最上位の項目だけで、
  //   項目名は英字の識別子（~ や / を含まず、RFC 6901 のエスケープが要らない）。入れ子の位置（"#/title/0"）は項目の入力に
  //   結び付けず form に出す。
  // WHY 項目ごと・form とも最初の 1 件だけ: 入力の下とフォームの上には文言を 1 つずつ出す。backend の errors は zod の issue の
  //   順で本文の key は最初の 1 件（apps/backend/shared/http/json-body.ts）。今の画面が送る本文（項目 1 つ）では、
  //   同じ項目の誤りも、本文全体の誤り（"#" の notObject と unknownKeys は同時に起きない）も 1 件までしか返らない。
  // WHY F を型引数にする: 呼び出し側（hook）が渡した項目名だけを fields のキーにし、画面が fieldErrors.title を型で読めるようにする。
  static toMessages<F extends string>(
    reason: unknown,
    locale: Locale,
    fields: readonly F[],
  ): ErrorMessages<F> {
    if (!(reason instanceof ApiError) || reason.errors.length === 0) {
      return { form: ApiErrorMessage.toMessage(reason, locale), fields: {} };
    }
    const fieldMessages: Partial<Record<F, string>> = {};
    const formMessages: string[] = [];
    for (const error of reason.errors) {
      const message = formatMessage(
        commonMessages,
        locale,
        error.key,
        error.params,
      );
      const field = fields.find((name) => error.pointer === `#/${name}`);
      if (field === undefined) {
        formMessages.push(message);
      } else {
        fieldMessages[field] ??= message;
      }
    }
    return { form: formMessages[0] ?? null, fields: fieldMessages };
  }
}
