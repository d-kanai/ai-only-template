# infra（GCP: Cloud Run + Cloud SQL の Terraform）

環境ごとの器（API、Artifact Registry、Cloud SQL、Secret Manager、サービスアカウントと IAM、Cloud Run の service / job、GitHub Actions 用の WIF）を作る Terraform。
環境は **stg と prod の 2 つ**で、**GCP のプロジェクトが別**。同じ module（`modules/app`）を、環境ごとのディレクトリ（`envs/stg`・`envs/prod`）から別の `project_id` で呼ぶ。環境の差は変数（`envs/<環境>/variables.tf` の既定値）だけ。
アプリのイメージは GitHub Actions（`.github/workflows/deploy.yml`）が入れ替える（main への push で stg、手動実行で prod）。決定と WHY は ADR `docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md`、日々の操作（デプロイ・ロールバック・migrate の再実行）はスキル `.claude/skills/deploy/SKILL.md`。

```
infra/
  modules/app/   1 環境分のリソースの定義（stg / prod で共通）
  envs/stg/      stg の root module（ここで init / plan / apply する）
  envs/prod/     prod の root module（同上）
```

`modules/app`（リソースの定義）:

| ファイル | 中身 |
| --- | --- |
| `versions.tf` | 使う provider（source だけ。版は `envs/<環境>/versions.tf`） |
| `variables.tf` | module の入力と、環境ごとに変えられる値の WHY（`project_id`・`github_environment` が必須） |
| `main.tf` | 名前（service / job。`name_prefix`）、API の有効化、Artifact Registry と古いイメージの削除 |
| `sql.tf` | Cloud SQL（`app` / `metabase` の 2 DB）、DB ユーザー、接続情報の Secret、接続数の予算 |
| `iam.tf` | 実行用のサービスアカウントと権限、MCP 用の IAM ユーザーの権限 |
| `run.tf` | Cloud Run: `frontend-customer`・migrate ジョブ、公開（allUsers） |
| `metabase.tf` | Cloud Run: `metabase`（Cloud SQL Auth Proxy のサイドカー付き） |
| `github_wif.tf` | Workload Identity Federation（main と GitHub Environment の名前で絞る）とデプロイ用のサービスアカウント |
| `outputs.tf` | GitHub の Environment の Variables に入れる値、URL、接続名 |

`envs/stg`・`envs/prod`（環境。中身の形は同じ）:

| ファイル | 中身 |
| --- | --- |
| `versions.tf` | Terraform・provider の版（完全固定） |
| `backend.tf` | GCS のバックエンド（`prefix` は `infra/stg` / `infra/prod`。バケットは `-backend-config` で渡す） |
| `main.tf` | provider（project / region）と `module "app"`（GitHub Environment の名前をここで固定） |
| `variables.tf` | 環境の入力と既定値（`project_id` だけ必須）。stg と prod の差はここの既定値 |
| `outputs.tf` | module の出力をそのまま出す（`github_variables` など） |
| `terraform.tfvars.example` | 入力の例（`terraform.tfvars` にコピーして使う。`terraform.tfvars` はコミットしない） |
| `.terraform.lock.hcl` | provider のハッシュ（コミットする。linux / darwin の amd64・arm64、windows の amd64。stg と prod で同じ内容） |

stg と prod の既定値の差（`envs/<環境>/variables.tf`）:

| 変数 | stg | prod | 意味（WHY は `modules/app/variables.tf`） |
| --- | --- | --- | --- |
| `sql_backup_retained_count` | 3 | 7 | 日次バックアップの世代数 |
| `sql_tier` | db-f1-micro | db-f1-micro | prod の負荷が増えたら prod だけ上げる |
| `customer_min_instances` | 0 | 0 | prod のコールドスタートを無くすなら 1 |
| `metabase_min_instances` | 0 | 0 | Metabase を常時使うなら 1 |
| `deletion_protection` | true | true | stg の作り直しを試すときだけ false |

## 前提
- Terraform 1.16.4（`envs/<環境>/versions.tf` の `required_version` と一致しないと止まる）と gcloud CLI。
- Billing を紐づけた GCP プロジェクトを **stg 用と prod 用の 2 つ**と、それぞれのオーナー相当の権限（初回の apply は手元から行う）。
- GitHub の Environments（Environment ごとの Variables と required reviewers）。public リポジトリなら使える。private リポジトリでは、GitHub Free だと Environment の Variables・required reviewers が使えない（required reviewers は Free / Pro / Team の private では使えない。https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments 、2026-09-30 確認）。
- 組織配下のプロジェクトで「ドメインで制限された共有」のポリシーがあると、Cloud Run の `allUsers` の invoker を付けられない（`modules/app/run.tf` の注意）。

