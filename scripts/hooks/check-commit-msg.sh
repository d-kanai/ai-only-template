#!/bin/bash
# コミットメッセージの形式を検査する（lefthook.yml の commit-msg から `bash scripts/hooks/check-commit-msg.sh {1}` で呼ばれる）。
# 形式は .claude/general/commit.md: 1 行目にサマリ、本文に 🎯 WHY / 📝 WHAT / 🛠️ 実装経緯 / ✅ 検証内容 の 4 見出しをこの順に、
# Co-Authored-By: の行。違反があれば、足りないものを stderr にすべて並べて exit 1（git がコミットを中止する）。
# WHY / 例外の理由は .claude/rules/git-guard.md。
#
# 引数: $1 = メッセージのファイル（git が commit-msg フックに渡す .git/COMMIT_EDITMSG）。
set -u

msg_file="${1:-}"
if [ -z "$msg_file" ] || [ ! -f "$msg_file" ]; then
  echo "check-commit-msg: メッセージのファイルがありません: ${msg_file}" >&2
  exit 1
fi

HEADINGS=("🎯 WHY" "📝 WHAT" "🛠️ 実装経緯" "✅ 検証内容")

# git が付けるコメント行（# で始まる）を除き、`git commit -v` の切り取り線より下（差分）を捨てた行を並べる。
# WHY コメント行を見ない: commit-msg フックは git がコメントを消す前のメッセージを受け取る（テンプレートの説明行が残っている）。
#   コメント文字は git の既定（#）を前提にする（core.commentChar は変えていない）。
lines=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in
    "# ------------------------ >8 ------------------------") break ;;
    "#"*) continue ;;
  esac
  lines+=("$line")
done <"$msg_file"

first="${lines[0]:-}"

# WHY マージコミットと fixup! / squash! / amend! は検査しない:
# - Merge: `git merge` / `gh pr merge` が作るメッセージ（Merge branch ... / Merge pull request ...）で、WHY などは PR 本文に書く。
# - fixup! / squash! / amend!: `git rebase --autosquash` で元のコミットにまとめる一時的なコミット。まとめた後のメッセージが検査対象。
case "$first" in
  "Merge "* | "fixup! "* | "squash! "* | "amend! "*) exit 0 ;;
esac

errors=()
if [ -z "${first//[[:space:]]/}" ]; then
  errors+=("1 行目（サマリ）が空です")
fi

# 見出しは 2 行目以降で、行全体（前後の空白を除く）が見出しと一致する行を探す。
positions=()
for heading in "${HEADINGS[@]}"; do
  pos=-1
  for ((i = 1; i < ${#lines[@]}; i++)); do
    trimmed="$(printf '%s' "${lines[$i]}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ "$trimmed" = "$heading" ]; then
      pos=$i
      break
    fi
  done
  if [ "$pos" -lt 0 ]; then
    errors+=("見出し「${heading}」の行がありません")
  fi
  positions+=("$pos")
done

# 見つかった見出しが .claude/general/commit.md の順（WHY → WHAT → 実装経緯 → 検証内容）に並んでいるか。
prev=-1
prev_heading=""
for idx in "${!HEADINGS[@]}"; do
  pos="${positions[$idx]}"
  [ "$pos" -lt 0 ] && continue
  if [ "$pos" -lt "$prev" ]; then
    errors+=("見出しの順番が違います: 「${HEADINGS[$idx]}」が「${prev_heading}」より前にあります")
  fi
  prev="$pos"
  prev_heading="${HEADINGS[$idx]}"
done

# WHY 大文字小文字を区別しない: git の trailer（git interpret-trailers）はキーの大文字小文字を区別しないため。
has_coauthor=0
for ((i = 1; i < ${#lines[@]}; i++)); do
  lower="$(printf '%s' "${lines[$i]}" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    "co-authored-by:"*) has_coauthor=1 ;;
  esac
done
if [ "$has_coauthor" -eq 0 ]; then
  errors+=("Co-Authored-By: の行がありません（例: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>）")
fi

if [ "${#errors[@]}" -gt 0 ]; then
  echo "check-commit-msg: コミットメッセージが .claude/general/commit.md の形式ではありません" >&2
  for error in "${errors[@]}"; do
    echo "  - ${error}" >&2
  done
  exit 1
fi
exit 0
