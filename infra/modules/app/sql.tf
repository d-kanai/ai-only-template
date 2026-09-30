# Cloud SQL for PostgreSQL（インスタンス 1 つに app / metabase の 2 DB）、DB ユーザー、接続情報の Secret。

# 資格情報の版。上げると、その回の apply で新しいパスワードを作り、DB ユーザーと Secret の両方に書く（ローテーション）。
# WHY 1 つの値を DB ユーザーと Secret で共有する: password_wo / secret_data_wo は write-only で state に値が残らず、
#   Terraform は「版が変わったときだけ」送る。版を片方だけ上げると、DB と Secret のパスワードがずれて接続できなくなる。
# ローテーション後は Cloud Run の新しいリビジョンが要る（Secret の latest はインスタンスの起動時に読まれる）。
#   手順は .claude/skills/deploy/SKILL.md。
locals {
  db_password_version = {
    app      = 1
    metabase = 1
  }
  # Metabase の MB_ENCRYPTION_SECRET_KEY の版。
  # WHY 原則変えない: Metabase は、このキーで接続情報（DB のパスワードなど）を暗号化して metabase DB に保存する。
  #   変えると保存済みの接続情報が読めなくなる（キーの入れ替えは Metabase の手順が別に要る）。
  metabase_encryption_key_version = 1
}

# パスワードは ephemeral（state にも plan にも残らない）で作る。apply のたびに新しい値になるが、送られるのは
#   上の版が変わったときだけ（write-only の引数）。
# length 32 / special = false: 英数字だけにする。WHY: 接続文字列（URL・JDBC の URI）にそのまま埋め込めるように
#   （記号は URL エンコードが要り、pg と JDBC で解釈が違うおそれがある）。英数字 32 文字で約 190 bit。
ephemeral "random_password" "db_app" {
  length  = 32
  special = false
}

ephemeral "random_password" "db_metabase" {
  length  = 32
  special = false
}

