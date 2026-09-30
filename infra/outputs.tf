# apply の後に使う値。`terraform output` で表示する（infra/README.md の初回手順）。

# GitHub の Repository variables にそのまま設定する値（deploy.yml が vars.<名前> で読む）。
# WHY Variables（Secrets ではない）: どれも秘密ではない（WIF なので鍵は無い）。ログに出ても困らず、ワークフローの if でも読める。
output "github_variables" {
  description = "GitHub の Settings > Secrets and variables > Actions > Variables に設定する値"
  value = {
    GCP_PROJECT_ID   = var.project_id
    GCP_REGION       = var.region
    GCP_WIF_PROVIDER = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA  = google_service_account.deployer.email
    # イメージ名の前まで（<region>-docker.pkg.dev/<project>/app）。ワークフローが /frontend-customer:<sha> などを付ける。
    GCP_AR_REPO = "${google_artifact_registry_repository.app.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}"
  }
}

# Cloud SQL の接続名（<PROJECT>:<REGION>:<INSTANCE>）。手元の Cloud SQL Auth Proxy や MCP の設定に使う。
output "instance_connection_name" {
  value = local.instance_connection_name
}

# Cloud SQL の公開 IP。Data Studio の接続先（ホスト名）に使う。
output "sql_public_ip" {
  value = google_sql_database_instance.main.public_ip_address
}

# 各 service の既定の URL（https://<service>-<hash>.<region>.run.app の形）。
output "customer_url" {
  value = google_cloud_run_v2_service.customer.uri
}

output "metabase_url" {
  value = google_cloud_run_v2_service.metabase.uri
}
