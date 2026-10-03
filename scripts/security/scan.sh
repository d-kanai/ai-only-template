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
#   zap-e2e           ZAP をプロキシにして E2E（pnpm test:e2e）を流し、E2E が触った画面と API の通信を ZAP の受け身の検査
#                     （passive scan）にかける（Low 以上の警告で失敗。CI。Issue #364）
#   zap-alerts <alerts.json> [ignore.tsv]
#                     ZAP の警告（/JSON/core/view/alerts/ の応答）の判定だけ（zap-e2e の中で使う。テストは scan.test.ts）
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
# ZAP の安定版（zaproxy/zap-stable。ZAP の公式のイメージ）。2.17.0 が 2026-10-03 時点の最新（Docker Hub のタグ latest と同じ digest）。
ZAP_IMAGE="zaproxy/zap-stable:2.17.0@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef"
# zizmor は公式のイメージが ghcr.io だけなので、scripts/security/zizmor/Dockerfile から作る（版とハッシュは同じディレクトリの
#   requirements.txt）。タグに版を入れ、版を変えたら作り直されるようにする。
ZIZMOR_IMAGE="ai-only-template/zizmor:1.30.1"
# semgrep-rules（https://github.com/semgrep/semgrep-rules の develop）のコミット。WHY 実行時に取る: Semgrep Rules License v1.0 は
#   規則の配布を禁じるので repo に入れない。WHY コミットで固定: レジストリ（p/...）の規則は日々変わり、同じコードで結果が変わる。
#   クラウドセッションでは semgrep.dev が 403 で、github.com の git は通る（2026-10-03 実測）。
SEMGREP_RULES_COMMIT="a84ff9cc2453ca91d581380de4b8b3f272f6f4be"

repo_root="$(git rev-parse --show-toplevel)"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/ai-only-template"

# git のリポジトリとして読む検査（gitleaks・Semgrep）は、作業ツリーと git の共通ディレクトリ（.git）を、ホストと同じ絶対パスで
#   コンテナに見せる。WHY: git worktree の作業ツリーの .git は「gitdir: <本体>/.git/worktrees/<名前>」を指すファイルで、
#   作業ツリーだけを /repo に載せると指す先がコンテナに無い。gitleaks は git のエラーを出しても終了コード 0 で「0 commits
#   scanned」になり、秘密情報を入れたコミットを通した（2026-10-03 実測。Codex の指摘、PR #386）。同じ絶対パスにすれば
#   .git のファイルの中の絶対パスがそのまま読める。worktree でなければ共通ディレクトリは作業ツリーの .git で、重ねて載せても同じ。
git_common_dir="$(cd "$repo_root" && cd "$(git rev-parse --git-common-dir)" && pwd)"
git_mounts_ro=(-v "$repo_root:$repo_root:ro" -v "$git_common_dir:$git_common_dir:ro" -w "$repo_root")
git_mounts_rw=(-v "$repo_root:$repo_root" -v "$git_common_dir:$git_common_dir" -w "$repo_root")

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

# 取得した規則のディレクトリを変数 rules に入れる。WHY 変数で返す（`$(...)` で受けない）: コマンド置換の中では set -e が効かず、
#   git fetch が失敗しても .complete まで進み、空の取得が「済み」として残って以後の push がずっと失敗した（reviewer の実測）。
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
  rules="$dir"
}

# ZAP の警告の判定（Issue #364）。$1 = ZAP の /JSON/core/view/alerts/ の応答、$2 = 除外のファイル（alertRef<TAB>WHY の行）。
#   Low / Medium / High の警告のうち、除外に無い alertRef があれば 1、除外のファイルの誤り・応答の形の誤りは 2。
#   Informational は表示だけで落とさない。WHY: 「Modern Web Application」（SPA だと知らせるだけ）のように直すものの無い知らせが
#   毎回出る（2026-10-03 に E2E を ZAP 経由で流して実測）。
#   WHY pluginId でなく alertRef で外す: 同じ規則（10055 の CSP）の中に別の問題（style-src と script-src の unsafe-inline など）があり、
#   pluginId で外すと許容していない問題まで通る。
#   WHY 理由の無い除外を誤りにする: 後から外してよいかを判断できない除外を残さない。
#   仕様は scripts/security/scan.test.ts。
zap_alerts() {
  local alerts_file="$1" ignore_file="$2" bad ignored failing
  # コメント（# で始まる行）と空行を除き、タブの後ろの理由が無い・空白だけの行を集める。
  bad="$(awk -F'\t' '!/^[[:space:]]*(#|$)/ && $2 ~ /^[[:space:]]*$/ { print "  line " NR ": " $0 }' "$ignore_file")"
  if [[ -n "$bad" ]]; then
    printf 'ZAP ignore list %s has entries without a reason (write alertRef<TAB>WHY):\n%s\n' "$ignore_file" "$bad" >&2
    return 2
  fi
  ignored="$(awk -F'\t' '!/^[[:space:]]*(#|$)/ { print $1 }' "$ignore_file" | jq -R . | jq -s .)"
  if ! jq -e '.alerts | type == "array"' "$alerts_file" >/dev/null; then
    echo "ZAP alerts file $alerts_file is not a ZAP alerts response ({\"alerts\": [...]})" >&2
    return 2
  fi
  # 1 行 = 「危険度 alertRef 名前 URL」。同じ URL の同じ警告（メソッド・パラメータ違い）は 1 行にまとめる。
  jq -r '.alerts[] | select(.risk == "Informational") | "\(.risk) \(.alertRef) \(.alert) \(.url)"' "$alerts_file" | sort -u
  failing="$(jq -r --argjson ignored "$ignored" \
    '.alerts[] | select(.risk != "Informational") | select(.alertRef as $ref | $ignored | index($ref) | not)
      | "\(.risk) \(.alertRef) \(.alert) \(.url)"' "$alerts_file" | sort -u)"
  if [[ -n "$failing" ]]; then
    printf 'ZAP found alerts (fix them, or add alertRef<TAB>WHY to %s):\n%s\n' "$ignore_file" "$failing" >&2
    return 1
  fi
}

