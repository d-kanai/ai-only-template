# クラウドセッションの実測と経緯

規則は `.claude/rules/cloud-session.md`、確認・復旧の手順はスキル `cloud-session`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。公式: https://code.claude.com/docs/en/cloud-environments.md 、hooks ドキュメント。

## VM の実測（2026-09-28、Claude Code on the web、環境タイプ cloud_default）
- Ubuntu x86_64、実行ユーザーは root（`HOME=/root`）、`/opt` は書き込み可。`/opt/node20` `/opt/node21` `/opt/node22` があり、PATH の `node` は `/opt/node22/bin/node`（22.22.2）。
- PATH の `pnpm` は `/opt/node22/bin/pnpm` で、単体では 10.33.0（`/tmp` で `pnpm --version`）。リポジトリ内では `packageManager`（`pnpm@12.7.0`）に従って 12.7.0 を `~/.local/share/pnpm/.tools/pnpm/12.7.0` に取得して動いていた。`.tool-versions` と一致したのは `packageManager` のおかげで、VM の pnpm の版ではない。
- フックには `CLAUDE_CODE_REMOTE=true` と `CLAUDE_PROJECT_DIR` が渡されていた。`CLAUDE_ENV_FILE` は Claude の通常の Bash には見えない（フックにだけ渡される想定どおり）。
- SessionStart フックは起動時に実行された（診断ログ `hook_spawn_completed` が exit 0、306 ms）が、Node の取得で失敗していた: nodejs.org への CONNECT がプロキシに 403 で拒否された（ネットワークポリシーで未許可。`curl -f` はハングせず即 exit 22）。code.claude.com も 403。registry.npmjs.org は `no_proxy` に含まれ、プロキシを通らず直接届く。
- 対策は 2 つ: (a) 環境設定（Network access）で nodejs.org を許可ドメインに追加、(b) npm レジストリから取るフォールバック（既定の許可範囲で動く）。(b) を実装済みなので (a) は必須ではない。
- setup script は実行されていなかった（`/opt/node-24.21.0` が無かった）。環境に設定されているかは未確認。
- setup script なしでフックが毎セッション入れる場合のコスト: レジストリの Node（52 MB）の取得・検証・展開が 3.1 秒、pnpm は tarball 1 MB とネイティブバイナリ 25 MB、スクリプト全体（nodejs.org の 403 → レジストリの Node・pnpm → `pnpm install --frozen-lockfile`）で 3.6 秒（pnpm のストアが温まった状態）。VM 既定の Node 22 で `pnpm install --frozen-lockfile` は 10 秒。
- VM 既定の Node 22.22.2 のままでも `pnpm install --frozen-lockfile` / `pnpm lint` / `pnpm test` / `pnpm build` は通った。
- クラウドでは `CI` が未設定なので、`pnpm install`（フックの中も含む）で lefthook の postinstall が pre-commit フックを `.git/hooks` に入れる。
- pnpm 12 の `pnpm` パッケージは placeholder で、本体は `@pnpm/exe.<platform>` のネイティブバイナリ（pnpm@12.7.0 の `install.js` / `native-binary.mjs`。LEARNINGS.md）。

## Docker / Postgres（Issue #51 / #57）
- 前提: `docker` CLI 29.3.1、`/usr/bin/dockerd`、`containerd`、Compose プラグイン v5.1.1（`/usr/libexec/docker/cli-plugins/docker-compose`）、`psql` があるが、デーモンは起動していない（`docker info` が失敗）。Podman は無い。
- root で `dockerd` を引数なしで起動すると約 1.1 秒で `API listen on /var/run/docker.sock` になった（storage driver は overlayfs）。既定のソケットのままで、以降の Bash の `docker` / `pnpm db:psql` も動く。
- イメージ `mirror.gcr.io/library/postgres:18-alpine`: `docker pull` 単体は約 10.5 秒。デーモン停止・イメージ未取得から、スクリプト全体（Node / pnpm はインストール済み → `pnpm install` → `dockerd` → pull → up で healthy）は 14.7 秒。2 回目（デーモン・コンテナ起動済み）は 2.5 秒。`select version()` は `PostgreSQL 18.6 on x86_64-pc-linux-musl`、ホストの `psql postgresql://app:app@localhost:5432/app` でも接続できた。
- Issue #57: Node / pnpm・デーモン・コンテナが用意済みの VM で、`CI=true CLAUDE_CODE_REMOTE=true` でスクリプトを直接実行すると、`pnpm install` → pull（取得済みの確認）→ up → `pnpm db:migrate`（`migrations applied successfully`）まで 3.4 秒で exit 0。migrate 単体は約 1 秒（表 1 つ）。
- Docker Hub のレート制限（イメージをミラーにした理由）: `postgres:17-alpine` で 1 回目の pull が `429 Too Many Requests` になり Postgres が起動しなかった（スクリプトは warn で exit 0）。直後の再試行では通った。manifest の HEAD で `ratelimit-limit: 100;w=3600`、`ratelimit-remaining: 0`、`docker-ratelimit-source: 160.79.106.139`（クラウドの出口 IP。他の利用者と共有しているかは未確認）。そのため `mirror.gcr.io`（Google が運営する Docker Hub のミラー。匿名で manifest の取得・pull ができた）から取り、pull も再試行する（Issue #51 の判断）。mirror.gcr.io 側のレート制限の有無は未確認。

