# この module が使う provider（どの provider を使うか = source だけ）。
# WHY 版をここに書かない: 版の固定（完全固定・5 日ルール）は呼び出す側の envs/<環境>/versions.tf と、その
#   .terraform.lock.hcl に置く（root module だけが provider の版を最終的に決める）。module にも同じ版を書くと、版を上げるときに
#   変える場所が 3 か所（module・stg・prod）になり、1 か所でも忘れると init が版の衝突で止まる。
# WHY Terraform の版・backend・provider の設定（project / region）も書かない: どれも root module（envs/<環境>）の責務。
#   module に provider の設定を書くと、環境ごとに別の project で呼び出せなくなる。
terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
    # ephemeral "random_password"（DB のパスワードなどを state に残さずに作る）に使う。
    random = {
      source = "hashicorp/random"
    }
  }
}
