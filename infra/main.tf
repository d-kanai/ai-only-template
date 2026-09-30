# 共通の名前、API の有効化、Artifact Registry。
# 構成の全体と WHY は docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md、手順は infra/README.md と
#   .claude/skills/deploy/SKILL.md。
# WHY Terraform は「器」だけ: イメージとトラフィック（どのリビジョンに流すか）はデプロイのたびに変わるので、GitHub Actions の
#   gcloud が入れ替える。Terraform にも持たせると、apply のたびに Actions が入れたイメージを古い値に戻してしまう
#   （Cloud Run の service / job は lifecycle.ignore_changes でイメージとトラフィックの差分を無視する）。

locals {
  # Cloud Run の service / job の名前。.github/workflows/deploy.yml・preview.yml も同じ名前を使う（変えるときは両方）。
  customer_service         = "frontend-customer"
  customer_preview_service = "frontend-customer-preview"
  migrate_job              = "frontend-customer-migrate"
  migrate_preview_job      = "frontend-customer-migrate-preview"
  metabase_service         = "metabase"

  # Artifact Registry のリポジトリ名。イメージは <region>-docker.pkg.dev/<project>/app/<イメージ名>:<git の sha>。
  artifact_repository = "app"

  # Cloud SQL の接続名（<PROJECT>:<REGION>:<INSTANCE>）。Cloud Run の Unix ソケットのパス（/cloudsql/<接続名>）と、
  #   Cloud SQL Auth Proxy の引数に使う。
  instance_connection_name = google_sql_database_instance.main.connection_name

  # 有効にする API。
  services = [
    "run.googleapis.com",                  # Cloud Run（service / job）
    "sqladmin.googleapis.com",             # Cloud SQL（Cloud Run の組み込み接続・Auth Proxy・リモート MCP もこの API を使う）
    "artifactregistry.googleapis.com",     # イメージの置き場所
    "secretmanager.googleapis.com",        # DB の接続文字列などの秘密
    "iam.googleapis.com",                  # サービスアカウント
    "iamcredentials.googleapis.com",       # WIF でサービスアカウントの短期トークンを発行する
    "sts.googleapis.com",                  # WIF で GitHub の OIDC トークンを交換する
    "cloudresourcemanager.googleapis.com", # プロジェクトの IAM（google_project_iam_member）
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.services)
  service  = each.value
  # WHY false: destroy でこの resource を消しても API は無効にしない。API を無効にすると、ほかの手段で作った resource
  #   （手作業の検証など）まで使えなくなる。
  disable_on_destroy = false
}

# アプリのイメージ（runtime / migrate）の置き場所。
resource "google_artifact_registry_repository" "app" {
  repository_id = local.artifact_repository
  location      = var.region
  format        = "DOCKER"
  description   = "frontend-customer の runtime / migrate イメージ（GitHub Actions が push する）"

  # 古いイメージを消す。WHY: main への push と PR の更新ごとにイメージが増え（migrate イメージは約 385MB。2026-09-30 の
  #   work-logs）、保存量に課金される。Cloud Run はデプロイ時にイメージを取り込むので、デプロイ済みのリビジョンは
  #   Artifact Registry からイメージを消しても動く（https://cloud.google.com/run/docs/deploying 「The container image is
  #   imported by Cloud Run when deployed, so after the deployment, you can delete the image from Artifact Registry」）。
  # false: 下のポリシーを実際に適用する（true だと消す対象をログに出すだけ）。
  cleanup_policy_dry_run = false

  # KEEP は DELETE より優先される。イメージ名ごとに新しい 10 件は、30 日より古くても残す（ロールバックの候補）。
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  # 30 日（2592000 秒）より古いものを消す（上の 10 件を除く）。
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }

  depends_on = [google_project_service.apis]
}
