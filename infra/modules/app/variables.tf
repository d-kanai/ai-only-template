# module の入力。project_id と github_environment だけが必須で、ほかは既定値のままで Issue #137 の構成になる。
# 値は呼び出す側（infra/envs/<環境>/main.tf）が渡す。環境ごとの差（stg / prod）はここの変数だけで表す（リソースの定義は共通）。

# GCP のプロジェクト ID（プロジェクト番号ではない）。Billing を紐づけ済みのプロジェクト。
variable "project_id" {
  type        = string
  description = "GCP のプロジェクト ID"
}

# リージョン。Cloud Run・Cloud SQL・Artifact Registry をすべて同じ場所に置く。
# WHY asia-northeast1（東京）: 利用者が日本にいる前提で遅延が小さく、Cloud Run と Cloud SQL を同じリージョンにすると
#   リージョン間の通信（遅延と egress 料金）が無い（Issue #137 の決定）。
variable "region" {
  type        = string
  description = "Cloud Run / Cloud SQL / Artifact Registry のリージョン"
  default     = "asia-northeast1"
}

# このプロジェクトに対応する GitHub Environment の名前（stg / prod）。WIF の条件に使う（github_wif.tf）。
# WHY 必須: 環境ごとに必ず違う値で、既定値を置くと prod の WIF が stg の Environment の job を受け付けるような取り違えが起きる。
variable "github_environment" {
  type        = string
  description = "このプロジェクトにデプロイする GitHub Environment の名前（deploy.yml の job の environment）"

  validation {
    condition     = contains(["stg", "prod"], var.github_environment)
    error_message = "github_environment は stg か prod（deploy.yml の workflow_dispatch の選択肢と同じ）。"
  }
}

# Cloud Run のアプリの service・migrate ジョブ・実行用のサービスアカウントの名前のもと（main.tf / iam.tf）。
# WHY 変数にする: テンプレートから別のアプリを作るときに名前を変えられるようにする。変えるときは .github/workflows/deploy.yml の
#   SERVICE / MIGRATE_JOB / イメージ名も同じにする。
# 形: サービスアカウントの account_id（run-<name_prefix>）が 6〜30 文字の英小文字・数字・ハイフンなので、それに収まる形に限る。
variable "name_prefix" {
  type        = string
  description = "Cloud Run の service / job とサービスアカウントの名前のもと"
  default     = "frontend-customer"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix は英小文字で始まり、英小文字・数字・ハイフンの 3〜26 文字（末尾はハイフン以外）。"
  }
}

# GitHub Actions からのデプロイを許すリポジトリ（owner/name）。Workload Identity Federation の条件に使う。
variable "github_repository" {
  type        = string
  description = "デプロイを許す GitHub のリポジトリ（owner/name）"
  default     = "d-kanai/ai-only-template"
}

# 上のリポジトリの数値の repository id（任意）。設定すると、WIF の条件でリポジトリ名に加えて id の一致も求める（github_wif.tf）。
# WHY: リポジトリ名は、リポジトリを消した後に第三者が同じ名前で作り直せる。id は GitHub が一意で再利用しないと保証している
#   （google-github-actions/auth の docs/SECURITY_CONSIDERATIONS.md）。
# WHY 既定 null（任意）: テンプレートから作ったリポジトリでは id が違い、既定値を置けない。調べ方は infra/README.md の手順 3。
# number: 数値だけを受け付け、名前などの取り違えを plan の前に止める。
variable "github_repository_id" {
  type        = number
  description = "デプロイを許す GitHub のリポジトリの数値の id（任意。gh api repos/<owner>/<name> --jq .id）"
  default     = null
}

