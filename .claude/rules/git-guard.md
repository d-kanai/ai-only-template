---
paths:
  - ".claude/settings.json"
  - ".claude/agents/**"
  - "lefthook.yml"
  - "scripts/hooks/guard-git*"
  - "scripts/hooks/check-commit-msg*"
  - "scripts/hooks/subagent-stop*"
  - "settings.test.ts"
---

# git 操作の機械的な強制（権限・フック・commit-msg）

文章で禁止していた git 操作を、Claude Code の権限（`permissions.deny`）・フック・Lefthook で止める（CLAUDE.md の原則 7。Issue #64）。
JSON にはコメントを書けないので、`.claude/settings.json` の各項目の WHAT / WHY はここに書く。実測と一次情報は `docs/git-guard.md`。

| 仕組み | ファイル | 止めるもの |
| --- | --- | --- |
| `permissions.deny` | `.claude/settings.json` | force push、main への push、`--no-verify`、squash マージ、`LEFTHOOK=0`（素直な書き方だけ） |
| PreToolUse フック | `scripts/hooks/guard-git.sh` | 上と同じものの変形（`-C` / `bash -c` / `&&` の後ろなど）、サブエージェントの commit / push / merge / rebase / tag / `reset --hard` / `checkout main` / `gh pr create・merge` / GitHub MCP の書き込み、main での commit / merge |
| commit-msg（Lefthook） | `lefthook.yml` → `scripts/hooks/check-commit-msg.sh` | 形式（`.claude/general/commit.md`）に合わないコミットメッセージ |
| SubagentStop フック | `scripts/hooks/subagent-stop.sh` | （止めない）共有の Git フックが worktree を指していたら直し、lockfile の未コミットの変更を知らせる |

検査: `settings.test.ts`（deny とフックの登録・matcher・スクリプトの存在と `bash -n`）、`scripts/hooks/guard-git.test.ts`、`scripts/hooks/check-commit-msg.test.ts`、`scripts/hooks/subagent-stop.test.ts`。
deny やフックを足す・変えるときは `settings.test.ts` の `REQUIRED_DENY_RULES` / `EXPECTED_HOOKS` と、スクリプトのテストの must pass / must reject も同じ変更で直す（手順はスキル `rule-check-test`）。

## settings.json の各項目
- `model`: メイン（オーケストレータ）のモデル（`.claude/general/orchestration.md`）。
- `permissions.deny`: Claude が実行しようとした Bash のコマンドが一致すると、フックの結果に関係なく拒否される（公式 hooks の「PreToolUse decision control」: deny ルールはフックが何を返しても評価される）。
  - `Bash(git push --force*)` / `Bash(git push -f*)`: force push。末尾の `*` の前に空白を置かないので、`--force-with-lease` や `-fu` も含む（公式 permissions の「Wildcard patterns」: `Bash(ls*)` は `lsof` にも当たる）。
  - `Bash(git push origin main*)` / `Bash(git push -u origin main*)`: main への push。`main-xxx` という名前のブランチへの push も止まるが、ブランチは `<type>/<Issue番号>-<内容>` なので当たらない。
  - `Bash(git commit --no-verify*)`: フックを飛ばすコミット。
  - `Bash(git merge --squash*)`: マージは merge commit だけ（`.claude/general/workflow.md`）。
  - `Bash(LEFTHOOK=0 *)`: Lefthook のフックを飛ばす。公式では deny は先頭の変数の代入を読み飛ばして照合する（`FOO=bar rm` は `Bash(rm *)` に当たる）ので、この書き方そのものが当たるかは未確認。フック側で必ず止める。
