---
paths:
  - "scripts/worktree-env*"
  - "scripts/hooks/worktree-*"
---

# worktree ごとの外部リソースの分離（WorktreeCreate / WorktreeRemove フック）

並列の worktree（`claude --worktree`、サブエージェントの `isolation: "worktree"`）が、同じ Postgres のデータベースや E2E のポートを使って互いに干渉しないようにする（Issue #64 のユーザー判断）。
決定は ADR `docs/adr/workflow/20260928-worktree-isolated-external-resources.md`、実測は 2026-09-28 の work-logs（2026-09-29 の「docs/ から移した記録」に担当 D の実測）。仕様は `scripts/worktree-env.test.ts`・`scripts/hooks/worktree-create.test.ts`・`scripts/hooks/worktree-remove.test.ts` で固定している。

## 設計: 一意な名前 → 導出 → `.env` → 作成
1. worktree の一意な名前（WorktreeCreate の入力の `name`。例 `agent-a3f2`）を決める（Claude Code が決める）。
2. `scripts/worktree-env.sh <name>` が、`.env.example` の変数のうち「リソースの一覧」にあるものを、名前から決定的に導いた値に置き換えて出す。
   - `DATABASE_URL`: パスのデータベース名を `app_wt_<sanitize した名前>`（`[a-z0-9_]` 以外は `_`、先頭が数字なら `_` を前置、`app_wt_` を含めて 63 文字以内）にする。
   - `E2E_PORT`: `3101 + (cksum(名前) % 800)`（3101〜3900。メインの 3100 と pnpm dev の 3000 に重ねない）。`env.ts` では任意（`toolEnv`。未設定なら 3100）だが、`.env.example` に行が無ければ導出は失敗する。
   - それ以外の行はそのまま。一覧の変数が `.env.example` に無ければ失敗する（分離されないまま共有のリソースを指す `.env` を作らない）。
3. WorktreeCreate フック（`scripts/hooks/worktree-create.sh`）がその出力を worktree の `.env` に書き、必要な作成（`create database`、`pnpm db:migrate`）まで行う。
4. アプリ・テスト・ツールは `apps/shared/env.ts` 経由で worktree の `.env` を読む（`findRepoRoot` は worktree の `pnpm-workspace.yaml` で止まる）ので、コードは何も変えずに worktree 専用のリソースを使う。

- WHY 決定的に導く: 乱数や空きの探索にすると、作り直したときに値が変わって作ったリソースを見失う。名前から計算できれば、後始末も名前だけで対象を決められる。
- WHY 値の入口を `.env` にする: 値の入口は `env.ts` の 1 か所（`.claude/rules/env.md`）。worktree ごとに `.env` を変えれば、分離のための分岐をコードに持たずに済む。
- InMemory / WASM の DB には置き換えない（テストは本物のリソースで行う。Issue #64 のユーザー判断）。

## リソースを足す手順（Redis の DB 番号・キーの接頭辞、バケット名の接頭辞など）
1. `env.ts` と `.env.example` に変数を足す。アプリの設定は `Env` / `PARSERS`（必須、既定値なし）、ツールの動かし方の切り替え（`E2E_PORT` など）は `ToolEnv`（任意）に置く（`.claude/rules/env.md`）。どちらでも `.env.example` には値を書く（`worktree-env.sh` の導出の元。無ければ失敗する）。
2. `scripts/worktree-env.sh` に `derive_<変数名>` の関数を 1 つ足し、`RESOURCES` と先頭の「リソースの一覧」のコメントに変数名を足す。
3. 作成が要るものは `worktree-create.sh` に、削除は同じファイルの孤立の掃除（`cleanup_orphan_databases` と同じ形）と `worktree-remove.sh` に足す。
4. テストを先に足す: 導出は `scripts/worktree-env.test.ts`、作成・削除は偽のコマンドを PATH に置く `scripts/hooks/worktree-*.test.ts`。

