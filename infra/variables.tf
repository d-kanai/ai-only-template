# 入力。project_id だけが必須で、ほかは既定値のままで Issue #137 の構成になる。
# 値は `terraform apply -var="project_id=..."` か、コミットしない terraform.tfvars（.gitignore 済み）で渡す。

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