## 初回の手順
**stg と prod で 1 回ずつ**行う（以下の `<ENV>` は `stg` か `prod`、`<PROJECT_ID>` はその環境のプロジェクト ID）。先に stg を最後まで通し、stg で動きを確かめてから prod を行うとよい。

### 1. 認証とプロジェクト
```sh
gcloud auth login
gcloud auth application-default login          # Terraform が使う資格情報（ADC）
gcloud config set project <PROJECT_ID>
# ADC で Service Usage などの API を呼ぶときの課金先。無いと「requires a quota project」で止まることがある。
gcloud auth application-default set-quota-project <PROJECT_ID>
```
- 環境を切り替えるときは `gcloud config set project` と `set-quota-project` もその環境のプロジェクトにする（以降の手順の gcloud は、今の設定のプロジェクトに対して動く）。

### 2. state 用の GCS バケット（Terraform より先に手で作る）
WHY 手で作る: state の置き場所を同じ state で管理すると、初回に置き場所が無い。
```sh
gcloud storage buckets create gs://<PROJECT_ID>-tfstate --location=asia-northeast1 --uniform-bucket-level-access
# 版を残す（state を壊したときに前の版に戻せる）。
gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
```
- 例は環境ごとのプロジェクトにバケットを作る形（stg の state は stg のプロジェクトに置く）。1 つのバケットに両方を置いてもよい（`envs/<環境>/backend.tf` の `prefix` が `infra/stg` / `infra/prod` で分かれているので、state はぶつからない）。

### 3. init と apply
```sh
cd infra/envs/<ENV>
terraform init -backend-config="bucket=<PROJECT_ID>-tfstate"
terraform apply -var="project_id=<PROJECT_ID>"
```
- 毎回 `-var` を書く代わりに `cp terraform.tfvars.example terraform.tfvars` で作り、`project_id = "<PROJECT_ID>"` を書いてもよい（`.gitignore` で `*.tfvars` を除外済み。コミットしない）。
- 推奨: `-var="github_repository_id=<id>"`（tfvars なら `github_repository_id = <id>`）も渡す。WIF の条件にリポジトリの数値の id が加わる（`modules/app/github_wif.tf`）。WHY: リポジトリ名は、リポジトリを消した後に第三者が同じ名前で作り直せるが、id は再利用されない（google-github-actions/auth の `docs/SECURITY_CONSIDERATIONS.md`）。id の調べ方: `gh api repos/<owner>/<repo> --jq .id`（または https://api.github.com/repos/<owner>/<repo> の `id`）。
- **apply が終わったらすぐに Metabase の管理者を作る**（手順 8 の 1）。WHY: Metabase の service は `allUsers` の invoker で公開している（`modules/app/run.tf`）ので、管理者ができるまでの間は、URL を知る誰でも初回セットアップ（`/setup`）を開いて管理者になれる。
- Cloud SQL の作成には時間がかかる（所要時間は未計測）。
- Cloud Run の service / job は仮のイメージ（`modules/app/variables.tf` の `bootstrap_image`）で作られる。アプリのイメージは手順 5 で入る。

### 4. GitHub の Environment と Variables
```sh
terraform output github_variables
```
GitHub の Settings > Environments で Environment `<ENV>`（`stg` / `prod`。名前は deploy.yml の選択肢と WIF の条件に合わせる）を作り、表示された 5 つ（`GCP_PROJECT_ID` / `GCP_REGION` / `GCP_WIF_PROVIDER` / `GCP_DEPLOYER_SA` / `GCP_AR_REPO`）を、その Environment の **Environment variables**（Secrets ではない）に同じ名前で登録する。
- WHY Environment ごと（Repository variables ではない）: 名前は同じで、値が環境（プロジェクト）ごとに違う。deploy.yml の job が `environment: stg` / `prod` を参照すると、`vars.*` はその Environment の値になる（GitHub の仕様: 同じ名前なら Environment の値が Repository の値より優先される）。
- WHY Variables: どれも秘密ではない（WIF なので鍵は無い）。
- **prod には required reviewers を付けることを推奨**（Environment の Deployment protection rules。GitHub 側の手作業）。付けると、prod へのデプロイは指定した人が承認してから動く。WIF の条件が Environment の名前を見る（`modules/app/github_wif.tf`）ので、prod の Environment を通らない job は prod のプロジェクトに入れない。
- 任意: Environment の Deployment branches and tags で `main` だけに絞ると、main 以外からの実行を GitHub 側でも止められる（deploy.yml の job の `if` と WIF の ref の条件に加えて）。
- Environment に `GCP_WIF_PROVIDER` が無いあいだは、deploy.yml は最初のステップで notice を出し、以降のステップをスキップして緑で終わる（GCP の準備前に赤くしないため）。

