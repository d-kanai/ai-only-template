# docs（読み込まれない記録）

実測値・経緯・一次情報の引用・採用しなかった案を置く。Claude Code は自動では読み込まない（常時読むのは CLAUDE.md と `.claude/general/`、パス依存で `.claude/rules/`、手順はスキル `.claude/skills/`）。規則を変える前に、該当する文書で経緯を確かめる（CLAUDE.md の 6）。
`instructions.test.ts` が、ここの文書がどこかから参照されていることを検査する。

| 文書 | 内容 | 規則の置き場所 |
| --- | --- | --- |
| [architecture-decisions.md](architecture-decisions.md) | ディレクトリ構成の段階・実測・tsconfig とゲートの経緯・採用しなかった案・一次情報 | `.claude/rules/backend.md`・`frontend.md`・`architecture-check.md` |
| [env.md](env.md) | 環境変数の実測（どこで止まるか、instrumentation、`.env` の読み方、直参照の検査の限界） | `.claude/rules/env.md` |
| [cloud-session.md](cloud-session.md) | クラウド VM の実測、Docker / Postgres、時間の見積もり、検証状況 | `.claude/rules/cloud-session.md` |
| [dependencies.md](dependencies.md) | pnpm の挙動の実測、safe-chain と minimumReleaseAge、版の確認 | `.claude/rules/dependencies.md` |
| [lint.md](lint.md) | ESLint を使わない理由の実測、Biome・lefthook の実測 | `.claude/rules/lint.md` |
| [testing.md](testing.md) | テストのルールの根拠になった実例と実測 | `.claude/rules/testing.md` |
| [mutation-testing.md](mutation-testing.md) | Stryker の score・時間の実測、static な変異の分析、vitest-runner の patch の経緯 | `.claude/rules/testing.md` |
| [claude-code-mechanics.md](claude-code-mechanics.md) | CLAUDE.md・rules・スキル・フック・サブエージェントの公式の仕様と実測 | `CLAUDE.md` |
| [git-guard.md](git-guard.md) | git 操作の強制（権限・PreToolUse フック・commit-msg）の実測と一次情報 | `.claude/rules/git-guard.md` |
| [work-log.md](work-log.md) | 作業ログの強制（Stop フック・CI）の実測と経緯 | `.claude/rules/work-log.md` |
| [worktree.md](worktree.md) | worktree ごとの外部リソースの分離の実測と一次情報 | `.claude/rules/worktree.md` |

- 作業ログ（日ごとの行動・判断）は `work-logs/`。
