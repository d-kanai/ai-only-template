# Terraform 本体・provider の版（root module なので、ここが版を決める。infra/modules/app/versions.tf は source だけ）。
# WHY 版を完全固定する: npm の依存と同じく、いつ誰が実行しても同じ provider で plan / apply する（docs/adr/quality/20260928-pin-exact-dependency-versions.md）。
#   provider の版は 5 日ルール（.claude/rules/dependencies.md の「版の決め方」、docs/adr/quality/20260928-pnpm-minimum-release-age-5-days.md）に
#   倣い、公開から 5 日以上たったもののうち最新を選ぶ。
#   provider のハッシュは同じディレクトリの .terraform.lock.hcl（コミットする）に固定し、`terraform init` が一致を確かめる。
# WHY stg / prod の両方に同じ内容で置く: 環境ごとに別の root module（別の state・別の init）なので、それぞれに版の宣言が要る。
#   版を上げるときは stg と prod の両方（この file と .terraform.lock.hcl）を変える（infra/README.md の「変更するとき」）。
terraform {
  required_version = "1.16.4"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }
}
