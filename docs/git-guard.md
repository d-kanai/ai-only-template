# git 操作の強制: 実測と一次情報

`.claude/rules/git-guard.md` の根拠。ルール（何をどう止めるか・WHY）はあちらに書き、ここには確かめた事実だけを残す。

## 使い捨てリポジトリでの実測（Issue #64 のコメント、2026-09-28、researcher）
claude 2.1.283 の `claude -p ... --setting-sources project`。公式は `https://code.claude.com/docs/en/<page>.md` で取得。

| 仕組み | 実測 |
| --- | --- |
| `permissions.deny`（Bash） | `Bash(git --version*)` / `Bash(git tag:*)` で拒否された。`true && git --version` も拒否。`git -C . tag` と `bash -c 'git --version'` は「requires approval」（`-p` では実行されない）。未信頼のワークスペースでは `permissions.allow` は無視されるが deny は効く |
| PreToolUse フック（`permissionDecision: "deny"`） | `matcher: "Bash"` のスクリプトで `git commit --allow-empty` を拒否できた。`if: "Bash(echo IFTEST*)"` は一致時だけ動く。入力の `agent_type` はメインで null、サブエージェントで型名 |
| サブエージェント | CLAUDE.md を読む。`disallowedTools` は効く。プロジェクトの `.claude/agents/*.md` のフロントマター `hooks:` は `-p`（未信頼）では実行されなかった（公式: フォルダの信頼ダイアログを受け入れた後だけ。`--agents` の JSON で渡すと効いた）。SubagentStart は `agent_type` 付きで発火 |
| lefthook の `commit-msg` | `run: ./check-msg.sh {1}` で 🎯 / 📝 / 🛠️ / ✅ と `Co-Authored-By` を検査し、欠けたメッセージを拒否できた |

## このリポジトリでの実測（2026-09-28、Issue #64 の worker B、Claude Code 2.1.284）
- 実際のフックとしての拒否: worker（サブエージェント）の作業中に `.claude/settings.json` へ PreToolUse を足した直後、同じセッションの次の Bash の呼び出し（`git commit / push` という文字列を含む Python のヒアドキュメントでファイルを書き換えるコマンド）が
  `PreToolUse:Bash hook error: guard-git: サブエージェントは git commit を実行できません（commit / push / PR 作成・マージはオーケストレータが行う）`
  で拒否された。分かったこと:
  - settings.json に足したフックは、起動し直さなくても同じセッションで効いた（外したときに同じセッションで外れるかは未確認）。
  - サブエージェントの Bash の入力に `agent_id` か `agent_type` が入っていた（どちらが入っていたかは見ていない）。
  - 文字列の中の `git commit` も止まる誤検知は、想定どおり実際に起きる。回避は Write / Edit ツールで書くこと（`.claude/rules/git-guard.md` の「誤検知」）。
- commit-msg: `scripts/hooks/check-commit-msg.test.ts` の最後のテストが、一時ディレクトリの git リポジトリに `lefthook.yml` と `scripts/hooks/check-commit-msg.sh` をコピーし、`.git/hooks/commit-msg` に `lefthook run --no-auto-install commit-msg "$@"`（lefthook 2.1.12）を手で置いて `git commit -F` を実行する。`🛠️ 実装経緯` の無いメッセージは非 0 で終わって stderr にその見出しが出て、正しいメッセージはコミットされる。このリポジトリの `.git/hooks` には `lefthook install` を実行していない（他の作業中の共有フックを書き換えないため）。

## 一次情報（公式、2026-09-28 に取得）
- permissions（https://code.claude.com/docs/en/permissions.md）
  - 「Wildcard patterns」: `Bash(ls *)` は `ls` と `ls -la` に当たり `lsof` に当たらない。`Bash(ls*)` は `lsof` にも当たる。
  - 「What a rule doesn't match」: `Bash(git push *)` は `git -C . push origin main`、`git -c push.default=current push origin main`、`git 'push' origin main` に当たらない。`Bash(rm *)` は `bash -c 'rm -rf build/'` に当たらない。
  - deny / ask は、先頭の変数の代入を読み飛ばして照合する（`Bash(rm *)` は `FOO=bar rm -rf tmp/` に当たる）。区切り（`&&` `||` `;` `|` など）の後ろ、サブシェル、コマンド置換の中も見る。
- hooks（https://code.claude.com/docs/en/hooks.md）
  - 「Matcher patterns」: 英数字・`_`・`-`・空白・`,`・`|` だけなら完全一致の一覧、それ以外の文字を含めばアンカーなしの JavaScript の正規表現。Stop / WorktreeCreate / WorktreeRemove は matcher を取らない（書いても無視される）。
  - 「PreToolUse decision control」: `permissionDecision: "deny"` でツールの呼び出しを止め、`permissionDecisionReason` は Claude に渡る。deny / ask のルールはフックが何を返しても評価される。exit 2 は deny と同じ扱いで、stderr が理由になる。
  - 共通の入力: `agent_id` はサブエージェントの中だけ、`agent_type` はサブエージェントの中と `--agent` で起動したセッションに付く。
  - SubagentStop: `decision: "block"` はサブエージェントを動かし続け、`reason` を次の指示として渡す。
  - 「Disable or remove hooks」: `disableAllHooks: true` で全フックを止める（`--settings '{"disableAllHooks": true}'` で 1 回だけ）。個々のフックを設定に残したまま止める方法は無い。
  - 「Workspace trust」: プロジェクトのサブエージェントのフロントマターの hooks は、信頼ダイアログを受け入れた後だけ動く。`-p` は受け入れたことにならない。
