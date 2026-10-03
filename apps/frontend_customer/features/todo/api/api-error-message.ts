import { commonMessages } from "@/shared/i18n/common.messages";
import { formatMessage } from "@/shared/i18n/i18n";
import type { Locale } from "@/shared/i18n/locale";
import { ApiError } from "./api-error";

// 失敗を画面の文言にするクラス（ApiErrorMessage）（Issue #116）。例外の ApiError は api-error.ts。
// WHY api-error.ts と別のファイルにする（Issue #384）: 1 ファイル 1 クラス（Biome の style/noExcessiveClassesPerFile）。

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
