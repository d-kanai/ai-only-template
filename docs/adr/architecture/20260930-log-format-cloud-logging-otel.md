# ログの 1 行は Cloud Logging の特別フィールドと OTel semconv の名前（入れ子）にし、種類を event.name の固定の一覧で全行に出す

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #209 / `.claude/rules/backend.md` / `.claude/rules/frontend.md` / `.claude/rules/shared.md` / `.claude/rules/env.md` / `apps/shared/logger.ts` / `apps/shared/log-event.ts` / `apps/frontend_customer/shared/request-log/request-log.ts` / `apps/backend/shared/infra/write.ts` / ADR `architecture/20260929-logger-single-exit.md` / ADR `architecture/20260929-request-log-in-proxy.md` / ADR `architecture/20260930-repository-write-log.md`

## 背景
ログの 1 行は、先頭に `level`・`timestamp`（ADR `architecture/20260929-logger-single-exit.md`）、リクエストログは 5W1H の独自のキー（`requestId`・`kind`・`path` など。ADR `architecture/20260929-request-log-in-proxy.md`）だった。デプロイ先の Cloud Run で Cloud Logging が JSON の行から読むのは特別フィールドだけで、`level` と文字列の `timestamp` はその一覧に無く、重大度と時刻が効かない見込みだった。ログの種類を表す共通の項目も無かった（2026-09-30 の work-logs「ログの規格の調査結果」）。ユーザーは規格に合わせ、種類を `api_request` のような名前で全行に出すことを選んだ（同日の work-logs「ユーザー判断: ログを Cloud Logging …」）。

## 決定
- 基盤が読むキーは Cloud Logging の特別フィールドにする。それ以外は OTel semconv の名前を入れ子のオブジェクトにする（`jsonPayload.http.request.method` と書ける）。依存は足さない（`logger.ts` の中の対応とキー名の変更だけ）。
- 行の先頭は `severity`・`time`・`message`・`event` の順。`message` と `event.name` は `LogEvent` の型で必須にし、`event.name` の値は `apps/shared/log-event.ts` の `LOG_EVENT_NAMES` の一覧だけ（一覧に無い名前は型エラー）。

| キー | 値 | 出典 |
| --- | --- | --- |
| `severity` | `INFO`（info）/ `WARNING`（warn）/ `ERROR`（error） | Cloud Logging の特別フィールド・LogSeverity |
| `time` | RFC 3339（`toISOString()`）。event に `time` があればそれ（リクエストの受信時刻） | Cloud Logging の特別フィールド |
| `message` | 人が読む英語の 1 文（Logs Explorer の一覧の行） | Cloud Logging の特別フィールド |
| `event.name` | `page_request` / `api_request` / `db_write` / `db_pool_error` / `server_error` / `app_start_failed` / `notification` / `logger_error` | OTel Logs Data Model の EventName |
| `event.phase` | `db_write` の `start` / `done` / `failed`、`notification` の失敗の `failed` | 独自 |
| `event.duration_ms` | `db_write` の done / failed の所要時間（ミリ秒の整数） | 独自 |
| `error` | `{ type, message }`（Error の name と message。DB のエラーは `{ type }` だけ） | OTel の exception.type / exception.message、ECS の error.type / error.message |
| `http.request.id` / `.method` / `.header.{referer, accept, content-type}` / `.body.size` | リクエストログ | OTel semconv の HTTP（id は `x-request-id`。規格の名前ではない） |
| `url.path` / `url.query_keys` | リクエストログ（クエリは値を出さずキーだけ） | OTel semconv の url.path（query_keys は独自） |
| `client.address` / `user_agent.original` / `server.address` / `user.id` | リクエストログ（`user.id` は認証が入るまで null） | OTel semconv |
| `logging.googleapis.com/trace` / `spanId` / `trace_sampled` | リクエストログだけ。`traceparent`（W3C）があれば `projects/<GCP_PROJECT_ID>/traces/<trace-id>`・parent-id・flags の bit 0。形が違えば 3 つとも出さない | Cloud Logging の特別フィールド、W3C Trace Context |
| `db.collection.name` / `db.operation.name` / `db.response.status_code` | 書き込みのログ（表名・`insert` / `update` / `delete`・SQLSTATE） | OTel semconv の DB |

