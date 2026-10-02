# 指示ファイルを読み込まれるときで分ける: 常時（CLAUDE.md・.claude/general）、パス依存（.claude/rules）、手順（スキル）、強制（フック・テスト）

- 日付: 2026-09-28
- 状態: 置き換え（→ workflow/20261002-always-loaded-rules-in-rules-workflow.md）
- 関連: Issue #64 / PR #75 / Issue #63 / PR #65 / `CLAUDE.md` / `rule-tests/instructions.test.ts`

## 背景
CLAUDE.md が `@rules/...` で全ルールを常時読み込み、常時のコンテキストが大きかった（2026-09-28 の work-logs「指示ファイルの読み込みとコンテキスト効率を公式ドキュメントで確認し、「機械的な強制を優先」を原則に追加（Issue #63 / #64）」）。文章で禁止しているだけのこと（サブエージェントの commit、main への直接の変更、コミットの形式、作業ログの漏れ）は、読み落とされても止まらなかった。

## 決定
- 常時読むのは CLAUDE.md（200 行以下）・LEARNINGS.md・`.claude/general/*.md`（1 ファイル 25 行以下）だけ。`@` で読んでよいのは LEARNINGS.md と `.claude/general/*.md` だけ。
- 規則と WHY は `.claude/rules/*.md` に置き、フロントマターの `paths` で、触ったファイルに応じて読ませる。
- 手順はスキル（`.claude/skills/<name>/SKILL.md`）。worker / reviewer は `skills:` で事前に読む。
- 機械で止められるものはフック・権限・テスト・CI に寄せ（CLAUDE.md の原則 7。Issue #63）、文書には参照と WHY だけを残す（workflow/20260928-git-operations-enforced-by-hooks.md、workflow/20260928-work-log-enforced-by-stop-hook-and-ci.md、workflow/20260928-worktree-isolated-external-resources.md）。
- 構成（行数・`@` の参照先・`paths` の一致・スキルのフロントマター）は `rule-tests/instructions.test.ts` で検査する。

## 理由
- 公式の仕様（2026-09-28 に確認）: CLAUDE.md は 1 ファイル 200 行以下が目安で、`.claude/rules/*.md` は `paths` に一致するファイルを触ったときだけ読まれる（https://code.claude.com/docs/en/memory ）。スキルは説明だけが常時、本文は呼び出したときに読まれる（https://code.claude.com/docs/en/skills ）。サブエージェントはプロジェクトの CLAUDE.md を読み、`skills:` で事前に読める（https://code.claude.com/docs/en/sub-agents ）。大規模向けの推奨も、パスのスコープは rules、手順はスキル（https://code.claude.com/docs/en/large-codebases ）。
- 使い捨てリポジトリでの実測で、`paths` による読み込み・スキル・フックの拒否が効くことを確かめてから入れた（2026-09-28 の work-logs「Issue #64 の前提（permissions.deny・フック・rules の paths・スキル・サブエージェント）を使い捨てリポジトリで実測」）。
- `@` の抽出（行頭か空白の直後、コードの中は除く）の根拠の実測: docs/claude-code-mechanics.md の「`@` import の実測」（2026-09-28 時点）→ 2026-09-29 の work-logs に移す。
- ユーザーの判断: 方針をすべて入れる。コード知能プラグインだけは入れない（Issue #64 のコメント）。

## 採用しなかった案
- CLAUDE.md をディレクトリごとに分けて減らす: ユーザーの判断「Claude.md を分けるよりスキルやフック」（2026-09-28 の work-logs の同じ項目）。
- コード知能プラグイン（TypeScript の LSP）: 今回は入れない（ユーザー判断。規模が大きくなったら検討）。
- サブエージェントの強制を `.claude/agents/*.md` のフロントマター `hooks:` / `disallowedTools` に置く: workflow/20260928-git-operations-enforced-by-hooks.md の「採用しなかった案」。
- `rule-check-test` スキルに `context: fork` を付ける（Issue #64 の方針 3）: worker / reviewer が作業中の文脈のまま手順として使うため付けない（PR #75）。

## 影響
- 良い点: 常時読む量が大きく減った（2026-09-28 の work-logs「Issue #64: 旧 rules/** の節の移動先（対応表）と、常時読み込む量の前後」）。
- 悪い点: どの規則がいつ読まれるかが `paths` に依存し、glob の typo は黙って読まれなくなる（テストで検査する）。`paths` が Write / Edit だけで読まれるかは未確認。
- 見直す条件: 記録に無い。
