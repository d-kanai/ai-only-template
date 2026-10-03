# セキュリティヘッダを next.config と Proxy で付け、CSP は nonce にし、API は同じオリジンの画面からだけ書き込める形にする

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #106 / `apps/frontend_customer/shared/security/security-headers.ts` / `apps/backend/shared/http/same-origin.ts` / `.claude/rules/code/frontend.md` / `.claude/rules/code/backend.md`

## 背景
基盤の棚卸し（2026-09-29）で、応答に CSP・HSTS・X-Content-Type-Options・Referrer-Policy などが無く、CORS の方針（API を同じオリジンからだけ呼ぶか）も決めていないことが分かった。
画面と API は同じ Next のプロセス（`app/api/**` の Route Handler）で、画面は同じオリジンの `/api/**` だけを fetch する。ログインもセッションもまだ無い。
画面は Mantine（Issue #292）で、部品の見た目を style 属性と `<style>` で付け、配色のインラインスクリプト（`ColorSchemeScript`）を `<head>` に置く。root layout は `headers()` を読むので、全画面がすでに動的レンダリング。

## 決定
- すべての応答に共通のヘッダ（HSTS 2 年 + includeSubDomains・nosniff・Referrer-Policy strict-origin-when-cross-origin・X-Frame-Options DENY・Permissions-Policy・COOP same-origin）を `next.config.ts` の `headers()` で付け、`X-Powered-By` を消す。
- 画面の応答にだけ、要求ごとの nonce を入れた Content-Security-Policy を `proxy.ts` で付ける。script-src は `'self' 'nonce-…' 'strict-dynamic'`（開発のときだけ `'unsafe-eval'`）、style-src は `'self' 'unsafe-inline'`、外への送信先（img / font / connect）は `'self'`、`frame-ancestors 'none'`。
- 値は `shared/security/security-headers.ts`（`SecurityHeaders`）に集め、単体テストで固定する。付いていることと CSP の下で画面が動くことは E2E（`apps/e2e/spec/security-headers.feature`）が確かめる。
- CORS: API は同じオリジンの画面からだけ呼ぶ前提にし、`Access-Control-Allow-*` は返さない。書き込み（GET / HEAD / OPTIONS 以外）で `Origin` のスキーム・ホストが、前段が受けたスキーム（`X-Forwarded-Proto`。無ければ要求の URL）と `Host` と違えば、`ProblemResponse.wrap` が handler の前に 403（`/problems/forbidden`・`request.origin.forbidden`）を返す。OFREP の api（評価は読み取りだが POST）は `OfrepResponse.wrap` が同じ判定で 403（OFREP の失敗の形）を返す。`Origin` の無い要求は通す。
- Proxy の matcher から拡張子の付いたパスの除外（`.*\..*`）を外す。`/todo/abc.x` のような URL も画面として描かれ、除外したままでは CSP の無い画面を開かせられる（reviewer の実測）。同じ理由で、除いたままの `/favicon.ico` には実物（`app/favicon.ico`）を置き、404 の画面として描かせない（Codex の指摘）。

## 理由
- CSP は nonce にする: Next 16 は要求の CSP ヘッダから nonce を読み、自分のスクリプトに自動で付ける（Next.js 16.3.6 同梱 `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`）。nonce の要る動的レンダリングは i18n ですでに受け入れている。hash は、Next が描くインラインスクリプト（RSC の payload の `self.__next_f.push`）の中身がデータで変わるので事前に決められない（コードの読みからの推定で、実測していない）。
- style-src を nonce にしない: CSP の nonce は style 属性には効かず、nonce を書くと `'unsafe-inline'` が無視されて Mantine の style 属性が止まる（https://www.w3.org/TR/CSP3/#allow-all-inline ）。CSS の差し込みでできる外への送信は img / font / connect を `'self'` に絞って塞ぐ。
- 共通のヘッダを next.config に置く: Proxy の matcher は静的ファイル（`/_next/static`）を除くので、JS・CSS の応答に nosniff・HSTS を付けられない。
- オリジンの検査を Proxy でなく `ProblemResponse.wrap` と `OfrepResponse.wrap` に置く: 2 つの wrap はすべての api の handle が通る口で（包み忘れは規則 `presentation-with-problem-response`）、拒否をほかの誤りと同じ Problem Details にでき、単体テストのカバレッジの中にある。CORS は応答を読ませないだけで、フォームの POST や text/plain の fetch はプリフライト無しで届くので、書き込みはサーバで止める必要がある（https://fetch.spec.whatwg.org/#origin-header 、OWASP CSRF Prevention Cheat Sheet の「Verifying Origin With Standard Headers」）。
- Origin を、前段が受けたスキーム（X-Forwarded-Proto）と Host と比べる: Cloud Run は前段で TLS を終えるので、アプリの要求の URL のスキーム（http）はブラウザの Origin（https）と合わない。ただしホストだけだと、同じホストの http のページ（HSTS が効く前の最初の訪問など）からの書き込みを通す（Codex の指摘、PR #366）。スキームは `X-Forwarded-Proto` と比べる（ブラウザのページは別のオリジンへの要求にこのヘッダを付けるとプリフライトになり送れないので、CSRF では偽れない）。

## 採用しなかった案
- CSP を next.config の静的なヘッダにして `'unsafe-inline'` で script を許す: インラインスクリプトの差し込み（XSS）を止められず、CSP の主な効き目が無くなる。
- style-src も nonce にして Mantine に `getStyleNonce` で付けさせる: style 属性（style props・CSS 変数）は nonce で許せず、部品の見た目が崩れる。
- CSRF トークン（double submit cookie など）: ログインもセッションも無い今は、トークンを配る仕組みが Origin の検査より重い。認証を入れるときに見直す。
- Origin の検査を Proxy で行う: 応答を Problem Details にするには Proxy が backend の形を知る必要があり、Proxy は単体テストのカバレッジの外。
- `Sec-Fetch-Site` で判定する: 古いブラウザは送らず、送らない要求の扱いを別に決める必要がある。Origin はすべての主要ブラウザが書き込みに付ける。
- `upgrade-insecure-requests` を付ける: 読み込む先は同じオリジンだけで、本番は HSTS で守る。付けると http で動かすローカル・E2E で同じオリジンの読み込みを https に書き換える。
- HSTS に preload を付ける: ブラウザに焼き込まれ取り消しに時間がかかる。ドメインが決まってから判断する。

## 影響
- 良い点: XSS で差し込まれたスクリプトは動かない。ほかのサイトの iframe に入れられない。ほかのサイトのページから Todo を作る・消すことができない。値はテストで固定され、消えると単体テストと E2E が落ちる。
- 悪い点: 外部のスクリプト・画像・フォント（CDN・解析ツール）を足すときは CSP を広げる必要がある。前段のプロキシが Host を書き換える構成では、同じオリジンの画面の書き込みも 403 になる（Cloud Run で Host が保たれるかは未確認。デプロイ先で確かめる）。ブラウザの文書の先読み（`purpose: prefetch`）は Proxy の matcher の `missing` で除いているので CSP が付かない（今の画面は文書の先読みを出さない。実測はしていない）。ビルド時に静的に出力される `_global-error` の画面は nonce を持たず、CSP の下で返るとスクリプトが止まりうる（返る条件は未確認）。
- 見直す条件: 認証（セッション Cookie）を入れるとき（CSRF の対策と SameSite を合わせて決める）。別のオリジンから API を呼ぶ利用者（別のフロントエンド・モバイル）ができたとき（CORS の許可の一覧を決める）。
