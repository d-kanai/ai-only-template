// リクエストログ（1 リクエスト = JSON 1 行、5W1H）の 1 行を組み立てる純粋関数（Issue #80。キーの名前は Issue #209）。
// 出力するのは apps/frontend_customer/proxy.ts（Next の規約ファイル）。ここは受け取った値から 1 行の中身を決めるだけで、
// 時刻の取得・乱数・出力をしない。WHY: 仕様（各項目の取り方）をテストで丸ごと固定し、proxy.ts を薄く保つため。
// 仕様の表は Issue #80、決定は ADR docs/adr/architecture/20260929-request-log-in-proxy.md（キーの名前は 20260930-log-format-cloud-logging-otel.md）、限界（status と所要時間が取れない、RSC のリクエストの扱い）は .claude/rules/frontend.md。

// 1 行の JSON の形。項目は Issue #80 の表（5W1H）、キーの名前は OTel semconv の HTTP の名前を入れ子にしたもの（Issue #209。
//   https://opentelemetry.io/docs/specs/semconv/http/http-spans/ 。ADR docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）。
// WHY OTel の名前: 独自の名前（以前の requestId・kind・path など）だと、ログの基盤やほかのツールに移ったときに対応表が要る。
//   OTel semconv は業界共通の名前で、ECS も統合が進んでいる（2026-09-30 の work-logs「ログの規格の調査結果」）。
// WHY 入れ子のオブジェクト（"http.request.method" の平らなキーにしない）: Logs Explorer で jsonPayload.http.request.method と
//   書ける。平らなキーは引用符が要る。
// WHY ヘッダ由来の項目を null にする（省略しない）: どの行も同じキーを持たせ、集計側で「無かった」と「出し忘れ」を区別するため。
//   trace の 3 つだけは例外で、traceparent が無ければキーごと出さない（下の traceFields の WHY）。
// WHY apps/shared の型（LogEventName）を import しない: apps/frontend_customer/shared/ から apps/shared は参照しない（規則
//   screen-to-shared）。event.name の値が一覧（apps/shared/log-event.ts）にあることは、この値を logger.info に渡す proxy.ts の
//   型チェックが見る（一覧に無い名前なら pnpm typecheck が落ちる）。
export type RequestLog = {
  // Logs Explorer の一覧に出る 1 行（Cloud Logging の特別フィールド）。"<METHOD> <path>"（クエリは含めない。下の url の WHY）。
  message: string;
  // What: ログの種類。/api/** は api_request（ブラウザからの API route 呼び出し）、それ以外は page_request（画面アクセス）
  event: { name: "page_request" | "api_request" };
  // When: 受信時刻（RFC 3339、UTC）。logger はこの time を現在時刻より優先する
  time: string;
  http: {
    request: {
      // Who: リクエストの相関 ID（上流の x-request-id か、無ければ生成した値。応答ヘッダ x-request-id にも付ける）
      id: string;
      method: string;
      // Why: referer（どの画面から来たか）/ How: accept・content-type
      header: {
        referer: string | null;
        accept: string | null;
        "content-type": string | null;
      };
      // How: Content-Length（バイト）
      body: { size: number | null };
    };
  };
  // What: パスと、クエリのキーだけ。WHY 値を出さない: 検索語・メールアドレスなどの個人情報をログに残さないため
  //   （query_keys は OTel に無い名前。OTel の url.query は値を含むので使わない）
  url: { path: string; query_keys: string[] };
  // Who: 接続元。address は x-forwarded-for の先頭 → x-real-ip → null
  client: { address: string | null };
  user_agent: { original: string | null };
  // Where: Host ヘッダのまま（ポートを含みうる。OTel の server.address はポートを含まない名前だが、分けずにそのまま出す）
  server: { address: string | null };
  // Who: 認証が入るまで常に null（枠だけ先に用意し、後で埋めてもログの形を変えずに済むようにする）
  user: { id: null };
} & TraceFields;

// Cloud Logging の特別フィールドの trace（https://docs.cloud.google.com/logging/docs/agent/logging/configuration#special-fields ）。
//   Logs Explorer でリクエストの行を Cloud Trace のトレースに結び付け、同じトレースの行をまとめて見られるようにする。
type TraceFields = {
  // projects/<プロジェクト ID>/traces/<trace-id>
  "logging.googleapis.com/trace"?: string;
  // traceparent の parent-id（16 桁の 16 進数。Cloud Logging の spanId と同じ形）
  "logging.googleapis.com/spanId"?: string;
  // trace-flags の sampled（最下位ビット）
  "logging.googleapis.com/trace_sampled"?: boolean;
};

export type RequestLogInput = {
  method: string;
  // 絶対 URL（NextRequest の request.url）。
  url: string;
  // NextRequest の request.headers（Headers）か、テスト用の record。
  headers: Headers | Record<string, string>;
  receivedAt: Date;
  // x-request-id が無いときだけ呼ぶ。proxy.ts は crypto.randomUUID を渡す。
  generateRequestId: () => string;
  // trace の projects/<プロジェクト ID>/ に入れる GCP のプロジェクト ID。proxy.ts は env.GCP_PROJECT_ID を渡す。
  // WHY 引数で受け取る（ここで env を読まない）: apps/frontend_customer/shared/ は apps/shared（env）を参照しない（規則
  //   screen-to-shared）。純粋関数のままにし、テストで値を決められるようにする。
  projectId: string;
};

