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

- クラウド VM の前提（公式 https://code.claude.com/docs/en/cloud-environments.md）: セッションごとに新しい VM（Ubuntu 24.04、x86_64）。Node.js は 20 / 21 / 22 が入っていて 22 が PATH にある。asdf は無い。セッションでは `CLAUDE_CODE_REMOTE=true` が設定される。
- 実測（2026-09-28、Claude Code on the web、環境タイプ cloud_default）:
  - VM は Ubuntu x86_64、実行ユーザーは root（`HOME=/root`）、`/opt` は書き込み可。`/opt/node20` `/opt/node21` `/opt/node22` があり、PATH の `node` は `/opt/node22/bin/node`（22.22.2）。
  - PATH の `pnpm` は `/opt/node22/bin/pnpm` で、単体では 10.33.0（`/tmp` で `pnpm --version`）。リポジトリ内では `package.json` の `packageManager`（`pnpm@12.7.0`）に従って 12.7.0 を `~/.local/share/pnpm/.tools/pnpm/12.7.0` に取得して動いていた。`.tool-versions` と一致したのは `packageManager` のおかげで、VM の pnpm そのものの版ではない。
  - フックには `CLAUDE_CODE_REMOTE=true` と `CLAUDE_PROJECT_DIR` が渡されていた。`CLAUDE_ENV_FILE` は Claude の通常の Bash には見えない（フックにだけ渡される想定どおり）。フックが書いた PATH が以降の Bash に効くかは、フックが成功する次のセッションで確認する（未確認）。
  - SessionStart フックは起動時に実行された（Claude Code の診断ログ `hook_spawn_completed` が exit 0、306 ms）が、Node の取得で失敗していた。nodejs.org への CONNECT がプロキシに 403 で拒否された（環境のネットワークポリシーで未許可。`curl -f` はハングせず即 exit 22）。code.claude.com も 403。registry.npmjs.org は `no_proxy` に含まれ、プロキシを通らず直接届く。
  - 対策は 2 つ。(a) 環境設定（セッションのタイトルバーの環境メニュー → Edit → Network access）で nodejs.org を許可ドメインに追加する。(b) スクリプトが nodejs.org で取れなければ npm レジストリから取る（既定の許可範囲で動く。下の「スクリプトの動き」）。(b) を実装済みなので (a) は必須ではない。
  - setup script は実行されていなかった（`/opt/node-24.21.0` が無かった）。環境に設定されているかは未確認。
  - setup script なしでフックが毎セッション入れる場合のコスト（実測）: レジストリの Node（52 MB）の取得・検証・展開が 3.1 秒、pnpm は tarball 1 MB とネイティブバイナリ 25 MB、スクリプト全体（nodejs.org の 403 → レジストリの Node・pnpm の取得 → `pnpm install --frozen-lockfile`）で 3.6 秒（pnpm のストアが温まった状態）。VM 既定の Node 22 で `pnpm install --frozen-lockfile` を実行したときは 10 秒だった。
  - VM 既定の Node 22.22.2 のままでも `pnpm install --frozen-lockfile` / `pnpm lint` / `pnpm test` / `pnpm build` は通った。
  - クラウドでは `CI` が未設定なので、`pnpm install`（フックの中も含む）で lefthook の postinstall が pre-commit フックを `.git/hooks` に入れる。
