# Metabase（OSS）on Cloud Run。BI は Data Studio と Metabase の両方を用意し、使い勝手を見て後で 1 つにする
#   （ADR docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md）。
# WHY Metabase: Claude が公式の MCP（/api/metabase-mcp、v0.60 以降）で質問とダッシュボードまで作れる。Data Studio には
#   レポートを作る API も MCP も無い。
# イメージは Terraform が管理する（アプリと違い、GitHub Actions では入れ替えない）。版を上げるときは local.metabase_image を変えて apply。

locals {
  # WHY v0.63.18.2: 安定版（-beta でない）の最新のうち、公開から 5 日以上たったもの（.claude/rules/dependencies.md の
  #   「版の決め方」の 5 日ルール。公開日は hub.docker.com の tags API の tag_last_pushed）。
  #   同じタグの digest は sha256:ca6d63cbedfd0a66a3c0239ac79a9df5f7ef3f2455027ab97e3bb26cbf281999。
  metabase_image = "metabase/metabase:v0.63.18.2"

  # WHY 2.25.4: 公開から 5 日以上たった最新（.claude/rules/dependencies.md の「版の決め方」の 5 日ルール。
  #   公開日は gcr.io の tags/list と GitHub の CHANGELOG.md）。
  cloud_sql_proxy_image = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.25.4"

  # Auth Proxy のヘルスチェックのポート（/startup を startup_probe で見る）。
  cloud_sql_proxy_health_port = 9090
}

