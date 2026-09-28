#!/usr/bin/env bash
# Codex の PR レビュー完了を待ち、指摘の有無で合否を返す。
# usage: scripts/wait-codex-review.sh <PR番号> [タイムアウト秒(既定 900)]
# exit 0: 完了・指摘なし / 1: 指摘あり / 2: タイムアウト
set -euo pipefail

PR=${1:?PR番号を指定}
TIMEOUT=${2:-900}
INTERVAL=20
BOT="chatgpt-codex-connector[bot]"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
HEAD=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
SHORT=${HEAD:0:7}

echo "PR #$PR head=$SHORT の Codex レビューを待機（最大 ${TIMEOUT}s）"
start=$(date +%s)
while :; do
  summary=$(gh api "repos/$REPO/issues/$PR/comments" \
    -q ".[] | select(.user.login==\"$BOT\") | .body" || true)
  if echo "$summary" | grep -q "Completed.*\`$SHORT\`"; then
    inline=$(gh api "repos/$REPO/pulls/$PR/comments" \
      -q "[.[] | select(.user.login==\"$BOT\" and .commit_id==\"$HEAD\")] | length")
    reviews=$(gh api "repos/$REPO/pulls/$PR/reviews" \
      -q "[.[] | select(.user.login==\"$BOT\" and .commit_id==\"$HEAD\" and (.body|length)>0)] | length")
    if [ "$inline" = "0" ] && [ "$reviews" = "0" ]; then
      echo "PASS: Codex レビュー完了、指摘なし（$SHORT）"
      exit 0
    fi
    echo "FAIL: Codex の指摘あり（inline=$inline, review=$reviews）。内容:"
    gh api "repos/$REPO/pulls/$PR/reviews" \
      -q ".[] | select(.user.login==\"$BOT\" and .commit_id==\"$HEAD\" and (.body|length)>0) | \"--- review\n\" + .body"
    gh api "repos/$REPO/pulls/$PR/comments" \
      -q ".[] | select(.user.login==\"$BOT\" and .commit_id==\"$HEAD\") | \"--- \" + .path + \":\" + (.line|tostring) + \"\n\" + .body"
    exit 1
  fi
  if [ $(( $(date +%s) - start )) -ge "$TIMEOUT" ]; then
    echo "TIMEOUT: ${TIMEOUT}s 以内にレビューが完了しなかった。PR のコメントを確認すること"
    exit 2
  fi
  sleep "$INTERVAL"
done