- セッション中にインストールしたものは次のセッションに残らない（VM が毎回新しいため）。残るのは setup script が書いたファイルだけ（環境キャッシュ = ファイルシステムのスナップショット）。
- 役割分担（公式 cloud-environments / hooks ドキュメント）:
  - **setup script（推奨）**: 環境設定ダイアログに書く。root で実行され、約 5 分以内に終わればファイルシステムがキャッシュされ、以後のセッションは setup script を飛ばしてキャッシュから始まる。重い作業（Node のダウンロード・展開、pnpm の導入）はここで行う。
  - **SessionStart フック**: `.claude/settings.json` の `hooks.SessionStart`（matcher `startup|resume`）が毎セッション（resume を含む）`scripts/cloud-session-start.sh` を実行する。軽い作業だけにする。既存のインストールを見つけて PATH を書き出し、`pnpm install --frozen-lockfile` を行う。setup script を設定していない場合は、フックが自分で Node / pnpm を入れる（フォールバック）。続けて `dockerd` を起動し、`docker compose pull`（再試行つき）と `docker compose up -d --wait --wait-timeout 120` で Postgres を立ち上げる（下の「Docker / Postgres」）。
  - JSON にはコメントを書けないため、フックの説明はこの節に書く。
- 環境設定ダイアログの setup script に貼る内容:
  ```
  bash scripts/cloud-session-start.sh --install-only
  ```
  - リポジトリがクローン済みのカレントディレクトリで実行される前提。setup script がクローン前に走る可能性は未確認。その場合は相対パスでスクリプトが見つからないので、スクリプトの内容を直接貼る（`.tool-versions` も読めないため、版は貼る側で合わせる必要がある）。
  - `--install-only` は Node / pnpm のインストールだけを行い、`CLAUDE_CODE_REMOTE` は見ない（setup script は Claude の起動前に走るため、この変数が無い可能性がある。未確認）。PATH の書き出しと `pnpm install` はしない。docker も触らない（起動したデーモンはセッションに引き継がれない。イメージの事前 pull は下の「Docker / Postgres」）。
- スクリプトの動き:
  - 版は `.tool-versions` の `nodejs` / `pnpm` の行から読む。スクリプトに直書きしない（`.tool-versions` が正）。
  - インストール先: `/opt` に書き込めれば `/opt/node-<版>`（setup script は root）、書けなければ `$HOME/.local/node-<版>`（フックの実行ユーザーは未確認）。検出は `/opt/node-<版>` → `$HOME/.local/node-<版>` の順で両方を見る。
  - Node はまず nodejs.org から取得し、SHASUMS256.txt で検証してから展開する。
  - nodejs.org で取れない（ネットワークポリシーで 403、SHASUMS 不一致など）ときは、npm レジストリの `node-linux-x64`（aarch64 は `node-linux-arm64`）にフォールバックする。Node 公式バイナリをそのまま同梱したパッケージ（https://github.com/aredridel/node-bin-gen 、provenance 付き）。版のメタデータ `https://registry.npmjs.org/node-linux-x64/<版>` の `dist.integrity`（tarball の sha512）で検証してから `dist.tarball` を展開する。jq はクラウド VM にあるか未確認なので使わず、sed で取り出す。
  - pnpm は Node の入手経路によらず、常にレジストリの tarball から入れる。レジストリの Node には npm が同梱されていないため `npm install -g` は使えず、経路を 1 本にそろえる。pnpm 12 の本体はネイティブバイナリで、`pnpm` パッケージの `pnpm` は置き換えられる前提の placeholder、バイナリは `@pnpm/exe.linux-x64`（aarch64 は `@pnpm/exe.linux-arm64`）にある（pnpm@12.7.0 の `install.js` / `native-binary.mjs`）。両方を integrity で検証して取得し、placeholder をバイナリで置き換えて `<node_dir>/lib/node_modules/pnpm` に置き、`<node_dir>/bin/pnpm` から symlink する（`npm install -g pnpm` と同じ最終形）。`pnpm` パッケージだけを置くと初回実行時にバイナリを自分でダウンロードしに行き、スクリプトのタイムアウト・検証の外になるため、バイナリも自分で取る。同じ版の `pnpm` が既にあれば何もしない。
  - フックはサブプロセスなので、PATH は `CLAUDE_ENV_FILE` に `export PATH=...` を追記して以降の Bash に引き継ぐ。
  - 何が失敗しても exit 0 で終わる（stderr に理由を出す）。setup script は exit 0 以外だとセッションが開始できない（公式）。フックも、失敗しても VM 既定の Node 22 でセッションは続けられる。
  - curl には `--connect-timeout 15` と `--max-time`（数十 MB の tarball は 60 秒、SHASUMS256.txt・レジストリのメタデータ・1 MB の pnpm tarball は 20 秒）を付けている。通信が止まったままフックの 600 秒打ち切りに達しないようにするため。最悪ケース（nodejs.org の 2 回が上限まで粘って失敗し、レジストリで Node 2 回・pnpm 4 回を取得）の合計は、接続タイムアウトも足す保守的な見積もりで (15 + 60) + (15 + 20) + (15 + 20) + (15 + 60) + (15 + 20) + (15 + 20) + (15 + 20) + (15 + 60) = 400 秒（`--max-time` は接続を含む全体の上限なので、実際は max-time の和の 280 秒が上限）。実測はいずれも数秒なので、60 秒かかるなら止まっているとみなせる。setup script の約 5 分はキャッシュされるかどうかの目安で、超えても失敗はしない。
  - アーキテクチャは x86_64 / aarch64 のみ対応。それ以外は何も入れない。
