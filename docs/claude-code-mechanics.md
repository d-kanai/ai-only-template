# Claude Code の指示・スキル・フックの仕組み（公式の仕様と実測）

指示ファイルの置き場所（CLAUDE.md / `.claude/general` / `.claude/rules` / `.claude/skills` / `docs`）を決めた根拠。Issue #64 の本文とコメントの要約。ここは読み込まれない記録。

## 公式の仕様（2026-09-28、code.claude.com/docs）
- Memory（https://code.claude.com/docs/en/memory ）: CLAUDE.md は 1 ファイル 200 行以下が目安（超えると起動時に警告）。`@path` import は 4 段まで、相対パスは import を書いたファイルから解決し、コードスパン・コードブロックの中は評価しない。サブディレクトリの CLAUDE.md は、そのディレクトリのファイルを読んだときに遅延で読み込まれる。`.claude/rules/*.md` は `paths:` フロントマター（glob）で一致するファイルを触ったときだけ読み込まれ、`/compact` 後もファイル一致で再読み込みされる。`claudeMdExcludes` で不要な CLAUDE.md を除外できる。
- Skills（https://code.claude.com/docs/en/skills ）: `.claude/skills/<name>/SKILL.md`。説明（`description` / `when_to_use`）だけが起動時に読まれ、本文は呼び出し時に読み込まれる。フロントマターに `paths`、`disable-model-invocation`、`user-invocable`、`allowed-tools`、`context: fork` + `agent:` + `background`、`hooks:`、`model` など。補助ファイルは `${CLAUDE_SKILL_DIR}` で参照。
- Subagents（https://code.claude.com/docs/en/sub-agents ）: プロジェクトの CLAUDE.md 階層を自動で読む（`omitClaudeMd: true` で除外。組み込みの Explore / Plan は読まない）。`skills:`、`hooks:`、`disallowedTools`、`maxTurns`、`memory:`、`isolation: "worktree"` がある。
- Hooks（https://code.claude.com/docs/en/hooks-guide ）: PreToolUse で exit 2 か `hookSpecificOutput.permissionDecision: "deny"` により Bash を拒否できる（`if` でコマンドの形で絞る）。イベントに SubagentStart / SubagentStop / PreCompact / PostCompact / InstructionsLoaded / WorktreeCreate / WorktreeRemove / PostToolUseFailure / Setup などがある。
- 大規模向け（https://code.claude.com/docs/en/large-codebases ）: ディレクトリごとの CLAUDE.md、`.claude/rules/` のパススコープ、手順はスキル、コード知能プラグイン（今回は入れない。ユーザー判断）。

## 実測（2026-09-28、researcher。使い捨てリポジトリ、claude 2.1.283 の `claude -p ... --setting-sources project`）
| 仕組み | 実測 | このリポジトリでの使い方 |
| --- | --- | --- |
| `permissions.deny`（Bash） | `Bash(git --version*)` / `Bash(git tag:*)` で拒否された。`true && git --version` も拒否。`git -C . tag` と `bash -c 'git --version'` は「requires approval」（`-p` では実行されない）。未信頼のワークスペースでは `permissions.allow` は無視されるが deny は効く | 書式は ` *` 形式。`-C` / `-c` / `bash -c` の抜け道は deny では塞げない（公式にも明記）ので PreToolUse フックで補う |
| PreToolUse フック（`permissionDecision: "deny"`） | `matcher: "Bash"` のスクリプトで `git commit --allow-empty` を拒否できた。`if: "Bash(echo IFTEST*)"` は一致時だけ動く。入力の `agent_type` はメインで null、サブエージェントで型名 | `scripts/hooks/guard-git.sh`。`agent_type` でサブエージェントだけに絞る |
| `.claude/rules/*.md` の `paths:` | `docs/b.txt` の Read では読まれず、`src/a.txt` の Read で読まれた。InstructionsLoaded フックに `load_reason: path_glob_match` と `trigger_file_path` が記録された | `.claude/rules/`。未確認: Write / Edit だけで一致ファイルを触ったとき |
| スキル（`paths` / `disable-model-invocation` / `context: fork`） | `paths` は「一致ファイルを触った後に一覧に出る条件」で、本文は Claude が呼ばない限り読まれない。`disable-model-invocation: true` は一覧に出ず `/name` でだけ起動。`context: fork` + `agent: general-purpose` はサブエージェントで動き、CLAUDE.md も読んでいた | 手順はスキル。モデル自身が実行する手順（`pr-flow` のマージなど）には `disable-model-invocation` を付けない（付けるとオーケストレータが呼べない）。危険な操作はスキルを隠すのではなく PreToolUse フックと `permissions.deny` で止める（`.claude/rules/git-guard.md`） |
| サブエージェント | CLAUDE.md を読む。`disallowedTools` は効く。プロジェクトの `.claude/agents/*.md` のフロントマター `hooks:` は `-p`（未信頼）では実行されなかった（公式: 信頼ダイアログを受け入れた後だけ。`--agents` の JSON で渡すと効いた）。`isolation: worktree` は `.claude/worktrees/agent-<id>` に作られ、変更なしなら自動で消える。WorktreeCreate フックは発火した（自前で `git worktree add` してパスを返す）が、WorktreeRemove は発火を確認できなかった。SubagentStart は `agent_type` 付きで発火 | サブエージェントへの強制は settings.json の PreToolUse に置く。WorktreeRemove に頼る後始末はしない |
| Stop フック | `git status --porcelain -- work-logs/<今日>.md` が空なら `{"decision":"block"}` で止まり、Claude がログを書いてから終了した（8 回で打ち切り。`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`） | `scripts/hooks/require-work-log.sh`。ユーザー側 Stop フック（未コミットがあれば止める）とぶつかるので、ログの追記 → コミットの順を前提にする |
| lefthook の `commit-msg` | `run: ./check-msg.sh {1}` で 🎯 / 📝 / 🛠️ / ✅ と `Co-Authored-By` を検査し、欠けたメッセージを拒否できた | `lefthook.yml` |

## `@` import の実測（2026-09-28、Issue #64。claude 2.1.284、使い捨てリポジトリで `claude -p ... --setting-sources project --disallowedTools Read Bash Glob Grep`）
- CLAUDE.md に `- 要点: @.claude/general/a.md`（`.` で始まるパス、行の途中で空白の直後）と書くと、`a.md` の中身（合言葉）がコンテキストに入っていた。
- 同じ行をコードスパン（`` `@.claude/general/a.md` ``）にすると読み込まれなかった（「無い」と答えた）。
- `instructions.test.ts` の @ の抽出（行頭か空白の直後、コードの中は除く）はこれに合わせている。全角の括弧の直後など、ほかの区切りでの挙動は未確認。

## 未確認
- 信頼済みの対話セッションでエージェントのフロントマター `hooks:` が効くか、WorktreeRemove の発火条件、rules の `paths` が Write / Edit で読まれるか、スキルの自動起動の精度。
- `.claude/rules` の `paths` の glob の方言（dotfile の扱いなど）。`instructions.test.ts` は Node の `path.matchesGlob` で照合しているので、両者で一致の判定が違いうる glob（`**` がドットで始まるディレクトリに一致するか など）は避け、パスを明示する。
