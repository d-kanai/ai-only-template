# 本番は GCP の Cloud Run + Cloud SQL にし、Terraform は器だけを、イメージの入れ替えは GitHub Actions の gcloud を受け持つ

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #137 / #104 / #129 / #130 / `infra/` / `.github/workflows/deploy.yml` / `.claude/skills/deploy/SKILL.md`

## 背景
デプロイ先が無かった（#104）。最初に Cloudflare Workers + Supabase + Metabase の構成（#129）を検討し、Next 16 を Workers に載せる実測（#130）をしたところ、リクエストごとの DB クライアント、`process.exit` で以降のリクエストが止まる、Node の middleware が experimental、`.env` の Worker への同梱などの制約があった（2026-09-29 の work-logs）。料金を比べると、GCP の Cloud Run + Cloud SQL（db-f1-micro）のほうが安く（#129 のコメント）、ユーザーが GCP に決めた。BI は Data Studio（旧 Looker Studio）と Metabase の両方を試すことにした（2026-09-29 の work-logs）。

## 決定
- アプリ（`apps/frontend_customer` の Next standalone）は Cloud Run の service、DB は Cloud SQL for PostgreSQL 18（ENTERPRISE / db-f1-micro / ZONAL / 10GB SSD / バックアップ 7 世代 / `ssl_mode = ENCRYPTED_ONLY`）。リージョンは `asia-northeast1`。
- Cloud Run から Cloud SQL へは、Cloud Run 組み込みの Unix ソケット（`/cloudsql/<接続名>`）で接続する。`DATABASE_URL` は URL 全体を Secret Manager に置く。
- Terraform（`infra/`）は「器」（API、Artifact Registry、Cloud SQL、Secret、サービスアカウントと IAM、Cloud Run の service / job、WIF）だけを持つ。アプリのイメージとトラフィックは GitHub Actions の gcloud が入れ替え、Terraform は `lifecycle.ignore_changes` で無視する。
- マイグレーションは Cloud Run の job（Dockerfile の migrate ステージ）で、main のデプロイのたびに service の前に実行する。
- BI は Data Studio（公開 IP + authorized networks + 読み取り専用ユーザー）と Metabase（Cloud Run の別 service、Cloud SQL Auth Proxy のサイドカー、min instances は既定 0）の両方を用意し、使い勝手を見て後で 1 つにする。
- Claude からの SQL の実行は Cloud SQL のリモート MCP（IAM データベース認証のユーザー、`data_api_access = ALLOW_DATA_API`）か MCP Toolbox for Databases を使う。

## 理由
- Cloud Run は標準の Node で動くので、#130 で実測した Workers の制約が無く、コードを変えずに載る（2026-09-30 の work-logs で standalone のイメージが起動し `/` と `/api/todos` が 200）。
- 料金は Cloud Run + Cloud SQL db-f1-micro が月 約 $32（10 万 req、Metabase を常時起動した場合）で、Cloudflare の構成（$38〜76）より安い（#129 のコメント、2026-09-29 の work-logs）。
- Unix ソケットの接続は pg と drizzle-kit がそのまま使え、コードの変更も VPC も要らない（2026-09-30 の work-logs で接続を模擬して確認）。
- イメージを Terraform に持たせると、デプロイのたびに Terraform の変数を変えて apply する必要があり、apply すると Actions が入れたイメージを古い値に戻す。器とイメージを分けると、Terraform の apply は構成を変えるときだけになる。
- Data Studio は無料だが、AI（Conversational Analytics）は BigQuery だけが対象で、レポートを作る API も MCP も無い。Metabase は公式 MCP で Claude が質問とダッシュボードを作れる（2026-09-29 の work-logs）。どちらが使いやすいかは使ってみないと分からない。
- Metabase（Java）は Unix ソケットに接続できない（https://cloud.google.com/sql/docs/postgres/connect-run 「Unix sockets are not natively supported in Java」）ので、Metabase だけ Auth Proxy のサイドカーにした。

## 採用しなかった案
- Cloudflare Workers + Supabase（#129 / #130）: Workers の制約（背景）と、Supabase Pro（$25/月）で GCP より高い。
- Vercel: Vercel 自身の Postgres が無く（2024-12 に Neon へ移行。2026-09-28 の work-logs）、DB を別の事業者に置くことになる。GCP に決めたので比較を深めていない。
- Terraform でイメージまで管理する: 上の理由（apply が Actions のデプロイを戻す・デプロイのたびに apply が要る）。
- PR ごとの preview 環境（専用サービス + DB）: ユーザー判断で不要。必要になったら別 Issue。
- Cloud SQL Connector（ライブラリ）: アプリのコードと依存が増える。組み込みのソケットで足りる。
- Private IP（VPC）: VPC コネクタ / Direct VPC egress の設定と費用が増え、Data Studio の Private IP 接続は「段階的に展開中」。
- 読み取り専用ユーザーを Terraform で作る: `google_sql_user` のユーザーは cloudsqlsuperuser のメンバーになり、読み取り専用にできない。

## 影響
- 費用の目安: Cloud SQL db-f1-micro 月 約 $12、アプリの実行は無料枠でほぼ $0、Metabase は min 0 なら使った分だけ（min 1 で +約 $19）。db-f1-micro は SLA の対象外。
- db-f1-micro の max_connections は 25。本番 3 インスタンス x 3、migrate 1、Metabase 6（アプリ DB 3 + 分析 3）で、Data Studio・psql・MCP には約 6 本しか残らない（スーパーユーザー用の予約 3 を除く）（配分は `infra/sql.tf`）。足りなくなったら tier を上げる。
- `.env` はイメージに入れない（`next build` が要求するので build ステージの中だけで作って消す）。本番の値はすべて Cloud Run の環境変数と Secret から入る。
- 読み取り専用ユーザー（Data Studio・Metabase の分析用）と、MCP 用の IAM ユーザーへの GRANT は psql の手作業（`infra/README.md`）。
- Data Studio の AI 機能は Cloud SQL には効かない（人が SQL を貼って見る用途）。
- 見直す条件: 接続数や性能が db-f1-micro で足りない、BI を 1 つに決めた。