export function buildRequestLog(input: RequestLogInput): RequestLog {
  // WHY Headers に揃える: Headers は名前の大文字・小文字を区別せずに引け、record（テスト）でも同じ読み方になる。
  const headers = new Headers(input.headers);
  const url = new URL(input.url);
  return {
    message: `${input.method} ${url.pathname}`,
    event: { name: requestEventName(url.pathname) },
    time: input.receivedAt.toISOString(),
    http: {
      request: {
        id: nonEmpty(headers.get("x-request-id")) ?? input.generateRequestId(),
        method: input.method,
        header: {
          referer: headers.get("referer"),
          accept: headers.get("accept"),
          "content-type": headers.get("content-type"),
        },
        body: { size: contentLength(headers.get("content-length")) },
      },
    },
    url: {
      path: url.pathname,
      // WHY 重複を除く: ?a=1&a=2 のような同じキーの繰り返しは、キーの種類を見る用途では 1 つで足りる。
      query_keys: [...new Set(url.searchParams.keys())],
    },
    client: { address: clientIp(headers) },
    user_agent: { original: headers.get("user-agent") },
    server: { address: headers.get("host") },
    user: { id: null },
    ...traceFields(headers.get("traceparent"), input.projectId),
  };
}

// traceparent から trace の 3 つのキーを作る。形が違えば何も出さない（空のオブジェクト）。
// WHY traceparent を読む: Cloud Run はリクエストに W3C の traceparent を自動で付ける（https://docs.cloud.google.com/run/docs/trace ）。
//   アプリの行を Cloud Run のリクエストログ（基盤が出す行）とトレースに結び付けるには、アプリの行に logging.googleapis.com/trace を
//   書く（https://docs.cloud.google.com/run/docs/logging の「Write structured logs」の例。例は X-Cloud-Trace-Context を読むが、
//   W3C の標準の traceparent にそろえる）。実機（Cloud Run）での結び付きは未確認。
// WHY 形が違えば出さない（null も入れない）: W3C の仕様は、形の違う・すべて 0 の trace-id / parent-id の traceparent を無視する
//   ことを求める（MUST ignore）。null のキーを残すと、Cloud Logging が trace として読もうとする値が行に入る。
// WHY version は 00 だけ: 今の仕様の版で、ほかの版は項目の並びが違いうる。版が上がったらここを見直す。
function traceFields(
  traceparent: string | null,
  projectId: string,
): TraceFields {
  // W3C Trace Context の traceparent（https://www.w3.org/TR/trace-context/#traceparent-header ）の version 00 の形。
  //   16 進数は小文字だけ（HEXDIGLC）。前後に余分な文字があれば一致させない（^ と $）。
  // WHY 関数の中に書く（最上位の定数にしない）: 最上位の値は Stryker の static な変異になり、ignoreStatic で検査から外れる。
  const match = traceparent?.match(
    /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/,
  );
  if (!match) {
    return {};
  }
  const [, traceId, spanId, flags] = match;
  if (isAllZero(traceId) || isAllZero(spanId)) {
    return {};
  }
  return {
    "logging.googleapis.com/trace": `projects/${projectId}/traces/${traceId}`,
    "logging.googleapis.com/spanId": spanId,
    // WHY 最下位ビットだけを見る: sampled は trace-flags の bit 0（W3C の FLAG_SAMPLED = 1）。ほかのビットは別の意味を持ちうる。
    "logging.googleapis.com/trace_sampled":
      (Number.parseInt(flags, 16) & 1) === 1,
  };
}

function isAllZero(hex: string): boolean {
  return /^0+$/.test(hex);
}

// WHY "/api" 自体と "/api/" で始まるものだけ: Route Handler は app/api/ の下にあり、"/apis" や "/api-docs" のような
//   前方一致だけが同じパスは画面として扱う（apps/frontend_customer/app/ の構成と同じ区切り）。
function requestEventName(pathname: string): RequestLog["event"]["name"] {
  return pathname === "/api" || pathname.startsWith("/api/")
    ? "api_request"
    : "page_request";
}

// WHY x-forwarded-for の先頭: プロキシを経るごとに右に追記されるので、先頭が最初の接続元（クライアント）になる。
//   Next.js v15 で request.ip は削除され、ヘッダから取るしかない（proxy.md）。ヘッダは偽装できるので、信頼できる
//   プロキシの後ろで動かす前提の値（.claude/rules/frontend.md の限界: 信頼できるリバースプロキシがヘッダを付け直す前提）。
function clientIp(headers: Headers): string | null {
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0].trim();
  return nonEmpty(forwardedFor) ?? nonEmpty(headers.get("x-real-ip"));
}

// WHY 数字だけのときに限る: Content-Length は 0 以上の整数（RFC 9110）。読めない値を Number() や parseInt で推測すると
//   "12abc" が 12、"" が 0 になり、実際と違うバイト数を記録してしまう。
// WHY value?.match: null の検査を別の条件に書くと、RegExp.test(null) が "null" として偽になるため、検査を消す変異が
//   結果を変えない（等価な変異として Stryker に残る）。
function contentLength(value: string | null): number | null {
  return value?.match(/^\d+$/) ? Number(value) : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value ? value : null;
}
