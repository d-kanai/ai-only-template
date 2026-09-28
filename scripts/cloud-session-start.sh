#!/bin/bash
# クラウドセッション（Claude Code on the web）の VM に、.tool-versions と同じ Node.js / pnpm を用意する。
# 詳細・役割分担は rules/code/env.md の「クラウドセッション」を参照。
#
# 使い方:
#   bash scripts/cloud-session-start.sh --install-only  # 環境設定の setup script から呼ぶ。Node / pnpm のインストールだけ行う
#   bash scripts/cloud-session-start.sh                 # SessionStart フック（.claude/settings.json）から呼ぶ。
#                                                       #   CLAUDE_CODE_REMOTE=true のときだけ動き、PATH 上の pnpm で pnpm install を行う
#                                                       #   （Node / pnpm の導入と PATH の書き出しは一時停止中。下の「一時停止」を参照）
#   bash scripts/cloud-session-start.sh --print-plan    # 読み取った版とインストール先を表示するだけ（テスト・確認用）
#   CLOUD_SESSION_START_DRY_RUN=1 ...                   # ダウンロード・インストールをせず、実行予定のコマンドを表示する
#
# WHY 2 つの入口に分けるか: 環境設定の setup script は初回だけ実行されてファイルシステムがキャッシュされるが、
#   SessionStart フックは毎セッション実行される（公式 cloud-environments / hooks ドキュメント）。重いダウンロードは
#   setup script（--install-only）に寄せ、フックは「既存のインストールを見つけて PATH を通し pnpm install する」
#   だけの速い経路にする。setup script を設定していない環境でも動くよう、フックは未インストールなら自分で入れる。
#
# 一時停止（2026-09-28〜）: クラウド環境の Network access が nodejs.org を拒否するため、フックでの Node / pnpm の
#   導入と PATH の書き出しを main でコメントアウトしている。フックは VM 既定の Node 22 / pnpm で pnpm install だけを行う。
#   nodejs.org を許可したら main のコメントを外して上の二段構えに戻す。詳細は main のコメントと rules/code/env.md。
#
# WHY set -e を使わない: このスクリプトは「どんな失敗でも exit 0 で終える」設計にしている。
#   フックが失敗するとセッション開始時にエラーが出るが、Node の取得に失敗しても
#   クラウド VM 既定の Node 22 で最低限の作業（コードを読む・編集する）はできる。フックの失敗で
#   セッションそのものを使えなくするより、stderr に理由を出して続行させる方が損失が小さい。
#   失敗は各処理で明示的に判定し、warn を出して return する。
# WHY set -u は使う: 関数本体での変数名の typo を、空文字のまま進めずその場で止めて気づけるようにするため。
#   ただし $(...) の中での違反はそのコマンド置換のサブシェルが落ちるだけで、呼び出し側には空文字が返り処理は続く。
#   つまり set -u だけでは「空のパスでインストール先を組み立てる」事故は防げない。空だと危険な HOME は
#   main で明示的に検査している（HOME が空だと $HOME/.local/node-<版> が /.local/node-<版> になり、
#   ルート直下という意図しない場所に書き込もうとするため）。
#   set -u の違反で main が落ちても、main をサブシェルで実行しているので最後の exit 0 は保たれる。
set -u

warn() {
  echo "cloud-session-start: $*" >&2
}

# CLOUD_SESSION_START_DRY_RUN=1 のときはコマンドを実行せず表示だけする。
# WHY: 実際のダウンロード（数十 MB）やグローバルインストールをせずに、分岐と PATH の書き出しをテストするため。
is_dry_run() {
  [ "${CLOUD_SESSION_START_DRY_RUN:-}" = "1" ]
}

# .tool-versions から `<tool> <version>` の行を探し、版だけを返す。
# WHY .tool-versions から読む: ローカルは asdf がこのファイルを読んで版を決めている。クラウドでも同じファイルを
#   唯一の情報源にすれば、版を上げるときに .tool-versions だけを変えればよく、スクリプトとの食い違いが起きない。
# 値の末尾の \r は取り除く: Windows で編集されて CRLF になった .tool-versions でも、版に \r が混ざって
#   URL やディレクトリ名が壊れないようにするため。
read_tool_version() {
  local tool="$1" file="$2"
  awk -v tool="$tool" '$1 == tool { v = $2; sub(/\r$/, "", v); print v; exit }' "$file"
}

# インストール先の候補。WHY 2 か所か:
#   - setup script は root で動く（公式 cloud-environments ドキュメント）。root なら全ユーザーから見える /opt に置く。
#   - SessionStart フックがどのユーザーで動くかは未確認。root でなければ /opt に書けないので、どのユーザーでも
#     書ける $HOME/.local に置く。
#   検出はこの順（/opt → $HOME/.local）で両方を見る。setup script（root）が /opt に入れたものを、別ユーザーで
#   動くフックからも再利用できるようにするため。
# CLOUD_SESSION_START_OPT_DIR: テストで、実行マシンの本物の /opt の権限に左右されずに分岐を確かめるための差し替え口。
opt_base() {
  echo "${CLOUD_SESSION_START_OPT_DIR:-/opt}"
}

