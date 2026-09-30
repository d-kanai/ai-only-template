#!/bin/bash
# クラウドセッション（Claude Code on the web）の VM に、.tool-versions と同じ Node.js / pnpm を用意し、
# compose.yaml の Postgres を起動してマイグレーション（apps/backend/shared/drizzle/）を当てる（フックのときだけ）。
# 詳細・役割分担は .claude/rules/cloud-session.md を参照。
#
# 使い方:
#   bash scripts/cloud-session-start.sh --install-only  # 環境設定の setup script から呼ぶ。Node / pnpm のインストールだけ行う
#   bash scripts/cloud-session-start.sh                 # SessionStart フック（.claude/settings.json）から呼ぶ。
#                                                       #   CLAUDE_CODE_REMOTE=true のときだけ動き、PATH の書き出しと pnpm install、
#                                                       #   .env が無ければ .env.example からのコピー、dockerd の起動と
#                                                       #   docker compose pull / up（Postgres）、pnpm db:migrate を行う
#   bash scripts/cloud-session-start.sh --print-plan    # 読み取った版とインストール先を表示するだけ（テスト・確認用）
#   CLOUD_SESSION_START_DRY_RUN=1 ...                   # ダウンロード・インストールをせず、実行予定のコマンドを表示する
#
# WHY 2 つの入口に分けるか: 環境設定の setup script は初回だけ実行されてファイルシステムがキャッシュされるが、
#   SessionStart フックは毎セッション実行される（公式 cloud-environments / hooks ドキュメント）。重いダウンロードは
#   setup script（--install-only）に寄せ、フックは「既存のインストールを見つけて PATH を通し pnpm install する」
#   だけの速い経路にする。setup script を設定していない環境でも動くよう、フックは未インストールなら自分で入れる。
#
# WHY Node を npm レジストリからも取れるようにするか: 2026-09-28 のクラウドセッションで、nodejs.org への CONNECT が
#   プロキシに 403 で拒否された（環境のネットワークポリシーで未許可）。一方 registry.npmjs.org はプロキシを通らず
#   直接届く（no_proxy に含まれる）。npm レジストリには Node 公式バイナリをそのまま同梱した node-linux-<arch>
#   （node-bin-gen、provenance 付き）があるので、nodejs.org で取れなければそちらに切り替える。環境設定で nodejs.org を
#   許可すれば第一候補の nodejs.org で取れる。どちらの経路でも、検証に通らなければ展開しない。
# WHY pnpm を npm で入れないか: レジストリの node-linux-<arch> には npm が同梱されていない。Node の入手経路で
#   pnpm の入れ方が変わると確認すべき経路が倍になるので、pnpm は常にレジストリの tarball から入れる 1 本にする。
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
#     クラウドで nodejs.org がプロキシに 403 で拒否されるときは、curl -f が待たずにすぐ失敗する（2026-09-28 実測）。
#   --max-time（呼び出し側で指定）: 1 回の取得の上限。数十 MB の tarball は 60 秒、それ以外（SHASUMS256.txt、
#     レジストリのメタデータ、1 MB の pnpm tarball）は 20 秒。
#     2026-09-28 のクラウド VM での実測: レジストリの node-linux-x64（52 MB）は取得・検証・展開まで 3.1 秒、
#     @pnpm/exe.linux-x64（25 MB）の取得は 0.2 秒。nodejs.org の .tar.xz はローカルで取得・展開まで約 5 秒。
#     60 秒かかるなら止まっているとみなせる。
#   最悪ケース（nodejs.org の 2 回がどちらも上限まで粘った末に失敗し、レジストリにフォールバックして Node 2 回・
#     pnpm 4 回を取得）の合計は、接続タイムアウトも足した保守的な見積もりで
#     (15 + 60) + (15 + 20)             … nodejs.org の tarball + SHASUMS256.txt
#     + (15 + 20) + (15 + 60)           … レジストリの node-linux-<arch> のメタデータ + tarball
#     + (15 + 20) + (15 + 20)           … pnpm のメタデータ + tarball
#     + (15 + 20) + (15 + 60) = 400 秒  … @pnpm/exe.<platform> のメタデータ + tarball
#     で、フックの 600 秒から pnpm install（クラウドで実測 10 秒）の時間を引いても余裕がある。
#     実際には --max-time が接続を含む 1 回の取得全体の上限なので、最悪でも max-time の和の 280 秒で終わる。
#   setup script の約 5 分はキャッシュされるかどうかの目安で、超えても失敗はしない（キャッシュされないだけ）ため、
#   上限はフックの 600 秒に合わせている。
download() {
  local url="$1" out="$2" max_time="$3"
  curl -fsSL --connect-timeout 15 --max-time "$max_time" -o "$out" "$url"
}

