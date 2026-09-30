# prod 環境（Actions の「Deploy」を environment: prod で手動実行したときだけデプロイされる環境）。
# リソースの定義はすべて infra/modules/app にあり、ここは prod の GCP プロジェクトと変数を渡すだけ。
# WHY stg / prod で同じ module: 構成（Cloud Run・Cloud SQL・IAM・WIF）を同じにし、stg で確かめたものがそのまま prod で動くようにする。
#   差は変数（variables.tf の既定値）だけで、stg との違いは infra/envs/stg/variables.tf と見比べれば分かる。
# 構成の全体と WHY は docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md、手順は infra/README.md。

# 以降の resource で project / region を省略したときの既定（module の中の resource もこの provider を使う）。
provider "google" {
  project = var.project_id
  region  = var.region
}

module "app" {
  source = "../../modules/app"

  project_id         = var.project_id
  region             = var.region
  github_environment = "prod" # deploy.yml の job の environment と同じ名前（WIF の条件。modules/app/github_wif.tf）。

  github_repository    = var.github_repository
  github_repository_id = var.github_repository_id
  sql_iam_users        = var.sql_iam_users

  sql_tier                  = var.sql_tier
  sql_backup_retained_count = var.sql_backup_retained_count
  customer_min_instances    = var.customer_min_instances
  metabase_min_instances    = var.metabase_min_instances
  deletion_protection       = var.deletion_protection
}