home_base() {
  echo "$HOME/.local"
}

# 既存のインストールがあればその node_dir を返す（無ければ空）。
# ディレクトリ名に版を含めるので、.tool-versions を上げると古い版は検出されず、新しい版が入る。
find_installed_node_dir() {
  local version="$1" base
  for base in "$(opt_base)" "$(home_base)"; do
    if [ -x "$base/node-$version/bin/node" ]; then
      echo "$base/node-$version"
      return 0
    fi
  done
}

# 新しく入れるときの node_dir。/opt に書けるならそこ、書けなければ $HOME/.local。
install_target_node_dir() {
  local version="$1"
  if [ -d "$(opt_base)" ] && [ -w "$(opt_base)" ]; then
    echo "$(opt_base)/node-$version"
  else
    echo "$(home_base)/node-$version"
  fi
}

# Node の公式配布物の名前（linux-x64 / linux-arm64）を返す。対応外のアーキテクチャなら何も出さず失敗する。
# クラウド VM は x86_64（公式 cloud-environments ドキュメント）。aarch64 も配布物があるので対応しておく。
# WHY 対応外を x64 に倒さない: 動かないバイナリを入れて PATH の先頭に置くと、VM 既定の Node まで使えなくなるため。
node_platform() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) echo "linux-x64" ;;
    aarch64) echo "linux-arm64" ;;
    *)
      warn "unsupported architecture: ${arch}"
      return 1
      ;;
  esac
}

# WHY curl にタイムアウトを付ける: 通信が止まったまま待ち続けると、フックは 600 秒で打ち切られ（公式 cloud-environments
#   ドキュメント）、「失敗しても warn を出して exit 0 で続ける」設計が守れなくなるので、自分で先に諦める。
#   --connect-timeout 15: 接続確立に 15 秒かかるならネットワーク不通・遮断とみなす（通常は 1 秒未満で終わる）。
#   --max-time（呼び出し側で指定）: 1 回の取得の上限。tarball は 240 秒、SHASUMS256.txt（数十 KB）は 60 秒。
#     最悪ケースの合計は 15 + 240 + 15 + 60 = 330 秒で、フックの 600 秒に余裕を持って収まる。
#     linux-x64 の .tar.xz は 2026-09-28 にローカルで取得・展開まで約 5 秒だったので、240 秒かかるなら止まっているとみなせる。
#   setup script の約 5 分はキャッシュされるかどうかの目安で、超えても失敗はしない（キャッシュされないだけ）ため、
#   上限はフックの 600 秒に合わせている。
download() {
  local url="$1" out="$2" max_time="$3"
  curl -fsSL --connect-timeout 15 --max-time "$max_time" -o "$out" "$url"
}

