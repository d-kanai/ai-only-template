# ZAP の検査は PR の CI から外し、main の日次で E2E を通した受け身の検査と active scan を流す

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #405 / Issue #364 / `.github/workflows/zap.yml` / `.github/workflows/ci.yml` / `scripts/security/scan.sh`（`zap-e2e`）/ `scripts/security/zap-ignore.tsv` / `rule-tests/security-scan.test.ts`（`ci-scan` / `zap-daily`）/ quality/20261003-zap-passive-scan-via-e2e.md

## 背景
quality/20261003-zap-passive-scan-via-e2e.md（Issue #364）で、PR の CI の E2E を ZAP のプロキシ経由で流し、受け身の検査（passive scan）だけで警告を判定するようにした。daiki から「ZAP のスコープはフルか」と聞かれ、攻撃を送る active scan はしていないと答えたところ、「passive scan も含められるなら、PR は普通の E2E、main の daily で ZAP でよい。DB は CI の中で完結するので気にしない」と判断した（2026-10-03、Issue #405）。

## 決定
- PR の CI（`ci.yml` の `ci` ジョブ）の E2E は、ZAP を通さない `pnpm test:e2e` に戻す。
- 新しいワークフロー `.github/workflows/zap.yml` が、main を毎日（UTC 23:45）と手動（workflow_dispatch）で `bash scripts/security/scan.sh zap-e2e` を実行する。
- `zap-e2e` は、E2E を ZAP 経由で流して受け身の検査を済ませた後、E2E が build したアプリを同じポートで起動し直し、ZAP が記録したそのサイトの URL すべてに active scan をかけ（上限 20 分）、受け身と active の両方の警告をまとめて判定する。
- 判定の仕組み（Low 以上で失敗・Informational は表示だけ・`zap-ignore.tsv` に alertRef と理由を書いて外す）は Issue #364 のまま。
- active scan で出た Low の 40014-2（持続型 XSS の弱点。JSON の応答）は、応答が JSON と nosniff で、画面が名前（title）をエスケープして描くので外す（理由は `zap-ignore.tsv`）。

## 理由
- active scan は時間がかかる（2026-10-03 のクラウドセッションの実測で、E2E が記録した 34 件の URL に 150 秒）。PR ごとに流すとマージを待たせる。
- E2E の記録を active scan の起点にすると、spider で辿るより実際の使われ方に沿った URL と本文の形が攻撃の対象になる。
- active scan を E2E の後に分けるのは、攻撃の値が DB に書き込まれ、同時に流すと E2E の前提を壊すため。DB は CI の中で起動した使い捨てで、書き込みは外に影響しない（daiki の判断）。
- 日次の結果は required status check にならないので、PR のマージは止めない。失敗は Actions の通知で気づく（mutation testing の日次ジョブと同じ）。

## 採用しなかった案
- PR の CI で受け身の検査を続け、active scan だけ日次にする: daiki が「PR は普通の E2E」と判断した。受け身の検査も日次で流すので、警告に気づくのは最大 1 日遅れる。
- active scan の対象を spider で集める: SPA の操作の後の画面や API の書き込みを辿れない（Issue #364 の baseline scan を採らなかった理由と同じ）。
- stg（デプロイ先）への active scan: stg がまだ無い。CI の中で完結すれば外の環境を荒らさない。

## 影響
- 良い点: 攻撃を送らないと分からない脆弱性（XSS・SQL インジェクションなど）を毎日見る。PR の CI から ZAP のイメージの取得と起動が消える。
- 悪い点: セキュリティヘッダの後退などに気づくのが、PR のマージ時ではなく翌朝になる。日次のジョブの赤はマージを止めないので、通知を見落とすと放置される。GitHub Actions での所要時間は未実測（手動の実行で確かめる）。
- 見直す条件: 日次の赤が放置されるようなら、受け身の検査だけ PR に戻すか、失敗を Issue にする仕組みを足す。
