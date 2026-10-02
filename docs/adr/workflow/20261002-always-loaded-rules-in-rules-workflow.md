# 常時読み込む要点を .claude/general から .claude/rules/workflow に移し、rules を分類のサブディレクトリに分ける

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #315 / `.claude/rules/workflow/` / `rule-tests/instructions.test.ts`

## 背景
常時読む要点（オーケストレーション・Issue → PR・コミット・作業ログ）は `.claude/general/*.md` に置き、CLAUDE.md の `@` で読ませていた（workflow/20260928-instruction-files-by-load-timing.md）。`.claude/general/` は Claude Code の決まった名前ではなく、このリポジトリで名付けただけだった。`.claude/rules/` は 12 ファイルが直下に並び、何の規則かを名前でしか分けられなかった。

## 決定
- `.claude/general/*.md` を `.claude/rules/workflow/` に移し、フロントマターの `paths` を持たせない（起動時に自動で読まれる）。CLAUDE.md の `@` は LEARNINGS.md だけにする。`workflow.md` は `issue-pr.md` に改名する。
- `.claude/rules/` は `<分類>/<名前>.md` に置く。分類は `workflow`（常時）・`code`（backend・frontend・shared・依存の向き）・`quality`（テスト・lint）・`tooling`（環境変数・依存・クラウドセッション・git ガード・作業ログのフック・worktree）の 4 つに固定する。フック側の `work-log.md` は `tooling/work-log-hooks.md` に改名する。
- `rule-tests/instructions.test.ts` で、分類の固定（`rules-category`）、`workflow/` に `paths` が無いこと（`rules-always`）、ほかの分類に `paths` があること（`rules-paths`）、旧 `.claude/general` が残らないこと（`legacy-general`）を検査する。

## 理由
- 公式 https://code.claude.com/docs/en/memory （2026-10-02 に確認）: `.claude/rules/` の `.md` は再帰で読まれ（「All `.md` files are discovered recursively, so you can organize rules into subdirectories」）、`paths` の無い rule は起動時に `.claude/CLAUDE.md` と同じ優先度で読まれる。
- サブエージェントも `paths` の無い rule を読むことを実測した（2026-10-02 の work-logs。InstructionsLoaded フックのログで、`claude -p` の親とサブエージェントの両方が `workflow/` の 4 つを `session_start` で読んだ）。
- 分類を置き場所にすると、常時か `paths` かと、何の規則かを置き場所で読め、検査で固定できる（ユーザーの依頼 2026-10-02「code workflow とかそういう分類で」）。

## 採用しなかった案
- `.claude/general/` のまま `@` で読む: Claude Code の仕組みで読めるものを独自の名前と `@` で読ませる理由が無い。
- 常時のものを分類に混ぜ、`paths` の有無だけで常時を決める: どれが常時かが置き場所で読めず、`paths` を消しただけで黙って常時が増える。
- 分類を ADR と同じ 4 つ（architecture / tech-stack / quality / workflow）にする: rules の中身（backend・frontend の規則、環境やフックの規則）と合わない。

## 影響
- 良い点: 常時の要点も rules として同じ仕組みで読まれ、`@` の検査が LEARNINGS.md だけになる。分類と常時の別を検査で固定できる。
- 悪い点: パスが変わり、コメントやメッセージの参照（多数）を書き換えた。過去の ADR・work-logs の旧パスは不変の記録として残る。
- 見直す条件: 分類に収まらない規則が出たとき（`RULE_CATEGORIES` に足す）。
