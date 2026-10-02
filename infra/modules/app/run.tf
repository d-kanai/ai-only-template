# Cloud Run: アプリ（frontend-customer）と migrate ジョブ。
# Metabase は metabase.tf。イメージは GitHub Actions が入れ替える（.github/workflows/deploy.yml）。

locals {
  # アプリが起動時に必須とする DB の設定（apps/shared/env.ts。.env.example に意味と WHY）。DATABASE_URL は Secret から入れる。
  # DATABASE_POOL_MAX（1 インスタンスのプールの最大接続数）は service / job ごとに違うので下で個別に書く
  #   （接続数の予算は sql.tf の tier のコメント）。
  database_env = {
    DATABASE_POOL_IDLE_TIMEOUT_MS  = "10000" # 使われない接続を 10 秒で閉じる（node-postgres の既定。.env.example と同じ）。
    DATABASE_CONNECTION_TIMEOUT_MS = "5000"  # 接続待ちの上限 5 秒（.env.example と同じ WHY）。
    # トランザクションを開いたまま何もしていない接続を 30 秒で切る（.env.example と同じ WHY。Issue #58）。
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = "30000"
  }
  # DATABASE_STATEMENT_TIMEOUT_MS / DATABASE_LOCK_TIMEOUT_MS（DB 側の文の実行時間・ロック待ちの上限）も service / job で違うので
  #   下で個別に書く（service は .env.example と同じ 10 秒 / 3 秒、job は 0 = 送らず DB の既定（上限なし）に従う）。
  # DB 側のタイムアウト 3 つは、job のマイグレーション（apps/backend/shared/drizzle/migrate.ts）にも効く: 入口がアプリのプール
  #   （apps/backend/shared/drizzle/database.ts の AppDatabase）で接続する（Issue #326。以前の drizzle-kit migrate には効かなかった）。
  # DB 以外でアプリが起動時に必須とする設定（apps/shared/env.ts。.env.example に意味と WHY）。service と job で同じ値。
  # WHY job にも渡す: マイグレーションの入口も env.ts を通り、必須の変数が 1 つでも欠けると止まる。
  app_env = {
    # リクエストログの trace（projects/<ID>/traces/<trace-id>。Cloud Logging の logging.googleapis.com/trace）に入れる
    #   プロジェクト ID（Issue #209）。Cloud Run が自動で付ける環境変数にプロジェクト ID は無い
    #   （https://docs.cloud.google.com/run/docs/container-contract ）ので、この module の入力から渡す。
    GCP_PROJECT_ID = var.project_id
  }
}

# lifecycle.ignore_changes（下の service / job）の WHY: イメージとトラフィックは GitHub Actions の gcloud が入れ替える（main.tf）。
#   `gcloud run deploy` はそのたびに client / client_version（どのツールでデプロイしたか）・リビジョン名・ラベルも書くので、
#   無視しないと次の terraform plan が毎回それを戻す差分を出す。traffic は、ロールバック（update-traffic --to-revisions）と
#   deploy.yml の LATEST への切り替え（update-traffic --to-latest）を gcloud が書く。

# アプリの frontend-customer（Next.js の standalone。Dockerfile の runtime ステージ）。
resource "google_cloud_run_v2_service" "customer" {
  name     = local.customer_service
  location = var.region
  # 外部からの HTTP を受ける（公開サイト）。
  ingress = "INGRESS_TRAFFIC_ALL"
  # Terraform からの削除を拒否する（URL が変わるのを防ぐ）。stg では外せる（variables.tf の deletion_protection）。
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.run_customer.email

    scaling {
      # 既定 0: アクセスが無いときは課金されない（代わりに最初のリクエストでコールドスタートを待つ）。
      #   prod でコールドスタートを無くしたいときは 1 にする（variables.tf の customer_min_instances）。
      min_instance_count = var.customer_min_instances
      # 3: 接続数の予算（sql.tf）で、3 インスタンス x プール 3 = 9 接続まで。
      max_instance_count = 3
    }

    # 1 インスタンスが同時に受けるリクエスト数（Cloud Run の既定 80）。プールは 3 なので、DB を使うリクエストは
    #   プールの空きを待つ（待ちの上限は DATABASE_CONNECTION_TIMEOUT_MS）。
    max_instance_request_concurrency = 80

    # Cloud Run 組み込みの Cloud SQL 接続。/cloudsql/<接続名>/.s.PGSQL.5432 に Unix ソケットを置く（中で Auth Proxy が動き、
    #   TLS と IAM で Cloud SQL に接続する）。WHY Cloud SQL Connector（ライブラリ）や Private IP を使わない: コードの変更も
    #   VPC も要らず、DATABASE_URL の host をソケットのディレクトリにするだけで pg と drizzle-kit がつながる
    #   （2026-09-30 の work-logs）。
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.instance_connection_name]
      }
    }

    containers {
      image = var.bootstrap_image

      # Dockerfile の runtime ステージは PORT=8080 で待ち受ける。Cloud Run はこの値を PORT として渡し、ここに転送する。
      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # リクエストを処理していないときは CPU を割り当てない（リクエスト単位の課金。最も安い）。
        cpu_idle = true
        # 起動中だけ CPU を増やし、コールドスタートを短くする。
        startup_cpu_boost = true
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret = google_secret_manager_secret.database_url.secret_id
            # latest: インスタンスの起動時に最新の版を読む（パスワードをローテーションしたら新しいリビジョンで反映）。
            version = "latest"
          }
        }
      }
      env {
        name  = "DATABASE_POOL_MAX"
        value = "3"
      }
      # DB 側の文の実行時間・ロック待ちの上限（.env.example と同じ値と WHY。Issue #58）。
      env {
        name  = "DATABASE_STATEMENT_TIMEOUT_MS"
        value = "10000"
      }
      env {
        name  = "DATABASE_LOCK_TIMEOUT_MS"
        value = "3000"
      }
      dynamic "env" {
        for_each = merge(local.database_env, local.app_env)
        content {
          name  = env.key
          value = env.value
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }
  }

  lifecycle {
    # WHY は上の「lifecycle.ignore_changes（下の service / job）の WHY」。
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
      template[0].revision,
      template[0].labels,
      traffic,
    ]
  }

  # 実行用 SA が Cloud SQL と Secret を使えるようになってからリビジョンを作る（先に作ると起動に失敗する）。
  depends_on = [
    google_project_iam_member.run_sql_client,
    google_secret_manager_secret_iam_member.customer_database_url,
    google_secret_manager_secret_version.database_url,
  ]
}

