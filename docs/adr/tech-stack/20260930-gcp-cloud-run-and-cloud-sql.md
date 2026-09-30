# 本番は GCP の Cloud Run + Cloud SQL にし、Terraform は器だけを、イメージの入れ替えは GitHub Actions の gcloud を受け持つ

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #137 / #104 / #129 / #130 / `infra/modules/app` / `infra/envs/stg` / `infra/envs/prod` / `.github/workflows/deploy.yml` / `.claude/skills/deploy/SKILL.md`

## 背景
デプロイ先が無かった（#104）。最初に Cloudflare Workers + Supabase + Metabase の構成（#129）を検討し、Next 16 を Workers に載せる実測（#130）をしたところ、リクエストごとの DB クライアント、`process.exit` で以降のリクエストが止まる、Node の middleware が experimental、`.env` の Worker への同梱などの制約があった（2026-09-29 の work-logs）。料金を比べると、GCP の Cloud Run + Cloud SQL（db-f1-micro）のほうが安く（#129 のコメント）、ユーザーが GCP に決めた。BI は Data Studio（旧 Looker Studio）と Metabase の両方を試すことにした（2026-09-29 の work-logs）。環境は stg と prod の 2 つを前提に、Terraform を module にする（2026-09-30 のユーザー判断）。

## 決定
- アプリ（`apps/frontend_customer` の Next standalone）は Cloud Run の service、DB は Cloud SQL for PostgreSQL 18（ENTERPRISE / db-f1-micro / ZONAL / 10GB SSD / バックアップ 7 世代（stg は既定 3）/ `ssl_mode = ENCRYPTED_ONLY`）。リージョンは `asia-northeast1`。
- Cloud Run から Cloud SQL へは、Cloud Run 組み込みの Unix ソケット（`/cloudsql/<接続名>`）で接続する。`DATABASE_URL` は URL 全体を Secret Manager に置く。
- 環境は stg と prod の 2 つで、**GCP のプロジェクトを分ける**。Terraform は 1 環境分のリソースを `infra/modules/app` に置き、`infra/envs/stg`・`infra/envs/prod` から同じ module を別の `project_id` で呼ぶ。環境の差は変数（Cloud SQL の tier・バックアップの世代数・アプリと Metabase の min instances・削除保護）だけ。state は環境ごとに GCS の prefix（`infra/stg` / `infra/prod`）を分ける。
- デプロイは、main への push で **stg に自動**、prod は `workflow_dispatch` で環境を選んだ **手動**だけ。GitHub Environments（`stg` / `prod`）を使い、Variables（`GCP_PROJECT_ID` など）は Environment ごとに持つ。prod の Environment には required reviewers を付けられる（GitHub 側の設定）。
- WIF は環境（プロジェクト）ごとに作り、条件でリポジトリ・ref（`refs/heads/main`）・GitHub Environment の名前を絞る。
- Terraform（`infra/modules/app`）は「器」（API、Artifact Registry、Cloud SQL、Secret、サービスアカウントと IAM、Cloud Run の service / job、WIF）だけを持つ。アプリのイメージとトラフィックは GitHub Actions の gcloud が入れ替え、Terraform は `lifecycle.ignore_changes` で無視する。
- マイグレーションは Cloud Run の job（Dockerfile の migrate ステージ）で、各環境へのデプロイのたびに service の前に実行する。
- BI は Data Studio（公開 IP + authorized networks + 読み取り専用ユーザー）と Metabase（Cloud Run の別 service、Cloud SQL Auth Proxy のサイドカー、min instances は既定 0）の両方を用意し、使い勝手を見て後で 1 つにする。
- Claude からの SQL の実行は Cloud SQL のリモート MCP（IAM データベース認証のユーザー、`data_api_access = ALLOW_DATA_API`）か MCP Toolbox for Databases を使う。

