import { logger } from "@repo/shared/logger";
import { DomainError, type DomainErrorCode } from "../error/domain-error";
import type { ErrorKey, ErrorKeyParams } from "../error/error-key";
import { InvalidRequestError } from "./invalid-request-error";
import { EnglishProblemDetail } from "./problem-detail.en";
import { SameOrigin } from "./same-origin";

// エラー応答を RFC 9457（Problem Details for HTTP APIs。https://www.rfc-editor.org/rfc/rfc9457.html ）の形にする（Issue #126）。
// WHY RFC 9457 に準拠する（ユーザー判断）: HTTP API のエラー本文の標準で、Spring の ProblemDetail・ASP.NET Core の
//   ProblemDetails が実装し、Zalando の API ガイドラインが MUST にしている（一次情報は 2026-09-29 の work-logs）。
//   独自の形（Issue #126 の前の、error の中に code・key・params と項目ごとの誤りを入れた形）だと、クライアントや汎用のツールが形を個別に知る必要がある。
//   決定と採用しなかった案は ADR docs/adr/architecture/20260929-error-response-rfc9457.md。

// WHY ここから再公開する: 画面（apps/frontend_customer）が backend から import してよいのは apps/backend/package.json の exports に
//   書いたファイルだけで、shared/error/error-key.ts は公開していない。画面の辞書はキーと params の形をこの型から作る
//   （キーを足すと画面の辞書が型エラーで追従を求める。Issue #116）。exports を増やさずに済むよう、Problem と同じ
//   このファイルから出す。
export type { ErrorKey, ErrorKeyParams };

// 文言に埋め込む値。JSON に載せて画面に渡すので string か number だけ（error-key.ts の ErrorKeyParams の各形もこれに収まる）。
type ErrorParams = Record<string, string | number>;

// エラーの種類（type）。RFC 9457 の 3.1.1 節: type は問題の種類を表す URI 参照（相対参照でもよい）で、クライアントは
//   これを種類の主な識別子に使う。
// WHY about:blank を使わない: about:blank は「HTTP ステータス以外に意味を持たない」ことを表す（4.2.1 節）。クライアントが
//   種類で分岐できるよう、種類ごとに固定の値にする。
// WHY 相対参照（/problems/...）: 3.1.1 節は絶対 URI を推奨するが、絶対 URI にするとドメインを決める必要があり、環境
//   （ローカル・本番）で変わる。相対参照にするときは完全なパス（"/types/123" のように / から）を含めることも推奨されて
//   おり、それに従う（パスの途中からの相対参照は、応答した URL ごとに別の URI に解決されてしまう）。
//   解決できる文書は今は置いていない（3.1.1 節: type は解決できない URI でもよい）。
export type ProblemType =
  | "/problems/validation-error"
  | "/problems/not-found"
  | "/problems/forbidden"
  | "/problems/internal-error";

// 項目ごとの誤り 1 件（RFC 9457 の 3 節の例の errors の要素と同じ形。拡張メンバー）。
// WHY zod の issue をそのまま返さない: code・expected・keys などは zod の内部の語彙で、zod の版で変わりうる。
//   クライアントとの契約はどこが（pointer）・なぜ（key と params）に固定し、開発者向けの英語（detail）を添える。
export type ProblemError = {
  // 誤りのある項目を指す JSON Pointer（RFC 6901）の URI の fragment の形。例: "#/title"、入れ子は "#/tags/1"。
  //   本文全体の誤り（オブジェクトでない・未知の項目）は "#"（文書全体）。組み立ては json-body.ts の toPointer。
  pointer: string;
  key: ErrorKey;
  params?: ErrorParams;
  // 開発者向けの英語（problem-detail.en.ts）。画面には出さない（契約外）。
  detail: string;
};

// InvalidRequestError（invalid-request-error.ts）が持つ項目ごとの誤り。detail は ProblemResponse.from が足す。
// WHY detail を後で足す: 英語の文を作る場所を ProblemResponse.from の 1 か所にし、例外を作る側（json-body.ts）に
//   英語の文言の都合を持ち込まない。
export type ProblemErrorInput = Omit<ProblemError, "detail">;

