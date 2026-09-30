# GitHub Actions から GCP にデプロイするための Workload Identity Federation（WIF）と、デプロイ用のサービスアカウント。
# WHY WIF（鍵ファイルを使わない）: GitHub の OIDC トークンを短期の GCP のトークンに交換するので、長期の鍵を GitHub の Secrets に
#   置かずに済む（漏れても使える期間が短く、ローテーションも要らない）。

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"

  # GitHub の OIDC トークンの claim を GCP の属性に写す。google.subject は必須（監査ログに出る主体）。
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # このリポジトリ以外のトークンを拒否する。WHY: token.actions.githubusercontent.com は GitHub の全リポジトリの共通の発行者で、
  #   条件が無いと他人のリポジトリのワークフローもこの provider でトークンを交換できる（Google は条件の設定を必須にしている）。
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# GitHub Actions がなりすますサービスアカウント（deploy.yml / preview.yml の GCP_DEPLOYER_SA）。
resource "google_service_account" "deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions deployer"
  depends_on   = [google_project_service.apis]
}

# このリポジトリのワークフローに、deployer へのなりすましを許す。
# 注意: main への push（deploy.yml）と PR（preview.yml）で同じ deployer を使うので、同じリポジトリのブランチの PR のワークフローも
#   本番にデプロイできる権限を持つ。WHY 今は分けない: リポジトリに push できる人は main にもマージできる（信頼の境界が同じ）。
#   分けるなら、本番用の SA を attribute.ref（refs/heads/main）に限った principalSet にする。
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# Cloud Run の service の更新（gcloud run deploy / update-traffic）と、job の更新・実行（gcloud run jobs update / execute）。
# WHY roles/run.developer（admin ではない）: IAM ポリシー（allUsers の invoker など）は Terraform が管理し、deployer には
#   変えさせない。job の実行まで足りるかは未確認（初回のデプロイで確かめる）。
resource "google_project_iam_member" "deployer_run_developer" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = google_service_account.deployer.member
}

# イメージの push。WHY リポジトリ単位: ほかの Artifact Registry のリポジトリには書かせない。
resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.deployer.member
}

# デプロイする service / job の実行用 SA として deployer が指定する（actAs）権限。
# WHY 必要: Cloud Run は、リビジョンを作る主体が実行用 SA を使ってよいかを確かめる。Metabase は Terraform だけが更新するので含めない。
resource "google_service_account_iam_member" "deployer_act_as" {
  for_each = {
    customer         = google_service_account.run_customer.name
    customer_preview = google_service_account.run_customer_preview.name
  }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}