## 理由
- Cloud Run は標準の Node で動くので、#130 で実測した Workers の制約が無く、コードを変えずに載る（2026-09-30 の work-logs で standalone のイメージが起動し `/` と `/api/todos` が 200）。
- 料金は Cloud Run + Cloud SQL db-f1-micro が月 約 $32（10 万 req、Metabase を常時起動した場合）で、Cloudflare の構成（$38〜76）より安い（#129 のコメント、2026-09-29 の work-logs）。
- Unix ソケットの接続は pg と drizzle-kit がそのまま使え、コードの変更も VPC も要らない（2026-09-30 の work-logs で接続を模擬して確認）。
- イメージを Terraform に持たせると、デプロイのたびに Terraform の変数を変えて apply する必要があり、apply すると Actions が入れたイメージを古い値に戻す。器とイメージを分けると、Terraform の apply は構成を変えるときだけになる。
- Data Studio は無料だが、AI（Conversational Analytics）は BigQuery だけが対象で、レポートを作る API も MCP も無い。Metabase は公式 MCP で Claude が質問とダッシュボードを作れる（2026-09-29 の work-logs）。どちらが使いやすいかは使ってみないと分からない。
- stg と prod のプロジェクトを分けると、IAM・API の有効化・課金・Quota が環境ごとに独立し、stg の deployer や操作ミスが prod に届かない。リソースの名前に環境名を入れなくてもぶつからず、デプロイとスキルの gcloud のコマンドが環境によらず同じになる。同じ module を使うので、stg で確かめた構成がそのまま prod になる（差は変数だけで、envs の `variables.tf` を見比べれば分かる）。
- prod を手動にすると、stg で動きを確かめてから人が出すタイミングを決められる。Environment の required reviewers で承認を挟める。WIF の条件で Environment の名前を見るので、prod の Environment を通らない job（承認を受けていない job）は prod のプロジェクトに入れない（Variables は秘密ではなく、値を知るだけでは防げないため）。
- Metabase（Java）は Unix ソケットに接続できない（https://cloud.google.com/sql/docs/postgres/connect-run 「Unix sockets are not natively supported in Java」）ので、Metabase だけ Auth Proxy のサイドカーにした。

## 採用しなかった案
- Cloudflare Workers + Supabase（#129 / #130）: Workers の制約（背景）と、Supabase Pro（$25/月）で GCP より高い。
- Vercel: Vercel 自身の Postgres が無く（2024-12 に Neon へ移行。2026-09-28 の work-logs）、DB を別の事業者に置くことになる。GCP に決めたので比較を深めていない。
- 1 つのプロジェクトに stg / prod を置き、リソース名の suffix（`-stg` / `-prod`）で分ける: IAM・Quota・課金・API が環境で共有され、stg の deployer に prod を触らせない権限の分け方がリソース単位になって複雑になる。Cloud SQL の `roles/cloudsql.client` はプロジェクト単位でしか付けられない（`infra/modules/app/iam.tf`）ので、stg のアプリが prod の DB に接続する権限も持ってしまう。
- prod も main への push で自動デプロイする: stg で確かめる前に prod に出る。stg を置く意味が薄れる。
- Terraform でイメージまで管理する: 上の理由（apply が Actions のデプロイを戻す・デプロイのたびに apply が要る）。
- PR ごとの preview 環境（専用サービス + DB）: ユーザー判断で不要。必要になったら別 Issue。
- Cloud SQL Connector（ライブラリ）: アプリのコードと依存が増える。組み込みのソケットで足りる。
- Private IP（VPC）: VPC コネクタ / Direct VPC egress の設定と費用が増え、Data Studio の Private IP 接続は「段階的に展開中」。
- 読み取り専用ユーザーを Terraform で作る: `google_sql_user` のユーザーは cloudsqlsuperuser のメンバーになり、読み取り専用にできない。

## 影響
- 費用の目安（1 環境あたり。stg と prod で約 2 倍）: Cloud SQL db-f1-micro 月 約 $12、アプリの実行は無料枠でほぼ $0、Metabase は min 0 なら使った分だけ（min 1 で +約 $19）。db-f1-micro は SLA の対象外。
- 初回の手順（プロジェクト・state のバケット・apply・GitHub の Environment と Variables・Metabase の管理者・読み取り専用ユーザー）は環境ごとに 2 回行う（`infra/README.md`）。
- `modules/app` を変えたら stg → prod の順に両方で apply する（片方だけだと環境の構成がずれる）。provider の版の固定と `.terraform.lock.hcl` も環境ごとに 2 か所。
- db-f1-micro の max_connections は 25（環境ごと）。アプリ 3 インスタンス x 3、migrate 1、Metabase 6（アプリ DB 3 + 分析 3）で、Data Studio・psql・MCP には約 6 本しか残らない（スーパーユーザー用の予約 3 を除く）（配分は `infra/modules/app/sql.tf`）。足りなくなったら tier を上げる。
- `.env` はイメージに入れない（`next build` が要求するので build ステージの中だけで作って消す）。stg / prod の値はすべて Cloud Run の環境変数と Secret から入る。
- 読み取り専用ユーザー（Data Studio・Metabase の分析用）と、MCP 用の IAM ユーザーへの GRANT は psql の手作業（`infra/README.md`）。
- Data Studio の AI 機能は Cloud SQL には効かない（人が SQL を貼って見る用途）。
- 見直す条件: 接続数や性能が db-f1-micro で足りない、BI を 1 つに決めた。
