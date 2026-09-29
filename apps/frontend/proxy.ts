import { logger } from "@repo/shared/logger";
import { type NextRequest, NextResponse } from "next/server";
import { buildRequestLog } from "@/shared/request-log/request-log";

// Next.js の規約ファイル（Proxy。旧 middleware）。ルート（app/ と同じ階層）に置き、matcher に一致するリクエストごとに、
// ルーティングの前に Node.js runtime で 1 回呼ばれる（Next.js 16.3.6 同梱
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md）。
// ここでは画面アクセスとブラウザからの API route 呼び出しを、1 リクエスト = JSON 1 行（stdout）で出す（Issue #80）。
// 出力はサーバ側のログの唯一の出口 logger（apps/shared/logger.ts。Issue #85。Issue #90 で apps/shared に移した）を通す。
// WHY 薄く保つ: 1 行の中身の決め方は shared/request-log/request-log.ts（純粋関数。テストで固定）に置き、ここは NextRequest の
//   値を渡して出力し、応答に x-request-id を付けるだけにする。このファイルは next start / next dev の中でだけ動くので
//   カバレッジの対象外にし（vitest.config.mts）、結線は E2E（apps/e2e/request-log.spec.ts）で確かめる。
// 限界（.claude/rules/frontend.md）: 応答の前に動くので status と所要時間は取れない。
// WHY 第 2 引数（NextFetchEvent）を受け取らない: event.waitUntil を使わないため（下の logger.info の WHY）。
export function proxy(request: NextRequest): NextResponse {
  const log = buildRequestLog({
    method: request.method,
    url: request.url,
    headers: request.headers,
    receivedAt: new Date(),
    generateRequestId: () => crypto.randomUUID(),
  });
  // WHY logger.info（info は stdout）に同期で 1 行: 出力先は stdout の NDJSON だけにし（ログの収集は実行環境に任せる）、
  //   ライブラリを入れない（Issue #80）。stdout への書き込みは同期で終わるので event.waitUntil は使わない。
  //   logger が先頭に level（"info"）を付ける。timestamp は log の受信時刻がそのまま使われる（ADR docs/adr/architecture/20260929-request-log-in-proxy.md の 1 行の形）。
  logger.info(log);
  // WHY 応答ヘッダに x-request-id: ブラウザの開発者ツールや呼び出し側から、応答と stdout の行を突き合わせられるようにする。
  //   NextResponse.next({ headers }) ではなく、応答を作ってから set する（next-response.md の next()）。
  const response = NextResponse.next();
  response.headers.set("x-request-id", log.requestId);
  return response;
}

// matcher: Proxy を動かすパス。Next はビルド時に静的に読むので、定数で書く（proxy.md の「Matcher」）。
//   負の先読みで、Next の静的ファイル（/_next/static）、画像の最適化（/_next/image）、favicon.ico、拡張子の付いた静的ファイル
//   （.*\..*。public/ のファイルなど）を除く。画面（/・/todo/<id>）と /api/** は対象になる。
//   WHY 除く: 画面 1 回の表示で JS・CSS・画像のリクエストが多数あり、ログが「画面アクセス」と「API 呼び出し」だけにならない。
//   missing: next/link のプリフェッチ（next-router-prefetch ヘッダ付きの RSC の取得）と、ブラウザのプリフェッチ（purpose: prefetch）
//   では Proxy を動かさない（proxy.md の「Negative matching」の例と同じ書き方。purpose の方は例に合わせただけで未実測）。
//   WHY: 一覧に表示されたリンクごとに /todo/<id> の page の行が 2 つずつ（segment の _tree と本体）出て、利用者が開いていない
//   画面のアクセスが記録された（2026-09-29 実測。同日の work-logs「docs/ から移した記録」）。Proxy の中では rsc / next-router-prefetch ヘッダが
//   request.headers から取り除かれ、URL の _rsc も消えるので、proxy() の中では見分けられない。matcher の missing は取り除く前の
//   ヘッダで判定され、プリフェッチの行が消えることを実測した。リンクを押したときのクライアント遷移（RSC の取得。プリフェッチの
//   ヘッダ無し）は画面アクセスとして page の行になる（accept は */*。document の読み込みは text/html）。
export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon\\.ico|.*\\..*$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