## WorktreeCreate（`scripts/hooks/worktree-create.sh`）
- 公式の契約（https://code.claude.com/docs/en/hooks.md の「WorktreeCreate」）: フックを設定すると Claude Code は自分では git worktree を作らない。command フックは作ったパスを stdout の最後の空でない行に出す（JSON は返せない。`hookSpecificOutput.worktreePath` は HTTP フック用）。0 以外で終わると作成が失敗する。フックが git の既定の動作を丸ごと置き換えるので `.worktreeinclude` は処理されない（だからフックの中で `.env` を作る。公式 hooks.md）。
- 手順: (1) `<メイン>/.claude/worktrees/<name>` に `<name>` ブランチの worktree を作る（既にあれば使う、ブランチがあればそれを使う、無ければ HEAD から作る）→ (2) 孤立した `app_wt_*` の DB を drop → (3) worktree で `CI=true pnpm install --frozen-lockfile` → (4) `.env` を書く → (5) DB が無ければ `create database`、worktree で `pnpm db:migrate` → (6) 共有フックの修復 → (7) パスを出す。
- メインの作業ツリーは `git worktree list` の 1 件目（cwd が worktree の中でもメインの下に作る）。
- docker（`docker compose exec -T db psql -U app -d app ...`）は必ずメインの作業ツリーで実行する。compose のプロジェクト名はディレクトリ名から決まるので、worktree の中では起動中の db コンテナが見つからない。
- 0 以外で終わるのは worktree そのものを作れないとき（name が不正、cwd が git リポジトリでない、`git worktree add` の失敗）だけ。docker が無い・DB の段・install・フックの修復の失敗は stderr に警告を出して続け、パスを返す。
  - DB を作れなくても `.env` は worktree 用の DB 名を指すので、メインの `app` を誤って使うことはない（DB を使うテストが「DB が無い」で止まる）。
  - 警告は stderr にしか出せない（command フックは `systemMessage` を返せない）。成功したフックの stderr がどこに出るかは未確認なので、DB が無いと言われたら stderr の手順（メインで `create database`、worktree で `pnpm db:migrate`）で作る。
- 上限: psql 15 秒、install 120 秒、migrate 15 秒、lefthook install 60 秒（`timeout` が無い macOS では `gtimeout`、どちらも無ければ上限なし）。
- 確認: `echo '{"name":"try-1","cwd":"'"$PWD"'"}' | WORKTREE_HOOK_DRY_RUN=1 bash scripts/hooks/worktree-create.sh`（実行予定を表示するだけ）。

## 共有フック（`.git/hooks/pre-commit`）の注意
- `.git/hooks` は本体と全 worktree で共有される。worktree で `pnpm install`（lefthook の postinstall）や、lockfile が変わった後の `pnpm exec` が走ると、本体のフックが worktree の lefthook を指すように書き換わる（LEARNINGS.md）。
- 対策: install には `CI=true` を付ける（postinstall がフックを入れない）。それでも worktree で素の `pnpm` を使えば起きうるので、WorktreeCreate / WorktreeRemove の最後に、pre-commit に `/.claude/worktrees/` が含まれていればメインで `pnpm exec lefthook install` を実行して直す。
- 限界: `.claude/worktrees/` の外に手で作った worktree を指すように書き換わった場合は検出しない（手で `pnpm exec lefthook install` する）。

## WorktreeRemove に頼らない
- 実測で WorktreeRemove の発火を確認できなかった（Issue #64 のコメント。`isolation: worktree` のサブエージェントの終了で発火しなかった）。
- そのため後始末の本命は WorktreeCreate の孤立の掃除: `app_wt_` で始まる DB のうち、ディレクトリのある worktree（`git worktree list`）に対応しないものを `drop database ... with (force)` する。`app_wt_[a-z0-9_]+` の形でない名前は触らない（列挙の結果を SQL に埋め込むため）。
- `worktree-remove.sh` は発火したときに早めに消すだけ: `worktree_path` が `<メイン>/.claude/worktrees/<name>` の形のときだけ、その DB を drop し、共有フックを直す。常に exit 0（0 以外だと worktree の削除そのものが失敗する。公式）。worktree のディレクトリやブランチは消さない。
- 限界: 次の WorktreeCreate が来るまで、消えた worktree の DB は残る。

## 限界
- 名前の sanitize で違う名前が同じ DB 名になりうる（`a-b` と `a_b`、63 文字を超えて前半が同じ名前）。Claude Code が付ける名前（英小文字・数字・`-`）では実用上重ならない想定。
- E2E_PORT は 800 通りのハッシュなので、並列の worktree で重なりうる。重なると `reuseExistingServer`（`apps/e2e/playwright.config.ts`）で別の worktree のサーバを使ってしまう。重なったら片方の `.env` の `E2E_PORT` を手で変える（次の WorktreeCreate で上書きされる）。
- `reuseExistingServer` は同じポートのサーバしか使わないので、worktree ごとに `next build` を待つ（メインで起動したサーバは使えない）。
- `.env` は WorktreeCreate のたびに作り直す（手で直した値は、同じ名前で作り直すと消える）。
- Postgres 以外の外部リソース（Docker のコンテナ名・ボリュームなど）は分けていない。compose の db コンテナはメインと全 worktree で 1 つを共有する。
- フックとしての実動作（Claude Code から呼ばれたときに、この経路で worktree が作られ、以降の作業がその `.env` で動くこと）は未確認。スクリプトを直接呼ぶ確認は 2026-09-29 の work-logs「docs/ から移した記録」。
