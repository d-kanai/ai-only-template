# Terraform 本体・provider の版と、state の置き場所（GCS）。
# WHY 版を完全固定する: npm の依存と同じく、いつ誰が実行しても同じ provider で plan / apply する（docs/adr/quality/20260928-pin-exact-dependency-versions.md）。
#   provider の版は 5 日ルール（docs/adr/quality/20260928-pnpm-minimum-release-age-5-days.md）に倣い、公開から 5 日以上たったものを選ぶ。
#   google 8.4.0 は 2026-09-22 公開（8.5.0 は 2026-09-29 公開で 5 日たっていない）。random 3.9.1。Terraform 1.16.4。
#   provider のハッシュは .terraform.lock.hcl（コミットする）に固定し、`terraform init` が一致を確かめる。
terraform {
  required_version = "1.16.4"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.4.0"
    }
    # ephemeral "random_password"（DB のパスワードなどを state に残さずに作る）に使う。
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }

  # state は GCS に置く（ロックも GCS のオブジェクトロックで取られる）。
  # WHY バケット名を書かない（partial configuration）: バケットはプロジェクトごとに違い、Terraform より先に手で作る
  #   （state を置くバケットを同じ state で管理すると、初回に置き場所が無い）。
  #   `terraform init -backend-config="bucket=<バケット名>"` で渡す（infra/README.md の初回手順）。
  # prefix: バケットの中の state のパス（infra/default.tfstate になる）。
  backend "gcs" {
    prefix = "infra"
  }
}

# 以降の resource で project / region を省略したときの既定。
provider "google" {
  project = var.project_id
  region  = var.region
}
