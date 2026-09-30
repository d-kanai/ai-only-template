---
name: deploy
description: GCP（Cloud Run + Cloud SQL）へのデプロイと運用（初回の terraform apply、main マージでのデプロイ、手動デプロイ、PR の preview、ロールバック、migrate ジョブの再実行、パスワードのローテーション、Data Studio / Metabase / Cloud SQL の MCP の接続）。infra/ や .github/workflows/deploy.yml・preview.yml を触るとき、本番の不具合で戻したいとき、デプロイやマイグレーションが失敗したときに使う。
---

# deploy（Cloud Run + Cloud SQL）

器（Cloud SQL・Cloud Run の service / job・Secret・IAM・WIF）は Terraform（`infra/`）、イメージの入れ替えは GitHub Actions の gcloud。
決定と WHY は ADR `docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md`、初回の手順と各接続の詳細は `infra/README.md`。
名前: 本番 `frontend-customer`、preview `frontend-customer-preview`、Metabase `metabase`、ジョブ `frontend-customer-migrate` / `frontend-customer-migrate-preview`、Cloud SQL `app-db`、リージョン `asia-northeast1`（`infra/main.tf` の locals。ワークフローも同じ名前）。
以下の gcloud は `--region asia-northeast1` を付ける（`gcloud config set run/region asia-northeast1` で省ける）。

## 初回（1 回だけ）
`infra/README.md` の「初回の手順」: 認証 → state 用の GCS バケット → `terraform init -backend-config="bucket=..."` → `terraform apply -var="project_id=..."` → `terraform output github_variables` を GitHub の Variables に登録 → main に push → 読み取り専用ユーザーを psql で作る → Data Studio / Metabase / MCP をつなぐ。
- Variables（`GCP_WIF_PROVIDER` など）が無いあいだ、deploy.yml / preview.yml のジョブはスキップされる。

## 通常のデプロイ（main へのマージ）
`.github/workflows/deploy.yml` が自動で動く: 2 イメージ（runtime / migrate）を build・push → migrate ジョブの実行（`--wait`）→ 本番の service のデプロイ → preview の DB の migrate。
- migrate が失敗したら service はデプロイされない（古いコードのまま動き続ける）。下の「migrate が失敗したとき」。
- 実行は `deploy-prod` で 1 本ずつ（途中で止めない）。
- マイグレーションは、1 つ前のコードでも動く形（列の追加は先、削除は次のリリース）で書く。WHY: migrate の後、service が切り替わるまでのあいだは古いコードが新しいスキーマで動く。ロールバックでも同じ（スキーマは戻さない）。

## 手動デプロイ
Actions の「Deploy」→「Run workflow」（main を選ぶ）。`gh workflow run deploy.yml --ref main` でも同じ。main の先端を出し直す。

## preview（PR）
`.github/workflows/preview.yml`: PR を開く・push すると runtime のイメージを `frontend-customer-preview` に `--no-traffic --tag pr-<番号>` で出し、URL（`https://pr-<番号>---frontend-customer-preview-<hash>.a.run.app` の形）を PR にコメントする（2 回目以降は同じコメントを書き換える）。閉じるとタグを外す。
- DB は `app_preview`（main のマイグレーションだけが当たる）。**スキーマを変える PR は preview では動かない**（WHY: `infra/run.tf` の migrate_preview）。
- fork からの PR は対象外（WIF で認証できない）。
- タグを手で外す: `gcloud run services update-traffic frontend-customer-preview --remove-tags pr-<番号>`。

