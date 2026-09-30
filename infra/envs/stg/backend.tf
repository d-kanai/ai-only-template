# state の置き場所（GCS。ロックも GCS のオブジェクトロックで取られる）。
# WHY バケット名を書かない（partial configuration）: バケットはプロジェクトごと（環境ごと）に違い、Terraform より先に手で作る
#   （state を置くバケットを同じ state で管理すると、初回に置き場所が無い）。
#   `terraform init -backend-config="bucket=<バケット名>"` で渡す（infra/README.md の初回手順）。
# prefix: バケットの中の state のパス（infra/stg/default.tfstate になる）。WHY 環境ごとに分ける: stg と prod で同じバケットを
#   使っても state がぶつからない（別のバケットでもよい）。
terraform {
  backend "gcs" {
    prefix = "infra/stg"
  }
}
