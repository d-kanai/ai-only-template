# infra（GCP: Cloud Run + Cloud SQL の Terraform）

本番の器（API、Artifact Registry、Cloud SQL、Secret Manager、サービスアカウントと IAM、Cloud Run の service / job、GitHub Actions 用の WIF）を作る Terraform。
アプリのイメージは GitHub Actions（`.github/workflows/deploy.yml`・`preview.yml`）が入れ替える。決定と WHY は ADR `docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md`、日々の操作（デプロイ・ロールバック・migrate の再実行）はスキル `.claude/skills/deploy/SKILL.md`。

| ファイル | 中身 |
| --- | --- |
| `versions.tf` | Terraform・provider の版（完全固定）、GCS のバックエンド |
| `variables.tf` | 入力（`project_id` だけ必須） |
| `main.tf` | 名前（service / job）、API の有効化、Artifact Registry と古いイメージの削除 |
| `sql.tf` | Cloud SQL（`app` / `app_preview` / `metabase` の 3 DB）、DB ユーザー、接続情報の Secret、接続数の予算 |
| `iam.tf` | 実行用のサービスアカウントと権限、MCP 用の IAM ユーザーの権限 |
| `run.tf` | Cloud Run: `frontend-customer`・`frontend-customer-preview`・migrate ジョブ 2 つ、公開（allUsers） |
| `metabase.tf` | Cloud Run: `metabase`（Cloud SQL Auth Proxy のサイドカー付き） |
| `github_wif.tf` | Workload Identity Federation とデプロイ用のサービスアカウント |
| `outputs.tf` | GitHub の Variables に入れる値、URL、接続名 |
| `.terraform.lock.hcl` | provider のハッシュ（コミットする。linux / darwin の amd64・arm64、windows の amd64） |

## 前提
- Terraform 1.16.4（`versions.tf` の `required_version` と一致しないと止まる）と gcloud CLI。
- Billing を紐づけた GCP プロジェクトと、そのプロジェクトのオーナー相当の権限（初回の apply は手元から行う）。
- 組織配下のプロジェクトで「ドメインで制限された共有」のポリシーがあると、Cloud Run の `allUsers` の invoker を付けられない（`run.tf` の注意）。

## 初回の手順

### 1. 認証とプロジェクト
```sh
gcloud auth login
gcloud auth application-default login          # Terraform が使う資格情報（ADC）
gcloud config set project <PROJECT_ID>
# ADC で Service Usage などの API を呼ぶときの課金先。無いと「requires a quota project」で止まることがある。
gcloud auth application-default set-quota-project <PROJECT_ID>
```

### 2. state 用の GCS バケット（Terraform より先に手で作る）
WHY 手で作る: state の置き場所を同じ state で管理すると、初回に置き場所が無い。
```sh
gcloud storage buckets create gs://<PROJECT_ID>-tfstate --location=asia-northeast1 --uniform-bucket-level-access
# 版を残す（state を壊したときに前の版に戻せる）。
gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
```

### 3. init と apply
```sh
cd infra
terraform init -backend-config="bucket=<PROJECT_ID>-tfstate"
terraform apply -var="project_id=<PROJECT_ID>"
```
- 毎回 `-var` を書く代わりに `infra/terraform.tfvars` に `project_id = "<PROJECT_ID>"` と書いてもよい（`.gitignore` で `*.tfvars` を除外済み。コミットしない）。
- Cloud SQL の作成には時間がかかる（所要時間は未計測）。
- Cloud Run の service / job は仮のイメージ（`variables.tf` の `bootstrap_image`）で作られる。アプリのイメージは手順 5 で入る。

### 4. GitHub の Variables
```sh
terraform output github_variables
```
表示された 5 つ（`GCP_PROJECT_ID` / `GCP_REGION` / `GCP_WIF_PROVIDER` / `GCP_DEPLOYER_SA` / `GCP_AR_REPO`）を、GitHub の Settings > Secrets and variables > Actions > **Variables**（Secrets ではない）に同じ名前で登録する。
- WHY Variables: どれも秘密ではない（WIF なので鍵は無い）。
- `GCP_WIF_PROVIDER` が無いあいだは、deploy.yml / preview.yml のジョブはスキップされる（GCP の準備前に赤くしないため）。

