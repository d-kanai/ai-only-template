#!/usr/bin/env bash
# Claude Code の WorktreeRemove フック（設計と WHY は .claude/rules/worktree.md）。
# worktree-create.sh が作った worktree（<メイン>/.claude/worktrees/<name>）の DB を drop し、共有フックを修復する。
#
# 入力（stdin の JSON）: worktree_path（WorktreeCreate が返したパス）、cwd。出力: なし（JSON の出力は捨てられる。公式
#   https://code.claude.com/docs/en/hooks.md の「WorktreeRemove」）。
# 終了コード: 常に 0。WHY: 0 以外だと、ディレクトリが残っている場合に worktree の削除そのものが失敗する（公式）。
#   DB の削除に失敗しても worktree の削除は止めない（残った DB は次の worktree-create.sh が孤立として消す）。
# WHY worktree のディレクトリは消さない: このフックの役割は worktree の外にあるリソース（DB）の後始末だけ。
# 注意: このフックが発火することは確かめられていない（isolation: worktree のサブエージェントの終了では発火しない）。
#   後始末の本命は worktree-create.sh の孤立した DB の掃除で、こちらは発火したときに早めに消すだけ。
#
# 確認:
#   echo '{"worktree_path":"'"$PWD"'/.claude/worktrees/try-1"}' | WORKTREE_HOOK_DRY_RUN=1 bash scripts/hooks/worktree-remove.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../worktree-env.sh
source "${SCRIPT_DIR}/../worktree-env.sh"

# WHY 固定値と接続先: worktree-create.sh と同じ（compose.yaml の app / app に接続して drop する）。
PSQL=(docker compose exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -At -c)

warn() {
  echo "worktree-remove: $*" >&2
}

is_dry_run() {
  [ "${WORKTREE_HOOK_DRY_RUN:-}" = "1" ]
}

# timeout があれば上限を付けて実行する（worktree-create.sh と同じ。macOS には標準で無いので、無ければそのまま実行）。
with_timeout() {
  local seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    "$@"
  fi
}

INPUT=$(cat)
WORKTREE_PATH=$(node -e 'let j; try { j = JSON.parse(process.argv[1]); } catch { process.exit(0); }
  const v = j?.worktree_path; process.stdout.write(typeof v === "string" ? v : "");' "$INPUT")

# このフックが作った形（<メイン>/.claude/worktrees/<name>）でなければ何もしない（関係のない DB を消さないため）。
# WHY cwd ではなく worktree_path からメインを求める: cwd は消えかけの worktree の中であることがあり、そこから git で
#   メインを探せるとは限らない。
case "$WORKTREE_PATH" in
  */.claude/worktrees/*) ;;
  *) exit 0 ;;
esac
MAIN_DIR=${WORKTREE_PATH%/.claude/worktrees/*}
NAME=${WORKTREE_PATH##*/.claude/worktrees/}
if [[ ! "$NAME" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]]; then
  exit 0
fi
DB=$(worktree_db_name "$NAME")
DROP_SQL="drop database if exists ${DB} with (force)"

if is_dry_run; then
  echo "[dry-run] (cd ${MAIN_DIR} && ${PSQL[*]} \"${DROP_SQL}\")"
  echo "[dry-run] (cd ${MAIN_DIR} && pnpm exec lefthook install) if .git/hooks/pre-commit points into .claude/worktrees/"
  exit 0
fi

# WITH (FORCE): 消える worktree のサーバ（E2E の next start など）が接続を残していても消す（Postgres 13 以降）。
# メインで実行する理由は worktree-create.sh の psql_main と同じ（docker compose のプロジェクト名はディレクトリ名で決まる）。
if ! command -v docker >/dev/null 2>&1; then
  warn "docker がありません。DB ${DB} は残ります（次の WorktreeCreate が孤立した DB として消します）"
elif ! (cd "$MAIN_DIR" && with_timeout 15 "${PSQL[@]}" "$DROP_SQL") >/dev/null; then
  warn "DB ${DB} を drop できませんでした（次の WorktreeCreate が孤立した DB として消します）"
fi

# 共有フックの修復（WHY は worktree-create.sh の repair_shared_hook）。worktree を消すと、そこを指すフックは動かなくなる。
hooks_dir=$(git -C "$MAIN_DIR" rev-parse --path-format=absolute --git-path hooks 2>/dev/null) || exit 0
if [ -f "${hooks_dir}/pre-commit" ] && grep -Fq "/.claude/worktrees/" "${hooks_dir}/pre-commit"; then
  (cd "$MAIN_DIR" && with_timeout 60 pnpm exec lefthook install) >&2 ||
    warn "共有フックの修復（pnpm exec lefthook install）に失敗しました。メインで pnpm exec lefthook install を実行してください"
fi
exit 0