# Metabase の MB_ENCRYPTION_SECRET_KEY（「16 文字以上の base64 の文字列」。英数字 32 文字は base64 の文字だけで、長さが 4 の倍数）。
ephemeral "random_password" "metabase_encryption_key" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name   = "app-db"
  region = var.region
  # WHY 18: 手元・CI の compose.yaml（postgres:18）と同じメジャー版にし、マイグレーションの SQL の動きをそろえる。
  database_version = "POSTGRES_18"
  # Terraform からの削除（destroy や作り直しになる変更）を拒否する。下の deletion_protection_enabled は GCP 側の保護で、
  #   コンソールや gcloud からの削除も拒否する。WHY 両方: データを持つ唯一の resource で、消すと戻せない（バックアップも消える）。
  # stg では外せる（variables.tf の deletion_protection。作り直しを試すとき）。
  deletion_protection = var.deletion_protection

  settings {
    # WHY ENTERPRISE を明示: PostgreSQL 16 以降は、指定しないと Enterprise Plus（高価で db-f1-micro を使えない）になる。
    edition = "ENTERPRISE"
    # WHY db-f1-micro（共有コア、RAM 0.6GB、max_connections 25）: 試用の段階で最も安い（月 約 $12）。
    #   SLA の対象外。料金の比較と接続数の配分は docs/adr/tech-stack/20260930-gcp-cloud-run-and-cloud-sql.md と下の「接続数の予算」。
    #   足りなくなったら db-g1-small（+約 $18/月）か専用コアにする（環境ごとに variables.tf の sql_tier で変える）。
    #   tier を変えると max_connections も変わるので、下の予算を見直す。
    # 接続数の予算（max_connections 25 のうち、PostgreSQL の既定で 3 はスーパーユーザー用に予約）:
    #   アプリ 3 インスタンス x 3 = 9、migrate 1、Metabase 1 インスタンス x（アプリ DB 3 + 分析 3）= 6、
    #   残り 約 6 を Data Studio・psql・MCP に使う。
    tier              = var.sql_tier
    availability_type = "ZONAL" # 1 ゾーン。REGIONAL（HA）は料金が約 2 倍になるので試用では使わない。
    disk_type         = "PD_SSD"
    disk_size         = 10   # GB。最小。
    disk_autoresize   = true # 足りなくなったら自動で増やす（減らせない）。
    # GCP 側の削除保護（上の deletion_protection の WHY）。
    deletion_protection_enabled = var.deletion_protection
    # Cloud SQL の Data API（ExecuteSql）を許す。WHY: Cloud SQL のリモート MCP の execute_sql / execute_sql_readonly は、
    #   これが ALLOW_DATA_API でないと動かない（https://docs.cloud.google.com/sql/docs/postgres/use-cloudsql-mcp）。
    #   実行できるのは IAM の権限（cloudsql.instances.executeSql）を持つ IAM データベース認証のユーザーだけ。
    data_api_access = "ALLOW_DATA_API"

    backup_configuration {
      enabled = true
      # WHY PITR（ポイントインタイムリカバリ）を使わない: WAL の保存に追加の容量と料金がかかる。試用の段階では日次のバックアップ
      #   （最大 1 日分の損失）で足りる。
      point_in_time_recovery_enabled = false
      # バックアップの開始時刻（UTC）。18:00 UTC = 03:00 JST（利用の少ない時間）。
      start_time = "18:00"
      backup_retention_settings {
        retained_backups = var.sql_backup_retained_count # 日次なので、世代数 = 日数（既定 7。variables.tf）。
      }
    }

    ip_configuration {
      # 公開 IP を持たせる。WHY: Data Studio は Cloud SQL Auth Proxy を使わず公開 IP に接続する
      #   （https://docs.cloud.google.com/looker/docs/studio/connect-to-postgresql 「doesn't use the Cloud SQL proxy」）。
      #   Cloud Run の組み込み接続と Metabase の Auth Proxy も公開 IP の経路を使う（どちらも IAM で認可し、TLS で暗号化される）。
      #   Private IP（VPC）は Data Studio が「段階的に展開中」で、VPC コネクタ / Direct VPC egress の設定と費用が増えるので使わない。
      ipv4_enabled = true
      # 暗号化されていない接続を拒否する（クライアント証明書は求めない）。WHY: 公開 IP に直接つなぐ Data Studio の経路を
      #   平文にしない。Data Studio は TLS 1.2 に対応している（上の URL）。Cloud Run の組み込み接続と Auth Proxy は常に暗号化される。
      ssl_mode = "ENCRYPTED_ONLY"
      # 公開 IP への直接の接続を許す送信元。Auth Proxy・Cloud Run の組み込み接続は IAM で認可されるので、ここに書かなくてよい。
      authorized_networks {
        # Data Studio（旧 Looker Studio）のサーバーの IPv4 の範囲（上の URL の「IP addresses」。データ所在地を有効にした
        #   Data Studio Pro は 142.251.56.0/24 に変わる）。
        name  = "data-studio"
        value = "142.251.74.0/23"
      }
    }

    # IAM データベース認証を有効にする。WHY: Cloud SQL のリモート MCP で SQL を実行するのは IAM 認証のユーザーだけ
    #   （variables.tf の sql_iam_users）。パスワードのユーザー（app など）の接続には影響しない。
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }

  depends_on = [google_project_service.apis]
}

# アプリの DB。
resource "google_sql_database" "app" {
  name     = "app"
  instance = google_sql_database_instance.main.name
}

# Metabase のアプリ DB（Metabase 自身の設定・質問・ダッシュボードを保存する）。
# WHY 同じインスタンス: Metabase の既定の H2（コンテナ内のファイル）は Cloud Run では再起動で消える。別インスタンスは費用が増える。
resource "google_sql_database" "metabase" {
  name     = "metabase"
  instance = google_sql_database_instance.main.name
}

# DB ユーザー（パスワード認証）。
# 注意: google_sql_user で作ったユーザーは cloudsqlsuperuser ロールのメンバーになる（CREATEROLE / CREATEDB を持つ）。
#   WHY 読み取り専用ユーザー（Data Studio・Metabase の分析用）を Terraform で作らない: 読み取り専用にできないため。
#   psql で作る（infra/README.md）。
# deletion_policy = "ABANDON": destroy でこの resource を消すとき、DB のロールは消さずに Terraform の管理から外す。
#   WHY: PostgreSQL はテーブルなどを所有するロールを DROP できず、destroy が失敗するため。
resource "google_sql_user" "app" {
  name                = "app"
  instance            = google_sql_database_instance.main.name
  password_wo         = ephemeral.random_password.db_app.result
  password_wo_version = local.db_password_version.app
  deletion_policy     = "ABANDON"
}