# WHY 1 か所にまとめる: レジストリの URL は --print-plan・DRY_RUN・実際の取得で同じものを使うため。
NPM_REGISTRY="https://registry.npmjs.org"

sha256_of() {
  # Ubuntu（クラウド VM）には coreutils の sha256sum がある。macOS で手元確認するときのために shasum にも倒す。
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# npm の integrity と同じ形式（sha512 の生バイトを base64 にしたもの）を返す。
# openssl を使う: Ubuntu（クラウド VM）にも macOS にもある。sha512sum は 16 進で出すので base64 に直す手間がかかる。
# macOS の base64 には改行を抑える -w0 が無いので、tr で改行を消して両方で同じ 1 行にする。
# openssl が無いときは空文字になり、呼び出し側の照合が一致しないので展開されない（検証できないものは入れない）。
sha512_integrity_of() {
  openssl dgst -sha512 -binary "$1" | base64 | tr -d '\n'
}

# レジストリの版メタデータ（JSON）から "<key>":"<文字列>" の値を取り出す。
# WHY jq を使わない: クラウド VM に jq があるかは未確認で、無ければフォールバックそのものが動かなくなるため。
#   レジストリのメタデータは空白なしの 1 行 JSON で、dist.integrity / dist.tarball のキーはそれぞれ 1 回だけ出る
#   （2026-09-28 に node-linux-x64 / pnpm / @pnpm/exe.linux-x64 の版メタデータで確認）。念のため空白も許し、最初の一致を使う。
json_string_field() {
  local key="$1" file="$2"
  grep -o "\"${key}\" *: *\"[^\"]*\"" "$file" | head -n 1 | sed 's/^.*: *"\(.*\)"$/\1/'
}

# npm レジストリからパッケージ <name>@<version> を取得・検証し、<dest>/package に展開する。
# 失敗したら warn を出して失敗を返す（<dest> の後始末は呼び出し側の一時ディレクトリごと消す）。
# WHY dist.integrity で検証する: nodejs.org の SHASUMS256.txt と同じく、途中で切れた・壊れた・差し替えられた
#   tarball を展開して以後ずっと使い続ける事故を防ぐため。integrity は npm が公開時に記録した tarball の sha512 で、
#   npm / pnpm 自身もインストール時にこれで照合している。sha512 以外（古い sha1 など）は弱いので受け付けない。
# 引数 max_time は tarball の取得の上限（秒）。メタデータは数 KB なので 20 秒で固定する。
fetch_registry_package() {
  local name="$1" version="$2" dest="$3" max_time="$4"
  local meta_url="${NPM_REGISTRY}/${name}/${version}"

  mkdir -p "$dest" || { warn "failed to create ${dest}"; return 1; }
  if ! download "$meta_url" "$dest/meta.json" 20; then
    warn "failed to download ${meta_url}"
    return 1
  fi

  local integrity tarball_url
  integrity="$(json_string_field integrity "$dest/meta.json")"
  tarball_url="$(json_string_field tarball "$dest/meta.json")"
  case "$integrity" in
    sha512-?*) ;;
    *)
      warn "no sha512 integrity in ${meta_url}"
      return 1
      ;;
  esac
  # https 以外（メタデータの破損など）の URL は取りに行かない。
  case "$tarball_url" in
    https://?*) ;;
    *)
      warn "no https tarball URL in ${meta_url}"
      return 1
      ;;
  esac

  if ! download "$tarball_url" "$dest/package.tgz" "$max_time"; then
    warn "failed to download ${tarball_url}"
    return 1
  fi
  local actual
  actual="sha512-$(sha512_integrity_of "$dest/package.tgz")"
  if [ "$actual" != "$integrity" ]; then
    warn "integrity mismatch for ${name}@${version} (expected: ${integrity}, actual: ${actual})"
    return 1
  fi

  # npm の tarball は package/ 以下に中身が入っている（node-linux-<arch>・pnpm・@pnpm/exe で確認）。
  if ! tar -xzf "$dest/package.tgz" -C "$dest" || [ ! -d "$dest/package" ]; then
    warn "failed to extract ${tarball_url}"
    return 1
  fi
}

