# CSP は単体テストで CSP Evaluator に評価させ、すべての応答に CORP と COEP を足す

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #379 / Issue #106 / `apps/frontend_customer/shared/security/security-headers.ts` / `apps/frontend_customer/shared/security/security-headers.test.ts` / `apps/e2e/spec/security-headers.feature` / architecture/20261003-security-headers-and-same-origin-api.md

## 背景
Issue #106 でセキュリティヘッダと CSP を入れた（architecture/20261003-security-headers-and-same-origin-api.md）。値は単体テストで丸ごと固定しているが、固定は「今の値から変わった」ことしか分からず、変えた値が弱いかどうかはレビューの目に頼っていた。Issue #379 で、ヘッダを外部のツールで評価すること、まだ付けていないヘッダ（Cross-Origin-Resource-Policy・Cross-Origin-Embedder-Policy・Trusted Types）を足せるかを調べた。

## 決定
- `SecurityHeaders.common()`（すべての応答）に `Cross-Origin-Resource-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` を足す。E2E は値に加えて、画面が `crossOriginIsolated` になること・失敗した読み込み（COEP / CORP が止めたもの）が 0 件であることを確かめる。
- 本番の CSP を、`security-headers.test.ts` で npm `csp_evaluator`（Google の CSP Evaluator。apps/frontend_customer の devDependencies）の既定の検査と strict CSP の検査にかけ、重大度 MEDIUM_MAYBE 以上の指摘を 0 件にする。除く指摘は種類と値で名指しする: `'self'` の SCRIPT_ALLOWLIST_BYPASS、UNSAFE_INLINE_FALLBACK、ALLOWLIST_FALLBACK（どれも 'strict-dynamic' を解さない古いブラウザ向けで、Next.js 16 の対応ブラウザでは効かない。理由はテストの WHY）。開発の CSP（'unsafe-eval'）が指摘されることも確かめる。
- Trusted Types（`require-trusted-types-for 'script'`）は入れない（CSP Evaluator の INFO の指摘のまま残す）。
- 動いているアプリのヘッダの受け身の検査は ZAP（quality/20261003-zap-passive-scan-via-e2e.md）が担い、ここでは値の強さを単体テストで、ブラウザで効くことを E2E で見る（分担）。

## 理由
- CORP / COEP: 画面も API も同じオリジンからしか使わず、CSP も読み込み先を 'self' に絞っているので、壊すものが無い（E2E で止めた読み込み 0 件を確かめた。2026-10-03 の work-logs）。ほかのサイトのページから応答を `<script>` / `<img>` で読み込ませず、Spectre のような side channel の入口を塞ぐ。
- CSP Evaluator を単体テストで: ブラウザもサーバも要らず、値を変えた PR の `pnpm test`（CI の ci ジョブ）でその場で止まる。依存は 0 で Apache-2.0。
- 除く指摘を名指しする: 種類ごと・重大度ごとに外すと、同じ種類の別の問題（script-src の別のホストの抜け道）まで黙って通る。
- Trusted Types を見送る: Turbopack の実行時のチャンク読み込みが `script.src` に文字列を入れ、Mantine 9.6.3 が `style.innerHTML` を使うので、強制すると画面が壊れる（https://github.com/vercel/next.js/discussions/95772 ）。

## 採用しなかった案
- CSP Evaluator の Web 版を手で使う: 値を変えるたびに人が貼り付ける必要があり、忘れても止まらない。
- STRICT_CSP の指摘に従い、script-src に古いブラウザ向けの `'unsafe-inline'`・`https:` を足す: 対応ブラウザでは何も変わらず、値を読む人とほかの検査（ZAP の CSP の規則）には弱く見える。
- Trusted Types を report-only で入れる: 報告の送り先が無く、違反を集める仕組みも無い。

## 影響
- 良い点: CSP を弱める変更（'unsafe-inline'・短い nonce・base-uri の欠け・抜け道のあるホスト）が、値の固定に加えて種類の名前付きで止まる。COEP / CORP で別のオリジンからの読み込み・埋め込みが止まる。
- 悪い点: 外部の画像・フォント・スクリプトを足すときは、相手が CORP（か CORS）を返さないと COEP で止まる。CSP Evaluator の版を上げると指摘の種類・重大度が変わりうる（テストが落ちて見直す）。
- 見直す条件: 外部のリソースを読み込むことになったら、COEP を `credentialless` にするかを決め直す。Next.js（Turbopack）と Mantine が Trusted Types に対応したら、入れるかを決め直す。
