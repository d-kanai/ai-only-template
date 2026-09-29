---
paths:
  - "scripts/cloud-session-start*"
  - ".claude/settings.json"
---

# クラウドセッション（scripts/cloud-session-start.sh）

Claude Code on the web（クラウドセッション）には asdf が無いため、`scripts/cloud-session-start.sh` で `.tool-versions` と同じ Node.js / pnpm を用意し、Postgres を起動する。
確認・復旧の手順はスキル `cloud-session`。決定は ADR `docs/adr/20260928-cloud-session-setup-script-and-hook.md`、VM の実測（前提・時間・403・レート制限）は 2026-09-28 の work-logs、検証状況（未確認の点）は 2026-09-29 の work-logs「docs/ から移した記録」。仕様は `scripts/cloud-session-start.test.ts` で固定している。

## 前提（公式 https://code.claude.com/docs/en/cloud-environments.md ）
- セッションごとに新しい VM（Ubuntu 24.04、x86_64）。Node 20 / 21 / 22 が入り 22 が PATH にある。asdf は無い。`CLAUDE_CODE_REMOTE=true` が設定される。
- セッション中にインストールしたものは次に残らない。残るのは setup script が書いたファイルだけ（環境キャッシュ）。キャッシュが作り直されるのは setup script か許可ネットワークを変えたとき、または約 7 日で失効したとき。

## 役割分担
- **setup script（推奨）**: 環境設定ダイアログに `bash scripts/cloud-session-start.sh --install-only` を書く。root で実行され、約 5 分以内に終わればキャッシュされる。重い作業（Node / pnpm の取得・展開）はここ。
  - `--install-only` は Node / pnpm のインストールだけ。`CLAUDE_CODE_REMOTE` は見ない（Claude の起動前に走るため無い可能性がある。未確認）。PATH の書き出し・`pnpm install`・docker は行わない（起動したデーモンはセッションに引き継がれない）。
  - クローン前に走る可能性は未確認。その場合はスクリプトの内容を直接貼る（版は貼る側で合わせる）。
- **SessionStart フック**: `.claude/settings.json` の `hooks.SessionStart`（matcher `startup|resume`）が毎セッション実行する。軽い作業だけ: 既存のインストールを見つけて PATH を書き出し、`pnpm install --frozen-lockfile`。setup script が無ければ自分で Node / pnpm を入れる。続けて `.env` が無ければコピー、`dockerd` の起動、`docker compose pull` と `up --wait`、`pnpm db:migrate`。
  - `CLAUDE_CODE_REMOTE` が `true` でなければ何もしない（ローカルは asdf）。
  - JSON にはコメントを書けないので、フックの説明はこのファイルに書く。
- `.tool-versions` の Node / pnpm を上げたら、setup script の内容を変えて保存し、キャッシュを作り直させる（`.tool-versions` の変更では作り直されない。例: `# nodejs <版> / pnpm <版>` のコメント行を書き換える）。

## スクリプトの規則
- 版は `.tool-versions` の `nodejs` / `pnpm` 行から読む（スクリプトに直書きしない）。
- インストール先: `/opt` に書ければ `/opt/node-<版>`、書けなければ `$HOME/.local/node-<版>`。検出は両方を見る。
- Node はまず nodejs.org から取り SHASUMS256.txt で検証する。取れなければ（403・不一致など）npm レジストリの `node-linux-x64`（aarch64 は `node-linux-arm64`。Node 公式バイナリを同梱したパッケージ）を `dist.integrity` の sha512 で検証して使う。jq は使わず sed で取り出す（VM にあるか未確認）。
- pnpm は常にレジストリの tarball から入れる（レジストリの Node には npm が無い）。pnpm 12 の `pnpm` パッケージは placeholder で本体は `@pnpm/exe.<platform>` のネイティブバイナリなので、両方を integrity で検証して取り、placeholder を置き換えて `<node_dir>/lib/node_modules/pnpm` に置き、`<node_dir>/bin/pnpm` から symlink する。WHY バイナリも自分で取る: 置かないと初回実行時に自分でダウンロードしに行き、タイムアウト・検証の外になる。同じ版があれば何もしない。
- PATH は `CLAUDE_ENV_FILE` に `export PATH=...` を追記して以降の Bash に引き継ぐ（フックはサブプロセス）。
- 何が失敗しても exit 0（stderr に理由）。WHY: setup script は exit 0 以外だとセッションが始まらない。フックも VM 既定の Node 22 で続けられる。
- アーキテクチャは x86_64 / aarch64 のみ。それ以外は何も入れない。
- `.env` はリポジトリ直下に無ければ `.env.example` からコピーする（あれば触らない）。Docker の段より前に行う（docker が無い・失敗しても `pnpm test` / `pnpm dev` が動くように）。
- Docker / Postgres（フックのときだけ）: `docker info` が通れば何もしない。通らなければ `setsid nohup dockerd ... &` で起動し（`setsid` が無ければ `nohup` だけ）、最大 30 秒待つ。`timeout 45 docker compose pull` を最大 3 回（2 秒・4 秒待って再試行）、`docker compose up -d --wait --wait-timeout 120`、成功したら `timeout 15 pnpm db:migrate`（VM ごとに DB が空なので表を作る）。`docker` / `dockerd` が無ければ warn で飛ばす。Node / pnpm に失敗しても Postgres は起動し、migrate は VM 既定の pnpm でも試す。
  - 既定のソケット・データ置き場のまま使うので `DOCKER_HOST` は書き出さない。
- 時間の上限: フックは 600 秒で打ち切られるので、最悪ケースの合計をそれ以下に収める。curl には `--connect-timeout 15` と `--max-time`（数十 MB の tarball 60 秒、メタデータ・SHASUMS・1 MB の pnpm tarball 20 秒）を付ける。Node / pnpm 280 + dockerd 30 + pull 45 × 3 + 間隔 6 + up 120 + migrate 15 = 586 秒。内訳と判断: curl の最悪ケースは接続タイムアウトも足すと 400 秒だが、`--max-time` は接続を含む全体の上限なので実際の上限は max-time の和の 280 秒。migrate の 15 秒は実測約 1 秒の 15 倍で、これ以上は長くしない（15 秒かかるなら止まっているとみなす）。pull を 240 秒 × 3 回にすると Docker の段だけで 30 + 720 + 6 + 120 = 876 秒になり 600 秒を超えるので、回数（3 回。一時的な 429 に再試行が効く）は残して 1 回の上限を 45 秒（実測の初回 pull 10.5 秒の 4 倍強）にした。値を変えるときはこの合計を計算し直す。
- setup script でイメージを pull しておく案は入れていない（キャッシュに `/var/lib/docker` が含まれて使えるか未確認）。

## 確認コマンド
```
bash scripts/cloud-session-start.sh --print-plan                                                # 読み取った版・インストール先・インストール済みか
CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh --install-only               # setup script の予定
CLAUDE_CODE_REMOTE=true CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh   # フックの予定（CLAUDE_ENV_FILE があれば PATH は書く。dockerd・.env の予定も出す）
```
- worktree の中で実行するときは `CI=true` を付ける（中の `pnpm install` が共有の `.git/hooks` を書き換えるため。LEARNINGS.md）。
