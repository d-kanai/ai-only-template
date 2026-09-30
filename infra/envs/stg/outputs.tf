# module の出力をそのまま外に出す（`terraform output` で表示する。infra/README.md の初回手順）。

# GitHub の Environment の Variables に入れる値（WHY は infra/modules/app/outputs.tf）。
output "github_variables" {
  description = "GitHub の Settings > Environments > <環境> > Environment variables に設定する値"
  value       = module.app.github_variables
}

# Cloud SQL の接続名（<PROJECT>:<REGION>:<INSTANCE>）。手元の Cloud SQL Auth Proxy や MCP の設定に使う。
output "instance_connection_name" {
  value = module.app.instance_connection_name
}

# Cloud SQL の公開 IP。Data Studio の接続先（ホスト名）に使う。
output "sql_public_ip" {
  value = module.app.sql_public_ip
}

# 各 service の既定の URL（https://<service>-<hash>.<region>.run.app の形）。
output "customer_url" {
  value = module.app.customer_url
}

output "metabase_url" {
  value = module.app.metabase_url
}
