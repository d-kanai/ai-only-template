#!/usr/bin/env bash
# worktree 用の .env の内容を stdout に出す（設計は .claude/rules/worktree.md）。
#
# 使い方:
#   bash scripts/worktree-env.sh <worktree の名前> [.env.example のパス]   # 既定はこのリポジトリの .env.example
#   source scripts/worktree-env.sh; worktree_db_name <名前>              # フックから関数だけを使う
#
# WHAT: .env.example を 1 行ずつ出し、下の「リソースの一覧」にある変数の行だけ、worktree の名前から導いた値に置き換える。
#   それ以外の行（コメント・空行・他の変数）はそのまま出す。先頭に生成の印のコメントを 1 行付ける。
# WHY: 並列の worktree が同じ外部リソース（Postgres のデータベース、E2E のポートなど）を使うと、テストの TRUNCATE や
#   マイグレーション、起動済みのサーバが互いに干渉する。値の入口は apps/shared/env.ts の 1 か所（.env）なので、
#   worktree ごとの .env に別の値を書けば、コードを変えずに分離できる。InMemory / WASM の DB には置き換えない
#   （テストは本物のリソースで行う。ADR docs/adr/workflow/20260928-worktree-isolated-external-resources.md）。
# WHY 決定的（同じ名前 → 同じ値）: 乱数や空きの探索にすると、同じ worktree で作り直したときに値が変わり、作ったデータベースを
#   見失う（孤立する）。名前から計算できれば、後始末（scripts/hooks/worktree-create.sh の孤立したデータベースの削除、
#   worktree-remove.sh）も名前だけで対象を決められる。
#
# リソースの一覧（変数名 → 導出する関数。1 リソース = 1 関数）:
#   DATABASE_URL → derive_DATABASE_URL: パスのデータベース名を app_wt_<sanitize した名前>（63 文字以内）にする
#   E2E_PORT     → derive_E2E_PORT:     3101 + (cksum(名前) % 800)。3101〜3900（メインの 3100 と重ねない）
# リソース（Redis の DB 番号やキーの接頭辞、バケット名の接頭辞など）を足すとき:
#   1. env.ts（アプリの設定は Env / PARSERS で必須、ツールの切り替えは ToolEnv で任意）と .env.example に変数を足す
#      （.claude/rules/env.md）。.env.example には必ず値を書く（ここで置き換える元の行になる）
#   2. ここに derive_<変数名> 関数を足し、RESOURCES と上の一覧に変数名を足す
#   3. 作成が要るもの（create database など）は scripts/hooks/worktree-create.sh に、削除は同じファイルの孤立の掃除と
#      worktree-remove.sh に足す
#   4. scripts/worktree-env.test.ts に導出のテストを足す

# 置き換える変数の一覧。.env.example にどれかが無ければ失敗する（分離されないまま共有のリソースを指す .env を作らないため）。
RESOURCES=(DATABASE_URL E2E_PORT)

# 名前を Postgres の識別子に使える形にする: [a-z0-9_] 以外は _ に、先頭が数字なら _ を前に付ける。
# WHY 英大文字も _ にする: Postgres は引用符なしの識別子を小文字に畳むので、大文字を残すと作った名前と比べる名前がずれる。
# 限界: 違う名前が同じ結果になりうる（a-b と a_b）。Claude Code が付ける名前（agent-<id>、bold-oak-a3f2 など）は
#   英小文字・数字・- だけなので、実用上は重ならない想定（.claude/rules/worktree.md の「限界」）。
worktree_sanitize() {
  local sanitized
  sanitized=$(printf '%s' "$1" | LC_ALL=C tr -c 'a-z0-9_' '_')
  case "$sanitized" in
    [0-9]*) sanitized="_${sanitized}" ;;
  esac
  printf '%s\n' "$sanitized"
}

# worktree の名前 → データベース名。
# WHY 63 文字に切る: Postgres の識別子の上限は 63 バイト（NAMEDATALEN - 1）で、超えると黙って切り詰められ、
#   作った名前と比べる名前がずれるため、先にこちらで切る。app_wt_ の接頭辞は、孤立の掃除で「worktree 用の DB だけ」を
#   選ぶ印（メインの app や他の DB を消さない）。
worktree_db_name() {
  local db
  db="app_wt_$(worktree_sanitize "$1")"
  printf '%s\n' "${db:0:63}"
}

# worktree の名前 → E2E のポート（3101〜3900）。
# WHY cksum: POSIX のコマンドで、Linux と macOS で同じ値になる（POSIX が CRC の計算方法を決めている）。
# WHY 800 通り: 1024 未満（特権ポート）と pnpm dev の 3000・メインの 3100 を避け、並列の数（数個〜十数個）に対して
#   重なりにくい幅にする。重なる可能性は残る（.claude/rules/worktree.md の「限界」）。
worktree_e2e_port() {
  local crc
  crc=$(printf '%s' "$1" | cksum | awk '{print $1}')
  printf '%s\n' "$((3101 + crc % 800))"
}

# derive_<変数名> <worktree の名前> <.env.example の値>: 置き換えた値を stdout に出す。導けなければ非 0。
derive_DATABASE_URL() {
  local name=$1 url=$2 base query
  base="${url%%\?*}"
  query="${url#"$base"}"
  # scheme://host/db の形でなければ、置き換えるデータベース名の場所が無い。
  if [[ ! "$base" =~ ^[A-Za-z][A-Za-z0-9+.-]*://[^/]+/[^/]+$ ]]; then
    echo "worktree-env: DATABASE_URL にデータベース名のパスがありません（値: ${url}）" >&2
    return 1
  fi
  printf '%s\n' "${base%/*}/$(worktree_db_name "$name")${query}"
}

derive_E2E_PORT() {
  worktree_e2e_port "$1"
}

worktree_env_main() {
  set -euo pipefail
  local name=${1:-}
  local example=${2:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env.example"}
  if [ -z "$name" ]; then
    echo "usage: bash scripts/worktree-env.sh <worktree-name> [.env.example]" >&2
    return 1
  fi
  if [ ! -f "$example" ]; then
    echo "worktree-env: ${example} がありません" >&2
    return 1
  fi

  # 途中で失敗したときに半端な内容を stdout に出さないよう、全部組み立ててから出す。
  local output line key resource derived found=" "
  output="# scripts/worktree-env.sh が .env.example から生成した worktree「${name}」用の .env（手で直しても次の WorktreeCreate で上書きされる）"$'\n'
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"
    for resource in "${RESOURCES[@]}"; do
      if [ "$line" != "$key" ] && [ "$key" = "$resource" ]; then
        derived=$("derive_${resource}" "$name" "${line#*=}")
        line="${resource}=${derived}"
        found+="${resource} "
      fi
    done
    output+="${line}"$'\n'
  done < "$example"

  for resource in "${RESOURCES[@]}"; do
    if [[ "$found" != *" ${resource} "* ]]; then
      echo "worktree-env: ${example} に ${resource} がありません（worktree ごとに分けられないため .env を作りません）" >&2
      return 1
    fi
  done
  printf '%s' "$output"
}

# 直接実行したときだけ main を動かす（source したときは関数の定義だけ）。
# WHY return で判定する: source されたときだけ return が成功する。BASH_SOURCE[0] と $0 の比較は、
#   bash -c 'source "$0"' <このファイル> のように $0 がこのファイルになる呼び方で誤判定するため。
if ! (return 0 2>/dev/null); then
  worktree_env_main "$@"
fi