- JSON にできない行も同じ形（`severity`・`time`・`message`・`event.name` = `logger_error`）にする。元の `event.name` は使わない（元の値の読み取り自体が例外を投げうる。元の種類で引いたときに種類ごとの項目の無い行が混ざる）。
- `GCP_PROJECT_ID` を `env.ts` の必須の変数に足し（開発・CI は `.env.example` の `local`）、Cloud Run の service と migrate の job に Terraform の `var.project_id` を渡す（job も `env.ts` を通る）。
- 通知の送信の失敗は `server_error` ではなく `notification`（`phase: failed`）。`server_error` は HTTP の境界の 500（`toProblemResponse`）だけの種類にする。
- 置き換える決定: ADR `architecture/20260929-logger-single-exit.md` の「先頭に `level` と `timestamp`」「`Error` は `{ name, message }`」と、ADR `architecture/20260929-request-log-in-proxy.md` の 5W1H のキー名（`requestId`・`kind` など）と、ADR `architecture/20260930-repository-write-log.md` のログのキー名と文言（`repository write start` など）。logger を唯一の出口にすること・Proxy で 1 リクエスト 1 行を出すこと・書き込みの入口の決定そのものは変えないので、3 つの ADR の状態は「採用」のまま。

## 理由
- Cloud Run の stdout / stderr の JSON の行で基盤が読むのは特別フィールド（`severity`・`message`・`time`・`logging.googleapis.com/trace` など）だけ（https://docs.cloud.google.com/logging/docs/agent/logging/configuration#special-fields 、https://docs.cloud.google.com/run/docs/logging ）。`severity` の値は LogSeverity の名前（https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity 。`WARN` は無く `WARNING`）。
- OTel の Logs Data Model（https://opentelemetry.io/docs/specs/otel/logs/data-model/ ）が業界共通のデータモデルで、ECS は OTel に寄贈され統合が進んでいる（https://www.elastic.co/blog/ecs-elastic-common-schema-otel-opentelemetry-announcement ）。属性の名前は OTel semconv（https://opentelemetry.io/docs/specs/semconv/http/http-spans/ 、https://opentelemetry.io/docs/specs/semconv/registry/attributes/db/ ）にそろえ、基盤を移っても対応表が要らないようにする。
- 種類は OTel の EventName（種類を一意に表す名前。動的な部分を入れない）に当たる。固定の一覧にして型で縛れば、同じ種類に別の名前が付いて保存したクエリ・アラートが一部の行を拾わなくなることを防げる（原則 7。typecheck で止まる）。段階は `event.phase` に分け、一覧を段階の数だけ増やさない。
- trace は Cloud Run が付ける W3C の `traceparent`（https://docs.cloud.google.com/run/docs/trace ）から作る。W3C の仕様は、形の違う・すべて 0 の trace-id / parent-id の `traceparent` を無視することを求める（https://www.w3.org/TR/trace-context/#traceparent-header ）。Cloud Run が自動で付ける環境変数にプロジェクト ID は無い（https://docs.cloud.google.com/run/docs/container-contract ）ので、`env.ts` で受け取る。

## 採用しなかった案
- OTLP の JSON（`resourceLogs` / `scopeLogs` / `logRecords` の入れ子）で出す: Cloud Logging の特別フィールドにならず、重大度・時刻・trace が効かない。コレクタも今は無い。
- pino の既定の形（`level` が数値 30 / 40 / 50、`time` がエポックのミリ秒）: Cloud Logging は数値の `level` もエポックの `time` も特別フィールドとして読まず、依存も増える。
- 平らなドット付きのキー（`"http.request.method"`）: Logs Explorer で `jsonPayload."http.request.method"` と引用符が要り、同じ接頭辞の項目をまとめて読めない。
- ECS の `event.kind` で種類を表す: 値が粗く（ほぼ `event`）、ログの種類（リクエスト・書き込みなど）を表せない。
- 種類ごとに段階を別の名前にする（`db_write_start` など）: 1 回の書き込みの前後を 1 つの条件で引けず、一覧が段階の数だけ増える。

## 影響
- 良い点: Cloud Logging で重大度・時刻・trace が効く見込みで、どの行も `jsonPayload.event.name` で種類を引ける。種類の名前の打ち間違い・書き忘れは型チェックで止まる。
- 悪い点: 実機（Cloud Run）での `severity` / `time` / trace の扱い、リクエストログと Cloud Run のリクエストログの結び付きは未確認（`gcloud logging read` で確かめる）。backend のログ（書き込み・500）には trace が無い（AsyncLocalStorage での伝播は別 Issue）。Error Reporting は stack か `@type` が無いと拾わない（https://docs.cloud.google.com/error-reporting/docs/formatting-error-messages 。別 Issue）。`server.address` は Host ヘッダのままでポートを含みうる（OTel の server.address はポートを含まない名前）。
- 見直す条件: 実機で特別フィールドが効かないと分かったとき、OTel のコレクタや OTLP を入れるとき、backend のログに trace を伝えるとき。