tool="${1:-}"
shift || true
case "$tool" in
  gitleaks-staged)
    # --redact: 見つけた値を出力に出さない（ターミナル・CI のログに秘密情報を残さない）。
    # rw: --staged の差分を取る git が index を読み書きしうる（ro で動くかは未確認なので、元の rw のままにする）。
    docker run --rm "${as_user[@]}" "${git_mounts_rw[@]}" "$GITLEAKS_IMAGE" \
      git --pre-commit --staged --redact --no-banner .
    ;;
  gitleaks-history)
    docker run --rm "${as_user[@]}" "${git_mounts_ro[@]}" "$GITLEAKS_IMAGE" \
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
    # ${files[@]+...}: Dockerfile が 0 件のとき、macOS の bash 3.2 は set -u の下で空の配列の展開を unbound variable にする。
    for file in ${files[@]+"${files[@]}"}; do
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
    ensure_semgrep_rules
    configs=()
    # javascript / typescript の security のディレクトリの規則のうち、ERROR の規則を含むファイルだけを読む。
    #   WHY ERROR だけ: WARNING 以下は 2026-10-03 の実測でテストと rule-tests の正規表現の組み立てなど 28 件が出て、どれも
    #   攻撃者の入力が届かない箇所だった。WHY ファイルを絞る: 読む規則を減らすと起動が速くなる（全部で約 16 秒 → 約 10 秒）。
    while IFS= read -r file; do configs+=(--config "/rules/${file#"$rules"/}"); done < <(
      find "$rules/javascript" "$rules/typescript" -path '*/security/*' -name '*.yaml' -exec grep -l 'severity: ERROR' {} + | sort
    )
    # --metrics=off / --disable-version-check: semgrep.dev に送らない・問い合わせない（クラウドセッションでは 403 で、版の確認の
    #   待ちで 99 秒かかった。2026-10-03 実測）。--error: 検出があれば終了コード 1。
    docker run --rm "${as_user[@]}" -e HOME=/tmp "${git_mounts_ro[@]}" -v "$rules:/rules:ro" "$SEMGREP_IMAGE" \
      semgrep scan --metrics=off --disable-version-check --severity ERROR --error --quiet "${configs[@]}" .
    ;;
  zap-e2e)
    # ZAP をプロキシ（daemon）として起動し、E2E のブラウザと API の呼び出しを通す（apps/e2e/playwright.config.ts の E2E_PROXY）。
    #   E2E が通った後、受け身の検査が済むのを待って警告を取り、zap_alerts で判定する。決定は
    #   ADR docs/adr/quality/20261003-zap-passive-scan-via-e2e.md。
    # WHY 受け身の検査だけ（攻撃を送る active scan をしない）: E2E の通信を見るだけなので E2E の結果と時間をほとんど変えない
    #   （2026-10-03 の実測で E2E 11 件が ZAP なしと同じく通った）。active scan は時間がかかり、DB を荒らして E2E と干渉する。
    # --network host: ZAP から E2E のサーバ（localhost:<E2E_PORT> と記録用のサーバのランダムなポート）にそのまま届くようにする。
    #   ブラウザは localhost の URL のまま ZAP に送るので、ZAP のコンテナの localhost がホストと同じである必要がある
    #   （Linux の Docker の host network。CI の ubuntu-latest とクラウドセッションで動く。Docker Desktop（Mac）で動くかは未確認）。
    # -silent: ZAP の更新の確認・アドオンの取得・テレメトリを止める。WHY: CI の結果を外部の状態に左右させない。クラウドセッションでは
    #   外への TLS がプロキシで失敗し、受け身の規則「ZAP is Out of Date」が版の問い合わせで止まって検査が終わらなかった（2026-10-03 実測）。
    # -host 127.0.0.1: ホストの外から ZAP（とその API）に届かないようにする。api.disablekey=true: API キーを使わない
    #   （127.0.0.1 からだけ届き、ジョブが終われば捨てる。キーの受け渡しを増やさない）。
    zap_port=8090
    zap_api="http://127.0.0.1:$zap_port"
    zap_container="ai-only-template-zap-$$"
    docker run -d --rm --name "$zap_container" --network host "$ZAP_IMAGE" \
      zap.sh -daemon -silent -host 127.0.0.1 -port "$zap_port" -config api.disablekey=true >/dev/null
    alerts_file="$(mktemp)"
    trap 'docker rm -f "$zap_container" >/dev/null 2>&1 || true; rm -f "$alerts_file"' EXIT
    # 起動を待つ（手元で約 10 秒。上限 120 秒）。
    for _ in $(seq 1 120); do
      if curl -sf "$zap_api/JSON/core/view/version/" >/dev/null; then break; fi
      sleep 1
    done
    curl -sf "$zap_api/JSON/core/view/version/" >/dev/null || { echo "ZAP did not start" >&2; docker logs "$zap_container" >&2; exit 1; }

    (cd "$repo_root" && E2E_PROXY="http://127.0.0.1:$zap_port" pnpm test:e2e)

    # 受け身の検査が済むのを待つ。済んだとみなすのは、残りの件数（recordsToScan）が 0 か、検査中の処理（currentTasks）が無く
    #   残りの件数が 3 秒続けて変わらないとき。WHY 0 だけを待たない: 2026-10-03 の実測（ZAP 2.17.0）で、検査中の処理が無くなった後も
    #   recordsToScan が 4 のまま減らなかった（-silent でも同じ。原因は未確認）。上限 120 秒を超えたら、検査を済ませないまま通さずに失敗する。
    previous="" stable=0 scanned=""
    for _ in $(seq 1 120); do
      remaining="$(curl -sf "$zap_api/JSON/pscan/view/recordsToScan/" | jq -r .recordsToScan)"
      tasks="$(curl -sf "$zap_api/JSON/pscan/view/currentTasks/" | jq '.currentTasks | length')"
      # 数でなければ（応答の形が変わった）、変わらないことを「済んだ」と取り違えないよう失敗にする。
      [[ "$remaining" =~ ^[0-9]+$ ]] || { echo "ZAP recordsToScan is not a number: $remaining" >&2; exit 1; }
      if [[ "$remaining" == "0" ]]; then scanned=1; break; fi
      if [[ "$tasks" == "0" && "$remaining" == "$previous" ]]; then stable=$((stable + 1)); else stable=0; fi
      if [[ $stable -ge 3 ]]; then scanned=1; break; fi
      previous="$remaining"
      sleep 1
    done
    [[ -n "$scanned" ]] || { echo "ZAP passive scan did not finish within 120 seconds" >&2; exit 1; }
    if [[ "$remaining" != "0" ]]; then echo "ZAP passive scan is idle with recordsToScan=$remaining (treated as finished)" >&2; fi

    # ZAP が E2E の通信を受けたことを確かめる。WHY: E2E_PROXY が Playwright に渡らない（変数の名前のずれ・設定の消失・Playwright の
    #   loopback の扱いの変更）と、ZAP の記録が空のまま警告 0 件で緑になり、検査が黙って効かなくなる（reviewer の実測。PR の検証）。
    #   E2E のサーバは localhost で動くので、記録したサイトに http://localhost: が 1 つも無ければ失敗にする。
    if ! curl -sf "$zap_api/JSON/core/view/sites/" | jq -e '.sites | any(startswith("http://localhost:"))' >/dev/null; then
      echo "ZAP recorded no E2E traffic (is E2E_PROXY reaching apps/e2e/playwright.config.ts?)" >&2
      exit 1
    fi

    curl -sf "$zap_api/JSON/core/view/alerts/" >"$alerts_file"
    zap_alerts "$alerts_file" "$repo_root/scripts/security/zap-ignore.tsv"
    ;;
  zap-alerts)
    zap_alerts "${1:?zap-alerts needs a ZAP alerts JSON file}" "${2:-$repo_root/scripts/security/zap-ignore.tsv}"
    ;;
  *)
    echo "usage: bash scripts/security/scan.sh <gitleaks-staged|gitleaks-history|actionlint|zizmor|hadolint|trivy-config|trivy-image|semgrep|zap-e2e|zap-alerts> [args...]" >&2
    exit 2
    ;;
esac