// エラー時のレスポンス本文（Content-Type: application/problem+json）。全 API で同じ形にする。
// 標準のメンバー（type・title・status・detail・instance）と、このアプリの拡張メンバー（key・params・errors）。
// WHY 画面は key と params だけで分岐・翻訳する（detail を読まない）: detail は開発者向けの英語で、言い回しを変えても
//   画面が壊れないよう契約に含めない（Issue #126。画面の文言は画面の辞書だけが持つ。Issue #116）。
export type Problem = {
  type: ProblemType;
  // 種類ごとに固定の英語の短い要約。RFC 9457 の 3.1.3 節: 発生ごとに変えない（翻訳を除く）。翻訳はしない。
  title: string;
  // HTTP のステータスと同じ値（RFC 9457 の 3.1.2 節: 生成側は実際のステータスと同じ値にしなければならない）。
  status: number;
  // この発生に固有の説明（RFC 9457 の 3.1.4 節）。key と params から作る英語（problem-detail.en.ts）。
  detail: string;
  // この発生を指す URI 参照。リクエストの URL のパス。クエリは含めない（リクエストログと同じ方針でクエリの値は出さない。Issue #85。
  //   パスの id は params.id と detail にも出るので、パスを隠す理由にはならない）。
  instance: string;
  // 何が起きたかを表す安定したキー（error-key.ts）。画面はこれを辞書で翻訳し、分岐にも使う。
  //   errors があるときは、その最初の 1 件の key と同じ（errors を読まない画面も 1 つの文言を出せる）。
  key: ErrorKey;
  // 文言に埋め込む値（上限の文字数・id など）。params の無いキーでは本文にキーごと出さない。
  params?: ErrorParams;
  // presentation の zod スキーマ（リクエストの形と、domain と同じキーで重ねた必須・長さ。Issue #144）の誤りのときだけ付く、
  //   項目ごとの誤りの一覧（Issue #88）。
  // WHY presentation の誤りだけ: domain の不変条件の誤り（DomainError）は key 1 つで、domain はリクエストの項目名を知らない
  //   （domain にリクエストの都合を持ち込まない）。項目ごとに返したい値の規則は presentation のスキーマで重ねる
  //   （.claude/rules/code/backend.md の「入力検証」の表の「リクエスト」）。JSON として読めない誤りも項目が無いので付けない。
  // WHY 省略可能にする（空配列にしない）: 誤りが項目に結び付かないとき（404・500・JSON でない）は一覧自体が無い。
  errors?: ProblemError[];
};

// 応答の種類。DomainError の code と、別のオリジンからの書き込みの拒否（forbidden。Issue #106）と、想定外の例外（internal_error）。
// WHY forbidden を DomainErrorCode に足さない: オリジンは HTTP の要求の性質で、domain の規則ではない（InvalidRequestError と同じ理由）。
type ProblemCategory = DomainErrorCode | "forbidden" | "internal_error";

// 応答の本文に入れる、何が起きたか（key と params）と項目ごとの誤り（errors）。ProblemResponse の respond が受け取る。
// WHY 1 つの値にまとめる（Issue #384。Biome の complexity/useMaxParams）: respond の引数が 5 個になっていた。key・params・errors は
//   どれも例外（DomainError・InvalidRequestError）が持つ「何が起きたか」の中身で、種類（category）と要求（request）とは役割が違う。
type ProblemContent = {
  key: ErrorKey;
  params?: ErrorParams;
  errors?: ProblemErrorInput[];
};

// 例外を Problem Details の Response にする変換（from）と、api の handle を包む口（wrap）。
// WHY クラスの static メソッドにする: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。状態を持たない変換なので static にし、api ファイルは
//   `readonly handle = ProblemResponse.wrap(async (request[, ctx]) => { ... })` と書く。
export class ProblemResponse {
  // WHY Record<ProblemCategory, ...> にする: DomainErrorCode に種類を足したとき、ここに type・title・status を書き忘れると
  //   型エラーになり、変換漏れを防げる。
  // WHY メソッドの中に置く（モジュールの最上位の定数・static フィールドにしない）: どちらも読み込み時にだけ評価される static な変異になり、
  //   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる（Issue #55）。
  private static problemKindOf(
    category: ProblemCategory,
  ): Pick<Problem, "type" | "title" | "status"> {
    const problemKinds: Record<
      ProblemCategory,
      Pick<Problem, "type" | "title" | "status">
    > = {
      validation_error: {
        type: "/problems/validation-error",
        title: "Validation error",
        status: 400,
      },
      not_found: {
        type: "/problems/not-found",
        title: "Not found",
        status: 404,
      },
      forbidden: {
        type: "/problems/forbidden",
        title: "Forbidden",
        status: 403,
      },
      internal_error: {
        type: "/problems/internal-error",
        title: "Internal error",
        status: 500,
      },
    };
    return problemKinds[category];
  }

  // WHY params・errors が undefined でも分岐しない: JSON.stringify は値が undefined のプロパティを出力しないので、
  //   本文に params・errors のキーが出ない（problem.test.ts・各 api のテストで toStrictEqual により確かめている）。
  // WHY Content-Type を application/problem+json にする: RFC 9457 の 3 節が定めるメディア型で、汎用の HTTP クライアントや
  //   ツールが Problem Details と見分ける手がかりになる（Response.json の既定は application/json）。画面の fetch は
  //   Content-Type を見ずに response.json() で読むので、変えても読める。
  private static respond(
    category: ProblemCategory,
    request: Request,
    { key, params, errors }: ProblemContent,
  ): Response {
    const kind = ProblemResponse.problemKindOf(category);
    const problem: Problem = {
      ...kind,
      detail: EnglishProblemDetail.of(key, params),
      instance: new URL(request.url).pathname,
      key,
      params,
      errors: errors?.map((error) => ({
        ...error,
        detail: EnglishProblemDetail.of(error.key, error.params),
      })),
    };
    return Response.json(problem, {
      status: kind.status,
      headers: { "content-type": "application/problem+json" },
    });
  }