sha256_of() {
  # Ubuntu（クラウド VM）には coreutils の sha256sum がある。macOS で手元確認するときのために shasum にも倒す。
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

install_node() {
  local version="$1" node_dir="$2"
  local platform dist_base tarball base
  platform="$(node_platform)" || return 1
  dist_base="https://nodejs.org/dist/v${version}"
  tarball="node-v${version}-${platform}.tar.xz"
  base="$(dirname "$node_dir")"

  if is_dry_run; then
    echo "[dry-run] curl -fsSL ${dist_base}/${tarball}"
    echo "[dry-run] curl -fsSL ${dist_base}/SHASUMS256.txt"
    echo "[dry-run] verify sha256 of ${tarball} against SHASUMS256.txt"
    echo "[dry-run] tar -xJf ${tarball} -> ${node_dir}"
    return 0
  fi

  mkdir -p "$base" || { warn "failed to create ${base}"; return 1; }
  # 一時ディレクトリは展開先と同じ場所に作る。最後の mv を同一ファイルシステム内の rename にして、
  # 一瞬で完了させる（別ファイルシステムだとコピーになり、途中で止まると中途半端なディレクトリが残る）。
  local work
  work="$(mktemp -d "$base/.node-download.XXXXXX")" || { warn "mktemp failed in ${base}"; return 1; }

  if ! download "${dist_base}/${tarball}" "$work/$tarball" 240; then
    warn "failed to download ${dist_base}/${tarball}"
    rm -rf "$work"
    return 1
  fi
  if ! download "${dist_base}/SHASUMS256.txt" "$work/SHASUMS256.txt" 60; then
    warn "failed to download ${dist_base}/SHASUMS256.txt"
    rm -rf "$work"
    return 1
  fi

  # WHY SHASUMS256.txt で検証する: 途中で切れた・壊れたダウンロードや差し替えられたファイルを展開して、
  #   以後のセッションでずっとその Node を使い続ける事故を防ぐため。公式が同じディレクトリに置いている
  #   チェックサム一覧と照合し、一致しなければ展開しない。
  local expected actual
  expected="$(awk -v f="$tarball" '$2 == f { print $1; exit }' "$work/SHASUMS256.txt")"
  actual="$(sha256_of "$work/$tarball")"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    warn "sha256 mismatch for ${tarball} (expected: ${expected:-<not found>}, actual: ${actual})"
    rm -rf "$work"
    return 1
  fi

  if ! tar -xJf "$work/$tarball" -C "$work"; then
    warn "failed to extract ${tarball}"
    rm -rf "$work"
    return 1
  fi

  # WHY 一時ディレクトリに展開してから mv する: 展開が途中で止まったとき（タイムアウト等）に中途半端な
  #   $node_dir が残ると、次回「インストール済み」と誤判定して壊れた Node を使い続けてしまうため。
  # ここに来るのは $node_dir/bin/node が無いとき（find_installed_node_dir で見つからなかった）なので、
  #   $node_dir が残っていれば壊れたインストールとみなして消す。消さずに mv すると $node_dir の中に
  #   node-v<版>-<platform> が入れ子になり、bin/node が見つからないままになる。
  if [ -e "$node_dir" ] && ! rm -rf "$node_dir"; then
    warn "failed to remove broken ${node_dir}"
    rm -rf "$work"
    return 1
  fi
  if ! mv "$work/node-v${version}-${platform}" "$node_dir"; then
    warn "failed to move Node.js into ${node_dir}"
    rm -rf "$work"
    return 1
  fi
  rm -rf "$work"
}

install_pnpm() {
  local version="$1" node_dir="$2"

  # 冪等性: 同じ版が入っていれば何もしない（`pnpm --version` の確認だけなので速い）。
  if [ -x "$node_dir/bin/pnpm" ] && [ "$("$node_dir/bin/pnpm" --version 2>/dev/null)" = "$version" ]; then
    return 0
  fi

  # WHY --prefix を明示する: npm のグローバル先は既定ではその Node の配下だが、環境変数や .npmrc の prefix で
  #   変えられる。クラウド VM に何が設定されているかは未確認なので、確実に $node_dir/bin/pnpm に入るよう固定する。
  if is_dry_run; then
    echo "[dry-run] npm install -g pnpm@${version} --prefix ${node_dir}"
    return 0
  fi

  if ! npm install -g "pnpm@${version}" --prefix "$node_dir" >&2; then
    warn "failed to install pnpm@${version}"
    return 1
  fi
}

# Node が無ければ入れる。使える Node が用意できなければ失敗する（DRY_RUN では入れたものとして成功する）。
# 使う node_dir はグローバル変数 NODE_DIR で呼び出し元に返す。
# WHY stdout で返さない: DRY_RUN の実行予定の表示が stdout に出るため、$(...) で受けると混ざってしまう。
ensure_node() {
  local node_version="$1"
  NODE_DIR="$(find_installed_node_dir "$node_version")"
  if [ -z "$NODE_DIR" ]; then
    NODE_DIR="$(install_target_node_dir "$node_version")"
    install_node "$node_version" "$NODE_DIR" || return 1
  fi

  # この後の npm / pnpm を、入れた Node で動かす。npm・pnpm のシバンは `#!/usr/bin/env node` なので、
  # PATH の先頭に置かないと VM 既定の Node 22 で動いてしまう。
  export PATH="$NODE_DIR/bin:$PATH"
}

# WHY CLAUDE_ENV_FILE に書く: フックはサブプロセスなので、ここで PATH を変えても Claude のその後の Bash には
#   引き継がれない。SessionStart フックに渡される CLAUDE_ENV_FILE に export 行を追記すると、以降の Bash
#   コマンドにその環境変数が反映される（公式 hooks ドキュメント）。他のフックの書き込みを消さないよう `>>` で追記する。
export_path() {
  local node_bin="$1"
  if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
    warn "CLAUDE_ENV_FILE is not set; PATH for ${node_bin} is not persisted to the session"
    return 0
  fi
  echo "export PATH=\"${node_bin}:\$PATH\"" >>"$CLAUDE_ENV_FILE"
}

install_dependencies() {
  local project_dir="$1"
  if is_dry_run; then
    echo "[dry-run] (cd ${project_dir} && pnpm install --frozen-lockfile)"
    return 0
  fi
  # --frozen-lockfile: lockfile と package.json がずれていたら更新せず失敗させる。クラウドで勝手に lockfile を
  #   書き換えて差分を作らないため（依存の版は lockfile が正。rules/code/dependencies.md）。
  if ! (cd "$project_dir" && pnpm install --frozen-lockfile >&2); then
    warn "pnpm install --frozen-lockfile failed; run it manually to see the details"
    return 1
  fi
}

main() {
  local mode="hook"
  case "${1:-}" in
    --print-plan) mode="print-plan" ;;
    --install-only) mode="install-only" ;;
  esac

  # WHY フックとしてはローカルで何もしない: このフックはローカルのセッションでも毎回実行される。ローカルは asdf が
  #   .tool-versions どおりの環境を用意しているので、ここで別の Node を入れると二重管理になる。
  #   クラウドでは CLAUDE_CODE_REMOTE=true が設定される（公式 cloud-environments ドキュメント）ので、それで判定する。
  # --print-plan は副作用が無い確認用なので、ローカルでも表示できるようにする。
  # --install-only は setup script 用。setup script は Claude の起動前に走るため CLAUDE_CODE_REMOTE が
  #   設定されていない可能性があり（未確認）、この変数では判定しない。環境設定ダイアログに明示的に書いたときだけ動く。
  if [ "$mode" = "hook" ] && [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    return 0
  fi

  # HOME が空・未設定だと $HOME/.local/node-<版> が /.local/node-<版> のような意図しない場所になる。
  # set -u では防げない（コマンド置換の中の違反は空文字になって処理が続く）ので、ここで明示的に止める。
  if [ -z "${HOME:-}" ]; then
    warn "HOME is empty or unset; skipping"
    return 0
  fi

  local project_dir
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    project_dir="$CLAUDE_PROJECT_DIR"
  else
    # setup script から呼ぶときなど CLAUDE_PROJECT_DIR が無い場合は、scripts/ の 1 つ上をリポジトリ直下とみなす。
    project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  fi

  local tool_versions="$project_dir/.tool-versions"
  if [ ! -f "$tool_versions" ]; then
    warn "${tool_versions} not found; skipping"
    return 0
  fi

  local node_version pnpm_version
  node_version="$(read_tool_version nodejs "$tool_versions")"
  pnpm_version="$(read_tool_version pnpm "$tool_versions")"
  if [ -z "$node_version" ] || [ -z "$pnpm_version" ]; then
    warn "nodejs / pnpm version not found in ${tool_versions}; skipping"
    return 0
  fi

  if [ "$mode" = "print-plan" ]; then
    local installed target
    installed="$(find_installed_node_dir "$node_version")"
    target="$(install_target_node_dir "$node_version")"
    echo "nodejs ${node_version}"
    echo "pnpm ${pnpm_version}"
    echo "node_dir ${installed:-$target}"
    if [ -n "$installed" ]; then echo "installed yes"; else echo "installed no"; fi
    echo "node_url https://nodejs.org/dist/v${node_version}/node-v${node_version}-$(node_platform 2>/dev/null || echo unsupported).tar.xz"
    echo "pnpm_bin ${installed:-$target}/bin/pnpm"
    return 0
  fi

  NODE_DIR=""
  if [ "$mode" = "install-only" ]; then
    # setup script ではセッションがまだ無いので、PATH の書き出しと pnpm install はしない（フック側の仕事）。
    ensure_node "$node_version" || return 0
    install_pnpm "$pnpm_version" "$NODE_DIR" || return 0
    return 0
  fi

  # WHY フックでの Node / pnpm の導入を一時停止している（2026-09-28〜）:
  #   クラウド環境の Network access が nodejs.org を拒否し（プロキシが CONNECT に 403 を返す）、フックは毎セッション
  #   Node のダウンロードに失敗して、その先の pnpm install まで進まなかった（rules/code/env.md のクラウドセッション節）。
  #   VM 既定の Node 22.22.2 / pnpm 12.7.0 で pnpm build / pnpm test が通ることは実測済みなので、nodejs.org を許可するまでは
  #   PATH 上の pnpm（VM 既定）で pnpm install だけを行う。registry.npmjs.org は許可されているので pnpm install は通る。
  # 戻し方: 環境設定の Network access で nodejs.org を許可したら、下の 3 行のコメントを外す（関数は削除せず残してある）。
  #   ensure_node は既存インストール（setup script が入れたもの）があればダウンロードせずに使う。
  #   pnpm の導入より先に PATH を書き出す: pnpm の導入に失敗しても、少なくとも .tool-versions の Node は使えるようにするため。
  # ensure_node "$node_version" || return 0
  # export_path "$NODE_DIR/bin"
  # install_pnpm "$pnpm_version" "$NODE_DIR" || return 0
  install_dependencies "$project_dir" || return 0
}

# サブシェルで実行する: set -u の違反など想定外の理由で main が異常終了しても、下の exit 0 まで到達させるため。
( main "$@" ) || warn "unexpected failure (exit $?); continuing the session"
exit 0
