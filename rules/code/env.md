# 実行環境ルール

ツールのバージョンは asdf で管理し、`.tool-versions` をリポジトリにコミットして全員（人間・AI）が同じ環境で動かす。

## Node.js
- 現行の **LTS** を使う。Current（奇数メジャー・LTS 前）は使わない。
- バージョンの決め方: 1次情報（nodejs.org の公式リリース一覧）で最新 LTS を確認する。
  ```
  curl -s https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0] | .version + " " + .lts'
  ```
  その具体的なバージョン（例: `24.x.y`）を `.tool-versions` に書く。`lts` のようなエイリアスは書かない（時間で解決先が変わるため）。
- `asdf nodejs resolve lts --latest-available` には頼らない（2026-09-28 時点、最新 LTS が 24.21.0 なのに 22.x を返した。実行時刻で 22.21.1 / 22.23.3 と値も変わる）。
- 新しい LTS が出たら Issue → PR で `.tool-versions` を上げる。

## pnpm
- パッケージマネージャは **pnpm** のみ。npm / yarn は使わない（`package-lock.json` / `yarn.lock` を作らない）。
- バージョンは **latest**。次のコマンドで最新を確認し、その具体的なバージョンを `.tool-versions` に書く。
  ```
  asdf list all pnpm | tail -1
  ```
- `package.json` を作るときは、`packageManager` フィールドにも同じバージョンを書く（`pnpm@x.y.z`）。

## 手順（初回・更新時）
```
asdf plugin add nodejs   # 未追加なら
asdf plugin add pnpm     # 未追加なら
asdf install             # .tool-versions のとおりに入れる
node --version && pnpm --version   # .tool-versions と一致することを確認
```

- `.tool-versions` を変えたら `asdf install` を実行し、`node --version` / `pnpm --version` の出力が一致することを確認してからコミットする。
- 一致しないときは `which node` を見る。`~/.asdf/shims/node` 以外（例: `~/.asdf/installs/nodejs/<別バージョン>/bin/node`）を指していたら PATH の問題であり、`.tool-versions` は正しい。`asdf which node` と `~/.asdf/shims/node --version` で確認する。
- Claude Code から実行するシェルではこの不一致が必ず起きる。Claude Code は asdf 管理の Node（2026-09-28 時点 22.12.0）配下にグローバルインストールされており、asdf の shim が起動時にその Node の bin を PATH の先頭に入れるため、子プロセスの素の `node` は `.tool-versions` を無視してその Node になる。AI が確認するときは `asdf which node` / `~/.asdf/shims/node --version` を使う。

## クラウドセッション
Claude Code on the web（クラウドセッション）では asdf が使えないため、`scripts/cloud-session-start.sh` で `.tool-versions` と同じ Node.js / pnpm を用意する。

- クラウド VM の前提（公式 https://code.claude.com/docs/en/cloud-environments.md）: セッションごとに新しい VM（Ubuntu 24.04、x86_64）。Node.js は 20 / 21 / 22 が入っていて 22 が PATH にある。asdf は無い。pnpm は入っているが版は未確認。セッションでは `CLAUDE_CODE_REMOTE=true` が設定される。
- セッション中にインストールしたものは次のセッションに残らない（VM が毎回新しいため）。残るのは setup script が書いたファイルだけ（環境キャッシュ = ファイルシステムのスナップショット）。
- 役割分担（公式 cloud-environments / hooks ドキュメント）:
  - **setup script（推奨）**: 環境設定ダイアログに書く。root で実行され、約 5 分以内に終わればファイルシステムがキャッシュされ、以後のセッションは setup script を飛ばしてキャッシュから始まる。重い作業（Node のダウンロード・展開、pnpm の導入）はここで行う。
  - **SessionStart フック**: `.claude/settings.json` の `hooks.SessionStart`（matcher `startup|resume`）が毎セッション（resume を含む）`scripts/cloud-session-start.sh` を実行する。軽い作業だけにする。既存のインストールを見つけて PATH を書き出し、`pnpm install --frozen-lockfile` を行う。setup script を設定していない場合は、フックが自分で Node / pnpm を入れる（フォールバック）。
  - JSON にはコメントを書けないため、フックの説明はこの節に書く。
