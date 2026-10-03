import { logger } from "@repo/shared/logger";
import type { z } from "zod";
import { DomainError } from "../error/domain-error";
import { EnglishProblemDetail } from "./problem-detail.en";
import { SameOrigin } from "./same-origin";

// OFREP（OpenFeature Remote Evaluation Protocol）の要求の読み取りと、失敗の応答（Issue #156）。
// 一次情報: https://github.com/open-feature/protocol の service/openapi.yaml（info.version 0.4.0。2026-10-02 に取得）。
// WHY Problem Details（problem.ts）にしない: OFREP のクライアント（@openfeature/ofrep-web-provider 0.4.3 が使う
//   @openfeature/ofrep-core 2.3.0 の OFREPApi）は、失敗の本文の errorCode を読んで OpenFeature のエラー（FLAG_NOT_FOUND など）に
//   変え、本文に key と errorCode が無い 400 / 404 / 500 を「形の違う応答」として扱う（2026-10-02 に npm の tarball の
//   index.esm.js の isEvaluationFailureResponse で確認）。OFREP の 2 本の api（features/feature-flag）だけの例外で、ほかの API は
//   Problem Details のまま。決定と採らなかった案は ADR docs/adr/architecture/20261002-feature-flag-ofrep-hardcoded.md。
// WHY shared/http に置く: Route Handler の入口と出口（problem.ts・json-body.ts と同じ単位）。OFREP の api ファイルの handle は
//   ProblemResponse.wrap ではなく OfrepResponse.wrap で包む（rule-tests/architecture.test.ts の presentation-with-problem-response が
//   features/feature-flag/internal/presentation/ だけに許す例外）。

// OFREP の失敗の errorCode（openapi.yaml の evaluationFailure の enum と、flagNotFound の FLAG_NOT_FOUND）のうち、この API が返すもの。
// WHY TARGETING_KEY_MISSING を持たない: targetingKey の要る規則（利用者ごとの出し分け）がまだ無い。足すときに増やす。
export type OfrepErrorCode =
  | "PARSE_ERROR"
  | "INVALID_CONTEXT"
  | "FLAG_NOT_FOUND"
  | "GENERAL";

// クライアントの誤りによる OFREP の失敗（400）。OfrepResponse.wrap が本文にする。
// key: 1 件の評価（evaluationFailure は key が必須）なら評価しようとした key、一括の評価（bulkEvaluationFailure は key を持たない）
//   なら undefined。
// WHY 404（FLAG_NOT_FOUND）をここで作らない: フラグが無いことは domain が DomainError(not_found, featureFlag.notFound) で表し、
//   wrap が OFREP の形に変える（domain は OFREP を知らない）。
export class OfrepError extends Error {
  constructor(
    readonly status: 400,
    readonly errorCode: Exclude<OfrepErrorCode, "FLAG_NOT_FOUND" | "GENERAL">,
    readonly errorDetails: string,
    readonly key: string | undefined,
  ) {
    super(`${errorCode} ${errorDetails}`);
    this.name = "OfrepError";
  }
}

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