- `hooks`:
  - `SessionStart`（matcher `startup|resume`）: `scripts/cloud-session-start.sh`（`.claude/rules/cloud-session.md`）。
  - `PreToolUse`（matcher は Bash と、`mcp__github__` の create_pull_request / merge_pull_request / push_files / create_or_update_file / delete_file / update_pull_request_branch、timeout 60 秒）: `scripts/hooks/guard-git.sh`。matcher は英数字・`_`・`|` だけなので、公式の「Matcher patterns」で完全一致の一覧として扱われる（ツールを足すときは名前を正確に書く）。
  - `Stop` / `PreCompact` / `InstructionsLoaded`: 作業ログのフック（`.claude/rules/work-log.md`）。`WorktreeCreate`（timeout 300 秒。`pnpm install` と migrate を含むため）/ `WorktreeRemove`: worktree の分離（`scripts/hooks/worktree-create.sh` のコメント）。
  - `SubagentStop`（timeout 60 秒）: `scripts/hooks/subagent-stop.sh`。
  - matcher: Stop / WorktreeCreate / WorktreeRemove は matcher を取らない（公式の表。書いても無視される）ので書かない。PreCompact / InstructionsLoaded / SubagentStop は取れるが、すべての発生で動かすので書かない。
  - コマンドはすべて `bash "$CLAUDE_PROJECT_DIR"/scripts/...sh`。WHY: フックのカレントディレクトリに頼らず（サブエージェントや worktree で変わる）、実行権限（git の file mode）にも頼らないため。

## deny とフックを二重にする理由
- deny は変形に弱い: `git -C . push`、`git -c k=v push`、`bash -c 'git push'`、`git 'push'` には当たらない（公式 permissions の「What a rule doesn't match」。Issue #64 の実測でも `git -C . tag` と `bash -c '...'` は deny に当たらず承認待ちになった）。フックは文字列全体から正規表現で拾うので、これらも止める。
- フックは失敗すると止めない（下の「読めないとき」）。node が無い・フックの timeout などでフックが働かなくても、素直な書き方は deny で止まる。deny は未信頼のワークスペースでも効いた（Issue #64 の実測）。

## guard-git.sh の判定
- サブエージェント = 入力に `agent_id` か `agent_type` があるとき。公式では `agent_id` はサブエージェントの中だけ、`agent_type` は `--agent` で起動したメインにも付く。片方だけでも止める側に倒す（`--agent` でメインを起動すると、メインもサブエージェント扱いになる。このリポジトリでは使わない）。
  - サブエージェントには `git commit` / `push` / `merge` / `rebase` / `tag` / `reset --hard` / `checkout main`、`gh pr create` / `gh pr merge`、GitHub MCP の書き込みツールを許さない（オーケストレータだけが行う。`.claude/general/orchestration.md`）。
  - `.claude/agents/*.md` の `hooks:` と `disallowedTools` は使わない。WHY: プロジェクトのサブエージェントのフロントマターの hooks は、ワークスペースの信頼ダイアログを受け入れた後だけ動き、`-p` では動かなかった（公式 hooks の「Workspace trust」、Issue #64 の実測）。`disallowedTools` に `Bash(git push *)` のような指定を書くと、Bash そのものが外れる（公式 sub-agents の `disallowedTools`）。
- 全員（メインとサブエージェント）:
  - force push（`--force` / `--force-with-lease` / `--force-if-includes` / `-f` を含む短いオプションの束 / `+` 付きの refspec）。
  - main への push（`main` / `HEAD:main` / `x:main` / `refs/heads/main` / `:main` / `--delete main`）。プッシュ先が無い（`git push` / `git push origin`）か `HEAD` のときはカレントブランチで判定する。
  - カレントブランチが main での `git commit` / `git merge`。ブランチは `-C <dir>` があればその場所、無ければ入力の `cwd` で `git symbolic-ref --short HEAD` を見る（コミットの無いブランチでも取れるため。取れなければ判定しない）。
  - `--no-verify`、`git commit -n`、`LEFTHOOK=0` / `LEFTHOOK=false`、`git merge --squash`、`gh pr merge --squash / -s / --rebase / -r`、MCP の `merge_pull_request` の `merge_method: squash / rebase`、MCP の push_files / create_or_update_file / delete_file の `branch: main`。
- 拒否は stdout の JSON（`permissionDecision: "deny"`、理由は Claude に渡る）で返し、exit 0。exit 2 を使わないのは、フックの失敗と区別するため。
- 読めないとき（node が無い・JSON でない）は止めず（fail open）、stderr に理由を出す。WHY: 判定できない入力で全コマンドを止めると作業が止まり、フックを外したくなる。主な操作は deny でも止まる。

