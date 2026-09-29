# Postgres は手元・CI・クラウドのすべてで同じ compose.yaml から起動する

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #51 / PR #53 / `.claude/rules/cloud-session.md` / `compose.yaml` / `.github/workflows/ci.yml`

## 背景
Postgres を導入するにあたり、手元・GitHub Actions・Claude のクラウドで同じ手順で起動したかった（ユーザーの要望「CI、Claude クラウドで動くもの優先」「ライセンスが面倒なら podman でも良い」）。クラウド VM には Docker と Compose が入っているが、デーモンは起動していなかった（2026-09-28 の work-logs「Docker / Compose / Postgres の実行環境を実測（Issue #51）」）。

## 決定
- 3 環境とも `compose.yaml` で起動する。CI も `services:` ではなく同じ Compose を使う。
- クラウドでは SessionStart フックが `dockerd` を起動してから `docker compose up -d --wait` する。
- イメージは Docker Hub の公開ミラー `mirror.gcr.io/library/postgres:18-alpine` から取り、pull を再試行する。

## 理由
- 同じファイルなら、環境ごとの設定のずれが起きない。
- クラウドでは自分で `dockerd` を起動すれば、pull と起動ができた（同日の work-logs）。
- Docker Hub の匿名 pull はレート制限で 429 になった（クラウド VM は共有の IP。同日の work-logs）。

## 採用しなかった案
- CI の `services:`: 環境ごとに定義が分かれる。
- apt で `postgresql` を VM に入れる: 手元・CI と別の手順になる。
- PGlite（WASM の Postgres）: サーバが要らないが、本番と別物になる。
- Docker Hub から直接 pull する: レート制限で失敗した。

## 影響
- 良い点: どの環境でも `pnpm db:up` で同じ Postgres が起動する。
- 悪い点: クラウドのフックが Docker の段の分だけ長くなる。`mirror.gcr.io` 側のレート制限と、手元の Podman での動作は未確認。
- 見直す条件: 記録に無い。