# 第一候補: nodejs.org の公式配布物を取得し、SHASUMS256.txt で検証して <work>/node-v<版>-<platform> に展開する。
fetch_node_from_nodejs_org() {
  local version="$1" platform="$2" work="$3"
  local dist_base="https://nodejs.org/dist/v${version}"
  local tarball="node-v${version}-${platform}.tar.xz"

  if ! download "${dist_base}/${tarball}" "$work/$tarball" 60; then
    warn "failed to download ${dist_base}/${tarball}"
    return 1
  fi
  if ! download "${dist_base}/SHASUMS256.txt" "$work/SHASUMS256.txt" 20; then
    warn "failed to download ${dist_base}/SHASUMS256.txt"
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
    return 1
  fi

  if ! tar -xJf "$work/$tarball" -C "$work"; then
    warn "failed to extract ${tarball}"
    return 1
  fi
}

install_node() {
  local version="$1" node_dir="$2"
  local platform base
  platform="$(node_platform)" || return 1
  base="$(dirname "$node_dir")"

  if is_dry_run; then
    local dist_base="https://nodejs.org/dist/v${version}" tarball="node-v${version}-${platform}.tar.xz"
    echo "[dry-run] curl -fsSL ${dist_base}/${tarball}"
    echo "[dry-run] curl -fsSL ${dist_base}/SHASUMS256.txt"
    echo "[dry-run] verify sha256 of ${tarball} against SHASUMS256.txt"
    echo "[dry-run] tar -xJf ${tarball} -> ${node_dir}"
    echo "[dry-run] if nodejs.org fails: curl -fsSL ${NPM_REGISTRY}/node-${platform}/${version} (dist.integrity / dist.tarball)"
    echo "[dry-run]   curl -fsSL <dist.tarball>, verify sha512 against dist.integrity, tar -xzf -> ${node_dir}"
    return 0
  fi

  mkdir -p "$base" || { warn "failed to create ${base}"; return 1; }
  # 一時ディレクトリは展開先と同じ場所に作る。最後の mv を同一ファイルシステム内の rename にして、
  # 一瞬で完了させる（別ファイルシステムだとコピーになり、途中で止まると中途半端なディレクトリが残る）。
  local work
  work="$(mktemp -d "$base/.node-download.XXXXXX")" || { warn "mktemp failed in ${base}"; return 1; }

  local extracted
  if fetch_node_from_nodejs_org "$version" "$platform" "$work"; then
    extracted="$work/node-v${version}-${platform}"
  else
    warn "falling back to the npm registry (node-${platform}@${version})"
    if ! fetch_registry_package "node-${platform}" "$version" "$work/registry" 60; then
      rm -rf "$work"
      return 1
    fi
    # node-linux-<arch> の package/ は bin/node・include・share などの公式配布物と同じ構成（npm は無い）。
    extracted="$work/registry/package"
  fi
  if [ ! -x "$extracted/bin/node" ]; then
    warn "bin/node not found in the downloaded Node.js"
    rm -rf "$work"
    return 1
  fi

  # WHY 一時ディレクトリに展開してから mv する: 展開が途中で止まったとき（タイムアウト等）に中途半端な
  #   $node_dir が残ると、次回「インストール済み」と誤判定して壊れた Node を使い続けてしまうため。
  # ここに来るのは $node_dir/bin/node が無いとき（find_installed_node_dir で見つからなかった）なので、
  #   $node_dir が残っていれば壊れたインストールとみなして消す。消さずに mv すると $node_dir の中に
  #   展開したディレクトリが入れ子になり、bin/node が見つからないままになる。
  if [ -e "$node_dir" ] && ! rm -rf "$node_dir"; then
    warn "failed to remove broken ${node_dir}"
    rm -rf "$work"
    return 1
  fi
  if ! mv "$extracted" "$node_dir"; then
    warn "failed to move Node.js into ${node_dir}"
    rm -rf "$work"
    return 1
  fi
  rm -rf "$work"
}

