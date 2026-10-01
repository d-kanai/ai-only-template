---
name: deploy
description: GCP（Cloud Run + Cloud SQL、stg / prod の 2 環境）へのデプロイと運用（環境ごとの初回の terraform apply、main マージでの stg へのデプロイ、prod への手動デプロイ、ロールバック、migrate ジョブの再実行、パスワードのローテーション、Data Studio / Metabase / Cloud SQL の MCP の接続）。infra/ や .github/workflows/deploy.yml を触るとき、stg / prod の不具合で戻したいとき、デプロイやマイグレーションが失敗したときに使う。
---

# deploy（Cloud Run + Cloud SQL）

器（Cloud SQL・Cloud Run の service / job・Secret・IAM・WIF）は Terraform（`infra/modules/app` を `infra/envs/stg`・`infra/envs/prod` から呼ぶ）、イメージの入れ替えは GitHub Actions の gcloud。
環境は stg と prod の 2 つで、GCP のプロジェクトが別（リソースの名前は同じ）。main へのマージで stg に自動、prod は手動実行でだけ出る。
決定と WHY は ADR `docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md`、初回の手順と各接続の詳細は `infra/README.md`。
名前: アプリ `frontend-customer`、Metabase `metabase`、ジョブ `frontend-customer-migrate`、Cloud SQL `app-db`、リージョン `asia-northeast1`（`infra/modules/app/main.tf` の locals。ワークフローも同じ名前）。
以下の gcloud は `--project <その環境のプロジェクト ID>` と `--region asia-northeast1` を付ける（`gcloud config set project ...` と `gcloud config set run/region asia-northeast1` で省ける）。**prod を触る前に、今の project が prod か stg かを `gcloud config get project` で確かめる**（名前が同じなので、project を取り違えるともう一方の環境を変えてしまう）。
Terraform は環境のディレクトリ（`infra/envs/stg` か `infra/envs/prod`）で実行する。

## 初回（環境ごとに 1 回。stg → prod の順）
`infra/README.md` の「初回の手順」: 認証 → state 用の GCS バケット → `cd infra/envs/<環境>` → `terraform init -backend-config="bucket=..."` → `terraform apply -var="project_id=..."` → GitHub の Environment（`stg` / `prod`）を作り、`terraform output github_variables` をその Environment の Variables に登録（prod には required reviewers を推奨）→ すぐに Metabase の管理者を作る（作るまでは誰でも `/setup` で管理者になれる）→ デプロイ（stg は main に push、prod は手動実行）→ 読み取り専用ユーザーを psql で作る → Data Studio / Metabase / MCP をつなぐ。
- Environment の Variables（`GCP_WIF_PROVIDER` など）が無いあいだ、deploy.yml は最初のステップで notice を出し、以降のステップをスキップする（ジョブは緑）。

## 通常のデプロイ（main へのマージ → stg）
`.github/workflows/deploy.yml` が Environment `stg` で自動で動く: 2 イメージ（runtime / migrate）を build・push → migrate ジョブの実行（`--wait`）→ service のデプロイ → `update-traffic --to-latest`（トラフィックを最新のリビジョンへ）→ 同じ migrate ジョブで backfill（`--args=pnpm,db:backfill`。データの移行。Issue #194）。
- backfill は切替の後に流す（WHY: 切替の前だと、切替までの間に旧アプリが書いた行が漏れる）。失敗してもアプリは切替済みのまま動く（履歴の無い Todo は Repository が補って読み書きする）。下の「backfill が失敗したとき・再実行」。
- migrate が失敗したら service はデプロイされない（古いコードのまま動き続ける）。下の「migrate が失敗したとき」。
- 実行は環境ごとの concurrency（`deploy-stg` / `deploy-prod`）で 1 本ずつ（途中で止めない）。
- マイグレーションは、1 つ前のコードでも動く形（列の追加は先、削除は次のリリース）で書く。WHY: migrate の後、service が切り替わるまでのあいだは古いコードが新しいスキーマで動く。ロールバックでも同じ（スキーマは戻さない）。prod は手動なので、stg より何リリースも前のコードが動いていることがある。prod へのデプロイでは、その間のマイグレーションがまとめて当たり、prod で今動いているコードが新しいスキーマで動く（「1 つ前のコード」は prod で今動いているコードのこと）。