resource "google_sql_user" "metabase" {
  name                = "metabase"
  instance            = google_sql_database_instance.main.name
  password_wo         = ephemeral.random_password.db_metabase.result
  password_wo_version = local.db_password_version.metabase
  deletion_policy     = "ABANDON"
}

# IAM データベース認証のユーザー（Cloud SQL の MCP 用。variables.tf の sql_iam_users）。
# PostgreSQL のユーザー名はメールアドレスそのもの。作った直後は DB 内の権限が無いので、psql で GRANT する（infra/README.md）。
resource "google_sql_user" "iam" {
  for_each = toset(var.sql_iam_users)
  name     = each.value
  instance = google_sql_database_instance.main.name
  type     = "CLOUD_IAM_USER"
}

# 接続情報の Secret。値は write-only（secret_data_wo）で送り、state に残さない。
# replication auto: Google がレプリカの場所を決める（最も安く、リージョンを選ぶ理由が無い）。

# アプリの DATABASE_URL（Cloud Run のアプリの service と migrate ジョブが読む）。
# WHY URL 全体を Secret に入れる（パスワードだけにしない）: アプリは DATABASE_URL の 1 つだけを読む（apps/shared/env.ts）。
#   Cloud Run の環境変数は「Secret の値」か「固定の文字列」のどちらかで、Secret の値を文字列に埋め込んで組み立てられない。
#   パスワードだけを Secret にすると、アプリ側に URL を組み立てるコードと環境変数（ホスト・DB 名など）が増える。
# 形: postgresql://<user>:<password>@/<db>?host=/cloudsql/<接続名>。host にディレクトリを渡すと pg（node-postgres）は
#   Unix ソケット（/cloudsql/<接続名>/.s.PGSQL.5432）に接続する。Cloud Run の組み込みの Cloud SQL 接続（run.tf の
#   cloud_sql_instance のボリューム）がそのソケットを置く（pg も drizzle-kit もこの形の URL でソケットに接続する）。
resource "google_secret_manager_secret" "database_url" {
  secret_id = "database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret                 = google_secret_manager_secret.database_url.id
  secret_data_wo         = "postgresql://${google_sql_user.app.name}:${ephemeral.random_password.db_app.result}@/${google_sql_database.app.name}?host=/cloudsql/${local.instance_connection_name}"
  secret_data_wo_version = local.db_password_version.app
}

# Metabase のアプリ DB の接続（MB_DB_CONNECTION_URI、JDBC の形）。
# WHY 127.0.0.1:5432: Metabase（Java）は Unix ソケットに接続できない（Cloud SQL の公式「Unix sockets are not natively
#   supported in Java」https://cloud.google.com/sql/docs/postgres/connect-run 。Metabase v0.63.18.2 の deps.edn に
#   Cloud SQL の Java Connector も junixsocket も無い）。同じインスタンス（Pod）のサイドカーの Cloud SQL Auth Proxy が
#   127.0.0.1:5432 で待ち受け、TLS と IAM の認可をして Cloud SQL につなぐ（metabase.tf）。ssl を URI に付けないのは、
#   暗号化が Proxy と Cloud SQL の間で行われ、Metabase と Proxy の間はインスタンスの中（ループバック）で閉じるため。
resource "google_secret_manager_secret" "metabase_db_uri" {
  secret_id = "metabase-db-uri"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "metabase_db_uri" {
  secret                 = google_secret_manager_secret.metabase_db_uri.id
  secret_data_wo         = "jdbc:postgresql://127.0.0.1:5432/${google_sql_database.metabase.name}?user=${google_sql_user.metabase.name}&password=${ephemeral.random_password.db_metabase.result}"
  secret_data_wo_version = local.db_password_version.metabase
}

resource "google_secret_manager_secret" "metabase_encryption_key" {
  secret_id = "metabase-encryption-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "metabase_encryption_key" {
  secret                 = google_secret_manager_secret.metabase_encryption_key.id
  secret_data_wo         = ephemeral.random_password.metabase_encryption_key.result
  secret_data_wo_version = local.metabase_encryption_key_version
}