## 時間の上限の見積もり（フックは 600 秒で打ち切り）
- curl の最悪ケース（nodejs.org の 2 回が上限まで粘って失敗し、レジストリで Node 2 回・pnpm 4 回を取得）: 接続タイムアウトも足す保守的な見積もりで (15 + 60) + (15 + 20) + (15 + 20) + (15 + 60) + (15 + 20) + (15 + 20) + (15 + 20) + (15 + 60) = 400 秒。`--max-time` は接続を含む全体の上限なので、実際は max-time の和の 280 秒が上限。実測はいずれも数秒なので、60 秒かかるなら止まっているとみなす。setup script の約 5 分はキャッシュされるかどうかの目安で、超えても失敗はしない。
- フック全体: Node / pnpm 280 + デーモン待ち 30 + pull 45 × 3 + 再試行の間隔 2 + 4 + up 120 + migrate 15 = 586 秒。残り約 14 秒が `pnpm install`（実測 10 秒）などの分。
  - migrate の 15 秒: 実測は約 1 秒。15 秒かかるなら止まっているとみなす。これ以上は長くしない。
  - 判断: 最初の案の pull 240 秒 × 3 回では Docker の段だけで 30 + 720 + 6 + 120 = 876 秒となり 600 秒を超えるため、再試行の回数（3 回）は変えず pull の上限を 45 秒に下げた。一時的な失敗（429 など）への再試行を残す方が効くと判断した（1 回目の 429 は直後の再試行で通った）。45 秒は実測（初回 pull 10.5 秒）の 4 倍強。
  - `pnpm install` と `docker info` の個々の呼び出しには上限を付けていない（実測で数秒以内）。timeout で打ち切った pull の途中までの取得分が再試行で再利用されるかは未確認。

## 検証状況（2026-09-28 時点）
- 確認済み: スクリプトを `CLAUDE_CODE_REMOTE=true` で直接実行すると、nodejs.org が 403 → レジストリへのフォールバックで `/opt/node-24.21.0/bin/node --version` が v24.21.0、`/opt/node-24.21.0/bin/pnpm --version` が 12.7.0 になり、`CLAUDE_ENV_FILE` に PATH の行が追記され、`pnpm install --frozen-lockfile` まで通った（3.6 秒）。2 回目はインストール済みとして取得をせず 0.06 秒。
- 確認済み（Issue #51）: `dockerd` の起動から Postgres が healthy になるまで通った。
- 未確認: SessionStart フックとして起動したときに、`dockerd` がフックの終了後も動き続けるか（`setsid nohup` で切り離している）。
- 未確認: フックとして成功し、書き出した PATH で以降の Bash の `node --version` / `pnpm --version` が `.tool-versions` どおりになるか。setup script に設定したときの動き。setup script がクローン前に走るか。setup script の実行時に `CLAUDE_CODE_REMOTE` があるか。フックの実行ユーザー。
- 未確認: setup script でイメージを pull しておくと、環境キャッシュに `/var/lib/docker` が含まれて次のセッションの `dockerd` が使えるか（そのため入れていない）。
- 未確認: setup script の内容を変えずに保存し直すだけでキャッシュが再構築されるか（公式の条件は「setup script を変更したとき」）。