- Docker / Postgres（Issue #51。フックのときだけ）:
  - 前提（2026-09-28 実測）: クラウド VM には `docker` CLI 29.3.1、`/usr/bin/dockerd`、`containerd`、Compose プラグイン v5.1.1（`/usr/libexec/docker/cli-plugins/docker-compose`）、`psql` が入っているが、デーモンは起動していない（`docker info` が失敗する）。Podman は無い。
  - スクリプトの動き: `docker info` が通れば何もしない。通らなければ `setsid nohup dockerd </dev/null >${TMPDIR:-/tmp}/dockerd.log 2>&1 &` でバックグラウンドに起動し（`setsid` が無ければ `nohup` だけ）、`docker info` が通るまで最大 30 秒待つ。その後リポジトリ直下で `docker compose pull` を最大 3 回（失敗したら 2 秒・4 秒待って再試行）実行し、続けて `docker compose up -d --wait --wait-timeout 120` で `compose.yaml` の healthcheck（`pg_isready`）が healthy になるまで待つ（上限 120 秒。pull は含まない）。どの段で失敗しても warn を出して exit 0（Node と同じ設計）。Node / pnpm の導入に失敗しても Postgres の起動は行う（Postgres は Node に依存しない）。`docker` / `dockerd` が無ければ warn を出して飛ばす。
  - 既定のソケット（`/var/run/docker.sock`）とデータ置き場（`/var/lib/docker`）のまま使える: root で `dockerd` を引数なしで起動すると約 1.1 秒で `API listen on /var/run/docker.sock` になった（storage driver は overlayfs）。そのため `DOCKER_HOST` を `CLAUDE_ENV_FILE` に書き出す必要はなく、以降の Bash の `docker` / `pnpm db:psql` もそのまま動く。
  - 実測（この VM、2026-09-28、イメージは `mirror.gcr.io/library/postgres:18-alpine`）: `docker pull` 単体は約 10.5 秒。デーモン停止・イメージ未取得の状態から、スクリプト全体（Node / pnpm はインストール済み → `pnpm install` → `dockerd` 起動 → pull → up で healthy）は 14.7 秒。2 回目（デーモン・コンテナ起動済み。pull は取得済みの確認だけ）は 2.5 秒。`docker compose exec -T db psql -U app -d app -c 'select version()'` は `PostgreSQL 18.6 on x86_64-pc-linux-musl`、ホストの `psql postgresql://app:app@localhost:5432/app` でも接続できた。
  - Docker Hub のレート制限（イメージをミラーにした理由）: Docker Hub（`postgres:17-alpine`）で試したときは、1 回目の pull が `429 Too Many Requests` になり Postgres が起動しなかった（スクリプトは warn を出して exit 0）。直後の再試行では pull できた。レート制限の確認用 manifest の HEAD では `ratelimit-limit: 100;w=3600`、`ratelimit-remaining: 0`、`docker-ratelimit-source: 160.79.106.139`（クラウドの出口 IP。他の利用者と共有しているとみられる。共有かは未確認）。そのため `compose.yaml` のイメージは `mirror.gcr.io`（Google が運営する Docker Hub のミラー。匿名で manifest の取得・pull ができた）から取り、あわせて pull を再試行する（Issue #51 での判断）。mirror.gcr.io 側のレート制限の有無は未確認。
  - setup script（`--install-only`）でイメージを pull しておく案は入れていない。環境キャッシュ（ファイルシステムのスナップショット）に `/var/lib/docker` が含まれ、次のセッションの `dockerd` がそれを使えるかを確かめていないため（未確認）。