### 5. 最初のデプロイ
main に push する（PR をマージする）か、Actions の「Deploy」を「Run workflow」で手動実行する。migrate ジョブ → 本番の service → preview の DB の migrate の順に動く。
URL は `terraform output customer_url`。

### 6. 読み取り専用ユーザー（Data Studio・Metabase の分析用。psql で手作業）
WHY Terraform で作らない: `google_sql_user` で作ったユーザーは cloudsqlsuperuser のメンバーになり、読み取り専用にできない。

手元から Cloud SQL Auth Proxy で接続する（公開 IP に IP を許可しなくてよく、TLS と IAM で守られる）。Proxy は https://cloud.google.com/sql/docs/postgres/sql-proxy の手順で入れる（Metabase のサイドカーと同じ 2.25.4 を推奨）。
```sh
cloud-sql-proxy --port 5433 "$(terraform output -raw instance_connection_name)" &
# app ユーザーのパスワードは Secret（database-url）の URL の中にある。
export PGPASSWORD="$(gcloud secrets versions access latest --secret=database-url | sed -E 's#^postgresql://[^:]+:([^@]+)@.*#\1#')"
psql "host=127.0.0.1 port=5433 dbname=app user=app"
```
```sql
-- パスワードは手元で作り（例: openssl rand -base64 24）、パスワードマネージャーなどリポジトリの外に保管する。
CREATE ROLE bi_readonly LOGIN PASSWORD '<パスワード>';
-- 書き込みの SQL を誤って流しても拒否されるようにする（GRANT で書き込み権限を渡さないことと二重にする）。
ALTER ROLE bi_readonly SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE app TO bi_readonly;
GRANT USAGE ON SCHEMA public TO bi_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bi_readonly;
-- これから migrate（app ユーザー）が作る表も読めるようにする。
ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT ON TABLES TO bi_readonly;
```

### 7. Data Studio（旧 Looker Studio）の接続
1. Data Studio でデータソースを追加し、PostgreSQL コネクタを選ぶ（https://docs.cloud.google.com/looker/docs/studio/connect-to-postgresql）。
2. ホスト: `terraform output -raw sql_public_ip`、ポート: 5432、データベース: `app`、ユーザー: `bi_readonly`。
3. 「SSL を有効にする」を選び、サーバーの CA 証明書を渡す。取り出し方の例: `gcloud sql ssl server-ca-certs list --instance=app-db --format="value(cert)" > server-ca.pem`（未確認: 実際にこの証明書で接続できるか。インスタンスは `ssl_mode = ENCRYPTED_ONLY` なので、暗号化しない接続は拒否される）。
4. Data Studio の送信元（142.251.74.0/23）は `sql.tf` の authorized networks に入れてある。データ所在地を有効にした Data Studio Pro は範囲が違う（`sql.tf` のコメント）。
- 「カスタムクエリ」で SELECT を書ける（1 文だけ、1 クエリ最大 15 万行）。Data Studio の AI 機能（Conversational Analytics）は BigQuery だけが対象で、Cloud SQL には使えない。

### 8. Metabase の接続
1. `terraform output -raw metabase_url` を開く（min instances 0 なので、最初は JVM の起動に 1〜2 分かかる）。管理者アカウントを作る。
2. 分析する DB を追加する: PostgreSQL、ホスト `127.0.0.1`、ポート `5432`、データベース `app`、ユーザー `bi_readonly`、SSL は使わない。WHY: 同じインスタンスのサイドカーの Cloud SQL Auth Proxy が 127.0.0.1:5432 で待ち受け、Cloud SQL との間を TLS で暗号化する（`metabase.tf`）。
3. Admin > Settings の Site URL を `metabase_url` にする（メールやリンクの URL に使われる）。
4. Claude から使う: Metabase の MCP（`<metabase_url>/api/metabase-mcp`、v0.60 以降、内蔵の OAuth。https://www.metabase.com/docs/latest/ai/mcp ）。未確認: Claude Code からの接続手順と、有効にするための管理画面の設定。
- 常時使うようになったら `terraform apply -var="metabase_min_instances=1"`（月 約 $19 増える）。

