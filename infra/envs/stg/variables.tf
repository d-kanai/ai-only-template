# stg 環境の入力。project_id だけが必須。
# 値は `terraform apply -var="project_id=..."` か、コミットしない terraform.tfvars（.gitignore 済み。terraform.tfvars.example を
#   コピーして作る）で渡す。
# 各変数の意味と WHY は infra/modules/app/variables.tf（ここでは stg の既定値と、その WHY だけを書く）。
# WHY stg / prod で変数をそろえる: どちらの環境でも同じ変数で同じ調整ができ、既定値の違いが環境の差そのものになる。

# stg の GCP プロジェクト ID（プロジェクト番号ではない）。stg と prod は別のプロジェクト（ADR の決定）。
variable "project_id" {
  type        = string
  description = "stg の GCP のプロジェクト ID"
}

variable "region" {
  type        = string
  description = "Cloud Run / Cloud SQL / Artifact Registry のリージョン"
  default     = "asia-northeast1"
}

variable "github_repository" {
  type        = string
  description = "デプロイを許す GitHub のリポジトリ（owner/name）"
  default     = "d-kanai/ai-only-template"
}

variable "github_repository_id" {
  type        = number
  description = "デプロイを許す GitHub のリポジトリの数値の id（任意。gh api repos/<owner>/<name> --jq .id）"
  default     = null
}

variable "sql_iam_users" {
  type        = list(string)
  description = "Cloud SQL に IAM 認証でログインし、Cloud SQL の MCP を使う Google アカウントのメールアドレス"
  default     = []
}

# 既定 db-f1-micro（stg / prod とも）。prod の負荷が増えたら prod だけ上げる。
variable "sql_tier" {
  type        = string
  description = "Cloud SQL の tier（例: db-f1-micro、db-g1-small）"
  default     = "db-f1-micro"
}

# stg の既定 3: stg のデータは戻す必要が少なく、保存量の課金を減らす（prod は 7）。
variable "sql_backup_retained_count" {
  type        = number
  description = "Cloud SQL の日次バックアップを残す世代数（1〜365）"
  default     = 3
}

# 既定 0（stg / prod とも）。prod でコールドスタートを無くしたいときは 1。
variable "customer_min_instances" {
  type        = number
  description = "アプリの Cloud Run の最小インスタンス数（0〜3）"
  default     = 0
}

variable "metabase_min_instances" {
  type        = number
  description = "Metabase の Cloud Run の最小インスタンス数（0 か 1）"
  default     = 0
}

# 既定 true（stg / prod とも）。stg で作り直しを試すときだけ false にする。
variable "deletion_protection" {
  type        = bool
  description = "Cloud SQL・アプリの service・migrate ジョブの削除保護"
  default     = true
}
