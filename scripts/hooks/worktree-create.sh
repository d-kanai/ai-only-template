#!/usr/bin/env bash
# Claude Code の WorktreeCreate フック（Issue #64。設計と WHY は .claude/rules/worktree.md）。
# claude --worktree や、サブエージェントの isolation: "worktree" で worktree を作るときに Claude Code が呼ぶ。
# フックを設定すると Claude Code は自分では git worktree を作らない（公式 https://code.claude.com/docs/en/hooks.md の
# 「WorktreeCreate」: "Configuring a WorktreeCreate hook replaces that default git behavior"）ので、ここで作る。
#
# 入力（stdin の JSON）: name（worktree の名前。例 agent-a3f2）、cwd（セッションのカレントディレクトリ）。
# 出力: stdout に作った worktree の絶対パスを 1 行だけ出す（command フックは stdout の最後の空でない行がパスとして読まれ、
#   JSON は返せない。公式の「WorktreeCreate output」）。ほかの出力はすべて stderr に出す。
# 終了コード: 0 以外だと worktree の作成が失敗する（公式）。そのため 0 以外で終わるのは worktree そのものを作れないとき
#   （name が不正、cwd が git リポジトリでない、git worktree add の失敗）だけにし、DB・install・フックの修復の失敗は
#   stderr に警告を出して続ける（worktree は使える。DB を作れなくても .env は worktree 用の DB 名を指すので、メインの DB を
#   誤って使うことはなく、テストが「DB が無い」で止まる）。
#
# 手順:
#   1. <メイン>/.claude/worktrees/<name> に <name> ブランチの worktree を作る（既にあれば使う）
#   2. 孤立した worktree 用の DB（app_wt_*。対応する worktree が無いもの）を drop する
#   3. worktree の中で CI=true pnpm install --frozen-lockfile
#   4. scripts/worktree-env.sh で worktree 用の .env を書く
#   5. worktree 用の DB を作り（あれば何もしない）、worktree の中で pnpm db:migrate
#   6. メインの共有フック（.git/hooks/pre-commit）が worktree を指していれば、メインで pnpm exec lefthook install
#   7. worktree の絶対パスを stdout に出す
#
# 確認:
#   echo '{"name":"try-1","cwd":"'"$PWD"'"}' | WORKTREE_HOOK_DRY_RUN=1 bash scripts/hooks/worktree-create.sh   # 実行予定の表示だけ

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_SCRIPT="$(cd "${SCRIPT_DIR}/.." && pwd)/worktree-env.sh"
# shellcheck source=../worktree-env.sh
source "$ENV_SCRIPT"

# stdout は Claude Code がパスとして読むので、既定の出力先を stderr にし、パス（と DRY_RUN の予定）だけを fd 3 に出す。
# WHY: git / pnpm / docker が stdout に出す行が混ざると、最後の行がパスでなくなりうる。
exec 3>&1 1>&2

# WHY 固定値: compose.yaml の POSTGRES_USER / POSTGRES_DB（app / app）。maintenance 用に app に接続して create / drop する
#   （接続中のデータベースは drop できないため、worktree 用の DB には接続しない）。
PSQL=(docker compose exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -At -c)
LIST_SQL="select datname from pg_database where starts_with(datname, 'app_wt_') order by 1"

warn() {
  echo "worktree-create: $*" >&2
}

is_dry_run() {
  [ "${WORKTREE_HOOK_DRY_RUN:-}" = "1" ]
}

plan() {
  echo "[dry-run] $*" >&3
}

# stdin の JSON から文字列の項目を取り出す（無い・文字列でなければ空）。
# WHY node: Claude Code は Node で動くのでフックの環境に必ずある。jq はローカルやクラウド VM にあるとは限らない。
json_field() {
  node -e 'let j; try { j = JSON.parse(process.argv[1]); } catch { process.exit(1); }
    const v = j?.[process.argv[2]]; process.stdout.write(typeof v === "string" ? v : "");' "$INPUT" "$1"
}

# timeout があれば上限を付けて実行する。
# WHY 上限: フックが止まったままだと worktree の作成（サブエージェントの起動）が進まない。
# WHY 無ければそのまま実行: macOS には標準で timeout が無い（coreutils の gtimeout はある場合がある）。上限が無くても動かす。
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

# メインの作業ツリーで psql を実行する（結果は stdout）。
# WHY メインで実行する: docker compose のプロジェクト名はカレントディレクトリの名前から決まるので、worktree の中で
#   実行すると別のプロジェクトとみなされ、起動中の db コンテナが見つからない。
psql_main() {
  (cd "$MAIN_DIR" && with_timeout 15 "${PSQL[@]}" "$1")
}

