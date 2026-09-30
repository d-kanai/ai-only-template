#!/usr/bin/env bash
# PR の差分に作業ログ（docs/work-logs/ の .md）の変更があるかを検査する。Issue #64（置き場所は Issue #101 で docs/ の下に移した）。
# 使い方: bash scripts/hooks/check-work-logs-diff.sh <base-ref>（CI では origin/<PR の base ブランチ>）
#
# WHAT: `git diff --name-only --no-renames --diff-filter=AM <base-ref>...HEAD` に ^docs/work-logs/.*\.md$ が 1 件以上あれば exit 0、無ければ理由を出して exit 1。
# WHY --diff-filter=AM（追加 A と変更 M だけ）: ログを削除しただけ（D）の PR は、記録を足していないので通さない。
# WHY --no-renames: 名前の変更を常に「削除 + 追加」として扱い、利用者の diff.renames の設定に結果が左右されないようにする
#   （rename の検出が効くと R になり、AM で外れる）。限界: ログの名前を変えただけの PR は「追加」があるので通る。
# WHY: 作業ログ（docs/work-logs/YYYY-MM-DD.md）の追記漏れを CI で止める（Issue #64 のユーザー判断。文書だけの PR も含めて例外なし）。
#   Stop フック（scripts/hooks/require-work-log.sh）はセッションの中の漏れを止め、こちらは PR 単位で止める。
# WHY 三点（...）: base-ref と HEAD の分岐点から HEAD までの差分（= PR の変更）だけを見る。二点（..）だと、PR の後に
#   base 側で入った作業ログの変更まで数えてしまう。分岐点を求めるので、CI の checkout は履歴を全部取る（fetch-depth: 0）。
# WHY 作業ツリーを見ない: CI で検査するのはコミット済みの PR の差分だけ（未コミットの変更は PR に入らない）。
# さらに（Issue #178）: PR で追加した作業ログの項目（`## ` の見出し）に `- 機械化:` の行が無ければ、その見出しを stderr に挙げて exit 1。
# WHY: 作業のたびに「lint / 型 / テスト / フック / CI で機械的に止められないか」を検討させる（CLAUDE.md の 7.。ユーザー指示）。
#   Stop フックはセッションの中で、こちらは PR 単位で止める。判定は scripts/hooks/work-log-sections.mjs（Stop フックと共通）。
# 詳細: .claude/rules/work-log.md。CI への組み込みは rule-tests/work-logs-check.test.ts が検査する。
set -u

# work-log-sections.mjs はこのスクリプトと同じディレクトリにある（cwd に依らずに見つける）。
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: bash scripts/hooks/check-work-logs-diff.sh <base-ref>" >&2
  exit 2
fi
base=$1

# git diff の失敗（base-ref が無い・分岐点が無いなど）は通さない（差分が取れないまま exit 0 にしない）。
if ! changed=$(git diff --name-only --no-renames --diff-filter=AM "${base}...HEAD"); then
  echo "check-work-logs-diff: ${base}...HEAD の差分を取れない（base-ref と履歴を確認。CI では actions/checkout の fetch-depth: 0 が要る）" >&2
  exit 1
fi

if ! printf '%s\n' "$changed" | grep -Eq '^docs/work-logs/.*\.md$'; then
  echo "check-work-logs-diff: ${base}...HEAD に作業ログ（docs/work-logs/*.md）の変更がありません。この PR でやったこと（調査・判断・確認した事実）を docs/work-logs/<日付>.md に追記してコミットしてください（.claude/rules/work-log.md）。" >&2
  exit 1
fi

# 追加した項目の `- 機械化:` の行（Issue #178）。上と同じ三点・追加と変更だけ・rename なしの diff の + の行を見る。
# WHY pathspec の 'docs/work-logs/*.md': git の pathspec の * は / にも一致するので、上の grep（サブディレクトリの .md も数える）と同じ範囲になる。
# WHY --no-color --no-ext-diff: 利用者の設定（color.diff=always・diff.external）で出力の形が変わると、+ の行を読めない。
# 失敗（diff が取れない・node が動かない）は通さない（CI は判定できないまま exit 0 にしない）。
if ! log_diff=$(git diff --no-color --no-ext-diff --no-renames --diff-filter=AM "${base}...HEAD" -- 'docs/work-logs/*.md'); then
  echo "check-work-logs-diff: ${base}...HEAD の作業ログの差分を取れない" >&2
  exit 1
fi
if ! missing=$(printf '%s\n' "$log_diff" | node "$script_dir/work-log-sections.mjs"); then
  echo "check-work-logs-diff: work-log-sections.mjs が失敗した（node があるか確認）" >&2
  exit 1
fi
if [ -n "$missing" ]; then
  {
    echo "check-work-logs-diff: ${base}...HEAD で追加した作業ログの項目に \`- 機械化: <縛れる（何で）/ 縛れない（理由）/ 対象外>\` の行がありません。各項目に足してコミットしてください（.claude/general/work-log.md）:"
    printf '%s\n' "$missing" | sed 's/^/  - /'
  } >&2
  exit 1
fi
exit 0
