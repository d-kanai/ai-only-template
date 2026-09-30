#!/bin/bash
# SubagentStop フック（.claude/settings.json の hooks.SubagentStop）。サブエージェントが終わるたびに次を確かめる。
# 1. 共有の Git フック（メインの .git/hooks の pre-commit・commit-msg）が、メイン以外の作業ツリー（worktree）の lefthook を
#    指していないか。指していたら、メインの作業ツリーで lefthook install を実行して直す。
#    WHY: .git/hooks は全 worktree で共有され、worktree で pnpm install / lefthook run / git commit をすると、共有のフックが
#    worktree の lefthook を指すように書き換わる（LEARNINGS.md）。
#    worktree を消すとフックが動かなくなるので、サブエージェントの終わりに直す。
# 2. pnpm-lock.yaml に未コミットの変更がないか（サブエージェントの作業ツリーとメインの作業ツリー）。あれば警告する。
#    WHY: pnpm exec などが install を走らせて lockfile を書き換えることがある（LEARNINGS.md）。依頼していない
#    lockfile の変化がコミットに紛れ込まないよう、オーケストレータに知らせる。
# 結果は stdout の {"systemMessage": "..."}（ユーザーに表示される）で返す。何もなければ何も出さない。
# WHY block しない（decision: "block" を返さない）: block はサブエージェントを動かし続ける指示になるが、共有フックはここで直し、
#   lockfile の扱いはオーケストレータの判断なので、サブエージェントを止めても直らない。
# どこで失敗しても exit 0（フックの失敗でサブエージェントの報告を止めない）。WHAT / WHY は .claude/rules/git-guard.md。
set -u

input="$(cat)"

# 入力の cwd（サブエージェントの作業場所。isolation: worktree なら worktree）。node で JSON を読む（依存を足さない）。
cwd=""
if command -v node >/dev/null 2>&1; then
  if ! cwd="$(printf '%s' "$input" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      try {
        const input = JSON.parse(raw);
        process.stdout.write(typeof input.cwd === "string" ? input.cwd : "");
      } catch (error) {
        process.stderr.write(`subagent-stop: 入力の JSON を読めません: ${error.message}\n`);
        process.exit(1);
      }
    });
  ')"; then
    exit 0
  fi
else
  echo "subagent-stop: node が見つからないため、CLAUDE_PROJECT_DIR で確かめます" >&2
fi
cwd="${cwd:-${CLAUDE_PROJECT_DIR:-$PWD}}"

# JSON の文字列にするためのエスケープ（\ と " と改行）。改行とタブ以外の制御文字は消す（lefthook の出力の色付けなど）。
json_string() {
  local s
  s="$(printf '%s' "$1" | tr -d '\000-\010\013-\037')"
  s="${s//$'\t'/ }"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}

common_dir="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
# メインの作業ツリー = 共通の .git の親（worktree の .git はファイルで、共通のディレクトリはメインの .git）。
main_root="$(cd "$common_dir/.." && pwd -P)"
cwd_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || cwd_root=""
[ -n "$cwd_root" ] && cwd_root="$(cd "$cwd_root" && pwd -P)"

messages=()

# フックの中の lefthook のパス（<作業ツリー>/node_modules/.pnpm/...）から作業ツリーの部分を取り出し、メインと違うものを返す。
# WHY パスに worktrees を含むかではなく「メインと違うか」で見る: worktree は .claude/worktrees の下とは限らない
#   （LEARNINGS.md の例はリポジトリの外の worktree）。
foreign_paths() {
  local hook="$1"
  grep -oE "/[^[:space:]\"']+/node_modules/\.pnpm/" "$hook" 2>/dev/null |
    sed 's#/node_modules/\.pnpm/$##' | sort -u | while IFS= read -r dir; do
      [ "$dir" != "$main_root" ] && printf '%s\n' "$dir"
    done
}

broken=()
for name in pre-commit commit-msg; do
  hook="$common_dir/hooks/$name"
  [ -f "$hook" ] || continue
  foreign="$(foreign_paths "$hook")"
  [ -n "$foreign" ] && broken+=("$name（${foreign//$'\n'/, }）")
done

if [ "${#broken[@]}" -gt 0 ]; then
  # WHY node_modules/.bin/lefthook を直接呼ぶ: pnpm exec は依存の状態によって install を走らせることがある（LEARNINGS.md）。
  #   無いとき（node_modules が無いなど）だけ pnpm exec にする。
  if [ -x "$main_root/node_modules/.bin/lefthook" ]; then
    repair=("$main_root/node_modules/.bin/lefthook" install)
  else
    repair=(pnpm exec lefthook install)
  fi
  if output="$(cd "$main_root" && "${repair[@]}" 2>&1)"; then
    messages+=("共有の Git フックが worktree の lefthook を指していたため、${main_root} で lefthook install を実行して直しました: ${broken[*]}")
  else
    messages+=("共有の Git フックが worktree の lefthook を指していますが、直せませんでした: ${broken[*]}。${main_root} で pnpm exec lefthook install を実行してください（出力: ${output}）")
  fi
fi

# lockfile の変更は、サブエージェントの作業ツリーとメインの作業ツリーの両方を見る（同じなら 1 回）。
roots=()
[ -n "$cwd_root" ] && roots+=("$cwd_root")
[ "$main_root" != "$cwd_root" ] && roots+=("$main_root")
for root in "${roots[@]}"; do
  if [ -n "$(git -C "$root" status --porcelain -- pnpm-lock.yaml 2>/dev/null)" ]; then
    messages+=("${root}/pnpm-lock.yaml に未コミットの変更があります。依頼した依存の変更でなければ git checkout -- pnpm-lock.yaml で戻してください")
  fi
done

if [ "${#messages[@]}" -gt 0 ]; then
  joined="subagent-stop: $(printf '%s\n' "${messages[@]}")"
  printf '{"systemMessage":%s}\n' "$(json_string "${joined%$'\n'}")"
fi
exit 0