# 1. worktree を作る。作れなければ 0 以外で終わる（Claude Code が作成失敗として扱う）。
create_worktree() {
  if git -C "$MAIN_DIR" worktree list --porcelain | grep -Fxq "worktree ${WORKTREE_DIR}" && [ -d "$WORKTREE_DIR" ]; then
    is_dry_run && plan "reuse existing worktree ${WORKTREE_DIR}"
    return 0
  fi
  local args
  if git -C "$MAIN_DIR" show-ref --verify --quiet "refs/heads/${NAME}"; then
    args=(worktree add "$WORKTREE_DIR" "$NAME")
  else
    args=(worktree add -b "$NAME" "$WORKTREE_DIR" HEAD)
  fi
  if is_dry_run; then
    plan "(cd ${MAIN_DIR} && git ${args[*]})"
    return 0
  fi
  # 登録だけ残ってディレクトリが消えた worktree（prunable）があると、同じパスに add できないので先に掃除する。
  git -C "$MAIN_DIR" worktree prune
  mkdir -p "$(dirname "$WORKTREE_DIR")"
  git -C "$MAIN_DIR" "${args[@]}"
}

# ディレクトリがある worktree（メインを除く）の DB 名を 1 行ずつ出す。
live_worktree_db_names() {
  local line path
  git -C "$MAIN_DIR" worktree list --porcelain | while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        path=${line#worktree }
        if [ "$path" != "$MAIN_DIR" ] && [ -d "$path" ]; then
          worktree_db_name "$(basename "$path")"
        fi
        ;;
    esac
  done
}

# 2. 孤立した DB を drop する。
# WHY ここで掃除する: WorktreeRemove フックの発火は実測で確認できなかった（Issue #64 のコメント）。消し忘れを次の作成で拾う。
# WHY app_wt_[a-z0-9_]+ の形だけを消す: 列挙の結果を SQL に埋め込むので、想定外の名前（記号入り）は触らない。
cleanup_orphan_databases() {
  if is_dry_run; then
    plan "(cd ${MAIN_DIR} && ${PSQL[*]} \"${LIST_SQL}\") and drop app_wt_* databases without a worktree"
    return 0
  fi
  local databases live db
  if ! databases=$(psql_main "$LIST_SQL"); then
    warn "worktree 用の DB を列挙できませんでした（孤立した DB の掃除を飛ばします）"
    return 0
  fi
  live=" $(live_worktree_db_names | tr '\n' ' ') "
  while IFS= read -r db; do
    [[ "$db" =~ ^app_wt_[a-z0-9_]+$ ]] || continue
    [[ "$live" == *" ${db} "* ]] && continue
    # WITH (FORCE): 孤立した worktree のサーバ（E2E の next start など）が接続を残していても消す（Postgres 13 以降）。
    psql_main "drop database if exists ${db} with (force)" >/dev/null ||
      warn "孤立した DB ${db} を drop できませんでした"
  done <<< "$databases"
}

# 3. 依存を入れる。
# WHY CI=true: lefthook の postinstall がフックを入れないようにする。.git/hooks は本体と全 worktree で共有されるので、
#   worktree で入れると本体のフックが worktree の lefthook を指すように書き換わる（LEARNINGS.md）。
install_dependencies() {
  if is_dry_run; then
    plan "(cd ${WORKTREE_DIR} && CI=true timeout 120 pnpm install --frozen-lockfile)"
    return 0
  fi
  (cd "$WORKTREE_DIR" && with_timeout 120 env CI=true pnpm install --frozen-lockfile) ||
    warn "pnpm install --frozen-lockfile に失敗しました（worktree で CI=true pnpm install --frozen-lockfile を実行してください）"
}

# 4. worktree 用の .env を書く。書けなければ 1。
# WHY worktree の .env.example を元にする: worktree のブランチで足した変数も入るようにする。
# WHY 一時ファイルに書いてから置き換える: 途中で失敗したときに半端な .env を残さない。
write_dotenv() {
  local target="${WORKTREE_DIR}/.env"
  if is_dry_run; then
    plan "bash ${ENV_SCRIPT} ${NAME} ${WORKTREE_DIR}/.env.example > ${target}"
    return 0
  fi
  if bash "$ENV_SCRIPT" "$NAME" "${WORKTREE_DIR}/.env.example" > "${target}.tmp"; then
    mv "${target}.tmp" "$target"
    return 0
  fi
  rm -f "${target}.tmp"
  warn ".env を書けませんでした（worktree の .env が無いので、アプリ・テストは必須の変数が無いとして止まります）"
  return 1
}

# 5. worktree 用の DB を作り、マイグレーションを当てる。
# WHY create database に IF NOT EXISTS が無い: Postgres の CREATE DATABASE には IF NOT EXISTS が無いので、先に pg_database を見る。
create_database_and_migrate() {
  local db exists
  db=$(worktree_db_name "$NAME")
  if is_dry_run; then
    plan "(cd ${MAIN_DIR} && ${PSQL[*]} \"create database ${db}\") unless it exists"
    plan "(cd ${WORKTREE_DIR} && timeout 15 pnpm db:migrate)"
    return 0
  fi
  if ! exists=$(psql_main "select 1 from pg_database where datname = '${db}'") ||
    { [ "$exists" != "1" ] && ! psql_main "create database ${db}" >/dev/null; }; then
    warn "worktree 用の DB ${db} を作れませんでした。この worktree の DB は分離されていません（DB が無いため、DB を使うテストは失敗します）。pnpm db:up の後、メインで docker compose exec -T db psql -U app -d app -c 'create database ${db}' と、worktree で pnpm db:migrate を実行してください"
    return 0
  fi
  (cd "$WORKTREE_DIR" && with_timeout 15 pnpm db:migrate) ||
    warn "pnpm db:migrate に失敗しました（worktree で pnpm db:migrate を実行してください）"
}

# 6. 共有フックの修復。
# WHY: worktree での pnpm install や pnpm exec が lefthook の postinstall を走らせると、本体と共有の .git/hooks/pre-commit が
#   worktree の lefthook を指すように書き換わる（LEARNINGS.md。CI=true を付けても、後から worktree で素の pnpm を使えば起きうる）。
#   worktree を消すとフックが動かなくなるので、メインの node_modules を指すように入れ直す。
repair_shared_hook() {
  if is_dry_run; then
    plan "(cd ${MAIN_DIR} && pnpm exec lefthook install) if .git/hooks/pre-commit points into .claude/worktrees/"
    return 0
  fi
  local hook
  hook="$(git -C "$MAIN_DIR" rev-parse --path-format=absolute --git-path hooks)/pre-commit"
  if [ -f "$hook" ] && grep -Fq "/.claude/worktrees/" "$hook"; then
    (cd "$MAIN_DIR" && with_timeout 60 pnpm exec lefthook install) ||
      warn "共有フックの修復（pnpm exec lefthook install）に失敗しました。メインで pnpm exec lefthook install を実行してください"
  fi
}

INPUT=$(cat)
NAME=$(json_field name) || { warn "stdin の JSON を読めませんでした"; exit 1; }
CWD=$(json_field cwd)
CWD=${CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}

# WHY name を絞る: パスの一部とブランチ名に使う。/ や .. を許すと .claude/worktrees の外を指せてしまう。
if [[ ! "$NAME" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || [[ "$NAME" == *..* ]] ||
  ! git check-ref-format --branch "$NAME" >/dev/null 2>&1; then
  warn "worktree の名前が不正です（英数字で始まり、英数字 . _ - だけ。値: ${NAME}）"
  exit 1
fi

# WHY 1 件目を使う: git worktree list は必ずメインの作業ツリーを先頭に出す。cwd が worktree の中でも（show-toplevel だと
#   その worktree になる）、メインの下に作る。
MAIN_DIR=$(git -C "$CWD" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
if [ -z "$MAIN_DIR" ]; then
  warn "${CWD} は git リポジトリではありません"
  exit 1
fi
WORKTREE_DIR="${MAIN_DIR}/.claude/worktrees/${NAME}"

create_worktree || { warn "git worktree add に失敗しました（${WORKTREE_DIR}）"; exit 1; }

if command -v docker >/dev/null 2>&1; then
  HAS_DOCKER=1
else
  HAS_DOCKER=0
  warn "docker がありません。孤立した DB の掃除と worktree 用の DB（$(worktree_db_name "$NAME")）の作成を飛ばします（DB は分離されていません）"
fi

[ "$HAS_DOCKER" = 1 ] && cleanup_orphan_databases
install_dependencies
if write_dotenv && [ "$HAS_DOCKER" = 1 ]; then
  create_database_and_migrate
fi
repair_shared_hook

printf '%s\n' "$WORKTREE_DIR" >&3
exit 0