resource "google_cloud_run_v2_service" "metabase" {
  name     = local.metabase_service
  location = var.region
  # 外部から開く（Metabase のログインで守る。Claude の MCP の接続もこの URL）。
  ingress = "INGRESS_TRAFFIC_ALL"
  # 作り直してよい（設定・質問・ダッシュボードは metabase DB にある）。
  deletion_protection = false

  template {
    service_account = google_service_account.run_metabase.email

    scaling {
      # 既定 0（使わないときは課金しない）。常時使うなら 1（variables.tf）。
      min_instance_count = var.metabase_min_instances
      # WHY 1: 接続数の予算（sql.tf）で Metabase は 6 接続まで。インスタンスが増えるとその倍になる。
      max_instance_count = 1
    }

    # 1 本目: Metabase 本体（外からのリクエストを受ける ingress コンテナ。ports を持てるのは 1 つだけ）。
    containers {
      name  = "metabase"
      image = local.metabase_image

      # Metabase の既定のポート（MB_JETTY_PORT の既定 3000。Docker では 0.0.0.0 で待ち受ける）。
      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu = "1"
          # WHY 2Gi: Metabase の公式の最低要件は 1 core / 1GB。JVM のヒープ（下の JAVA_OPTS）とそれ以外に余裕を持たせる。
          memory = "2Gi"
        }
        # リクエストを処理していないときは CPU を割り当てない。代わりに、同期（sync / fingerprint）などの裏の処理は
        #   リクエストの間しか進まない（試用の段階では許容。常時使うなら min 1 と合わせて false を検討）。
        cpu_idle = true
        # JVM の起動（1〜2 分）を短くする。
        startup_cpu_boost = true
      }

      # Auth Proxy が起動して healthy になってから Metabase を起動する（先に起動するとアプリ DB に接続できず失敗する）。
      depends_on = ["cloud-sql-proxy"]

      # アプリ DB の種類。MB_DB_CONNECTION_URI と組にする（Metabase の公式「The connection type requirement is the same as MB_DB_TYPE」）。
      env {
        name  = "MB_DB_TYPE"
        value = "postgres"
      }
      # アプリ DB の接続（jdbc:postgresql://127.0.0.1:5432/metabase?user=...&password=...。WHY は sql.tf）。
      env {
        name = "MB_DB_CONNECTION_URI"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.metabase_db_uri.secret_id
            version = "latest"
          }
        }
      }
      # アプリ DB に保存する接続情報（分析する DB のパスワードなど）を暗号化するキー。WHY は sql.tf の metabase_encryption_key_version。
      env {
        name = "MB_ENCRYPTION_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.metabase_encryption_key.secret_id
            version = "latest"
          }
        }
      }
      # アプリ DB と、分析する DB（Metabase の画面で登録する app DB）のプールの上限。既定はどちらも 15。
      # WHY 3: db-f1-micro の max_connections 25 に収めるため（接続数の予算は sql.tf）。
      env {
        name  = "MB_APPLICATION_DB_MAX_CONNECTION_POOL_SIZE"
        value = "3"
      }
      env {
        name  = "MB_JDBC_DATA_WAREHOUSE_MAX_CONNECTION_POOL_SIZE"
        value = "3"
      }
      # JVM のヒープの上限をコンテナのメモリの 75%（2Gi のうち 約 1.5GB）にする。
      # WHY: JVM の既定はコンテナのメモリの 25% で、Metabase には小さい。Metabase の Docker イメージは JAVA_OPTS を JVM に渡す
      #   （v0.63.18.2 の bin/docker/run_metabase.sh が `java $JAVA_OPTS -jar /app/metabase.jar` で起動する）。
      #   実際のメモリ使用量は未確認（初回の起動後に Cloud Run のメトリクスで確かめる）。
      env {
        name  = "JAVA_OPTS"
        value = "-XX:MaxRAMPercentage=75"
      }

      # 起動の完了を /api/health（初期化が終わると 200）で判定する。
      # WHY: JVM とアプリ DB のマイグレーションで起動に 1〜2 分かかる。10 秒ごとに 24 回（最大 240 秒）待つ。
      startup_probe {
        period_seconds    = 10
        timeout_seconds   = 5
        failure_threshold = 24
        http_get {
          path = "/api/health"
          port = 3000
        }
      }
    }

    # 2 本目: Cloud SQL Auth Proxy のサイドカー。127.0.0.1:5432 で待ち受け、Cloud SQL に TLS と IAM（run-metabase の SA）でつなぐ。
    # WHY サイドカー: Metabase（Java）は Cloud Run 組み込みの Unix ソケットに接続できない（sql.tf の metabase_db_uri）。
    #   分析する app DB（Metabase の画面で登録）も同じ 127.0.0.1:5432 から読み取り専用ユーザーで接続する。
    containers {
      name  = "cloud-sql-proxy"
      image = local.cloud_sql_proxy_image
      args = [
        # 待ち受けるポート（アドレスの既定は 127.0.0.1。インスタンスの外からは届かない）。
        "--port=5432",
        # /startup・/readiness・/liveness を有効にし、Cloud Run の startup_probe が届くように全インターフェースで待ち受ける。
        "--health-check",
        "--http-address=0.0.0.0",
        "--http-port=${local.cloud_sql_proxy_health_port}",
        # ログを JSON 1 行にする（Cloud Logging で重大度・フィールドとして読める）。
        "--structured-logs",
        local.instance_connection_name,
      ]

      resources {
        limits = {
          # WHY 1 vCPU: 1 未満の CPU は「同時実行数 1・第 1 世代の実行環境」などの条件がつく
          #   （https://cloud.google.com/run/docs/configuring/services/cpu）。サイドカー単位で条件が効くかを確かめていないので、
          #   条件の無い 1 にする。cpu_idle なので、リクエストを処理していないときは課金されない。
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      # Proxy の準備ができたか（Cloud SQL への接続の準備が終わったか）。Metabase の depends_on はこれを待つ。
      startup_probe {
        period_seconds    = 2
        timeout_seconds   = 1
        failure_threshold = 30
        http_get {
          path = "/startup"
          port = local.cloud_sql_proxy_health_port
        }
      }
    }
  }

  lifecycle {
    # コンソール・gcloud で触ったときに付く値の差分は無視する（イメージは Terraform が管理するので無視しない）。
    # template[0].revision: パスワードのローテーションで `gcloud run services update --revision-suffix` を使う
    #   （.claude/skills/deploy/SKILL.md）。無視しないと、次の plan がリビジョン名を戻す差分を出す。
    ignore_changes = [
      client,
      client_version,
      template[0].revision,
    ]
  }

  depends_on = [
    google_project_iam_member.run_sql_client,
    google_secret_manager_secret_iam_member.metabase_db_uri,
    google_secret_manager_secret_iam_member.metabase_encryption_key,
    google_secret_manager_secret_version.metabase_db_uri,
    google_secret_manager_secret_version.metabase_encryption_key,
  ]
}