# pnpm をレジストリの tarball から $node_dir/lib/node_modules/pnpm に入れ、$node_dir/bin/pnpm から実行できるようにする。
# WHY 2 つのパッケージを取るか: pnpm 12 の本体は Rust のネイティブバイナリで、pnpm パッケージの package/pnpm は
#   それに置き換えられる前提の placeholder にすぎない。バイナリは os/cpu 別の @pnpm/exe.<platform> パッケージにあり、
#   `npm install -g pnpm` では optionalDependencies として一緒に入り、preinstall（install.js）が placeholder を
#   バイナリで置き換える（pnpm@12.7.0 の install.js / native-binary.mjs で確認）。ここでも同じ最終形を作る。
#   pnpm パッケージだけを置くと、初回実行時に bin/pnpm.mjs がバイナリを自分でダウンロードしに行く。その通信は
#   このスクリプトのタイムアウトや検証の外になるので、2 つとも自分で取得・検証する。
# WHY pnpm パッケージも置くか（バイナリだけにしない）: ネイティブバイナリは同梱の dist/（node-gyp）を自分の隣から
#   探す（bin/pnpm.mjs のコメント）。pn / pnpx / pnx の sh スクリプトも隣の pnpm を実行する。
# libc は glibc 前提（クラウド VM は Ubuntu）。musl 用の @pnpm/exe.<platform>-musl は扱わない。
install_pnpm() {
  local version="$1" node_dir="$2"

  # 冪等性: 同じ版が入っていれば何もしない（`pnpm --version` の確認だけなので速い）。
  if [ -x "$node_dir/bin/pnpm" ] && [ "$("$node_dir/bin/pnpm" --version 2>/dev/null)" = "$version" ]; then
    return 0
  fi

  local platform
  platform="$(node_platform)" || return 1
  local exe_name="@pnpm/exe.${platform}"
  local modules="$node_dir/lib/node_modules"

  if is_dry_run; then
    echo "[dry-run] curl -fsSL ${NPM_REGISTRY}/pnpm/${version} (dist.integrity / dist.tarball)"
    echo "[dry-run] curl -fsSL ${NPM_REGISTRY}/${exe_name}/${version} (dist.integrity / dist.tarball)"
    echo "[dry-run]   curl -fsSL <dist.tarball> for each, verify sha512 against dist.integrity, tar -xzf"
    echo "[dry-run] place pnpm -> ${modules}/pnpm (native binary from ${exe_name} replaces the placeholder)"
    echo "[dry-run] ln -s ../lib/node_modules/pnpm/pnpm ${node_dir}/bin/pnpm"
    return 0
  fi

  mkdir -p "$modules" "$node_dir/bin" || { warn "failed to create ${modules}"; return 1; }
  # Node と同じく、置き場所と同じディレクトリに一時ディレクトリを作り、最後に rename で差し替える。
  local work
  work="$(mktemp -d "$modules/.pnpm-download.XXXXXX")" || { warn "mktemp failed in ${modules}"; return 1; }

  if ! fetch_registry_package pnpm "$version" "$work/pnpm" 20 \
    || ! fetch_registry_package "$exe_name" "$version" "$work/exe" 60; then
    warn "failed to install pnpm@${version}"
    rm -rf "$work"
    return 1
  fi
  if ! mv -f "$work/exe/package/pnpm" "$work/pnpm/package/pnpm"; then
    warn "failed to install pnpm@${version} (could not place the native binary)"
    rm -rf "$work"
    return 1
  fi
  # 別の版や壊れた pnpm が残っていれば消してから置く（残したまま mv すると中に入れ子になるため）。
  if [ -e "$modules/pnpm" ] && ! rm -rf "$modules/pnpm"; then
    warn "failed to install pnpm@${version} (could not remove ${modules}/pnpm)"
    rm -rf "$work"
    return 1
  fi
  if ! mv "$work/pnpm/package" "$modules/pnpm"; then
    warn "failed to install pnpm@${version} (could not move it into ${modules})"
    rm -rf "$work"
    return 1
  fi
  rm -rf "$work"

  # npm の global install と同じく、bin には相対 symlink を置く（node_dir ごと移しても壊れない）。
  local bin_name
  for bin_name in pnpm pnpx pn pnx; do
    [ -e "$modules/pnpm/$bin_name" ] || continue
    if ! ln -sfn "../lib/node_modules/pnpm/${bin_name}" "$node_dir/bin/${bin_name}"; then
      warn "failed to install pnpm@${version} (could not link bin/${bin_name})"
      return 1
    fi
  done
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

  # この後の pnpm install を、入れた Node と pnpm で動かす。pnpm 自体はネイティブバイナリだが、
  # 依存のライフサイクルスクリプト（postinstall など）は PATH の node で動くので、PATH の先頭に置かないと
  # VM 既定の Node 22 で動き、さらに VM 既定の pnpm が先に見つかってしまう。
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
  #   書き換えて差分を作らないため（依存の版は lockfile が正。.claude/rules/dependencies.md）。
  if ! (cd "$project_dir" && pnpm install --frozen-lockfile >&2); then
    warn "pnpm install --frozen-lockfile failed; run it manually to see the details"
    return 1
  fi
}

