# リクエストログは Next の Proxy（edge 層）で、1 リクエスト = JSON 1 行（5W1H）で出す

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #80 / PR #81 / `.claude/rules/frontend.md` / `apps/frontend/proxy.ts` / `apps/frontend/shared/request-log/request-log.ts`

## 背景
画面アクセスとブラウザからの API route 呼び出しを、誰が・何を・いつ・どこで・なぜ・どのように呼んだかが分かる 1 行の JSON で残したかった（ユーザーの依頼）。最初の提案は、backend の presentation 層のラッパー（status と所要時間が取れる）だった（2026-09-29 の work-logs「アクセスログ（1 アクセス 1 行の JSON、5W1H）の情報設計を提案した（実装はまだ）」）。

## 決定
- 出す場所は Next の Proxy（`apps/frontend/proxy.ts`）。1 行の中身は純粋関数 `buildRequestLog` が組み立て、logger で 1 行（stdout）出す（20260929-logger-single-exit.md）。
- クエリは値を出さずキーだけ。status と所要時間は出さない。応答ヘッダ `x-request-id` を付け、応答と行を突き合わせられるようにする。
- 静的ファイルと、next/link のプリフェッチ（`next-router-prefetch` ヘッダ）は matcher で除く。クリックによる遷移は `kind: "page"` のまま。

## 理由
- ユーザーの判断（「ログは edge でいい。画面アクセスとブラウザからの API route 呼び出しが 1 行出れば良い」。2026-09-29 の work-logs「リクエストログはユーザー判断で edge 層（Next の proxy.ts）に決まった。Issue #80 を作成」）。
- Proxy は `middleware` を改名したもので、プロジェクトのルートに置き、Node.js runtime で動く。応答の前に動くので status と所要時間は取れない。RSC リクエストでは `rsc` / `next-router-prefetch` ヘッダが取り除かれる（Next.js 16.3.6 同梱 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`）。
- matcher の `missing` が無いと、一覧のリンクのプリフェッチで、開いていない画面の行が出た。proxy の中ではプリフェッチとクリックの遷移を見分けられず、クリックの遷移は curl などの非ブラウザとも区別できない（2026-09-29 の work-logs「Issue #80 のリクエストログを実装した（proxy.ts、実測でプリフェッチを matcher の missing で除外）」）。
- クエリの値は個人情報を含みうる（Issue #80）。

## 採用しなかった案
- backend の presentation 層のラッパー（`withAccessLog`）: status と所要時間は取れるが、1 行出れば十分とした（ユーザー判断）。
- クリックの遷移を `navigation` として分ける: curl などの非ブラウザと区別できない。
- ログのライブラリ（pino / winston など）を入れる: 1 行を stdout に出すだけで足りる（Issue #80）。
- `event.waitUntil` で応答後に出す: stdout への書き込みは同期で終わる。

## 影響
- 良い点: 画面と API の呼び出しが、同じ形の 1 行で残る。
- 悪い点: status と所要時間が無い。matcher の拡張子の除外は、ドットを含む API のパスも除く。`client.ip` はヘッダを信じる値で、信頼できるリバースプロキシの後ろでだけ意味を持つ。ブラウザの戻る・進むでルーターのキャッシュが使われると、画面の行は出ない（PR #81 の reviewer 指摘と限界）。
- 見直す条件: status と所要時間が要るようになったら、presentation 層のラッパーか、リバースプロキシのアクセスログを使う。
