#!/usr/bin/env bash
# Claude Code の Stop フック（.claude/settings.json の hooks.Stop から呼ぶ）。Issue #64。
#
# WHAT: このターン（最後の人間の発言以降）にツールを使ったのに、その日の作業ログ logs/<今日>.md が
#   作業ツリー（未追跡・ステージ済みを含む）でも、このターンの間のコミット（最後の人間の発言の timestamp 以降）でも
#   変わっていなければ、
#   {"decision":"block","reason":...} を stdout に出して停止を拒否する（Claude はログを書いてから止まり直す）。
# WHY: 調査だけの依頼などで作業ログの追記が漏れた（LEARNINGS.md、Issue #64 のユーザー判断）。文章のルールではなく
#   フックで止める（CLAUDE.md の「7. 機械的な強制を優先」）。
# 詳細（判定の限界・タイムゾーン・ユーザー側の Stop フックとの順序）: .claude/rules/work-log.md、実測は docs/work-log.md。
#
# 入力（stdin の JSON。公式 https://code.claude.com/docs/en/hooks.md の Stop input）:
#   transcript_path: 会話の JSONL。stop_hook_active: Stop フックの block で続けている途中なら true。cwd: 作業ディレクトリ。
# 出力: 拒否するときだけ JSON を 1 行。許可するときは何も出さない。終了コードは常に 0。
# WHY 読めない・git でないときは何もしない（許可）: 判定できない状態で止め続けると、Claude が何をしても停止できなくなる
#   （公式の 8 回の連続上限までループする）。理由は stderr に出す。
set -u

warn() { echo "require-log: $*" >&2; }

input=$(cat)

# node で入力と transcript を読み、「cwd」「最後の人間のターン以降の tool_use の数」「最後の人間のターンの時刻」を
# タブ区切りの 1 行で返す。時刻は transcript の行の timestamp（ISO 8601）を秒に切り捨てた UTC（例: 2026-09-28T21:37:27Z）。
# 人間のターンが無い・timestamp が無い・日時として読めないときは空（下で今日の 0 時にフォールバックする）。
# stop_hook_active が true なら transcript を読まずに数を 0 とする（下で「ツールを使っていない」と同じく止めない）。
# WHY stop_hook_active のときは判定しない: block で続けたターンの終わりにもう一度 block すると、ログを書けない状況
#   （git が壊れているなど）で上限（8 回）までループする。1 回目の block で Claude はログを書く機会を得ているので、2 回目は見ない。
# 依存（jq など）は足さない（Claude Code は node で動くので node はある。実行環境の前提は .claude/rules/work-log.md）。
# 人間のターン: type が "user" で、isMeta でなく、message.content が文字列か、配列で tool_result を含まないもの。
#   WHY tool_result を除く: ツールの結果も type "user" の行として記録される（2026-09-28 に実セッションの transcript で確認）。
#   WHY isMeta を除く: Stop フックのフィードバックや他セッションからのメッセージは isMeta: true の user 行で、人間の発言ではない。
# 数えるのは type が "assistant" の行の message.content にある type "tool_use" の要素。
# JSON として読めない行は飛ばす（transcript は非同期に書かれ、最後の行が途中で切れていることがある）。
parsed=$(
  printf '%s' "$input" | node -e '
    const fs = require("node:fs");
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let hook;
      try {
        hook = JSON.parse(raw);
      } catch {
        console.error("require-log: 入力を読めない（stdin が JSON ではない）");
        process.exit(3);
      }
      const cwd = typeof hook.cwd === "string" && hook.cwd !== "" ? hook.cwd : process.cwd();
      if (hook.stop_hook_active === true) {
        process.stdout.write(`${cwd}\t0\t\n`);
        return;
      }
      let text;
      try {
        text = fs.readFileSync(hook.transcript_path, "utf8");
      } catch (error) {
        console.error(`require-log: transcript を読めない（${hook.transcript_path}）: ${error.message}`);
        process.exit(3);
      }
      const entries = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          entries.push(JSON.parse(line));
        } catch {}
      }
      const isHumanTurn = (e) => {
        if (e?.type !== "user" || e.isMeta === true) return false;
        const content = e.message?.content;
        if (typeof content === "string") return true;
        return Array.isArray(content) && !content.some((c) => c?.type === "tool_result");
      };
      let start = 0;
      let since = "";
      entries.forEach((e, i) => {
        if (!isHumanTurn(e)) return;
        start = i + 1;
        const time = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
        since = Number.isNaN(time) ? "" : new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
      });
      let toolUses = 0;
      for (const e of entries.slice(start)) {
        const content = e?.type === "assistant" ? e.message?.content : undefined;
        if (!Array.isArray(content)) continue;
        toolUses += content.filter((c) => c?.type === "tool_use").length;
      }
      process.stdout.write(`${cwd}\t${toolUses}\t${since}\n`);
    });
  '
) || exit 0

IFS=$'\t' read -r cwd tool_uses since <<<"$parsed"

# ツールを使っていない（会話だけの）ターンは、記録すべき調査・変更が無いので止めない。
[ "$tool_uses" -gt 0 ] 2>/dev/null || exit 0

if ! root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null); then
  warn "git リポジトリではないため判定しない（cwd: $cwd）"
  exit 0
fi

# 日付はローカルのタイムゾーン（date +%F）。logs/ のファイル名を付けるときと同じ規則にする（限界は .claude/rules/work-log.md）。
log="logs/$(date +%F).md"

# 作業ツリーでの変更（未追跡・ステージ済みを含む）。pathspec はリポジトリ直下からのパスなので -C "$root" で実行する。
if [ -n "$(git -C "$root" status --porcelain -- "$log")" ]; then
  exit 0
fi
# このターンの間のコミットでの変更（コミットの日時が最後の人間の発言の時刻以降）。「ログを追記 → コミット」まで
# 済ませた後の停止を通すため。
# WHY コミットも見る: この環境のユーザー側の Stop フックは未コミットの変更があると止めるので、ログはコミットしてから止まる。
#   作業ツリーだけを見ると、コミットした後に必ずこのフックで止まってしまう。
# WHY 今日の 0 時ではなくターンの開始: 今日の 0 時以降にすると、その日に 1 度でもログがコミットされれば（main の取り込みを含む）
#   以後のターンがすべて素通りした（Issue #64 の実測で当日 66 件。docs/work-log.md）。
# timestamp が取れないときだけ今日の 0 時にフォールバックする（止め続けないように緩い方へ倒す。理由は stderr）。
if [ -z "$since" ]; then
  warn "最後の人間のターンの timestamp を読めないため、今日の 0 時以降のコミットで判定する"
  since=midnight
fi
if [ -n "$(git -C "$root" log --since="$since" --format=%H -- "$log")" ]; then
  exit 0
fi

reason="作業ログ ${log} に、このターンでやったこと（調査・判断・確認した事実）を追記してください（.claude/general/log.md）。追記してからコミットしてください。"
REASON="$reason" node -e 'process.stdout.write(`${JSON.stringify({ decision: "block", reason: process.env.REASON })}\n`)'
exit 0