// OFREP の api の handle を包み、handler が投げた例外を OFREP の失敗の応答にする（ProblemResponse.wrap の OFREP 版）。
// WHY 包む口にする: Next の Route Handler には共通の catch が無く、包み忘れると Next の素の 500 が漏れる（problem.ts の
//   ProblemResponse.wrap と同じ）。handle の中に try / catch を書かない規則（handle-without-try-catch）も同じく効く。
export class OfrepResponse {
  // WHY Args を型引数にして引数をそのまま透過する・handler の呼び出しを try の中に置く: ProblemResponse.wrap と同じ
  //   （ctx の型を残す。同期の throw も変換する）。
  static wrap<Args extends [Request, ...unknown[]]>(
    handler: (...args: Args) => Promise<Response>,
  ): (...args: Args) => Promise<Response> {
    return async (...args) => {
      // WHY 別のオリジンからの要求をここでも拒否する（Issue #106）: OFREP の評価は読み取りだが POST で、API は同じオリジンの画面
      //   からだけ呼ぶ前提（GET / HEAD / OPTIONS 以外は Origin を確かめる）を ProblemResponse.wrap と同じく全 API で守る。
      //   形は OFREP の失敗の本文にそろえる（errorCode は evaluationFailure の enum にある GENERAL。openapi.yaml に 403 の定義は無い）。
      //   判定と WHY は same-origin.ts、決定は ADR docs/adr/architecture/20261003-security-headers-and-same-origin-api.md。
      if (SameOrigin.rejects(args[0])) {
        return Response.json(
          {
            errorCode: "GENERAL",
            // WHY problem-detail.en.ts から取る: 英語の文はキーごとに 1 か所（ProblemResponse の 403 と同じ文）。
            errorDetails: EnglishProblemDetail.of(
              "request.origin.forbidden",
              undefined,
            ),
          },
          { status: 403 },
        );
      }
      try {
        return await handler(...args);
      } catch (error) {
        return OfrepResponse.failure(error);
      }
    };
  }

  // 例外を OFREP の失敗の応答にする。
  //   - OfrepError → その status（400）と { key?, errorCode, errorDetails }（key があれば evaluationFailure、無ければ
  //     bulkEvaluationFailure の形）
  //   - フラグが無い DomainError（featureFlag.notFound）→ 404 と { key, errorCode: FLAG_NOT_FOUND, errorDetails }（flagNotFound の形）
  //   - それ以外 → ログに残し、500 と { errorCode: GENERAL, errorDetails }
  // WHY 500 に errorCode: GENERAL を付ける: openapi.yaml の 500 の本文（generalErrorResponse）が定義するのは errorDetails だけだが、
  //   ほかの項目を禁じていない（additionalProperties の指定が無い）。ユーザー指示（Issue #156 のコメント）の形に合わせ、
  //   evaluationFailure の errorCode の enum にある GENERAL を付ける。
  //   限界: key を付けないので、ofrep-core 2.3.0 が errorCode を読むのは一括の評価の 500 だけ（1 件の評価の 500 は key が無いと
  //   「形の違う応答」として扱われる）。web provider は一括の評価だけを使うので実害は無い。
  // WHY Content-Type は application/json（Response.json の既定）: provider は 200 の応答が JSON の MIME でなければ失敗にする。
  private static failure(error: unknown): Response {
    if (error instanceof OfrepError) {
      return Response.json(
        {
          ...(error.key === undefined ? {} : { key: error.key }),
          errorCode: error.errorCode,
          errorDetails: error.errorDetails,
        },
        { status: error.status },
      );
    }
    if (OfrepResponse.isFlagNotFound(error)) {
      return Response.json(
        {
          key: error.params.key,
          errorCode: "FLAG_NOT_FOUND",
          errorDetails: EnglishProblemDetail.of(error.key, error.params),
        },
        { status: 404 },
      );
    }
    // WHY ログに残す・英語の固定の文・event.name を server_error にする: problem.ts の ProblemResponse.from と同じ
    //   （想定外の例外の原因はサーバのログにだけ残し、応答では内部の情報を隠す）。
    logger.emit({
      message: "unexpected error",
      event: { name: "server_error" },
      error,
    });
    return Response.json(
      {
        errorCode: "GENERAL",
        errorDetails: EnglishProblemDetail.of(
          "server.internalError",
          undefined,
        ),
      },
      { status: 500 },
    );
  }

  // WHY key で見分ける（code の not_found だけで見ない）: ほかの not_found（todo.notFound）は OFREP の api からは起きず、起きたら
  //   想定外（500）として気づけるようにする。key が featureFlag.notFound なら params は { key }（DomainError の型が縛る）。
  private static isFlagNotFound(
    error: unknown,
  ): error is DomainError<"featureFlag.notFound"> & {
    params: { key: string };
  } {
    return error instanceof DomainError && error.key === "featureFlag.notFound";
  }
}