  // presentation の各 API の handle が投げた例外（ProblemResponse.wrap が捕まえたもの）を Problem Details の Response に変換する。
  //   変換の規則をここ 1 か所に集める。
  // WHY request を受け取る: instance（この発生を指す URI 参照）にリクエストのパスを入れるため。
  static from(error: unknown, request: Request): Response {
    if (error instanceof DomainError) {
      return ProblemResponse.respond(error.code, request, {
        key: error.key,
        params: error.params,
      });
    }
    if (error instanceof InvalidRequestError) {
      return ProblemResponse.respond("validation_error", request, {
        key: error.key,
        params: error.params,
        errors: error.errors,
      });
    }
    // WHY ログに残す: 想定外の例外は原因を調べる必要がある。レスポンスでは詳細を隠すので、
    //   サーバのログ（stderr の 1 行の JSON）にだけ残す。ログはすべて logger を通す（.claude/rules/code/backend.md の「ログ」）。
    //   Error は logger が { type, message } にする（stack は出さない）。
    // WHY 英語の固定の文言: ログは開発者が読むもので、apps/backend の非テストコードには日本語を置かない（Issue #116）。
    // WHY event.name を server_error にする（Issue #209。apps/shared/log-event.ts）: API の想定外の例外（500）を 1 つの種類で引け、
    //   アラートの条件にできる。DomainError など 400 / 404 の行は出さないので、この名前の行はすべてサーバ側の不具合の候補。
    logger.emit({
      message: "unexpected error",
      event: { name: "server_error" },
      error,
    });
    // WHY 固定のキーと detail にする: 例外の message には内部の情報（接続先、SQL など）が含まれうるため、クライアントに返さない。
    return ProblemResponse.respond("internal_error", request, {
      key: "server.internalError",
    });
  }

  // presentation の各 api の handle（Route Handler）を包み、handler が投げた例外を ProblemResponse.from で Problem Details の
  //   Response にする（Issue #141）。各 api は `readonly handle = ProblemResponse.wrap(async (request[, ctx]) => { ... })` と書く。
  // WHY 包む口（handler を受け取り同じ形の関数を返す）にする: 以前は 5 本の api が同じ try { ... } catch (error) { return ProblemResponse.from(error, request); } を
  //   手書きしていた。Next の Route Handler には共通の catch が無い（Proxy は handler の例外を捕まえず、instrumentation の
  //   onRequestError は記録するだけ）ので、1 本でも書き忘れると Problem Details ではない Next の素の 500 がクライアントに漏れる。
  //   書き忘れは規則 presentation-with-problem-response（rule-tests/architecture.test.ts）が止める。
  // WHY handle の意味（Route Handler そのもの）と形（アロー関数のプロパティ）は変えない: 戻り値は handler と同じ引数の関数なので、
  //   `export const GET = new ListTodosApi(...).handle` の組み立ても、テストの `.handle(request)` もそのまま使える。
  //   包む対象はアロー関数のままなので、中の this はインスタンスを指し続ける。
  // WHY Args を型引数にして引数をそのまま透過する: (request) と (request, ctx: { params: Promise<...> }) の両方の handler を
  //   同じ関数で包み、ctx の型（動的セグメントの名前）を呼び出し側に残すため。先頭は Request に固定する（instance に使う）。
  // WHY RequestBody.parse や await ctx.params を共通化しない（ユーザー判断）: 本文の有無・動的セグメントの有無と、id と本文を
  //   確かめる順番（rename-todo.api.ts・change-todo-completion.api.ts は id を先に見て 404 を優先する）が api ごとに違い、handler の中に書いた方が
  //   その api の処理を 1 か所で読める。ここは例外の変換だけを受け持つ。
  // WHY handler の呼び出しを try の中に置く（handler(...args).catch(...) にしない）: async でない handler が同期で throw
  //   しても、同じく Problem Details にするため。
  static wrap<Args extends [Request, ...unknown[]]>(
    handler: (...args: Args) => Promise<Response>,
  ): (...args: Args) => Promise<Response> {
    return async (...args) => {
      // WHY 別のオリジンからの書き込みをここで拒否する（Proxy にしない。Issue #106）: wrap は OFREP 以外のすべての api の handle が
      //   通る 1 か所で（包み忘れは規則 presentation-with-problem-response が止める。OFREP の api は ofrep.ts の OfrepResponse.wrap が
      //   同じ判定をする）、拒否の応答をほかの誤りと同じ Problem Details に
      //   できる。Proxy（apps/frontend_customer/proxy.ts）は単体テストのカバレッジの外で、backend の Problem の形も持たない。
      //   判定と WHY は same-origin.ts、決定は ADR docs/adr/architecture/20261003-security-headers-and-same-origin-api.md。
      if (SameOrigin.rejects(args[0])) {
        return ProblemResponse.respond("forbidden", args[0], {
          key: "request.origin.forbidden",
        });
      }
      try {
        return await handler(...args);
      } catch (error) {
        return ProblemResponse.from(error, args[0]);
      }
    };
  }
}