# docker のデーモンが使えるようにする。動いていなければ dockerd をバックグラウンドで起動し、docker info が通るまで待つ。
# WHY フックで起動するか: クラウド VM には docker CLI・dockerd・containerd・Compose プラグインが入っているが、
#   デーモンは起動していない（2026-09-28 実測。docker info が失敗する）。VM はセッションごとに新しく、
#   セッション中に起動したプロセスは次のセッションに残らないので、毎セッション起動する。
# WHY 既定のソケット（/var/run/docker.sock）・データ置き場（/var/lib/docker）のまま起動するか: root で dockerd を
#   引数なしで起動すると、約 1 秒で /var/run/docker.sock で待ち受けた（2026-09-28 実測）。既定のままなら
#   DOCKER_HOST を CLAUDE_ENV_FILE に書き出す必要がなく、以降の Bash の docker / docker compose もそのまま動く。
# WHY setsid nohup で切り離すか: dockerd はフックが終わった後もセッション中ずっと動いている必要がある。フックの
#   プロセスグループやセッションが終わるときのシグナルで一緒に止まらないよう、別セッションにする。
#   setsid は util-linux のコマンドで macOS には無いので、無ければ nohup だけで起動する（テストを macOS でも動かすため）。
# WHY 標準入出力をすべて付け替えるか: バックグラウンドの dockerd がフックの stdout / stderr を握ったままだと、
#   フックの呼び出し側が出力の終わりを待ち続けうる（spawnSync のテストでも同じ）。出力はログファイルに残し、
#   起動に失敗したときに読めるようにする。ログは ${TMPDIR:-/tmp}/dockerd.log（テストで一時ディレクトリに差し替えるため TMPDIR に従う）。
# WHY 待つのは 30 秒か: 実測では 1 秒程度で使えるようになる。30 秒かかるなら起動に失敗しているとみなし、
#   フックの 600 秒打ち切りに近づく前に諦める。CLOUD_SESSION_START_DOCKER_WAIT_SECONDS はテストで待ち時間を
#   縮めるための差し替え口。
# 失敗したら warn を出して失敗を返す（呼び出し側で Postgres の起動を飛ばす）。
ensure_docker_daemon() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found; skipping Postgres"
    return 1
  fi
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v dockerd >/dev/null 2>&1; then
    warn "docker daemon is not running and dockerd not found; skipping Postgres"
    return 1
  fi

  local log="${TMPDIR:-/tmp}/dockerd.log"
  local wait_seconds="${CLOUD_SESSION_START_DOCKER_WAIT_SECONDS:-30}"
  if is_dry_run; then
    echo "[dry-run] setsid nohup dockerd </dev/null >${log} 2>&1 &"
    echo "[dry-run] wait up to ${wait_seconds}s until docker info succeeds"
    return 0
  fi

  if command -v setsid >/dev/null 2>&1; then
    setsid nohup dockerd </dev/null >"$log" 2>&1 &
  else
    nohup dockerd </dev/null >"$log" 2>&1 &
  fi

  local deadline=$((SECONDS + wait_seconds))
  until docker info >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      warn "docker daemon did not become ready within ${wait_seconds}s; see ${log}"
      return 1
    fi
    sleep 1
  done
}

