# リクエストログ（Issue #80）

画面アクセスとブラウザからの API route 呼び出し（`/api/**`）を、1 リクエスト = JSON 1 行（NDJSON、stdout）で出す。
出す場所は edge 層の Next の Proxy（`apps/frontend/proxy.ts`）。1 行の中身は `apps/frontend/shared/request-log/request-log.ts` の純粋関数 `buildRequestLog` が組み立て、`request-log.test.ts` で固定している。結線（matcher・stdout・応答ヘッダ）は `apps/e2e/request-log.spec.ts`。
規則（置き場所・カバレッジ）は `.claude/rules/frontend.md`・`testing.md`・`architecture-check.md`。

## 決めたこと
- 出す場所は Proxy（ユーザー判断 2026-09-29）。backend の presentation 層のラッパー（status と所要時間が取れる）は採らず、1 行出れば十分とした。
- 出力は `logger.info(line)`（`apps/backend/shared/infra/logger.ts`。Issue #85 で `console.log(JSON.stringify(line))` から変えた）の 1 行（stdout）。ライブラリは入れない。stdout への書き込みは同期で終わるので `event.waitUntil` は使わない。
- 応答ヘッダ `x-request-id` に `requestId` を付け、応答と行を突き合わせられるようにする。

## 1 行の形（5W1H）
| 5W1H | フィールド | 取り方 |
| --- | --- | --- |
| - | `level` | 常に `"info"`。logger が行の先頭に付ける（Issue #85） |
| Who | `requestId` | `x-request-id` ヘッダ（空でなければ）、無ければ `crypto.randomUUID()`。応答ヘッダ `x-request-id` にも付ける |
| Who | `client.ip` / `client.userAgent` | `x-forwarded-for` の先頭（前後の空白を除く）→ `x-real-ip` → `null` / `user-agent` |
| Who | `user.id` | 認証導入まで常に `null`（枠だけ） |
| What | `kind` | パスが `/api` か `/api/` で始まれば `"api"`、それ以外は `"page"`（`/apis`・`/api-docs` は page） |
| What | `method` / `path` / `queryKeys` | メソッド / パス / クエリのキーだけ（出現順、重複は 1 回）。値は出さない（個人情報を避ける） |
| When | `timestamp` | 受信時刻の ISO 8601（UTC）。logger は event の `timestamp` をそのまま使い、`level` の次に置く |
| Where | `host` | `Host` ヘッダ |
| Why | `referer` | `Referer` ヘッダ |
| How | `accept` / `contentType` / `requestBytes` | `Accept` / `Content-Type` / `Content-Length`（0 以上の整数のときだけ数値。読めない値は `null`） |

- ヘッダが無いときは省略せず `null`（どの行も同じキーを持つ）。
- 対象外（matcher の負の一致）: `/_next/static`、`/_next/image`、`favicon.ico`、拡張子付きのパス（`.*\..*`）。
- 対象外（matcher の `missing`）: `next-router-prefetch` ヘッダ付き（next/link のプリフェッチ）、`purpose: prefetch`（ブラウザのプリフェッチ。proxy.md の例に合わせただけで未実測）。

## 一次情報（Next.js 16.3.6 同梱 `apps/frontend/node_modules/next/dist/docs`）
- `01-app/03-api-reference/03-file-conventions/proxy.md`
  - `middleware` は非推奨で `proxy` に改名（v16.0.0）。プロジェクトのルート（`app/` と同じ階層）に `proxy.ts` を置き、`export function proxy(request)` と `export const config = { matcher }`。
  - 既定で Node.js runtime。`runtime` の設定は不可（設定するとエラー）。
  - matcher は定数でなければならない（ビルド時に静的に読む）。`source` と `has` / `missing`（header・query・cookie）を持てる。「Negative matching」の例が `missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }]`。
  - 「RSC requests and rewrites」: RSC リクエストでは `rsc`・`next-router-state-tree`・`next-router-prefetch` ヘッダが `request.headers` から取り除かれる（HTML と RSC の扱いを揃えるため）。
  - `NextFetchEvent.waitUntil` で応答後もログ送信などを続けられる（今回は使わない）。
  - v15 で `request.ip` / `geo` は削除（IP はヘッダから取る）。
- `04-functions/next-response.md`: `NextResponse.next()` で処理を続ける。`NextResponse.next({ request: { headers } })` は上流への要求ヘッダ、`{ headers }` はクライアントへの応答ヘッダ。今回は応答を作ってから `response.headers.set("x-request-id", ...)`。

