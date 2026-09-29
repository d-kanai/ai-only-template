# リポジトリ全体を検査するルール検査テストは、apps/ ではなくリポジトリ直下の rule-tests/ にまとめる

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #86 / PR #91 / `.claude/rules/testing.md` / スキル `rule-check-test`

## 背景
リポジトリ直下に 8 本のルール検査テスト（architecture / instructions / lint / package / pnpm-workspace / settings / typecheck / work-logs-check）が並び、直下の見通しが悪かった。ユーザーからは「root にあるもので apps に移すべきものは無いか」という質問があった。

## 決定
- 8 本をリポジトリ直下の `rule-tests/` にまとめる。`apps/` には置かない。
- 名前は `rule-tests`（用語「ルール検査テスト」とスキル `rule-check-test` に対応させる）。

## 理由
- ルール検査テストは特定の app ではなく、リポジトリ全体（workspace の package.json、biome.json、`.claude/`、CI、apps をまたぐ依存の向き）を検査するので、apps/ には属さない（2026-09-29 の work-logs「リポジトリ直下のファイルで apps/ に移すべきものがあるかを整理した（ユーザーの質問）」）。
- 名前はユーザーの判断（2026-09-29 の work-logs「ルール検査テストをまとめるディレクトリ名の候補を出した」）。

## 採用しなかった案
- `apps/` の下に置く: 特定の app を検査するものではない。
- 名前を `guardrails/` にする: 意図は伝わるが、「テスト」であることが名前に無い。
- 名前を `fitness/` にする: architecture fitness functions の用語で、知らないと分からない。
- 名前を `repo-tests/` にする: 範囲は伝わるが、何を検査するかが曖昧。
- ツールの設定（biome / tsconfig / vitest / stryker / lefthook / compose / pnpm-workspace）も動かす: 各ツールがリポジトリ直下を探す規約なので動かさない。

## 影響
- 良い点: 直下のファイルが減り、ルール検査テストの一覧が 1 か所で分かる。
- 悪い点: 各テストはリポジトリ直下を 1 つ上のディレクトリとして参照する。
- 見直す条件: 記録に無い。
