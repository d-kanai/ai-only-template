---
paths:
  - "scripts/security/**"
  - "lefthook.yml"
  - "rule-tests/security-scan.test.ts"
  - ".github/workflows/ci.yml"
  - ".github/workflows/deploy.yml"
  - "**/Dockerfile"
  - "infra/**/*.tf"
---

# セキュリティの検査ツール（Issue #362）

gitleaks・actionlint・zizmor・hadolint・Trivy・Semgrep を、`scripts/security/scan.sh` から digest で固定した Docker イメージで動かす。同じスクリプトを lefthook のフック（`lefthook.yml`）・CI の `ci` ジョブ（`ci.yml`）・デプロイ（`deploy.yml`）が呼ぶ。決定と採用しなかった案（CodeQL・OSV-Scanner・Checkov などを入れない理由）は ADR `docs/adr/quality/20261003-security-scan-tools.md`。

## どこで何を見るか
| 検査 | 見るもの | pre-commit | pre-push | CI（`ci` ジョブ） | デプロイ |
| --- | --- | --- | --- | --- | --- |
| gitleaks | 秘密情報（API キー・トークン） | ステージ済みの変更 | | 全履歴 | |
| actionlint | ワークフローの構文・式・run の shellcheck | ワークフローを変えたとき | | ○ | |
| zizmor | ワークフローのセキュリティ（スクリプトインジェクション・資格情報の残留など） | ワークフローを変えたとき | | ○ | |
| hadolint | Dockerfile の lint（warning 以上） | 変えた Dockerfile | | 追跡しているすべて | |
| Trivy config | Dockerfile と `infra/` の Terraform の設定ミス（HIGH / CRITICAL） | Dockerfile か `.tf` を変えたとき | | ○ | |
| Semgrep | コードの脆弱性のパターン（semgrep-rules の JS / TS の security の ERROR） | | ○ | ○ | |
| Trivy image | runtime のイメージの OS パッケージ（直せる HIGH / CRITICAL） | | | | push の後・マイグレーションの前 |

- 依存（npm）の脆弱性は `pnpm audit`（`.claude/rules/tooling/github-actions.md`）が見る。Trivy と Semgrep には npm の依存を見させない（同じ指摘が 2 か所に出る）。
- WHY フックと CI の両方: フックは手元ですぐ気づくため、CI は `--no-verify` や Docker の止まった環境で飛ばされたときの最後の砦（required status check の `ci` ジョブ）。
- WHY Semgrep は pre-push: 1 回 18〜28 秒かかる（2026-10-03 実測。規則の取得済みの 2 つの環境）。
- `lefthook.yml` のトップレベルにはフック（`pre-commit` / `pre-push` / `commit-msg`）のほかを書かない。WHY: `extends:` で読む別のファイルに `skip: true` を書くと本体の検査が黙って飛ばされ（lefthook 2.1.12 で実測）、`rc:` は hook のスクリプトが source するファイルで、検査を止める環境変数を入れられる。フックを足すときは `rule-tests/security-scan.test.ts` の `ALLOWED_LEFTHOOK_KEYS` にも足す。
- CI の検査のステップは `run` だけにし、ワークフローと job に `defaults:` を書かない（shell や env で、同じ run のまま実行の仕方を変えられるため）。
- 機械化: 組み込みの形（イメージの digest・zizmor のハッシュ・semgrep-rules のコミット・フックのコマンドの run と glob・CI の 6 つのステップ・デプロイのステップの順序）は `rule-tests/security-scan.test.ts`（仕様は対の `.feature`、限界はテストの冒頭）。

## 前提
- Docker が動いていること（Postgres と同じ）。止まっていると、検査のあるコミット・push は失敗する。
- 初回だけ、イメージの pull・zizmor のイメージの build・semgrep-rules の取得（`git fetch`）が走る。キャッシュは `${XDG_CACHE_HOME:-~/.cache}/ai-only-template`。
- クラウドセッションでは、プロキシの CA を `SSL_CERT_FILE`（Trivy）と `PIP_CERT`（zizmor の build）でコンテナに渡す（scan.sh が自動で行う）。

## 止まったら（誤検知の抑え方）
抑えるときは、その行か直前の行のコメントに WHY（なぜ問題でないか）を書く。WHY の有無は機械で見ない（reviewer が見る）。
- gitleaks: 行末に `gitleaks:allow` のコメント。テストの値など、ファイルごと外すときは `.gitleaksignore` に fingerprint（gitleaks の出力の `Fingerprint`）を書く。本物の秘密情報を入れてしまったら、抑えずに失効させ、履歴から消す。
- actionlint: 指摘を直す（shellcheck の指摘は `run` の書き方を直す）。どうしても外すなら `.github/actionlint.yaml` の `paths.<glob>.ignore`。
- zizmor: 該当の行に `# zizmor: ignore[<audit 名>]`。
- hadolint: 該当の命令の直前の行に `# hadolint ignore=<コード>`。
- Trivy config: 該当のブロックか属性の直前の行に `#trivy:ignore:<ID>`（例: `infra/modules/app/sql.tf` の `GCP-0017`。2026-10-03 に効くことを実測）。
- Trivy image: ベースのイメージ（`Dockerfile` の FROM）の版を上げる。直した版が無いもの（`--ignore-unfixed`）は止めない。
- Semgrep: 該当の行か直前の行に `// nosemgrep: <規則の ID>`（ID を書かないと全規則を外すので、必ず書く）。
- 実測で効くのを確かめたのは Trivy の書き方だけ。ほかは各ツールの公式ドキュメントの書き方で、使うときに効くことを確かめる。

## 版を上げるとき
1. Docker Hub のタグの digest を引く: `docker buildx imagetools inspect <名前>:<タグ>` の `Digest`（マルチアーキの index の digest。arm64 の Mac と amd64 の CI の両方で同じ値を使える）。
2. `scan.sh` の `<ツール>_IMAGE="<名前>:<タグ>@sha256:<digest>"` を書き換える（タグと digest の両方）。
3. zizmor: `scripts/security/zizmor/requirements.txt` の版と、`https://pypi.org/pypi/zizmor/<版>/json` の linux の wheel（manylinux / musllinux × x86_64 / aarch64）の 4 つの sha256 を書き換え、`scan.sh` の `ZIZMOR_IMAGE` のタグを同じ版にする（タグが同じだと古いイメージのまま動く。テストが止める）。ベースの python は digest を引き直す。
4. semgrep-rules: `git ls-remote https://github.com/semgrep/semgrep-rules develop` のコミットで `SEMGREP_RULES_COMMIT` を書き換える。
5. 手元で `bash scripts/security/scan.sh <検査>` を全部流し、新しい指摘を直すか上の方法で抑えてから PR にする。
- WHY digest: イメージのタグは差し替えられる（Trivy は 2026-03 に Docker Hub のタグと trivy-action のタグを乗っ取られた。GHSA-69fq-xp46-6x23）。Actions の SHA 固定と同じ考え。