### 9. Cloud SQL の MCP（Claude から SQL を実行する）
2 つの方法がある（どちらを使うかは試して決める）。
- **Cloud SQL のリモート MCP**（`https://sqladmin.googleapis.com/mcp`、読み取りだけなら `/mcp/readonly`）: IAM データベース認証のユーザーだけが SQL を実行できる（https://docs.cloud.google.com/sql/docs/postgres/use-cloudsql-mcp）。
  1. `terraform apply -var='sql_iam_users=["<あなたの Google アカウント>"]'` で、DB ユーザー（CLOUD_IAM_USER）と権限（`roles/mcp.toolUser` ほか。`iam.tf`）を作る。インスタンスは `data_api_access = ALLOW_DATA_API` と `cloudsql.iam_authentication = on` にしてある（`sql.tf`）。
  2. 手順 6 と同じく app ユーザーで psql に入り、`GRANT bi_readonly TO "<あなたの Google アカウント>";`（読み取りの権限を渡す）。
  3. Claude の設定: Claude.ai はカスタムコネクタに URL と OAuth クライアント（Google Auth Platform で作る）を登録する（上の URL の「Claude.ai」）。未確認: Claude Code からの接続手順。
- **MCP Toolbox for Databases**（手元で stdio の MCP サーバーを動かす。https://github.com/googleapis/genai-toolbox）: 手元の ADC で Cloud SQL に接続する。
  ```json
  {
    "mcpServers": {
      "cloud-sql-app": {
        "command": "npx",
        "args": ["-y", "@toolbox-sdk/server@1.12.0", "--prebuilt=cloud-sql-postgres", "--stdio"],
        "env": {
          "CLOUD_SQL_POSTGRES_PROJECT": "<PROJECT_ID>",
          "CLOUD_SQL_POSTGRES_REGION": "asia-northeast1",
          "CLOUD_SQL_POSTGRES_INSTANCE": "app-db",
          "CLOUD_SQL_POSTGRES_DATABASE": "app",
          "CLOUD_SQL_POSTGRES_USER": "bi_readonly",
          "CLOUD_SQL_POSTGRES_PASSWORD": "<bi_readonly のパスワード>",
          "CLOUD_SQL_POSTGRES_READONLY": "true"
        }
      }
    }
  }
  ```
  - 版の WHY: 1.12.0 は 2026-09-17 公開で、公開から 5 日以上たった最新（1.13.x は 2026-09-25 公開。確認は 2026-09-30、npm レジストリ）。環境変数の名前は genai-toolbox の `internal/prebuiltconfigs/tools/cloud-sql-postgres.yaml`。
  - パスワードを書いた設定ファイルはコミットしない。未確認: 実際の接続。

## 変更するとき
- `terraform plan` で差分を読んでから `terraform apply`。Cloud Run のイメージとトラフィックの差分は出ない（`lifecycle.ignore_changes`。WHY は `main.tf`）。
- provider の版を上げるときは `versions.tf` を変えて `terraform init -upgrade` → `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64 -platform=windows_amd64` で `.terraform.lock.hcl` を作り直してコミットする（5 日ルール。`versions.tf` のコメント）。
- パスワードのローテーションは `sql.tf` の `db_password_version` を上げて apply し、Cloud Run の新しいリビジョンを出す（スキル `deploy`）。
- 削除: Cloud SQL・本番の service・migrate ジョブは削除保護を付けている。消すときは先に保護を外す apply が要る（誤って消さないため）。
