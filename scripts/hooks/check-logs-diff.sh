#!/usr/bin/env bash
# PR の差分に作業ログ（logs/ の .md）の変更があるかを検査する。Issue #64。
# 使い方: bash scripts/hooks/check-logs-diff.sh <base-ref>（CI では origin/<PR の base ブランチ>）
#
# WHAT: `git diff --name-only --diff-filter=AM <base-ref>...HEAD` に ^logs/.*\.md$ が 1 件以上あれば exit 0、無ければ理由を出して exit 1。
# WHY --diff-filter=AM（追加 A と変更 M だけ）: ログを削除しただけ（D）の PR や、名前を変えただけ（R）の PR は、記録を足していないので通さない。
# WHY: 作業ログ（logs/YYYY-MM-DD.md）の追記漏れを CI で止める（Issue #64 のユーザー判断。文書だけの PR も含めて例外なし）。
#   Stop フック（scripts/hooks/require-log.sh）はセッションの中の漏れを止め、こちらは PR 単位で止める。
# WHY 三点（...）: base-ref と HEAD の分岐点から HEAD までの差分（= PR の変更）だけを見る。二点（..）だと、PR の後に
#   base 側で入った logs の変更まで数えてしまう。分岐点を求めるので、CI の checkout は履歴を全部取る（fetch-depth: 0）。
# WHY 作業ツリーを見ない: CI で検査するのはコミット済みの PR の差分だけ（未コミットの変更は PR に入らない）。
# 詳細: .claude/rules/work-log.md。CI への組み込みは logs-check.test.ts が検査する。
set -u

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: bash scripts/hooks/check-logs-diff.sh <base-ref>" >&2
  exit 2
fi
base=$1

# git diff の失敗（base-ref が無い・分岐点が無いなど）は通さない（差分が取れないまま exit 0 にしない）。
if ! changed=$(git diff --name-only --diff-filter=AM "${base}...HEAD"); then
  echo "check-logs-diff: ${base}...HEAD の差分を取れない（base-ref と履歴を確認。CI では actions/checkout の fetch-depth: 0 が要る）" >&2
  exit 1
fi

if printf '%s\n' "$changed" | grep -Eq '^logs/.*\.md$'; then
  exit 0
fi

echo "check-logs-diff: ${base}...HEAD に作業ログ（logs/*.md）の変更がありません。この PR でやったこと（調査・判断・確認した事実）を logs/<日付>.md に追記してコミットしてください（.claude/rules/work-log.md）。" >&2
exit 1
