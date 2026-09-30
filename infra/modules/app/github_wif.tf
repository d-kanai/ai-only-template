# GitHub Actions から GCP にデプロイするための Workload Identity Federation（WIF）と、デプロイ用のサービスアカウント。
# WHY WIF（鍵ファイルを使わない）: GitHub の OIDC トークンを短期の GCP のトークンに交換するので、長期の鍵を GitHub の Secrets に
#   置かずに済む（漏れても使える期間が短く、ローテーションも要らない）。
# WHY 環境（プロジェクト）ごとに作る: stg と prod は別の GCP プロジェクトで、pool・provider・deployer もその中にある。stg の
#   deployer に prod を触る権限は無い。

locals {
  # デプロイを許す git の ref。deploy.yml の job の if（github.ref == 'refs/heads/main'）と同じ（変えるときは両方）。
  github_deploy_ref = "refs/heads/main"
}

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
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.ref"           = "assertion.ref"
  }

  # このリポジトリ以外のトークンを拒否する。WHY: token.actions.githubusercontent.com は GitHub の全リポジトリの共通の発行者で、
  #   条件が無いと他人のリポジトリのワークフローもこの provider でトークンを交換できる（Google は条件の設定を必須にしている）。
  # github_repository_id を設定したら、数値の repository id の一致も求める。WHY: リポジトリ名は、リポジトリを消した後に第三者が
  #   同じ名前で作り直せる。id は GitHub が一意で再利用しないと保証している（google-github-actions/auth の
  #   docs/SECURITY_CONSIDERATIONS.md「Use GitHub's Numeric, Immutable Values」）。id は文字列の claim なので引用符で比べる。
  # ref（refs/heads/main）: main のワークフローのトークンだけを受け付ける。WHY: stg も prod も main からしか出さない
  #   （deploy.yml の job の if も main に限る）。ここで絞らないと、main 以外のブランチに push したワークフロー（レビューも CI も
  #   通っていないコード）が deployer になりすませる（job の if はそのワークフローの中の条件で、ブランチ側で書き換えられる）。
  # environment（GitHub Environment の名前 = var.github_environment）: その Environment を参照した job のトークンだけを受け付ける。
  #   WHY: prod の Environment に required reviewers を付けたとき、承認を通らない job（environment を書かないワークフローや、
  #   environment: stg の job）が prod のプロジェクトに入れないようにする。Variables は秘密ではないので、prod の WIF の値は
  #   誰でも書ける。GitHub の OIDC トークンの environment の claim は「job が使う Environment の名前」
  #   （https://docs.github.com/en/actions/reference/security/oidc 、2026-09-30 確認）。未確認: environment を参照しない job の
  #   トークン（claim が無い）が実際に拒否されること（初回のデプロイの後に確かめる。.claude/skills/deploy/SKILL.md）。
  attribute_condition = join(" && ", compact([
    "assertion.repository == \"${var.github_repository}\"",
    var.github_repository_id == null ? null : "assertion.repository_id == \"${var.github_repository_id}\"",
    "assertion.ref == \"${local.github_deploy_ref}\"",
    "assertion.environment == \"${var.github_environment}\"",
  ]))

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# GitHub Actions がなりすますサービスアカウント（deploy.yml の GCP_DEPLOYER_SA）。
resource "google_service_account" "deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions deployer"
  depends_on   = [google_project_service.apis]
}

# このリポジトリのワークフローに、deployer へのなりすましを許す。
# principalSet はリポジトリ単位だが、上の provider の attribute_condition が main（ref）と Environment に合わないトークンを
#   交換の時点で拒否するので、なりすませるのは「main の、この環境の Environment を参照した job」だけになる。
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
  service_account_id = google_service_account.run_customer.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.deployer.member
}