# compose.yaml の Postgres のイメージを取得してから起動し、healthcheck が通る（healthy になる）まで待つ。
# WHY pull を分けて再試行するか: イメージの取得はネットワークに左右される唯一の段で、一時的な失敗（レート制限・
#   通信の切断）で Postgres が起動しないのを減らすため。2026-09-28 のクラウド VM では Docker Hub の匿名 pull が
#   429（出口 IP の残り回数 0）で失敗し、直後の再試行では通った。イメージは compose.yaml で mirror.gcr.io に
#   しているが、ミラーでも一時的な失敗はありうるので再試行は残す。
#   最大 3 回、間隔は 2 秒・4 秒（倍々）。最後の失敗の後は待たない。取得済みのイメージなら pull は数秒で終わる。
# WHY pull を timeout 45 で囲むか: curl の --max-time と同じく、通信が止まったまま待ち続けてフックの 600 秒打ち切りに
#   達し「失敗しても warn を出して exit 0 で続ける」設計が崩れるのを防ぐため。docker compose pull 自体には全体の
#   上限を指定するオプションが無い。45 秒は実測（mirror.gcr.io から 18-alpine の初回 pull が 10.5 秒、2026-09-28）の
#   4 倍強で、45 秒かかるなら止まっているとみなす。
#   値はフック全体の最悪ケースを 600 秒に収めるように決めた（.claude/rules/cloud-session.md の「時間の上限」）:
#     Node / pnpm の取得（curl の --max-time の和）280 + デーモン待ち 30 + pull 45 × 3 + 再試行の間隔 6
#     + up の --wait-timeout 120 = 571 秒。残り約 30 秒が pnpm install（実測 10 秒）などの分。
#   pull を 240 秒にすると Docker の段だけで 30 + 720 + 6 + 120 = 876 秒になり、600 秒を超える。
#   timeout で打ち切られた pull は失敗として扱い、次の再試行に回る。
# WHY --wait: コンテナの起動だけでなく healthcheck（pg_isready）が通るまで待つ。フックが終わった時点で
#   psql やアプリから接続できる状態にするため。
# WHY --wait-timeout 120: healthcheck は約 30 秒（2 秒 × 15 回）で unhealthy になり --wait は失敗で返るが、
#   コンテナの作成・起動そのものが止まった場合にも上限を設け、フックの 600 秒打ち切りに近づく前に諦める。
#   pull は up の前に済ませているので、この 120 秒に pull の時間は含まれない。実測では 3 秒で healthy になった。
# WHY 出力を stderr に回すか: SessionStart フックの stdout は Claude のコンテキストに入るため、pull の進捗などで
#   埋めない（pnpm install と同じ）。
# イメージの pull は毎セッション行う（約 10 秒、2026-09-28 実測）。setup script（--install-only）で pull して
#   環境キャッシュに残す案は、キャッシュに /var/lib/docker が含まれるかを確かめていないため入れていない。
start_database() {
  local project_dir="$1"
  if is_dry_run; then
    echo "[dry-run] (cd ${project_dir} && timeout 45 docker compose pull) up to 3 times, waiting 2s / 4s between attempts"
    echo "[dry-run] (cd ${project_dir} && docker compose up -d --wait --wait-timeout 120)"
    return 0
  fi

  local attempt delay=2
  for attempt in 1 2 3; do
    if (cd "$project_dir" && timeout 45 docker compose pull >&2); then
      break
    fi
    if [ "$attempt" -eq 3 ]; then
      warn "docker compose pull failed 3 times; skipping Postgres"
      return 1
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done

  if ! (cd "$project_dir" && docker compose up -d --wait --wait-timeout 120 >&2); then
    warn "docker compose up -d --wait --wait-timeout 120 failed; run it manually to see the details"
    return 1
  fi
}

