// リクエストログ（1 リクエスト = JSON 1 行、5W1H）の 1 行を組み立てる純粋関数（Issue #80）。
// 出力するのは apps/frontend/proxy.ts（Next の規約ファイル）。ここは受け取った値から 1 行の中身を決めるだけで、
// 時刻の取得・乱数・出力をしない。WHY: 仕様（各項目の取り方）をテストで丸ごと固定し、proxy.ts を薄く保つため。
// 仕様の表は Issue #80、決定は ADR docs/adr/architecture/20260929-request-log-in-proxy.md、限界（status と所要時間が取れない、RSC のリクエストの扱い）は .claude/rules/frontend.md。

// 1 行の JSON の形。フィールド名は Issue #80 の表のとおり（5W1H）。
// WHY ヘッダ由来の項目を null にする（省略しない）: どの行も同じキーを持たせ、集計側で「無かった」と「出し忘れ」を区別するため。
export type RequestLog = {
  // Who: リクエストの相関 ID（上流の x-request-id か、無ければ生成した値。応答ヘッダ x-request-id にも付ける）
  requestId: string;
  // Who: 接続元。ip は x-forwarded-for の先頭 → x-real-ip → null
  client: { ip: string | null; userAgent: string | null };
  // Who: 認証が入るまで常に null（枠だけ先に用意し、後で埋めてもログの形を変えずに済むようにする）
  user: { id: null };
  // What: /api/** は "api"（ブラウザからの API route 呼び出し）、それ以外は "page"（画面アクセス）
  kind: "page" | "api";
  method: string;
  path: string;
  // What: クエリのキーだけ。WHY 値を出さない: 検索語・メールアドレスなどの個人情報をログに残さないため
  queryKeys: string[];
  // When: 受信時刻（ISO 8601、UTC）
  timestamp: string;
  // Where: Host ヘッダ
  host: string | null;
  // Why: Referer ヘッダ（どの画面から来たか）
  referer: string | null;
  // How: Accept / Content-Type / Content-Length
  accept: string | null;
  contentType: string | null;
  requestBytes: number | null;
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
};

export function buildRequestLog(input: RequestLogInput): RequestLog {
  // WHY Headers に揃える: Headers は名前の大文字・小文字を区別せずに引け、record（テスト）でも同じ読み方になる。
  const headers = new Headers(input.headers);
  const url = new URL(input.url);
  return {
    requestId:
      nonEmpty(headers.get("x-request-id")) ?? input.generateRequestId(),
    client: {
      ip: clientIp(headers),
      userAgent: headers.get("user-agent"),
    },
    user: { id: null },
    kind: requestKind(url.pathname),
    method: input.method,
    path: url.pathname,
    // WHY 重複を除く: ?a=1&a=2 のような同じキーの繰り返しは、キーの種類を見る用途では 1 つで足りる。
    queryKeys: [...new Set(url.searchParams.keys())],
    timestamp: input.receivedAt.toISOString(),
    host: headers.get("host"),
    referer: headers.get("referer"),
    accept: headers.get("accept"),
    contentType: headers.get("content-type"),
    requestBytes: contentLength(headers.get("content-length")),
  };
}

// WHY "/api" 自体と "/api/" で始まるものだけ: Route Handler は app/api/ の下にあり、"/apis" や "/api-docs" のような
//   前方一致だけが同じパスは画面として扱う（apps/frontend/app/ の構成と同じ区切り）。
function requestKind(pathname: string): RequestLog["kind"] {
  return pathname === "/api" || pathname.startsWith("/api/") ? "api" : "page";
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
