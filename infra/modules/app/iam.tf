# 実行用のサービスアカウント（Cloud Run の service / job が動くときの ID）と、その権限。
# デプロイ用（GitHub Actions）のサービスアカウントと WIF は github_wif.tf。
# WHY service ごとに分ける: 読める Secret を必要なものだけにする（Metabase にアプリの DB のパスワードを読ませない、
#   アプリに Metabase の DB のパスワードと暗号化キーを読ませない）。

# アプリ（frontend-customer）と migrate ジョブ。
resource "google_service_account" "run_customer" {
  account_id   = "run-${var.name_prefix}"
  display_name = "Cloud Run: ${var.name_prefix} と migrate ジョブ"
  depends_on   = [google_project_service.apis]
}

# Metabase（Cloud SQL Auth Proxy のサイドカーもこの ID で認可される）。
resource "google_service_account" "run_metabase" {
  account_id   = "run-metabase"
  display_name = "Cloud Run: metabase"
  depends_on   = [google_project_service.apis]
}

# Cloud SQL に接続する権限（cloudsql.instances.connect / get）。Cloud Run の組み込み接続と Auth Proxy が使う。
# WHY プロジェクト単位: roles/cloudsql.client はインスタンス単位で付けられない（プロジェクトの IAM だけ）。
resource "google_project_iam_member" "run_sql_client" {
  for_each = {
    customer = google_service_account.run_customer.member
    metabase = google_service_account.run_metabase.member
  }
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = each.value
}

# Secret を読む権限は Secret ごとに、読む service の ID にだけ付ける。
resource "google_secret_manager_secret_iam_member" "customer_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.run_customer.member
}

resource "google_secret_manager_secret_iam_member" "metabase_db_uri" {
  secret_id = google_secret_manager_secret.metabase_db_uri.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.run_metabase.member
}

resource "google_secret_manager_secret_iam_member" "metabase_encryption_key" {
  secret_id = google_secret_manager_secret.metabase_encryption_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.run_metabase.member
}

# Cloud SQL の MCP を使う人（variables.tf の sql_iam_users）の権限。
# roles/mcp.toolUser: リモート MCP のツールを呼ぶ。roles/cloudsql.studioUser: SQL の実行（cloudsql.instances.executeSql）。
#   roles/cloudsql.viewer: インスタンス・ユーザーの一覧と取得（list_instances など）。roles/cloudsql.instanceUser: IAM データベース
#   認証でログインする（cloudsql.instances.login）。
# 出典: https://docs.cloud.google.com/sql/docs/postgres/use-cloudsql-mcp の「Required roles」（2026-09-30 確認）。
#   実際に MCP から SQL を実行できるかは未確認（初回の apply の後に確かめる。.claude/skills/deploy/SKILL.md）。
locals {
  sql_iam_user_roles = {
    for pair in setproduct(var.sql_iam_users, ["roles/mcp.toolUser", "roles/cloudsql.studioUser", "roles/cloudsql.viewer", "roles/cloudsql.instanceUser"]) :
    "${pair[0]} ${pair[1]}" => { user = pair[0], role = pair[1] }
  }
}

resource "google_project_iam_member" "sql_iam_user" {
  for_each = local.sql_iam_user_roles
  project  = var.project_id
  role     = each.value.role
  member   = "user:${each.value.user}"
  # ほかの IAM と違いサービスアカウントを参照しないので、API（cloudresourcemanager）の有効化を明示的に待つ。
  depends_on = [google_project_service.apis]
}