# 誰でも（認証なしで）アクセスできるようにする。WHY: 公開の Web サイトで、ログインは画面側の責務。Metabase は Metabase の
#   ログインで守る（Claude の MCP もこの URL に接続する）。
# 注意（Metabase）: 管理者を作るまでは、URL を知る誰でも初回セットアップ（/setup）を開いて管理者になれる。apply の直後に
#   管理者を作る（infra/README.md の手順 3）。
# 注意: 組織のポリシー「ドメインで制限された共有」があると allUsers を付けられない（その場合は service の
#   invoker_iam_disabled = true を使う。https://cloud.google.com/run/docs/securing/managing-access#invoker_check）。
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = {
    customer = google_cloud_run_v2_service.customer.name
    metabase = google_cloud_run_v2_service.metabase.name
  }
  name     = each.value
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# マイグレーションを 1 回実行するジョブ。service と同じ runtime イメージを、コマンドだけ変えて（node migrate/migrate.mjs。
#   apps/backend/shared/drizzle/migrate.ts を束ねたもの）動かす（Issue #326。WHY は Dockerfile の先頭）。
#   イメージとコマンドは deploy.yml の gcloud run jobs update が組で入れ替える（WHY は deploy.yml の「Update migrate job image」）。
# deploy.yml がデプロイのたびに、イメージを入れ替えて（jobs update）から実行し（jobs execute --wait）、成功したら
#   service をデプロイする。WHY アプリの起動時に migrate しない: 複数インスタンスが同時に当てるのを避け、失敗したら
#   新しいリビジョンを出さずに止めるため（.claude/skills/db-migration/SKILL.md「アプリの起動で migrate しない」）。
resource "google_cloud_run_v2_job" "migrate" {
  name                = local.migrate_job
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    # 1 タスクだけ（同じマイグレーションを並列に当てない）。
    task_count = 1

    template {
      service_account = google_service_account.run_customer.email
      # WHY 再試行しない: 途中で失敗したマイグレーションを自動で当て直すと、原因を見ずに同じ失敗を重ねる。失敗したら
      #   deploy.yml が止まり、人が原因を見てジョブを再実行する（.claude/skills/deploy/SKILL.md）。
      max_retries = 0
      # 10 分で打ち切る（今のマイグレーションは数秒。ロック待ちで止まり続けるのを防ぐ）。
      timeout = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.instance_connection_name]
        }
      }

      containers {
        image = var.bootstrap_image

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }
        # マイグレーションは接続 1 本で順に当てる（drizzle-orm の migrator が 1 つのトランザクションで流す）。env.ts が必須にしているので値を渡す。
        env {
          name  = "DATABASE_POOL_MAX"
          value = "1"
        }
        # WHY job は文の実行時間・ロック待ちを無効（0）にする: マイグレーションの DDL は表の大きさに比例して長くなり、アプリの
        #   ロックを待つことがある。API 向けの 10 秒 / 3 秒で打ち切るとマイグレーションが半端に止まり、デプロイも止まる。
        #   上限はジョブの timeout（600s）が持つ（Codex の指摘への判断。PR #259）。
        env {
          name  = "DATABASE_STATEMENT_TIMEOUT_MS"
          value = "0"
        }
        env {
          name  = "DATABASE_LOCK_TIMEOUT_MS"
          value = "0"
        }
        dynamic "env" {
          for_each = merge(local.database_env, local.app_env)
          content {
            name  = env.key
            value = env.value
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  lifecycle {
    # command / args も無視する（Issue #326）: deploy.yml がイメージと組で node migrate/migrate.mjs に入れ替える。
    #   Terraform が持つと、初回の apply の仮のイメージ（bootstrap_image の hello）に node が無く、apply 直後のジョブが動かない。
    ignore_changes = [
      template[0].template[0].containers[0].image,
      template[0].template[0].containers[0].command,
      template[0].template[0].containers[0].args,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_iam_member.run_sql_client,
    google_secret_manager_secret_iam_member.customer_database_url,
    google_secret_manager_secret_version.database_url,
  ]
}