### 5. 最初のデプロイ
- stg: main に push する（PR をマージする）か、Actions の「Deploy」を「Run workflow」で `main` と `stg` を選んで手動実行する。
- prod: Actions の「Deploy」を「Run workflow」で `main` と `prod` を選んで手動実行する（main への push では prod に出ない）。required reviewers を付けたら、承認してから動く。

migrate ジョブ → service → トラフィックを最新のリビジョンへ、の順に動く（main 以外のブランチを選んだ手動実行はスキップされる）。
URL は `terraform output customer_url`（その環境のディレクトリで）。

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
4. Data Studio の送信元（142.251.74.0/23）は `modules/app/sql.tf` の authorized networks に入れてある。データ所在地を有効にした Data Studio Pro は範囲が違う（`modules/app/sql.tf` のコメント）。
- 「カスタムクエリ」で SELECT を書ける（1 文だけ、1 クエリ最大 15 万行）。Data Studio の AI 機能（Conversational Analytics）は BigQuery だけが対象で、Cloud SQL には使えない。

### 8. Metabase の接続
1. `terraform output -raw metabase_url` を開く（min instances 0 なので、最初は JVM の起動に 1〜2 分かかる）。管理者アカウントを作る。**apply の直後に行う**（管理者ができるまでは URL を知る誰でも `/setup` で管理者になれる。手順 3 の WHY）。
2. 分析する DB を追加する: PostgreSQL、ホスト `127.0.0.1`、ポート `5432`、データベース `app`、ユーザー `bi_readonly`、SSL は使わない。WHY: 同じインスタンスのサイドカーの Cloud SQL Auth Proxy が 127.0.0.1:5432 で待ち受け、Cloud SQL との間を TLS で暗号化する（`modules/app/metabase.tf`）。
3. Admin > Settings の Site URL を `metabase_url` にする（メールやリンクの URL に使われる）。
4. Claude から使う: Metabase の MCP（`<metabase_url>/api/metabase-mcp`、v0.60 以降、内蔵の OAuth。https://www.metabase.com/docs/latest/ai/mcp ）。未確認: Claude Code からの接続手順と、有効にするための管理画面の設定。
- 常時使うようになったら、その環境のディレクトリで `terraform apply -var="metabase_min_instances=1"`（tfvars なら `metabase_min_instances = 1`。月 約 $19 増える）。

### 9. Cloud SQL の MCP（Claude から SQL を実行する）
2 つの方法がある（どちらを使うかは試して決める）。
- **Cloud SQL のリモート MCP**（`https://sqladmin.googleapis.com/mcp`、読み取りだけなら `/mcp/readonly`）: IAM データベース認証のユーザーだけが SQL を実行できる（https://docs.cloud.google.com/sql/docs/postgres/use-cloudsql-mcp）。
  1. `terraform apply -var='sql_iam_users=["<あなたの Google アカウント>"]'` で、DB ユーザー（CLOUD_IAM_USER）と権限（`roles/mcp.toolUser` ほか。`modules/app/iam.tf`）を作る（その環境のディレクトリで。tfvars なら `sql_iam_users`）。インスタンスは `data_api_access = ALLOW_DATA_API` と `cloudsql.iam_authentication = on` にしてある（`modules/app/sql.tf`）。
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
- 構成（リソース）を変えるときは `modules/app` を変え、**stg → prod の順に**それぞれのディレクトリ（`envs/stg`・`envs/prod`）で `terraform plan` の差分を読んでから `terraform apply` する（module は共通なので、片方だけ apply すると環境の構成がずれたままになる）。Cloud Run のイメージとトラフィックの差分は出ない（`lifecycle.ignore_changes`。WHY は `modules/app/main.tf`）。
- 環境ごとの値（tier・min instances など）は、その環境の `variables.tf` の既定値か `terraform.tfvars` で変える。stg と prod で違う値にしてよいのは変数だけ（リソースの定義は `modules/app` の 1 か所）。新しく環境で変えたい値ができたら、`modules/app/variables.tf` に変数を足し、両方の `envs/<環境>/variables.tf` と `main.tf` から渡す。
- provider の版を上げるときは `envs/stg/versions.tf` と `envs/prod/versions.tf` を変え、それぞれのディレクトリで `terraform init -upgrade -backend=false` → `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64 -platform=windows_amd64` で `.terraform.lock.hcl` を作り直してコミットする（5 日ルール。`envs/<環境>/versions.tf` のコメント）。
- パスワードのローテーションは `modules/app/sql.tf` の `db_password_version` を上げて、環境ごとに apply し、Cloud Run の新しいリビジョンを出す（スキル `deploy`）。WHY 環境ごと: 版は module の中にあり stg / prod で共通なので、上げた後に apply した環境からパスワードが変わる。
- 削除: Cloud SQL・アプリの service・migrate ジョブは削除保護を付けている（`deletion_protection`、既定 true）。消すときは先に `deletion_protection = false` で apply してから destroy する（誤って消さないため）。