- ローカルでもフックは毎回実行されるが、`CLAUDE_CODE_REMOTE` が `true` でなければ何もしない（ローカルは asdf を使う）。
- setup script を使わない場合は、**毎セッション**フックが Node / pnpm をダウンロードする（VM が毎回新しく、セッション中のインストールは残らないため）。そのぶん毎回の開始が遅くなる（上の実測で数秒）。
- `.tool-versions` の Node / pnpm を上げたとき:
  - キャッシュには旧版しか入っていない。キャッシュが作り直されるのは、環境の setup script か許可ネットワークを変更したとき、または約 7 日で失効したときだけ（公式 cloud-environments ドキュメント）。`.tool-versions` の変更では作り直されない。
  - そのままでもフックが新しい版を見つけられず毎セッションダウンロードするので動くが、遅い。環境設定ダイアログで setup script の内容を変更して保存し、キャッシュを再構築させる（公式の条件は「setup script を変更したとき」。内容を変えずに保存し直すだけで再構築されるかは未確認なので、例えば setup script に `# nodejs <版> / pnpm <版>` のようなコメント行を置き、版を上げるたびに書き換える）。
- 確認方法:
  ```
  bash scripts/cloud-session-start.sh --print-plan   # 読み取った版・インストール先・インストール済みかを表示するだけ
  CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh --install-only                  # setup script の実行予定を表示するだけ
  CLAUDE_CODE_REMOTE=true CLOUD_SESSION_START_DRY_RUN=1 bash scripts/cloud-session-start.sh      # フックの実行予定を表示するだけ（CLAUDE_ENV_FILE があれば PATH は書く。デーモンが動いていなければ dockerd の起動予定も出す）
  ```
- 検証状況（2026-09-28 時点）:
  - クラウド VM 上で確認済み: スクリプトを `CLAUDE_CODE_REMOTE=true` で直接実行すると、nodejs.org が 403 → レジストリへのフォールバックで `/opt/node-24.21.0/bin/node --version` が v24.21.0、`/opt/node-24.21.0/bin/pnpm --version` が 12.7.0 になり、`CLAUDE_ENV_FILE` に PATH の行が追記され、`pnpm install --frozen-lockfile` まで通った（3.6 秒）。2 回目はインストール済みとして取得をせず 0.06 秒で終わった。テスト（`scripts/cloud-session-start.test.ts`）も通る。
  - クラウド VM 上で確認済み（Issue #51）: `CLAUDE_CODE_REMOTE=true` で直接実行すると、`dockerd` の起動から Postgres が healthy になるまで通った（上の「Docker / Postgres」の実測）。
  - 未確認: SessionStart フックとして起動したときに `dockerd` がフックの終了後も動き続けるか（`setsid nohup` で切り離しているが、フックとしての実行では確かめていない）。
  - 未確認: SessionStart フックとして起動したときにこの経路で成功し、書き出した PATH で以降の Bash の `node --version` / `pnpm --version` が `.tool-versions` どおりになるか。setup script に設定したときの動き。次のクラウドセッションで確認し、結果をここに反映する。
