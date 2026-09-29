#!/usr/bin/env bash
# Claude Code の PreCompact フック（.claude/settings.json の hooks.PreCompact から呼ぶ）。Issue #64。
#
# WHAT: compact（/compact か自動）の直前に、作業状態を <リポジトリ直下>/.claude/state/pre-compact.md に上書きで書く。
#   書くもの: 日時・trigger（manual / auto）・ブランチ・HEAD・git status --short・git stash list の件数・直近 5 コミットの 1 行目。
# WHY: compact で会話が要約されると、どのブランチで何を変更中だったか（未コミットの変更・stash）が要約から落ちることがある。
#   compact の後に Claude（や人）がこのファイルを読めば、直前の状態を確かめられる。
# WHY logs/ に書かない: logs/ は人が読む作業の記録。自動の dump を入れると、Stop フック（require-log.sh）の
#   「logs/<今日>.md が変わったか」の判定が、ログを書いていないのに素通りになる。
# WHY 上書き: 必要なのは直前の 1 回分だけ。追記するとセッションをまたいで増え続ける。.claude/state/ は .gitignore 済み。
# 詳細: .claude/rules/work-log.md。
#
# 入力（stdin の JSON。公式 https://code.claude.com/docs/en/hooks.md の PreCompact input）: trigger, cwd。
# 出力: なし。終了コードは常に 0（exit 2 や decision: block は compact を止めるので使わない）。
set -u

warn() { echo "pre-compact: $*" >&2; }

input=$(cat)
parsed=$(
  printf '%s' "$input" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let hook = {};
      try {
        hook = JSON.parse(raw);
      } catch {
        console.error("pre-compact: 入力を読めない（stdin が JSON ではない）。cwd と trigger は既定値で書く");
      }
      const str = (v, fallback) => (typeof v === "string" && v !== "" ? v : fallback);
      process.stdout.write(`${str(hook.trigger, "unknown")}\t${str(hook.cwd, process.cwd())}\n`);
    });
  '
) || exit 0
IFS=$'\t' read -r trigger cwd <<<"$parsed"

if ! root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null); then
  warn "git リポジトリではないため書かない（cwd: $cwd）"
  exit 0
fi

# 状態はファイルを作る前に集める（作った .claude/state/ が git status に混ざらないように。.gitignore 済みなら出ない）。
branch=$(git -C "$root" branch --show-current 2>/dev/null)
head=$(git -C "$root" rev-parse HEAD 2>/dev/null) || head="(コミットなし)"
status=$(git -C "$root" status --short 2>/dev/null)
stash_count=$(git -C "$root" stash list 2>/dev/null | wc -l | tr -d ' ')
commits=$(git -C "$root" log -5 --format='- %h %s' 2>/dev/null)

state_dir="$root/.claude/state"
mkdir -p "$state_dir" || { warn "$state_dir を作れない"; exit 0; }
{
  echo "# compact 直前の作業状態"
  echo
  echo "- date: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "- trigger: $trigger"
  echo "- branch: ${branch:-(detached)}"
  echo "- HEAD: $head"
  echo "- stash: $stash_count"
  echo
  echo "## git status --short"
  echo
  echo '```'
  [ -n "$status" ] && printf '%s\n' "$status"
  echo '```'
  echo
  echo "## 直近 5 コミット"
  echo
  [ -n "$commits" ] && printf '%s\n' "$commits"
} >"$state_dir/pre-compact.md" || warn "$state_dir/pre-compact.md に書けない"
exit 0
