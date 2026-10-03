# セキュリティの検査は gitleaks・actionlint・zizmor・hadolint・Trivy・Semgrep を digest で固定した Docker イメージで、コミットフックと CI で動かす

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #362 / Issue #112 / `scripts/security/scan.sh` / `lefthook.yml` / `.github/workflows/ci.yml` / `.github/workflows/deploy.yml` / `.claude/rules/tooling/security-scan.md` / `rule-tests/security-scan.test.ts` / quality/20261003-pnpm-audit-in-ci.md

## 背景
Issue #112 では、依存の脆弱性を `pnpm audit` で止めることにし、CodeQL は入れなかった（本番の repo を private にするので有料の GitHub Code Security が要る。quality/20261003-pnpm-audit-in-ci.md）。コードの脆弱性のパターン・秘密情報の混入・ワークフローと Dockerfile と Terraform の設定ミス・イメージの OS パッケージの脆弱性を、毎回同じに止める機械の検査は無かった。daiki の依頼（2026-10-03）は「無料のツールで、最新のものをコミットフックに入れたい」「Trivy にしか無いカバー範囲があれば入れる」「zizmor を入れる」。

## 決定
- 6 つのツールを入れる。gitleaks（秘密情報）、actionlint（ワークフローの構文と run の shellcheck）、zizmor（ワークフローのセキュリティ）、hadolint（Dockerfile）、Trivy（Dockerfile と `infra/` の Terraform の設定ミス、デプロイするイメージの OS パッケージ）、Semgrep（コードの脆弱性のパターン）。
- どれも `scripts/security/scan.sh` から、`<名前>:<タグ>@sha256:<digest>` で固定した Docker イメージで動かす。zizmor だけは `scripts/security/zizmor/Dockerfile`（digest で固定した python に、PyPI の wheel をハッシュ付きで入れる）から作る。
- lefthook の pre-commit に gitleaks（ステージ済み）・actionlint・zizmor・hadolint・Trivy config（それぞれ関係するファイルを変えたときだけ）、pre-push に Semgrep を置く。CI の `ci` ジョブで 6 つすべて（gitleaks は全履歴）を動かす。`deploy.yml` は push したイメージを、マイグレーションとデプロイの前に Trivy で検査する。
- Semgrep の規則は semgrep-rules の固定したコミットを実行時に取り、JavaScript / TypeScript の security の ERROR の規則だけを使う。
- 組み込みの形は `rule-tests/security-scan.test.ts` が検査する。
- 既存の指摘は直した（ワークフローの `run` への式の埋め込みを `env` に、checkout に `persist-credentials: false`）。Cloud SQL の公開 IP（Data Studio のため）だけは Trivy の指摘を理由つきで抑えた。

## 理由
- Docker で動かすのは、手元（Mac）・クラウドセッション・CI で同じ版を、Postgres のために既にある Docker 以外に何も入れずに動かせるため。クラウドセッションのプロキシは github.com の releases と ghcr.io の blob を 403 で拒否し、バイナリを直接落とす方式は使えなかった（2026-10-03 実測）。
- digest で固定するのは、タグが差し替えられるため。Trivy は 2026-03 に Docker Hub のタグと trivy-action / setup-trivy の Action のタグを乗っ取られた（GHSA-69fq-xp46-6x23）。同じ理由で Trivy と gitleaks の Action を使わず、CLI をイメージで動かす（gitleaks-action は組織の repo ではライセンスキーも要る）。
- Semgrep の規則を repo に入れないのは、Semgrep Rules License v1.0 が規則の配布を禁じるため。コミットで固定するのは、レジストリ（`p/...`）の規則が日々変わり、同じコードで結果が変わるため。ERROR だけにしたのは、WARNING 以下が 2026-10-03 の実測で 28 件出て、どれもテストや rule-tests の正規表現など攻撃者の入力が届かない箇所だったため。
- Semgrep を pre-push にしたのは、1 回 10〜20 秒かかり（2026-10-03 実測）、コミットのたびには重いため。
- CI でも動かすのは、フックが `--no-verify` や Docker の止まった環境で飛ばされうるため。`ci` ジョブに置くのは required status check が `ci` だけのため（pnpm audit と同じ）。
- イメージの検査をデプロイに置くのは、イメージをビルドするのがデプロイだけで、PR の CI でビルドすると数分延びるため。push の後でも、トラフィックを移す前に止まれば利用者には出ない。

## 採用しなかった案
- CodeQL: private では有料（quality/20261003-pnpm-audit-in-ci.md）。
- OSV-Scanner: npm の依存の脆弱性は `pnpm audit` が見ている。同じ指摘が 2 か所に出る。
- Checkov / KICS / tfsec: Terraform の設定ミスは Trivy が見る（tfsec は Trivy に統合された）。ツールを増やすと同じ指摘を 2 か所で抑えることになる。
- Semgrep のレジストリの規則（`--config p/...`）: 結果が日々変わり、クラウドセッションでは semgrep.dev に届かない（403）。
- 各ツールの GitHub Action: タグの乗っ取り（Trivy）とライセンスキー（gitleaks）の問題があり、手元と CI で別の動かし方になる。
- バイナリを直接落として動かす: クラウドセッションで github.com の releases が 403。
- DAST（動いているアプリへの攻撃の検査）: 別のスレッドで調べる（この Issue の範囲外）。

## 影響
- 良い点: 秘密情報・ワークフローのインジェクション・設定ミス・コードの脆弱性のパターンを、コミットの前と CI で毎回同じに止める。版は repo の差分で上げ下げを追える。
- 悪い点: コミット・push に Docker が要る（止まっていると失敗する）。初回はイメージの取得と zizmor の build と semgrep-rules の取得で時間がかかる。CI の `ci` ジョブが 6 つの検査の分（初回の取得を含め 1〜2 分、未実測）延びる。Semgrep は ERROR の規則だけなので、WARNING 以下のパターンは見ない。
- 見直す条件: CI の所要時間が問題になったら、検査を別のジョブ（required に足す）に分ける。WARNING の規則で本物の指摘が見つかったら、対象を広げる。DAST を入れると決まったら、デプロイの後の検査として別の ADR にする。
