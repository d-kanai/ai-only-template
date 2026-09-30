# apply の後に使う値。infra/envs/<環境>/outputs.tf がそのまま外に出し、`terraform output` で表示する（infra/README.md の初回手順）。

# GitHub の Environment（var.github_environment。stg / prod）の Variables にそのまま設定する値（deploy.yml が vars.<名前> で読む）。
# WHY Environment ごと（Repository variables ではない）: 名前は同じで値が環境ごとに違う。deploy.yml の job が
#   environment: stg / prod を参照すると、vars.<名前> はその Environment の値になる。
# WHY Variables（Secrets ではない）: どれも秘密ではない（WIF なので鍵は無い）。ログに出ても困らない。
output "github_variables" {
  description = "GitHub の Settings > Environments > <環境> > Environment variables に設定する値"
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
