import { logger } from "@repo/shared/logger";
import { DomainError } from "../error/domain-error";
import { OfrepError } from "./ofrep-error";
import { EnglishProblemDetail } from "./problem-detail.en";
import { SameOrigin } from "./same-origin";

// OFREP（OpenFeature Remote Evaluation Protocol）の失敗の応答（Issue #156）。下の WHY は OFREP の要求の読み取り（ofrep-request.ts）と
//   失敗（ofrep-error.ts）にも共通する。
// 一次情報: https://github.com/open-feature/protocol の service/openapi.yaml（info.version 0.4.0。2026-10-02 に取得）。
// WHY Problem Details（problem.ts）にしない: OFREP のクライアント（@openfeature/ofrep-web-provider 0.4.3 が使う
//   @openfeature/ofrep-core 2.3.0 の OFREPApi）は、失敗の本文の errorCode を読んで OpenFeature のエラー（FLAG_NOT_FOUND など）に
//   変え、本文に key と errorCode が無い 400 / 404 / 500 を「形の違う応答」として扱う（2026-10-02 に npm の tarball の
//   index.esm.js の isEvaluationFailureResponse で確認）。OFREP の 2 本の api（features/feature-flag）だけの例外で、ほかの API は
//   Problem Details のまま。決定と採らなかった案は ADR docs/adr/architecture/20261002-feature-flag-ofrep-hardcoded.md。
// WHY shared/http に置く: Route Handler の入口と出口（problem.ts・json-body.ts と同じ単位）。OFREP の api ファイルの handle は
//   ProblemResponse.wrap ではなく OfrepResponse.wrap で包む（rule-tests/architecture.test.ts の presentation-with-problem-response が
//   features/feature-flag/internal/presentation/ だけに許す例外）。
// WHY 1 ファイル 1 クラスに分ける（Issue #384。Biome の style/noExcessiveClassesPerFile）: 失敗の errorCode と例外は ofrep-error.ts、
//   要求の本文の読み取りは ofrep-request.ts、失敗の応答（OfrepResponse）はこのファイル。

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