# リポジトリ直下の .env が無ければ .env.example からコピーする（Issue #59）。既にあれば触らない。
# WHY: アプリ・テスト・drizzle-kit は必須の環境変数を .env から読み（apps/shared/env.ts）、既定値を持たない。
#   VM はセッションごとに新しいクローンで .env が無いので、そのままだと pnpm db:migrate も pnpm test も欠けた変数の名前を
#   出して止まる。.env.example の値は compose.yaml の開発用 DB に合わせた開発用の値（秘密ではない）で、手元の
#   `cp .env.example .env` と同じ状態にする。
# WHY 既にある .env は上書きしない: 利用者がセッションの中で書き換えた値（別の DB を指すなど）を消さないため。
# WHY .env.example も無いときは warn だけで続ける: 環境変数だけで値が渡されている場合もあり、その場合は pnpm db:migrate が通る。
#   足りなければ env.ts が欠けた名前を出し、下の migrate の warn になる。
# WHY Docker の段より前に呼ぶ（main）: docker が無い・pull や up が失敗したときも、pnpm test / pnpm dev などは .env が無いと
#   必須の変数が欠けて止まる。.env の用意は Docker に依存しないので、Docker の結果に関係なく行う（Issue #59 の reviewer 指摘）。
ensure_dotenv() {
  local project_dir="$1"
  if [ -f "$project_dir/.env" ]; then
    if is_dry_run; then echo "[dry-run] ${project_dir}/.env exists; keep it"; fi
    return 0
  fi
  if [ ! -f "$project_dir/.env.example" ]; then
    warn "${project_dir}/.env.example not found; not creating .env"
    return 0
  fi
  if is_dry_run; then
    echo "[dry-run] (cd ${project_dir} && cp .env.example .env)"
    return 0
  fi
  if ! (cd "$project_dir" && cp .env.example .env); then
    warn "cp .env.example .env failed"
  fi
}