## 誤検知（受け入れている）
- シェルの構文解析をせず、クォートとバックスラッシュを消した文字列から拾うので、文字列の中の git も止める: `echo "git push --force"`、`grep "git commit" ...`、本文に `git push --force` などを含む `git commit -m "..."`、ヒアドキュメントの中身。
  - WHY 受け入れるか: シェルを正しく解析するにはパーサが要り（依存を足さない）、解析の漏れは見逃し（止めるべきものが通る）になる。誤検知は止める側の誤りで、書き方を変えれば済む。
  - 回避: コミットメッセージは Write ツールでファイルに書いて `git commit -F <file>` で渡す。禁止のパターンを含む文章は Bash のヒアドキュメントではなく Write / Edit ツールで書く（matcher は Bash と MCP だけなので、Write / Edit は検査されない）。
  - 2026-09-28、このフックを入れた直後のサブエージェントの Bash（`git commit / push` という文字列を含む Python のヒアドキュメント）が実際に拒否された（`docs/git-guard.md`）。

## 緊急時（フックを外す）
- フックを 1 つだけ止める設定や環境変数は用意していない（公式にも個別に無効にする方法は無い。`disableAllHooks` は全フックを止める）。WHY: `LEFTHOOK=0` のような抜け道は、Claude 自身が同じコマンドに付けられ、禁止が効かなくなる。
- 外すときは `.claude/settings.json` の該当の項目を消す（PR の差分に残り、レビューで見える）。ユーザーが自分のターミナルで git を実行するのは、フックの対象外（フックは Claude のツールの呼び出しにだけ効く）。
- 1 回だけ全フックを止めるなら、ユーザーが `claude --settings '{"disableAllHooks": true}'` で起動する（公式 hooks の「Disable or remove hooks」。SessionStart などほかのフックも止まる）。
- commit-msg と pre-commit の Lefthook は、人間が緊急時に `LEFTHOOK=0 git commit` で飛ばせる（`.claude/rules/lint.md`）。Claude には deny とフックが許さない。

## check-commit-msg.sh（commit-msg）
- 検査: 1 行目（サマリ）が空でない、2 行目以降に `🎯 WHY` / `📝 WHAT` / `🛠️ 実装経緯` / `✅ 検証内容` の行（前後の空白を除いて見出しだけの行）がこの順にある、`Co-Authored-By:` の行がある（大文字小文字は区別しない。git の trailer と同じ）。違反はすべて並べて exit 1。
- `#` で始まる行（git のコメント）と、`git commit -v` の切り取り線より下（差分）は見ない。WHY: commit-msg フックは git がコメントを消す前のメッセージを受け取る。
- 検査しないもの: 1 行目が `Merge ` で始まる（`git merge` / `gh pr merge` が作る。WHY などは PR 本文にある）、`fixup! ` / `squash! ` / `amend! `（`git rebase --autosquash` で元のコミットにまとめる一時的なコミット）。`Revert "..."` は検査する（取り消す理由を書く）。
- `bash scripts/hooks/check-commit-msg.sh {1}` で呼ぶ（`{1}` はメッセージのファイル）。フックは `pnpm install` の postinstall が入れる（`.claude/rules/lint.md`）。lefthook.yml に commit-msg を足した後は、メインの作業ツリーで `pnpm exec lefthook install` を実行するまで `.git/hooks/commit-msg` は無い。

## subagent-stop.sh（SubagentStop）
- メインの `.git/hooks` の pre-commit / commit-msg の中の lefthook のパス（`<作業ツリー>/node_modules/.pnpm/...`）が、メインの作業ツリー以外を指していたら、メインで `node_modules/.bin/lefthook install`（無ければ `pnpm exec lefthook install`）を実行して直す。WHY: worktree で install や commit をすると共有のフックが worktree を指すように書き換わる（LEARNINGS.md）。パスに `worktrees` を含むかではなく「メインと違うか」で見るのは、worktree がリポジトリの外にあることもあるため。`pnpm exec` を先に使わないのは、install が走ることがあるため（LEARNINGS.md の Issue #50）。
- サブエージェントの作業ツリーとメインの作業ツリーの `pnpm-lock.yaml` に未コミットの変更があれば知らせる。
- 結果は `systemMessage`（ユーザーに表示される）で返し、block しない。WHY: block はサブエージェントに作業を続けさせる指示で、共有フックはここで直り、lockfile はオーケストレータが判断するので、止めても直らない。