# Cloud Run の service / job を初めて作るときだけ使うイメージ。
# WHY 仮のイメージで作る: アプリのイメージは GitHub Actions が Artifact Registry に push して `gcloud run deploy` で入れ替える
#   （Terraform は器だけ。lifecycle.ignore_changes でイメージの差分を無視する）。初回の apply の時点ではまだアプリのイメージが無いので、
#   Google の公開サンプル（8080 で待ち受ける hello）で作っておく。
variable "bootstrap_image" {
  type        = string
  description = "Cloud Run の service / job を初めて作るときの仮のイメージ"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# Metabase の最小インスタンス数（0 か 1）。
# WHY 既定 0: 使わないときは課金されない（試用の段階）。代わりに、最初のアクセスで JVM の起動（1〜2 分）を待つ。
#   常時使うようになったら 1 にする（常時起動の目安は #129 のコメントの料金比較で月 約 $19）。
variable "metabase_min_instances" {
  type        = number
  description = "Metabase の Cloud Run の最小インスタンス数（0 か 1）"
  default     = 0

  validation {
    condition     = contains([0, 1], var.metabase_min_instances)
    error_message = "metabase_min_instances は 0 か 1。"
  }
}

# Cloud SQL に IAM データベース認証でログインする Google アカウント（メールアドレス）の一覧。
# WHY: Cloud SQL のリモート MCP（https://sqladmin.googleapis.com/mcp）の execute_sql / execute_sql_readonly は、
#   IAM データベース認証のユーザーでしか SQL を実行できない（https://docs.cloud.google.com/sql/docs/postgres/use-cloudsql-mcp）。
#   ここに書いたアカウントに DB ユーザー（CLOUD_IAM_USER）と MCP の呼び出しに要るロールを付ける。DB 内の権限（SELECT など）は
#   Terraform では付けられないので psql で GRANT する（infra/README.md）。
variable "sql_iam_users" {
  type        = list(string)
  description = "Cloud SQL に IAM 認証でログインし、Cloud SQL の MCP を使う Google アカウントのメールアドレス"
  default     = []
}

# Cloud SQL のマシンの種類（sql.tf）。
# WHY 既定 db-f1-micro（stg / prod とも）: 試用の段階で最も安い。prod の負荷が増えたら prod だけ上げられるように変数にする。
#   tier で max_connections が変わるので、上げ下げのときは sql.tf の「接続数の予算」を見直す。
variable "sql_tier" {
  type        = string
  description = "Cloud SQL の tier（例: db-f1-micro、db-g1-small）"
  default     = "db-f1-micro"
}

# 日次バックアップを残す世代数（sql.tf の backup_configuration）。
# WHY 変数にする: 保存量に課金されるので、戻す必要の少ない stg では減らせるようにする（envs/stg の既定は prod より少ない）。
variable "sql_backup_retained_count" {
  type        = number
  description = "Cloud SQL の日次バックアップを残す世代数（1〜365）"
  default     = 7

  validation {
    condition     = var.sql_backup_retained_count >= 1 && var.sql_backup_retained_count <= 365
    error_message = "sql_backup_retained_count は 1〜365。"
  }
}

# アプリの Cloud Run の最小インスタンス数（run.tf）。
# WHY 既定 0: アクセスが無いときは課金されない。prod でコールドスタートを無くしたいときは 1 にする（常時 1 インスタンス分の課金）。
# WHY 上限 3: max_instance_count（3。sql.tf の接続数の予算）を超えられない。
variable "customer_min_instances" {
  type        = number
  description = "アプリの Cloud Run の最小インスタンス数（0〜3）"
  default     = 0

  validation {
    condition     = var.customer_min_instances >= 0 && var.customer_min_instances <= 3
    error_message = "customer_min_instances は 0〜3（max_instance_count が 3）。"
  }
}

# Cloud SQL・アプリの service・migrate ジョブの削除保護（sql.tf / run.tf）。
# WHY 既定 true: データと URL を誤って消さない。stg で作り直しを試すときだけ false にする（false で apply してから destroy）。
variable "deletion_protection" {
  type        = bool
  description = "Cloud SQL（Terraform と GCP の両方）・アプリの service・migrate ジョブの削除保護"
  default     = true
}
