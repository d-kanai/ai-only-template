#!/usr/bin/env bash
# セキュリティの検査ツールを、digest で固定した Docker イメージで動かす（Issue #362）。
# lefthook のフック（lefthook.yml）・CI（.github/workflows/ci.yml）・デプロイ（deploy.yml）が同じこのスクリプトを呼ぶ。
# 使い方: bash scripts/security/scan.sh <検査> [引数...]（リポジトリ直下で実行する）
#   gitleaks-staged   ステージ済みの変更の秘密情報（pre-commit）
#   gitleaks-history  全履歴の秘密情報（CI）
#   actionlint        .github/workflows の構文・式・run の shellcheck
#   zizmor            .github/workflows のセキュリティ（スクリプトインジェクション・資格情報の残留など）
#   hadolint [file…]  Dockerfile の lint（warning 以上で失敗。引数なしは追跡しているすべての Dockerfile）
#   trivy-config      Dockerfile と infra/（Terraform）の設定ミス（HIGH / CRITICAL で失敗）
#   trivy-image <img> ビルドしたイメージの OS パッケージの脆弱性（直せる HIGH / CRITICAL で失敗。deploy.yml）
#   semgrep           コードの脆弱性のパターン（semgrep-rules の javascript / typescript の security の ERROR の規則）
# 決定と採用しなかった案は ADR docs/adr/quality/20261003-security-scan-tools.md、規則と誤検知の抑え方は
#   .claude/rules/tooling/security-scan.md。
#
# WHY Docker: 手元（Mac）・クラウドセッション・CI で同じ版を、Postgres で使っている Docker 以外に何も入れずに動かす。
#   クラウドセッションのプロキシは github.com の releases と ghcr.io の blob を 403 で拒否し（2026-10-03 実測）、
#   バイナリを直接落とす方式は使えなかった。Docker Hub のイメージは取れた。
# WHY digest で固定: イメージのタグは差し替えられる（Trivy は 2026-03 に Docker Hub の v0.69.5 / v0.69.6 と Action のタグを
#   乗っ取られた。GHSA-69fq-xp46-6x23）。`<名前>:<タグ>@sha256:<digest>` は digest で取り、タグは読むための飾り。
#   rule-tests/security-scan.test.ts がこのファイルのイメージがすべて digest 付きであることを検査する。
set -euo pipefail

GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
ACTIONLINT_IMAGE="rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"
HADOLINT_IMAGE="hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d"
TRIVY_IMAGE="aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"
SEMGREP_IMAGE="semgrep/semgrep:1.179.0@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b"
# zizmor は公式のイメージが ghcr.io だけなので、scripts/security/zizmor/Dockerfile から作る（版とハッシュは同じディレクトリの
#   requirements.txt）。タグに版を入れ、版を変えたら作り直されるようにする。
ZIZMOR_IMAGE="ai-only-template/zizmor:1.30.1"
# semgrep-rules（https://github.com/semgrep/semgrep-rules の develop）のコミット。WHY 実行時に取る: Semgrep Rules License v1.0 は
#   規則の配布を禁じるので repo に入れない。WHY コミットで固定: レジストリ（p/...）の規則は日々変わり、同じコードで結果が変わる。
#   クラウドセッションでは semgrep.dev が 403 で、github.com の git は通る（2026-10-03 実測）。
SEMGREP_RULES_COMMIT="a84ff9cc2453ca91d581380de4b8b3f272f6f4be"

repo_root="$(git rev-parse --show-toplevel)"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/ai-only-template"

# 手元のユーザーで動かす（作られるファイルの持ち主を合わせ、git の dubious ownership で止まらないようにする）。
as_user=(--user "$(id -u):$(id -g)")

# TLS を中継するプロキシの CA（クラウドセッションの SSL_CERT_FILE）をコンテナに渡す。WHY: コンテナの中はホストの CA を信頼せず、
#   Trivy の DB の取得が x509 で失敗した（2026-10-03 実測。/root/.ccr/README.md の「docker build」）。手元・CI では SSL_CERT_FILE が
#   無いので何もしない。
ca_args=()
if [[ -n "${SSL_CERT_FILE:-}" && -f "${SSL_CERT_FILE}" ]]; then
  ca_args=(-v "${SSL_CERT_FILE}:/etc/ssl/certs/host-ca.crt:ro" -e SSL_CERT_FILE=/etc/ssl/certs/host-ca.crt)
fi

ensure_zizmor_image() {
  if docker image inspect "$ZIZMOR_IMAGE" >/dev/null 2>&1; then return; fi
  local secret=()
  # PIP_CERT（クラウドセッションのプロキシの CA）があるときだけ、build の secret で pip に渡す（Dockerfile のコメント）。
  if [[ -n "${PIP_CERT:-}" && -f "${PIP_CERT}" ]]; then secret=(--secret "id=pip_cert,src=${PIP_CERT}"); fi
  docker build --quiet ${secret[@]+"${secret[@]}"} -t "$ZIZMOR_IMAGE" "$repo_root/scripts/security/zizmor" >/dev/null
}

