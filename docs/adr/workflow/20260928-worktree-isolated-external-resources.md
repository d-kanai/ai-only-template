# worktree ごとの外部リソースは、worktree 名から値を導いて WorktreeCreate フックが .env に書き、作成まで行う

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #64 / PR #75 / `.claude/rules/worktree.md` / `scripts/hooks/worktree-create.sh` / `scripts/worktree-env.sh`

## 背景
worktree を分けて並列に作業すると、テストの Postgres（globalSetup が `test_*` のスキーマを全部消す、E2E の `TRUNCATE` と固定のポート、`public` のマイグレーション）が互いに衝突する（2026-09-28 の work-logs「worktree で並列作業するときのテスト用 DB の分離方針を検討（調査・判断のみ）」）。

## 決定
- worktree ごとに一意な名前を決め、WorktreeCreate フックがその名前から各リソースの値（Postgres のデータベース名、E2E のポート。将来は Redis の DB 番号やキーの接頭辞など）を導いて `.env` に書き、`create database` と migrate まで行う。
- リソースを足すときは、`Env`（`env.ts`）・`.env.example`・フックの生成規則を足すだけにする。
- 後始末は WorktreeRemove に頼らず、WorktreeCreate が、対応する worktree の無いデータベースを消す。
- InMemory / WASM の DB には置き換えない（architecture/20260928-always-use-postgres-no-in-memory-switch.md）。

## 理由
- ユーザーの判断（Issue #64 のコメント、2026-09-28）。値の入口は `env.ts` の 1 か所なので、リソースの種類を増やしても同じ形で足せる。
- 使い捨てリポジトリの実測で、WorktreeCreate フックは発火したが、WorktreeRemove は発火を確認できなかった（2026-09-28 の work-logs「Issue #64 の前提…を使い捨てリポジトリで実測」）。
- WorktreeCreate フックは既定の git の動きを置き換え、`.worktreeinclude` は処理されないので、`.env` はフックの中で作る（https://code.claude.com/docs/en/hooks.md ）。
- スクリプトの実動作（worktree の作成から migrate、孤立したデータベースの削除まで）: docs/worktree.md の「実測（2026-09-28、Issue #64 の担当 D）」（2026-09-28 時点）→ 2026-09-29 の work-logs に移す。

## 採用しなかった案
- InMemory / WASM の DB（pg-mem、PGlite）にする: 本番の `Pool` の経路を通らない。
- WorktreeRemove で `drop database` する: 発火を確認できなかった。
- フックが JSON（`hookSpecificOutput.worktreePath`）を返す（Issue #64 の依頼の案）: command フックは stdout の最後の行をパスとして読むので、JSON を返せない（公式 hooks.md）。

## 影響
- 良い点: 並列の worktree が互いのデータを消さない。
- 悪い点: worktree を作るたびに install・DB の作成・migrate の時間がかかる。Claude Code からフックとして起動したときの動きは一部未確認（`.claude/rules/worktree.md`）。
- 見直す条件: 記録に無い。
