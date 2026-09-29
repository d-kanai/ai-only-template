---
name: cloud-session
description: クラウドセッション（Claude Code on the web）の環境の確認と復旧。CLAUDE_CODE_REMOTE=true の環境で node / pnpm の版が .tool-versions と違う、Postgres や docker が動いていない、E2E の Chromium が見つからないとき、scripts/cloud-session-start.sh や setup script を確かめる・直すときに使う。
---

# cloud-session（Claude Code on the web の環境）

クラウド VM には asdf が無いので、`scripts/cloud-session-start.sh` が `.tool-versions` と同じ Node / pnpm を入れ、Postgres を起動してマイグレーションを当てる。
スクリプトの仕様と WHY は `.claude/rules/cloud-session.md`、決定は ADR `docs/adr/workflow/20260928-cloud-session-setup-script-and-hook.md`、VM の実測・時間は 2026-09-28 の work-logs。

## 仕組み（2 つの入口）
- **SessionStart フック**（`.claude/settings.json`、matcher `startup|resume`）: 毎セッション `bash scripts/cloud-session-start.sh` を実行する。`CLAUDE_CODE_REMOTE=true` のときだけ動く（ローカルでは何もしない）。既存の Node / pnpm を見つけて PATH を `CLAUDE_ENV_FILE` に書き出し → `pnpm install --frozen-lockfile` → `.env` が無ければ `.env.example` からコピー → `dockerd` の起動 → `docker compose pull`（再試行つき）→ `up --wait` → `pnpm db:migrate`。Node / pnpm が無ければ自分で入れる。
- **setup script**（環境設定ダイアログ。ユーザーが設定する）: `bash scripts/cloud-session-start.sh --install-only`。Node / pnpm のインストールだけ行い、ファイルシステムが環境キャッシュに残る。WHY: 重い取得をキャッシュに寄せ、毎セッションの開始を速くする。
- どちらも失敗しても exit 0 で終わる（stderr に理由）。WHY: setup script は exit 0 以外だとセッションが始まらない。フックも VM 既定の Node 22 で続けられる。

## 確認する
1. 版の確認: `node --version` と `pnpm --version` が `.tool-versions`（`nodejs` / `pnpm` の行）と一致するか。
   - 一致しなければ、このシェルで `export PATH=/opt/node-<.tool-versions の nodejs の版>/bin:$PATH`（例: `/opt/node-24.21.0/bin`）。WHY: フックが書いた PATH が以降の Bash に効くかは未確認で、Bash の呼び出しごとにシェルの状態は引き継がれない。
2. 読み取った版・インストール先・インストール済みかだけを表示: `bash scripts/cloud-session-start.sh --print-plan`
3. 実行予定だけを表示（何も入れない・起動しない）:
   ```sh
   CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh --install-only               # setup script の予定
   CLAUDE_CODE_REMOTE=true CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh   # フックの予定（CLAUDE_ENV_FILE があれば PATH は書く）
   ```
4. Postgres: `docker info` が通るか、`docker compose ps` で `db` が healthy か、`docker compose exec -T db psql -U app -d app -c 'select 1'`。

## 復旧する（VM のリセット後に dockerd / Postgres / 表が消えたとき）
1. リポジトリ直下で `CLAUDE_CODE_REMOTE=true bash scripts/cloud-session-start.sh` を実行する。Node / pnpm が入っていれば取得を飛ばし、`dockerd` の起動 → Postgres の起動 → `pnpm db:migrate` まで戻る（Node / pnpm がインストール済みなら数秒）。
   - worktree の中で実行するときは `CI=true` を付ける。WHY: 中の `pnpm install` が lefthook の postinstall を走らせ、本体と共有の `.git/hooks/pre-commit` を worktree のパスに書き換える（LEARNINGS.md）。
2. 出力の warn を読む。docker / dockerd が無い、pull の失敗（Docker Hub の 429 など）、up のタイムアウトはここに出る。
3. `.env` は既にあれば触らない。必須の変数が欠けていれば `cp .env.example .env` を確かめる（`.claude/rules/env.md`）。

## E2E（Playwright）
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e`。WHY: VM の `/opt/pw-browsers` の Chromium（ビルド 1194）は `@playwright/test` の要求するビルドと違い、変数なしだと `Executable doesn't exist` で失敗する。
- 前提: Postgres が起動し、マイグレーションが当たっていること（上の復旧手順）。

## ユーザーに依頼すること（セッションの中からは変更できない）
- 環境設定ダイアログの setup script（上の `--install-only` の 1 行）、許可ドメイン（Network access。nodejs.org は未許可でも npm レジストリへのフォールバックで動く）、Claude GitHub App のインストール。
- `.tool-versions` の Node / pnpm を上げたとき: 環境キャッシュは `.tool-versions` の変更では作り直されない。setup script の内容を変えて保存してもらう（例: `# nodejs <版> / pnpm <版>` のコメント行を版に合わせて書き換える）。そのままでもフックが毎セッション取得するので動くが遅い。

## GitHub 操作
- `gh` は無い。GitHub MCP ツールと `curl`（`GH_TOKEN`）を使う（`pr-flow` スキルの「クラウドセッションでの読み替え」）。