## prod へのデプロイ・手動デプロイ
Actions の「Deploy」→「Run workflow」で `main` と環境（`prod` / `stg`）を選ぶ。`gh workflow run deploy.yml --ref main -f environment=prod` でも同じ。main の先端をその環境に出す。
- prod に出す前に、同じコミットが stg で動いていることを確かめる（stg のデプロイが緑で、画面・API が動く）。
- prod の Environment に required reviewers を付けていれば、承認するまで待つ（Actions の実行の画面で Review deployments）。
- main 以外のブランチを選ぶとジョブはスキップされる（deploy.yml の job の `if`。WIF の条件も main 以外を拒否する）。
- 未確認: 初回のデプロイで、Environment を参照しない job のトークンが WIF で拒否されること（`infra/modules/app/github_wif.tf` の attribute_condition）。

## ロールバック（前のリビジョンに戻す。以下はその環境の project で）
1. リビジョンを探す: `gcloud run revisions list --service frontend-customer`（新しい順。どのコミットかは `gcloud run revisions describe <リビジョン>` のイメージのタグ = git の sha）。
2. 戻す: `gcloud run services update-traffic frontend-customer --to-revisions <リビジョン>=100`。
3. 直したコードを出すと（stg は main へのマージ、prod はその後の手動実行）、deploy.yml が新しいリビジョンを出し、`update-traffic --to-latest` で自動的に LATEST（最新のリビジョン）に 100% を戻す。
   - WHY deploy.yml が戻す: `gcloud run deploy` だけでは戻らない。公式 https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration 「Lifecycle of traffic splits」: "If you split traffic between multiple revisions or assigned traffic to a previous revision, all subsequent deployments use that traffic split pattern going forward."（2026-09-30 確認）。
   - 注意（stg）: 戻した後の main へのマージは、直す PR でなくても LATEST に戻す（戻したリビジョンに固定し続けたいなら、その間は main にマージしない）。prod は手動実行するまで戻したまま。
- DB のマイグレーションは戻らない。前のリビジョンが新しいスキーマで動かないなら、戻すのではなく直したコードを出す。
- Artifact Registry は各イメージの新しい 10 件と 30 日以内を残す（`infra/modules/app/main.tf`）が、デプロイ済みのリビジョンはイメージを消しても動く。

## migrate が失敗したとき・再実行
1. 失敗した実行とログを見る: `gcloud run jobs executions list --job frontend-customer-migrate`、`gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="frontend-customer-migrate"' --limit 50`。
2. 原因（SQL・接続・Secret）を直す。コードの問題なら PR で直して main にマージする（deploy.yml が stg で最初からやり直す。prod はその後に手動実行）。
3. 同じイメージで再実行するだけなら: `gcloud run jobs execute frontend-customer-migrate --wait`。成功したら、service のデプロイは Actions の「Re-run failed jobs」か手動デプロイで行う。
- ジョブは再試行しない（`max_retries = 0`。WHY は `infra/modules/app/run.tf`）。

## backfill が失敗したとき・再実行（データの移行。Issue #194）
1. ログを見る: 上の「migrate が失敗したとき」と同じ `gcloud logging read …`（同じジョブ）。`jsonPayload.event.name="db_backfill"` の `event.phase="failed"` の行に、ファイル（`file.name`）・SQLSTATE（`db.response.status_code`）・例外が出る。失敗したファイルは ROLLBACK 済みで、後のファイルは流れていない。
2. 原因を直す。SQL の誤りなら PR で直して main にマージする（deploy.yml が stg で最初からやり直し、切替の後に backfill を流す）。
3. 手動で流し直す（SQL は冪等なので何度流してもよい）: `gcloud run jobs execute frontend-customer-migrate --region asia-northeast1 --wait --args=pnpm,db:backfill`。
   - `--args` はこの実行 1 回だけコンテナの CMD（`pnpm db:migrate`）を置き換える。ジョブの定義は変わらない（`--args` を付けない実行は今までどおり migrate）。ENTRYPOINT は置き換えないので、コマンドの先頭（`pnpm`）から書く。
   - 未確認: Cloud Run の実機で `--args=pnpm,db:backfill` が `pnpm db:backfill` として動くこと（ローカルの `pnpm db:backfill` と backfill.test.ts の script の実行では確かめた。初回の stg のデプロイで確かめる）。