## 実測（2026-09-29、`pnpm build && pnpm start -p 3100`、Chromium 141）
- curl（`-H "Accept: text/html"` で `/?q=secret`、続けて `/api/todos`）。`favicon.ico`（404）は行が出ない。`client.ip` は `127.0.0.1`（next start が `x-forwarded-for` を付ける）。
  （以下は Issue #80 の時点の行。Issue #85 以降は先頭に `"level":"info"` が付き、`timestamp` が 2 番目に来る。例: `{"level":"info","timestamp":"2026-09-29T02:02:49.774Z","requestId":"d26d2b94-...",...}`）
  ```
  {"requestId":"d26d2b94-cdd9-4d38-a826-c3bee820e1c6","client":{"ip":"127.0.0.1","userAgent":"curl/8.5.0"},"user":{"id":null},"kind":"page","method":"GET","path":"/","queryKeys":["q"],"timestamp":"2026-09-29T02:02:49.774Z","host":"localhost:3100","referer":null,"accept":"text/html","contentType":null,"requestBytes":null}
  {"requestId":"3c79270c-b712-4137-b43a-aa63a3d40de0","client":{"ip":"127.0.0.1","userAgent":"curl/8.5.0"},"user":{"id":null},"kind":"api","method":"GET","path":"/api/todos","queryKeys":[],"timestamp":"2026-09-29T02:02:49.803Z","host":"localhost:3100","referer":null,"accept":"*/*","contentType":null,"requestBytes":null}
  ```
  応答ヘッダに `x-request-id: 3c79270c-b712-4137-b43a-aa63a3d40de0`（行の requestId と同じ）。
- ブラウザ（Playwright）で Todo が 1 件ある `/` を開く → リンクで詳細へ → 戻る。ブラウザが送ったリクエスト（document / fetch）:
  - `GET /`（document）、`GET /api/todos`、`GET /todo/<id>?_rsc=...`（`rsc: 1`・`next-router-prefetch: 1`・`next-router-segment-prefetch: /_tree`）、`GET /todo/<id>?_rsc=...`（`rsc: 1`・`next-router-prefetch: 1`）
  - クリック: `GET /todo/<id>?_rsc=...`（`rsc: 1` だけ）、`GET /api/todos/<id>`、詳細の「一覧」リンクのプリフェッチ `GET /?_rsc=...` × 2
  - 戻る: `GET /api/todos`（`/` の RSC は取り直さない）
- matcher に `missing` が無いとき: 上のリクエストすべてで行が出た。プリフェッチの 4 件も `kind: "page"` で、`queryKeys: []`（`_rsc` は Proxy の URL から消えている）、`accept: "*/*"`、`referer` は開いていた画面。リンクを押す前に、開いていない `/todo/<id>` の行が 2 つ出た（一覧のリンク 1 つにつき 2 行）。
- `rsc` / `next-router-prefetch` ヘッダは `request.headers` に無い（proxy.md のとおり）ので、`proxy()` の中ではプリフェッチとクライアント遷移を見分けられない。`accept` はどちらも `*/*`。
- matcher に `missing`（`next-router-prefetch`）を足した後: プリフェッチの行は出ず、残るのは次の 6 行（計測用の POST を含む。`requestId`・`client`・`timestamp` などは省略）。
  ```
  api  POST /api/todos                 accept */*                         referer null
  page GET  /                          accept text/html,application/...   referer null
  api  GET  /api/todos                 accept */*                         referer http://localhost:3100/
  page GET  /todo/<id>                 accept */*                         referer http://localhost:3100/
  api  GET  /api/todos/<id>            accept */*                         referer http://localhost:3100/todo/<id>
  api  GET  /api/todos                 accept */*                         referer http://localhost:3100/
  ```
- E2E（`apps/e2e/request-log.spec.ts`）で同じ並びを検証している。`missing` を外すと、クリック後の行の一覧にプリフェッチの `/todo/<id>`・`/` の page の行が増えて失敗した。

## 限界
- matcher の `.*\\..*$`（拡張子付きの静的ファイルの除外）は、パスのどこかにドットがあるリクエストを API も含めて除く（例: `/api/todos/a.b` は proxy が動かず行が出ない）。今の ID は uuid なので当たらない（reviewer が manifest の regexp で確認）。上流の `x-request-id` は長さ・形式を検査せずそのまま使う（Headers が CR / LF を拒否し JSON.stringify がエスケープするので注入は起きない）。`Content-Length` が 2^53 を超えると `Number()` で丸まる。
- status と所要時間は取れない: Proxy は応答の前（ルーティングの前）に動く。要るなら backend の presentation 層のラッパー（採らなかった案）か、リバースプロキシのアクセスログを使う。
- クライアント遷移（リンクのクリック）は、document の読み込みと同じ `kind: "page"` になる。見分けは `accept`（document は `text/html` を含む、クライアント遷移は `*/*`）でできるが、`*/*` は curl など非ブラウザからの画面の取得と同じなので `kind` は分けていない。
- ブラウザの戻る・進むで Next のルーターのキャッシュが使われると、画面の行は出ない（出るのは画面が呼ぶ API の行だけ）。
- `client.ip` はヘッダを信じる値。`x-forwarded-for` はクライアントが偽装できるので、信頼できるリバースプロキシの後ろで、そのプロキシがヘッダを付け直す前提で使う。
- Server Functions（Server Actions）は使っていない（`.claude/rules/frontend.md`）。proxy.md の「Good to know」では、その画面のパスへの POST として扱われるので、page の行になるはず（未実測）。