# 起動した Postgres に apps/backend/shared/drizzle/ のマイグレーションを当てる（pnpm db:migrate = drizzle-kit migrate。Issue #57）。
# WHY フックで当てるか: VM はセッションごとに新しく、Postgres もデータの無い状態で起動する。表が無いままだと、
#   pnpm dev / pnpm test:e2e が「relation "todos" does not exist」で失敗する。
#   当て済みのものは飛ばす（drizzle.__drizzle_migrations に記録がある）ので、何度実行しても同じ結果になる。
# 接続先（DATABASE_URL）は apps/backend/shared/drizzle/drizzle.config.ts が env.ts 経由で .env から読む（.env は main で Docker の段より前に
#   ensure_dotenv が用意済み）。スクリプトは接続先を持たず、DATABASE_URL を差し込まない（既定値を 1 か所 = .env.example に
#   するため。Issue #59）。フックの環境に DATABASE_URL があれば、そのまま引き継がれて .env より優先される。
# WHY timeout 15: 実測は約 1 秒（2026-09-28、表 1 つ）。15 秒かかるなら止まっているとみなす。フック全体の最悪ケースを
#   600 秒に収めるための見積もりは .claude/rules/cloud-session.md の「時間の上限」（571 + 15 = 586 秒）。
# WHY Node / pnpm の導入に失敗していても試すか: VM 既定の pnpm でも packageManager の版を取って動く（2026-09-28 の work-logs の VM の実測）。
#   失敗しても warn を出すだけで、セッションは続けられる。
# 出力は stderr に回す（stdout は Claude のコンテキストに入るため。start_database と同じ）。
migrate_database() {
  local project_dir="$1"
  if is_dry_run; then
    echo "[dry-run] (cd ${project_dir} && timeout 15 pnpm db:migrate)"
    return 0
  fi
  if ! (cd "$project_dir" && timeout 15 pnpm db:migrate >&2); then
    warn "pnpm db:migrate failed; run it manually to see the details"
    return 1
  fi
}

# フック: Node / pnpm を用意して pnpm install する。失敗しても呼び出し側は続けて Postgres を起動する。
setup_node_and_dependencies() {
  local node_version="$1" pnpm_version="$2" project_dir="$3"
  NODE_DIR=""
  ensure_node "$node_version" || return 0

  # setup script で入れ済みなら、ここはダウンロードせず PATH の書き出しと pnpm install だけの速い経路になる。
  # pnpm の導入より先に PATH を書き出す: pnpm の導入に失敗しても、少なくとも .tool-versions の Node は使えるようにするため。
  export_path "$NODE_DIR/bin"
  install_pnpm "$pnpm_version" "$NODE_DIR" || return 0
  install_dependencies "$project_dir" || return 0
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
    local platform
    platform="$(node_platform 2>/dev/null || echo unsupported)"
    echo "node_url https://nodejs.org/dist/v${node_version}/node-v${node_version}-${platform}.tar.xz"
    echo "node_registry_url ${NPM_REGISTRY}/node-${platform}/${node_version}"
    echo "pnpm_registry_url ${NPM_REGISTRY}/pnpm/${pnpm_version}"
    echo "pnpm_exe_registry_url ${NPM_REGISTRY}/@pnpm/exe.${platform}/${pnpm_version}"
    echo "pnpm_bin ${installed:-$target}/bin/pnpm"
    return 0
  fi

  if [ "$mode" = "install-only" ]; then
    # setup script ではセッションがまだ無いので、PATH の書き出しと pnpm install はしない（フック側の仕事）。
    # docker も触らない: setup script の後にキャッシュされるのはファイルシステムのスナップショット（公式 cloud-environments
    #   ドキュメント）なので、ここで起動したデーモン（プロセス）はセッションに残らない。イメージの事前 pull は start_database のコメント。
    NODE_DIR=""
    ensure_node "$node_version" || return 0
    install_pnpm "$pnpm_version" "$NODE_DIR" || return 0
    return 0
  fi

  # WHY Node / pnpm の失敗で Postgres の起動を止めないか: Postgres はコンテナで動き、Node に依存しない。
  #   Node の取得に失敗しても（VM 既定の Node 22 で作業は続けられる）、DB は使えるようにしておく。
  setup_node_and_dependencies "$node_version" "$pnpm_version" "$project_dir"
  ensure_dotenv "$project_dir"
  ensure_docker_daemon || return 0
  start_database "$project_dir" || return 0
  migrate_database "$project_dir" || return 0
}

# サブシェルで実行する: set -u の違反など想定外の理由で main が異常終了しても、下の exit 0 まで到達させるため。
( main "$@" ) || warn "unexpected failure (exit $?); continuing the session"
exit 0
