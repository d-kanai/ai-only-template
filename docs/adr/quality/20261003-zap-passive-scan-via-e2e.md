# 動いているアプリのセキュリティの検査は、E2E を ZAP のプロキシ経由で流し、受け身の検査の警告で CI を落とす

- 日付: 2026-10-03
- 状態: 置き換え（→ quality/20261003-zap-daily-active-scan.md）
- 関連: Issue #364 / Issue #106 / `scripts/security/scan.sh`（`zap-e2e` / `zap-alerts`）/ `scripts/security/zap-ignore.tsv` / `apps/e2e/playwright.config.ts` / `.github/workflows/ci.yml` / `rule-tests/security-scan.test.ts` / quality/20261003-security-scan-tools.md

## 背景
Issue #362 で静的な検査（gitleaks・Semgrep など）を入れたが、動いているアプリの応答（ヘッダ・Cookie・情報の漏れ）を見る検査（DAST）は無かった。repo は private にする予定なので、無料のツールだけを使う（daiki の判断 2026-10-03）。Issue #364 の当初の案は ZAP の baseline scan（クローラで辿った画面を受け身で検査する）だったが、daiki の判断（2026-10-03、Issue #364 のコメント）で「E2E テストを流して検査とする」ことにした。

## 決定
- CI の `ci` ジョブの E2E のステップを `bash scripts/security/scan.sh zap-e2e` にする。scan.sh が ZAP（`zaproxy/zap-stable` を digest で固定）を daemon として起動し、`E2E_PROXY` を渡して `pnpm test:e2e` を流す。Playwright は `E2E_PROXY` があるときだけ、ブラウザと API の呼び出しの通信をそのプロキシに通す。
- ZAP は受け身の検査（passive scan）だけをする。攻撃を送る active scan はしない。
- 判定は Low / Medium / High の警告で失敗、Informational は表示だけ。許容する警告は `scripts/security/zap-ignore.tsv` に alertRef と理由を書いて外す（理由の無い行は誤り）。
- 最初に外したのは CSP の `style-src 'unsafe-inline'`（10055-6）だけ。Mantine が style 属性で見た目を付けるため（Issue #106 の判断。`security-headers.ts`）。

## 理由
- E2E を検査にすると、クローラが辿れない画面・フォームの送信の後の状態・API の応答まで、E2E が実際に触った範囲を検査でき、検査の範囲が E2E の網羅と一緒に広がる（Issue #364 のコメント）。
- 受け身の検査だけにするのは、E2E の結果と時間をほとんど変えないため。2026-10-03 の実測（クラウドセッション）で、ZAP 経由の E2E 11 件は ZAP なしと同じく通り、scan.sh zap-e2e 全体（ZAP の起動・E2E・検査の待ち）は約 31 秒だった。active scan は時間がかかり、DB を書き換えて E2E と干渉する。
- E2E を 1 回だけ流す（E2E のステップを兼ねる）のは、E2E を 2 回流すと CI が延びるため。
- alertRef で外すのは、同じ規則（10055 の CSP）の別の問題（script-src の unsafe-inline など）まで黙って通さないため。
- `-silent` で起動するのは、ZAP の更新の確認などの外への通信で結果を変えないため。クラウドセッションでは受け身の規則「ZAP is Out of Date」が版の問い合わせで止まり、検査が終わらなかった（2026-10-03 実測）。

## 採用しなかった案
- ZAP の baseline scan（`zap-baseline.py`）: クローラは SPA の操作の後の画面や API の書き込みを辿れない。E2E と別に起動したアプリを検査する分、CI が延びる。
- ZAP の full scan（active scan）を CI で: 時間がかかり、攻撃の要求が DB を荒らす。stg への日次の実行は Issue #364 の当初の案のとおり、必要になったら別に決める。
- Schemathesis（OpenAPI を元にした API のファジング）: backend の OpenAPI が要る（#115 の後）。この PR には含めない。
- StackHawk・Dastardly: 無料で使えるかが不確か（Issue #364 の調査）。

## 影響
- 良い点: E2E を足すたびに、その画面と API の応答がセキュリティヘッダ・Cookie・情報の漏れの観点で検査される。#106（セキュリティヘッダ）が外れたら CI が止まる。
- 悪い点: CI の E2E に ZAP のイメージの取得と起動が加わる（GitHub Actions での所要時間は未実測）。`--network host` を使うので、Docker Desktop（Mac）で zap-e2e が動くかは未確認（手元のふだんの E2E は `pnpm test:e2e` で ZAP なしに動く）。受け身の検査が済んだかの判定は、残りの件数が 0 か、検査中の処理が無く件数が 3 秒変わらないことで見る（ZAP 2.17.0 で件数が 4 のまま減らないことがあった。原因は未確認）。
- 見直す条件: CI の所要時間が問題になったら、検査を別のジョブ（required に足す）に分ける。stg への active scan や Schemathesis を入れると決まったら、別の ADR にする。
