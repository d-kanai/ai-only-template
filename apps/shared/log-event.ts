// ログの 1 行の種類（event.name）に使える名前の一覧（Issue #209。ADR docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）。
// logger（./logger.ts）の LogEvent がこの型で event.name を縛るので、一覧に無い名前は型エラーになる（pnpm typecheck）。
//
// WHY event.name を全行に必須にする: Logs Explorer で jsonPayload.event.name="db_write" のように、ログの種類を 1 つの項目で
//   引けるようにする（message は人が読む文で、表記ゆれや文の変更で検索が壊れる）。OTel の Logs Data Model の EventName
//   （https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-eventname 。種類を一意に表す名前で、動的な部分を入れない）
//   に当たる。ECS の event.kind は値が粗い（ほぼ event）ので使わない。
// WHY 1 か所の定数にする: 名前を呼び出し側で自由に書けると、同じ種類に別の名前（db_write と repository_write など）が付き、
//   保存したクエリ・アラートが一部の行を拾わなくなる。一覧を見れば出うる種類がすべて分かる。
// WHY snake_case で動的な部分を入れない: 値の種類が有限の一覧になり、集計（種類ごとの件数）とアラートの条件に使える。
//   段階（start / done / failed）や対象（表の名前）は event.phase などの別の項目に入れる。
// WHY 値だけのファイルにする（logger.ts に書かない）: 一覧を足す・変える差分が、出力の仕組み（logger.ts）の差分と混ざらない。
//   型と定数だけで何も import しないので、logger と同じくどこから読んでも副作用が無い。
//
// 名前と、それを出す場所:
//   page_request      画面アクセスのリクエストログ（apps/frontend_customer/proxy.ts）
//   api_request       /api/** の呼び出しのリクエストログ（同上）
//   db_write          Repository の書き込みの前後（apps/backend/shared/infra/write.ts。event.phase が start / done / failed）
//   db_pool_error     アイドル中の Postgres の接続のエラー（apps/backend/shared/infra/database.ts）
//   server_error      API の想定外の例外（500。apps/backend/shared/presentation/problem.ts）
//   app_start_failed  起動時の検証の失敗（apps/frontend_customer/instrumentation-node.ts）
//   notification      通知の送信（notification モジュール。失敗は event.phase が failed）
//   logger_error      logger 自身が event を JSON にできなかった（./logger.ts が出す。呼び出し側は使わない）
export const LOG_EVENT_NAMES = [
  "page_request",
  "api_request",
  "db_write",
  "db_pool_error",
  "server_error",
  "app_start_failed",
  "notification",
  "logger_error",
] as const;

export type LogEventName = (typeof LOG_EVENT_NAMES)[number];