## ロールバック（本番を前のリビジョンに戻す）
1. リビジョンを探す: `gcloud run revisions list --service frontend-customer`（新しい順。どのコミットかは `gcloud run revisions describe <リビジョン>` のイメージのタグ = git の sha）。
2. 戻す: `gcloud run services update-traffic frontend-customer --to-revisions <リビジョン>=100`。
3. 直したコードを main にマージすると deploy.yml が新しいリビジョンを出す。未確認: トラフィックを特定のリビジョンに固定した後の `gcloud run deploy` が、新しいリビジョンに 100% を移すか。移らなければ `gcloud run services update-traffic frontend-customer --to-latest` で LATEST に戻す。
- DB のマイグレーションは戻らない。前のリビジョンが新しいスキーマで動かないなら、戻すのではなく直したコードを出す。
- Artifact Registry は各イメージの新しい 10 件と 30 日以内を残す（`infra/main.tf`）が、デプロイ済みのリビジョンはイメージを消しても動く。

## migrate が失敗したとき・再実行
1. 失敗した実行とログを見る: `gcloud run jobs executions list --job frontend-customer-migrate`、`gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="frontend-customer-migrate"' --limit 50`。
2. 原因（SQL・接続・Secret）を直す。コードの問題なら PR で直して main にマージする（deploy.yml が最初からやり直す）。
3. 同じイメージで再実行するだけなら: `gcloud run jobs execute frontend-customer-migrate --wait`。成功したら、service のデプロイは Actions の「Re-run failed jobs」か手動デプロイで行う。
- preview の DB: `gcloud run jobs execute frontend-customer-migrate-preview --wait`。
- ジョブは再試行しない（`max_retries = 0`。WHY は `infra/run.tf`）。

## 構成を変える（Terraform）
`cd infra && terraform plan -var="project_id=..."` で差分を読み、`terraform apply`。イメージとトラフィックの差分は出ない（`lifecycle.ignore_changes`）。
- 接続数（`DATABASE_POOL_MAX`・max instances・Metabase のプール）を変えるときは、`infra/sql.tf` の「接続数の予算」（db-f1-micro は max_connections 25）の中に収める。
- Metabase の常時起動: `-var="metabase_min_instances=1"`。Metabase の版は `infra/metabase.tf` の `metabase_image`（5 日ルール）。

## パスワードのローテーション
1. `infra/sql.tf` の `db_password_version` の該当する値を 1 上げて apply（DB ユーザーと Secret が同じ apply で新しい値になる）。
2. 動いているインスタンスは古い値のまま（Secret の latest はインスタンスの起動時に読まれる）で、プールの新しい接続が失敗し始める。apply の直後に新しいリビジョンを作って入れ替える: `gcloud run services update frontend-customer --revision-suffix=rotate-<yyyymmdd>`（Metabase は `metabase`）。
   - preview はアクセスが無くなるとインスタンスが 0 になり、次の起動で新しい値を読む。migrate ジョブは実行のたびに読む。
   - 未確認: 実際のローテーション（手順の通しの確認はまだしていない）。
- `metabase_encryption_key_version` は変えない（Metabase が保存した接続情報が読めなくなる）。

## 接続（詳細は `infra/README.md`）
- 手元の psql: Cloud SQL Auth Proxy（`cloud-sql-proxy --port 5433 <接続名>`）+ Secret（`database-url`）のパスワード。
- Data Studio: 公開 IP + `bi_readonly` + SSL（手順 7）。
- Metabase: `127.0.0.1:5432` + `bi_readonly`、SSL なし（サイドカーの Proxy。手順 8）。Claude からは Metabase の MCP。
- Cloud SQL の MCP: リモート MCP（`sql_iam_users` に Google アカウントを足して apply + GRANT）か MCP Toolbox（手順 9）。

## 困ったとき
- deploy.yml が `vars.GCP_WIF_PROVIDER` の条件でスキップされる: GitHub の Variables が未登録（初回の手順 4）。
- Actions の auth のステップが権限エラーで失敗する: WIF の条件（`infra/github_wif.tf` の `github_repository`）とリポジトリ名が違う。
- service の起動に失敗する（リビジョンが Ready にならない）: 起動時の環境変数の検査（`apps/shared/env.ts`）か DB 接続。`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="frontend-customer"' --limit 50`。
- `too many clients already` などの接続数のエラー: 接続数の予算を超えた（`infra/sql.tf`）。
