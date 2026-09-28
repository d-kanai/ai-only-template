# worktree ごとの外部リソースの分離: 実測と一次情報

規則は `.claude/rules/worktree.md`。ここは実測・公式の引用・経緯の記録（読み込まれない）。

## 経緯（Issue #64）
- ユーザー判断（Issue #64 の 2 つ目のコメント、2026-09-28）: 「worktree ごとに一意な名前（ブランチ名や worktree 名）を決め、`WorktreeCreate` フックがその名前から各リソースの値（Postgres のデータベース名、Redis の DB 番号やキーの接頭辞、E2E のポート、将来のバケット名の接頭辞など）を導いて `.env` に書き、必要な作成（`create database`、migrate など）まで行う。`WorktreeRemove` で消す」。「リソースを足すときは `Env` と `.env.example` とフックの生成規則を足すだけにする。InMemory / WASM の DB には置き換えない」。
- 実測（Issue #64 の 3 つ目のコメント、2026-09-28、researcher。claude 2.1.283 の `claude -p ... --setting-sources project`、使い捨てリポジトリ）: 「`isolation: worktree` は `.claude/worktrees/agent-<id>` に作られ、変更なしなら自動で消える。WorktreeCreate フックは発火した（自前で `git worktree add` してパスを返す）が、WorktreeRemove は発火を確認できなかった」。→ WorktreeRemove に頼る後始末はせず、WorktreeCreate 側で孤立した DB を掃除する設計にした。

## 公式の仕様（https://code.claude.com/docs/en/hooks.md 、2026-09-28 に取得）
- WorktreeCreate: 「Configuring a WorktreeCreate hook replaces that default git behavior」。「Because the hook replaces the default behavior entirely, `.worktreeinclude` is not processed. If you need to copy local configuration files like `.env` into the new worktree, do it inside your hook script.」
- 入力: 共通の項目（`session_id` / `transcript_path` / `cwd` / `hook_event_name`）と `name`（「a slug identifier for the new worktree, either specified by the user or auto-generated, for example `bold-oak-a3f2`」）。
- 出力: 「Command hooks (`type: "command"`): print the path as the last non-empty line of stdout」。「HTTP hooks: return `{ "hookSpecificOutput": { "hookEventName": "WorktreeCreate", "worktreePath": "/absolute/path" } }`」。「A `WorktreeCreate` command hook can't return JSON, because Claude Code reads its stdout as the worktree path.」
  - Issue #64 の依頼では JSON（`hookSpecificOutput.worktreePath`）を出す案だったが、`.claude/settings.json` の登録は command フックなので、公式に従いパスだけを出す。
- 「Claude Code refuses an absolute path that contains `.` or `..` segments, and any path that passes through a symlink below the repository root」。
- 終了コード: 「any non-zero exit code from `WorktreeCreate` aborts worktree creation, and any non-zero exit code from `WorktreeRemove` makes worktree removal fail if the directory still exists afterward」。
- WorktreeRemove の発火条件（公式）: `--worktree` のセッションを終えて削除を選んだとき、`isolation: "worktree"` のサブエージェントが終わったとき、バックグラウンドセッションを削除したとき。入力は `worktree_path`。JSON の出力は捨てられる。
  - 「For git-based worktrees, Claude Code handles cleanup automatically with `git worktree remove`. If you configured a WorktreeCreate hook for a non-git version control system, pair it with a WorktreeRemove hook」。WorktreeCreate フックで git worktree を作った場合に Claude Code が `git worktree remove` するかは未確認。

## 実測（2026-09-28、Issue #64 の担当 D）
- 実 Postgres（compose の db、PostgreSQL 18）で、フックが使う SQL を `docker compose exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -At -c ...` で実行: `create database app_wt_check` → `select datname from pg_database where starts_with(datname, 'app_wt_')` に `app_wt_check` → `select 1 ...` が `1` → `drop database if exists app_wt_check with (force)` → もう一度 drop しても `NOTICE: ... does not exist, skipping` で exit 0。
- スクリプトを直接呼んだ確認（フックとしての起動ではない）: このリポジトリを scratchpad の `ai-only-template/` に clone し（compose のプロジェクト名をそろえ、起動中の db コンテナを使うため）、clone の中に worktree を作った（本体の `.git/hooks` には触れない）。
  1. `{"name":"real-check",...}` で `worktree-create.sh` → exit 0、stdout はパス 1 行だけ。`git worktree add -b real-check` と `CI=true pnpm install --frozen-lockfile`（362 ms）が通った。clone の HEAD の `.env.example` に `E2E_PORT` が無かったので、`worktree-env.sh` が「E2E_PORT がありません」で止まり、`.env` と DB は作らなかった（想定どおり）。
  2. worktree の `.env.example` と `env.ts` を作業中の版に差し替えて同じ名前で再実行 → 既存の worktree を使い、`.env` が `DATABASE_URL=postgresql://app:app@localhost:5432/app_wt_real_check`、`E2E_PORT=3337` になり、`create database app_wt_real_check` と `pnpm db:migrate`（`migrations applied successfully`）が通った。`app_wt_real_check` に `todos` 表ができていた。
  3. worktree のディレクトリを消してから別の名前（`real-check-2`）で実行 → 孤立した `app_wt_real_check` が drop された。
  4. `app_wt_real_check_2` を作ってから `{"worktree_path":".../.claude/worktrees/real-check-2"}` で `worktree-remove.sh` → exit 0 で drop された。
- 未確認: Claude Code からフックとして起動したときの動き（`isolation: worktree` のサブエージェントがこの worktree と `.env` で動くか、WorktreeRemove が発火するか、成功したフックの stderr がどこに表示されるか）。