- 環境設定ダイアログの setup script に貼る内容:
  ```
  bash scripts/cloud-session-start.sh --install-only
  ```
  - リポジトリがクローン済みのカレントディレクトリで実行される前提。setup script がクローン前に走る可能性は未確認。その場合は相対パスでスクリプトが見つからないので、スクリプトの内容を直接貼る（`.tool-versions` も読めないため、版は貼る側で合わせる必要がある）。
  - `--install-only` は Node / pnpm のインストールだけを行い、`CLAUDE_CODE_REMOTE` は見ない（setup script は Claude の起動前に走るため、この変数が無い可能性がある。未確認）。PATH の書き出しと `pnpm install` はしない。
- スクリプトの動き:
  - 版は `.tool-versions` の `nodejs` / `pnpm` の行から読む。スクリプトに直書きしない（`.tool-versions` が正）。
  - インストール先: `/opt` に書き込めれば `/opt/node-<版>`（setup script は root）、書けなければ `$HOME/.local/node-<版>`（フックの実行ユーザーは未確認）。検出は `/opt/node-<版>` → `$HOME/.local/node-<版>` の順で両方を見る。
  - Node は nodejs.org から取得し、SHASUMS256.txt で検証してから展開する。pnpm はその Node の npm で入れる。
  - フックはサブプロセスなので、PATH は `CLAUDE_ENV_FILE` に `export PATH=...` を追記して以降の Bash に引き継ぐ。
  - 何が失敗しても exit 0 で終わる（stderr に理由を出す）。setup script は exit 0 以外だとセッションが開始できない（公式）。フックも、失敗しても VM 既定の Node 22 でセッションは続けられる。
  - curl には `--connect-timeout 15` と `--max-time`（tarball は 240 秒、SHASUMS256.txt は 60 秒）を付けている。通信が止まったままフックの 600 秒打ち切りに達しないようにするため（最悪ケースの合計 15 + 240 + 15 + 60 = 330 秒）。setup script の約 5 分はキャッシュされるかどうかの目安で、超えても失敗はしない。
  - アーキテクチャは x86_64 / aarch64 のみ対応。それ以外は何も入れない。
- ローカルでもフックは毎回実行されるが、`CLAUDE_CODE_REMOTE` が `true` でなければ何もしない（ローカルは asdf を使う）。
- setup script を使わない場合は、**毎セッション**フックが Node をダウンロードする（VM が毎回新しく、セッション中のインストールは残らないため）。そのぶん毎回の開始が遅くなる。
- `.tool-versions` の Node / pnpm を上げたとき:
  - キャッシュには旧版しか入っていない。キャッシュが作り直されるのは、環境の setup script か許可ネットワークを変更したとき、または約 7 日で失効したときだけ（公式 cloud-environments ドキュメント）。`.tool-versions` の変更では作り直されない。
  - そのままでもフックが新しい版を見つけられず毎セッションダウンロードするので動くが、遅い。環境設定ダイアログで setup script の内容を変更して保存し、キャッシュを再構築させる（公式の条件は「setup script を変更したとき」。内容を変えずに保存し直すだけで再構築されるかは未確認なので、例えば setup script に `# nodejs <版> / pnpm <版>` のようなコメント行を置き、版を上げるたびに書き換える）。
- 確認方法:
  ```
  bash scripts/cloud-session-start.sh --print-plan   # 読み取った版・インストール先・インストール済みかを表示するだけ
  CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh --install-only                  # setup script の実行予定を表示するだけ
  CLAUDE_CODE_REMOTE=true CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh      # フックの実行予定を表示するだけ（CLAUDE_ENV_FILE があれば PATH は書く）
  ```
- 未検証（2026-09-28 時点）: クラウドセッションで実際に setup script / フックが動き、Node / pnpm が `.tool-versions` どおりになるかは未確認。ローカル（macOS）で確認済みなのは、テスト（`scripts/cloud-session-start.test.ts`）、Linux 用 tarball の取得・SHASUMS 検証・展開、ローカルではフックが何もしないこと。最初のクラウドセッションで `node --version` / `pnpm --version` を確認し、結果をここに反映する。