## 構成を変える（Terraform）
リソースは `infra/modules/app` を変え、`cd infra/envs/stg && terraform plan -var="project_id=..."` で差分を読んで `terraform apply` → 同じことを `infra/envs/prod` で（stg → prod の順）。イメージとトラフィックの差分は出ない（`lifecycle.ignore_changes`）。
- 環境ごとの値（`sql_tier`・`customer_min_instances`・`metabase_min_instances`・`deletion_protection`・`sql_backup_retained_count`）は `infra/envs/<環境>/variables.tf` の既定値か `terraform.tfvars`。stg と prod の差は変数だけにする（`infra/README.md` の表）。
- 接続数（`DATABASE_POOL_MAX`・max instances・Metabase のプール）や tier を変えるときは、`infra/modules/app/sql.tf` の「接続数の予算」（db-f1-micro は max_connections 25）の中に収める。
- Metabase の常時起動: `-var="metabase_min_instances=1"`。Metabase の版は `infra/modules/app/metabase.tf` の `metabase_image`（5 日ルール）。

## パスワードのローテーション
1. `infra/modules/app/sql.tf` の `db_password_version` の該当する値を 1 上げて、環境ごとに apply（DB ユーザーと Secret が同じ apply で新しい値になる。版は stg / prod で共通なので、両方で apply して手順 2 を行う）。
2. 動いているインスタンスは古い値のまま（Secret の latest はインスタンスの起動時に読まれる）で、プールの新しい接続が失敗し始める。apply の直後に新しいリビジョンを作って入れ替える: `gcloud run services update frontend-customer --revision-suffix=rotate-<yyyymmdd>`（Metabase は `metabase`）。
   - migrate ジョブは実行のたびに読む。
   - 未確認: 実際のローテーション（手順の通しの確認はまだしていない）。
- `metabase_encryption_key_version` は変えない（Metabase が保存した接続情報が読めなくなる）。

## 接続（詳細は `infra/README.md`）
- 手元の psql: Cloud SQL Auth Proxy（`cloud-sql-proxy --port 5433 <接続名>`）+ Secret（`database-url`）のパスワード。
- Data Studio: 公開 IP + `bi_readonly` + SSL（手順 7）。
- Metabase: `127.0.0.1:5432` + `bi_readonly`、SSL なし（サイドカーの Proxy。手順 8）。Claude からは Metabase の MCP。
- Cloud SQL の MCP: リモート MCP（`sql_iam_users` に Google アカウントを足して apply + GRANT）か MCP Toolbox（手順 9）。

## 困ったとき
- deploy.yml のジョブがスキップされる: main 以外のブランチで手動実行した（job の `if`）。ステップだけがスキップされる（最初のステップの notice）: その Environment の Variables が未登録（初回の手順 4）。
- Actions の auth のステップが権限エラーで失敗する: WIF の条件（`infra/modules/app/github_wif.tf` の attribute_condition: リポジトリ名・id、ref が main、Environment の名前）に合っていない。Environment の Variables を別の環境の値で登録した（stg の Environment に prod の `GCP_WIF_PROVIDER` など）ときも、Environment の名前が合わず失敗する。
- service の起動に失敗する（リビジョンが Ready にならない）: 起動時の環境変数の検査（`apps/shared/env.ts`）か DB 接続。`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="frontend-customer"' --limit 50`。
- `too many clients already` などの接続数のエラー: 接続数の予算を超えた（`infra/modules/app/sql.tf`）。
