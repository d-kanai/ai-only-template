import type { z } from "zod";
import { OfrepError } from "./ofrep-error";
import { EnglishProblemDetail } from "./problem-detail.en";

// OFREP（OpenFeature Remote Evaluation Protocol）の評価の要求の本文の読み取り（Issue #156）。
//   全体の WHY（Problem Details にしない理由・一次情報）は ofrep.ts の冒頭。

// OFREP の評価の要求の本文を読む。
// WHY クラスの static メソッド: backend の本番コードは単独の関数を export しない（ADR docs/adr/architecture/20261002-class-based-backend.md）。
export class OfrepRequest {
  // 本文を JSON として読み、schema（各 api ファイルの requestSchema）で parse した値を返す。誤りは OfrepError（400）にする。
  //   - JSON として読めない（空の本文も）→ PARSE_ERROR
  //   - 本文がオブジェクトでない（配列・null・文字列）→ PARSE_ERROR（評価の要求として読めない）
  //   - context（とその中）の誤り → INVALID_CONTEXT（openapi.yaml の 400 の例が INVALID_CONTEXT）
  // WHY RequestBody.parse（json-body.ts）を使わない: あちらは Problem Details の InvalidRequestError と ErrorKey に変える。OFREP の
  //   errorCode は別の語彙で、errorCode は画面の辞書（ErrorKey）に載せない（provider が errorCode を OpenFeature のエラーに変える）。
  // WHY errorDetails は英語の固定の文か zod の説明: openapi.yaml の errorDetails は人が読むための任意の文（ログ・デバッグ用）で、
  //   provider は分岐に使わない。ErrorKey のある誤りは problem-detail.en.ts の同じ文を使い、英語の文を 2 か所に書かない。
  static async parse<Schema extends z.ZodType>(
    request: Request,
    schema: Schema,
    key: string | undefined,
  ): Promise<z.output<Schema>> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OfrepError(
        400,
        "PARSE_ERROR",
        EnglishProblemDetail.of("request.body.notJson", undefined),
        key,
      );
    }
    const result = schema.safeParse(body);
    if (result.success) {
      return result.data;
    }
    // WHY 最初の issue だけを見る: OFREP の失敗の本文は errorCode を 1 つだけ持つ。失敗した safeParse の issues は 1 件以上ある。
    const [issue] = result.error.issues;
    if (issue.path.length === 0) {
      throw new OfrepError(
        400,
        "PARSE_ERROR",
        EnglishProblemDetail.of("request.body.notObject", undefined),
        key,
      );
    }
    // WHY path が空でなければ context の誤り: スキーマの項目は context だけで、未知の項目は z.object が捨てる（誤りにならない）。
    throw new OfrepError(
      400,
      "INVALID_CONTEXT",
      `Invalid evaluation context at ${issue.path.join(".")}: ${issue.message}.`,
      key,
    );
  }
}