ensure_semgrep_rules() {
  local dir="$cache_dir/semgrep-rules/$SEMGREP_RULES_COMMIT"
  if [[ ! -f "$dir/.complete" ]]; then
    rm -rf "$dir"
    mkdir -p "$dir"
    git -C "$dir" init --quiet
    git -C "$dir" fetch --quiet --depth 1 https://github.com/semgrep/semgrep-rules "$SEMGREP_RULES_COMMIT"
    git -C "$dir" checkout --quiet FETCH_HEAD
    # .complete: 取得が最後まで済んだ印。途中で止まった取得を使わない。
    touch "$dir/.complete"
  fi
  printf '%s\n' "$dir"
}

tool="${1:-}"
shift || true
case "$tool" in
  gitleaks-staged)
    # --redact: 見つけた値を出力に出さない（ターミナル・CI のログに秘密情報を残さない）。
    docker run --rm "${as_user[@]}" -v "$repo_root:/repo" -w /repo "$GITLEAKS_IMAGE" \
      git --pre-commit --staged --redact --no-banner .
    ;;
  gitleaks-history)
    docker run --rm "${as_user[@]}" -v "$repo_root:/repo:ro" -w /repo "$GITLEAKS_IMAGE" \
      git --redact --no-banner .
    ;;
  actionlint)
    # 引数なし: .github/workflows の全ファイル（ワークフローは互いに参照しうるので、変えたファイルだけにしない）。
    docker run --rm "${as_user[@]}" -v "$repo_root:/repo:ro" -w /repo "$ACTIONLINT_IMAGE" -color=false
    ;;
  zizmor)
    ensure_zizmor_image
    # --offline: GitHub の API を使う audit（タグの差し替えの確認など）を使わない。トークンとネットワークに依存させない。
    docker run --rm "${as_user[@]}" -v "$repo_root:/repo:ro" -w /repo "$ZIZMOR_IMAGE" --offline .github/workflows
    ;;
  hadolint)
    # 引数なし: git が追跡しているすべての Dockerfile（CI）。引数あり: そのファイルだけ（pre-commit の {staged_files}）。
    files=("$@")
    if [[ ${#files[@]} -eq 0 ]]; then
      while IFS= read -r file; do files+=("$file"); done < <(git -C "$repo_root" ls-files 'Dockerfile' '**/Dockerfile')
    fi
    # --failure-threshold warning: info（DL3066 など）では失敗にしない。warning 以上で失敗する。
    for file in "${files[@]}"; do
      docker run --rm -i "$HADOLINT_IMAGE" hadolint --failure-threshold warning - <"$repo_root/$file"
    done
    ;;
  trivy-config)
    # DB は使わない（設定の検査の規則はイメージに入っている）。--skip-dirs: 依存とビルドの成果物を見ない。
    docker run --rm "${as_user[@]}" -v "$repo_root:/repo:ro" -w /repo -e HOME=/tmp "$TRIVY_IMAGE" \
      config --exit-code 1 --severity HIGH,CRITICAL --quiet \
      --skip-dirs node_modules --skip-dirs '**/node_modules' --skip-dirs '**/.next' .
    ;;
  trivy-image)
    image="${1:?trivy-image needs an image name}"
    # --scanners vuln --pkg-types os: OS パッケージの脆弱性だけ（npm の依存は pnpm audit、秘密情報は gitleaks が見る）。
    # --ignore-unfixed: 直した版が無いものでは止めない（止めても直せない）。
    # docker.sock: ホストの docker にある（deploy.yml が pull した）イメージを読む。
    mkdir -p "$cache_dir/trivy"
    docker run --rm ${ca_args[@]+"${ca_args[@]}"} -v /var/run/docker.sock:/var/run/docker.sock -v "$cache_dir/trivy:/cache" \
      "$TRIVY_IMAGE" image --cache-dir /cache --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed \
      --scanners vuln --pkg-types os --quiet "$image"
    ;;
  semgrep)
    rules="$(ensure_semgrep_rules)"
    configs=()
    # javascript / typescript の security のディレクトリの規則のうち、ERROR の規則を含むファイルだけを読む。
    #   WHY ERROR だけ: WARNING 以下は 2026-10-03 の実測でテストと rule-tests の正規表現の組み立てなど 28 件が出て、どれも
    #   攻撃者の入力が届かない箇所だった。WHY ファイルを絞る: 読む規則を減らすと起動が速くなる（全部で約 16 秒 → 約 10 秒）。
    while IFS= read -r file; do configs+=(--config "/rules/${file#"$rules"/}"); done < <(
      find "$rules/javascript" "$rules/typescript" -path '*/security/*' -name '*.yaml' -exec grep -l 'severity: ERROR' {} + | sort
    )
    # --metrics=off / --disable-version-check: semgrep.dev に送らない・問い合わせない（クラウドセッションでは 403 で、版の確認の
    #   待ちで 99 秒かかった。2026-10-03 実測）。--error: 検出があれば終了コード 1。
    docker run --rm "${as_user[@]}" -e HOME=/tmp -v "$repo_root:/src:ro" -v "$rules:/rules:ro" -w /src "$SEMGREP_IMAGE" \
      semgrep scan --metrics=off --disable-version-check --severity ERROR --error --quiet "${configs[@]}" .
    ;;
  *)
    echo "usage: bash scripts/security/scan.sh <gitleaks-staged|gitleaks-history|actionlint|zizmor|hadolint|trivy-config|trivy-image|semgrep> [args...]" >&2
    exit 2
    ;;
esac
