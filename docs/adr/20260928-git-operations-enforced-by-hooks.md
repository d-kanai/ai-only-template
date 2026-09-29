# git 操作の禁止は文章ではなく、permissions.deny・PreToolUse フック・lefthook の commit-msg で止める

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #64 / PR #75 / `.claude/rules/git-guard.md` / `scripts/hooks/guard-git.sh` / `.claude/settings.json` / `lefthook.yml`

## 背景
サブエージェントの commit / push / PR 作成、main への直接の commit / push、force push、`--no-verify`、コミットメッセージの形式は、文章で禁止していただけだった（Issue #64）。

## 決定
- `.claude/settings.json` の `permissions.deny` と、PreToolUse フック `scripts/hooks/guard-git.sh` の両方で止める。フックは入力の `agent_type` / `agent_id` でサブエージェントを見分け、サブエージェントの commit / push / merge / PR 作成 / GitHub MCP の書き込みを deny する。全員に対して、main での commit、main への push、force push、`--no-verify`、squash を deny する。
- コミットメッセージの形式（🎯 / 📝 / 🛠️ / ✅ と `Co-Authored-By`）は lefthook の `commit-msg` で検査する。

## 理由
- 公式: `Bash(git push *)` のような deny のルールは、`git -C . push`、`git -c ... push`、`bash -c '...'` に当たらない（https://code.claude.com/docs/en/permissions.md の「What a rule doesn't match」）。PreToolUse フックは `permissionDecision: "deny"` でツールの呼び出しを止められる（https://code.claude.com/docs/en/hooks.md ）。
- 実測: deny と PreToolUse の拒否、`agent_type` がサブエージェントでだけ入ること、lefthook の commit-msg の拒否を使い捨てリポジトリで確かめた（2026-09-28 の work-logs「Issue #64 の前提（permissions.deny・フック・rules の paths・スキル・サブエージェント）を使い捨てリポジトリで実測」）。このリポジトリでも、フックが作業中に実際に deny した（2026-09-28 の work-logs「PR #75 の reviewer 指摘 9 件を反映した」）。
- git は長いオプションを一意な接頭辞で受け付けるので、フックは最短の接頭辞から拾う（git 2.43.0 の `builtin/commit.c` / `push.c` / `merge.c`）。

## 採用しなかった案
- `permissions.deny` だけで止める: `-C` / `-c` / `bash -c` の抜け道を塞げない（公式にも明記）。
- `.claude/agents/*.md` のフロントマター `hooks:` / `disallowedTools` で止める: フロントマターの hooks は信頼ダイアログを受け入れた後だけ動き（`-p` では動かなかった）、`disallowedTools` に `Bash(git push *)` を書くと Bash 全体が外れる（https://code.claude.com/docs/en/sub-agents.md 、実測は上の work-logs）。
- 危険な手順のスキルを `disable-model-invocation` で隠す: オーケストレータ自身も呼べなくなる。危険な操作はフックと deny で止める。

## 影響
- 良い点: 読み落としに関係なく、毎回同じ結果で止まる。
- 悪い点: 文字列の中の `git commit` も止まる誤検知がある（回避と、見逃す方向の限界は `.claude/rules/git-guard.md`）。メインの Bash・MCP での実際の拒否は未確認（テストは入力の JSON を直接渡して確かめた）。
- 見直す条件: 記録に無い。