- permission-modes（https://code.claude.com/docs/en/permission-modes.md）
  - deny のルールは `bypassPermissions` を含むすべてのモードで効く。allow のルールは `bypassPermissions` では意味を持たない。
  - 「Protected paths」: `.git`・`.claude` などへの書き込みは、`default` / `acceptEdits` で確認、`auto` で分類器、`bypassPermissions` で確認なし。
  - `permissions.defaultMode: "bypassPermissions"` を読むのは user / `--settings` / managed の設定とある（プロジェクトの `.claude/settings.json` で効くかは未確認。`settings.test.ts` はどこにあっても拒否する）。
- git 2.43.0 のオプション定義（https://raw.githubusercontent.com/git/git/v2.43.0/builtin/commit.c ・ `push.c` ・ `merge.c`）。git は長いオプションを一意な接頭辞で受け付ける（parse-options）ので、`guard-git.sh` は最短の接頭辞から拾う。
  - commit: `OPT_BOOL('n', "no-verify", ...)` と `OPT__VERBOSE`（`--no-verbose` がある）。`--no-v`〜`--no-ver` は両方に当たり、`--no-veri` から `--no-verify` に決まる。
  - push: 長いオプションの名前は repo / all / branches / mirror / delete / tags / dry-run / porcelain / force / recurse-submodules / thin / receive-pack / exec / set-upstream / progress / prune / no-verify / follow-tags / signed / atomic / push-option（ほかに force-with-lease / force-if-includes）。`m` で始まるのは mirror だけ、`--fo` は follow-tags と曖昧、`--a` は atomic と曖昧、`b` で始まるのは branches だけ。
  - merge: stat / summary / squash / commit / edit / ff / ff-only / verify-signatures / strategy / strategy-option / message / into-name / abort / quit / continue / allow-unrelated-histories / progress / overwrite-ignore / signoff / no-verify。`--s` は stat・summary・squash・strategy・signoff と曖昧で、`--sq` から squash に決まる。`--no-verify-signatures` は `--no-verify` の接頭辞ではない。
- lefthook 2.1.12 のバイナリ（`node_modules/.pnpm/lefthook-linux-x64@2.1.12/.../bin/lefthook`）の文字列に含まれる環境変数: `LEFTHOOK_BIN`・`LEFTHOOK_CONFIG`・`LEFTHOOK_EXCLUDE`・`LEFTHOOK_OUTPUT`・`LEFTHOOK_VERBOSE`（`strings | grep LEFTHOOK_`、2026-09-28）。`.git/hooks/pre-commit`（lefthook が書くスクリプト）は `LEFTHOOK=0` で終わり、`LEFTHOOK_BIN` があればそれを lefthook の代わりに実行する。`LEFTHOOK_CONFIG` / `LEFTHOOK_EXCLUDE` の効果は実行して確かめていない（名前から設定の差し替え・除外と判断し、止める側に倒した）。
- sub-agents（https://code.claude.com/docs/en/sub-agents.md）
  - `disallowedTools` に `Bash(git push *)` のような指定を書くと、ツール全体（Bash）が外れる。
  - `skills:` は起動時にスキルの本文をすべて読み込む。`disable-model-invocation: true` のスキルは事前読み込みできない。

## reviewer の指摘で直した見逃し（2026-09-28）
reviewer が `guard-git.sh` に JSON を直接渡して、次が許可されることを確かめた: `--no-verif` / `--forc` / `--squas` などの省略形、`git -c core.hooksPath=...`、`LEFTHOOK_EXCLUDE=`、`--mirror`、`gh pr merge --squash=true` と `-sd`、サブエージェントの `git -C "$(pwd)" commit`（`( )` を区切りにしていたため git と commit が分かれた）と `cherry-pick` / `revert` / `am` / `pull`、`cd <dir> && git commit` と `--git-dir`（ブランチを cwd で見ていた）。`-o <値>` の読み飛ばしは、壊しても落ちるテストが無かった。すべてテスト（`scripts/hooks/guard-git.test.ts`）に足して直した。残る見逃しは `.claude/rules/git-guard.md` の「見逃す方向の限界」。

## 未確認
- メイン（オーケストレータ）の Bash・GitHub MCP のツールで、フックが実際に拒否すること（テストでは入力の JSON を直接渡して確かめた）。
- SubagentStop フックが実際のサブエージェントの終了で動き、`systemMessage` が表示されること。
- `Bash(LEFTHOOK=0 *)` の deny が `LEFTHOOK=0 git commit` に当たるか（公式の「先頭の代入を読み飛ばす」とどう組み合わさるか）。
- `.claude/settings.json` からフックを消したとき、同じセッションで外れるか。
