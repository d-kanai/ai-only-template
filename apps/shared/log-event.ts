import { z } from "zod";
import { LogFieldMarks } from "./log-field-marks";
import { RequestLogSchema } from "./request-log-schema";

// ログの 1 行の種類（event.name）の一覧と、種類ごとの行の形（zod のスキーマ）とマスクの印（Issue #209・#216。ADR
//   docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）。logger（./logger.ts）は呼び出し側が渡した event を
//   ここのスキーマで parse した結果だけを出す。
// スキーマの組み立てに使うクラスは Issue #384 で別のファイルに分けた（1 ファイル 1 クラス。Biome の
//   style/noExcessiveClassesPerFile）: 印は ./log-field-marks.ts の LogFieldMarks、自由文の網とマスクした値は
//   ./free-text-mask.ts の FreeTextMask・MASK、リクエストログの形は ./request-log-schema.ts の RequestLogSchema、
//   重大度は ./log-severity.ts の LogSeverity。
//
// WHY event.name を全行に必須にする: Logs Explorer で jsonPayload.event.name="db_write" のように、ログの種類を 1 つの項目で
//   引けるようにする（message は人が読む文で、表記ゆれや文の変更で検索が壊れる）。OTel の Logs Data Model の EventName
//   （https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-eventname 。種類を一意に表す名前で、動的な部分を入れない）
//   に当たる。ECS の event.kind は値が粗い（ほぼ event）ので使わない。
// WHY 1 か所の定数にする: 名前を呼び出し側で自由に書けると、同じ種類に別の名前（db_write と repository_write など）が付き、
//   保存したクエリ・アラートが一部の行を拾わなくなる。一覧を見れば出うる種類がすべて分かる。
// WHY snake_case で動的な部分を入れない: 値の種類が有限の一覧になり、集計（種類ごとの件数）とアラートの条件に使える。
//   段階（start / done / failed）や対象（表の名前）は event.phase などの別の項目に入れる。
//
// 名前と、それを出す場所:
//   page_request      画面アクセスのリクエストログ（apps/frontend_customer/proxy.ts）
//   api_request       /api/** の呼び出しのリクエストログ（同上）
//   db_write          Repository の書き込みの 1 文ごとの前後（apps/backend/shared/drizzle/writer.ts。event.phase が start / done / failed）
//   db_pool_error     アイドル中の Postgres の接続のエラー（apps/backend/shared/drizzle/database.ts）
//   server_error      API の想定外の例外（500。apps/backend/shared/http/problem.ts）
//   health_check      ヘルスチェック（/api/health）で DB に問い合わせられなかった（503。event.phase が failed。
//                     apps/backend/features/health/internal/presentation/get-health.api.ts）
//   app_start_failed  起動時の検証の失敗（apps/frontend_customer/instrumentation-node.ts）
//   notification      通知の送信（notification モジュール。失敗は event.phase が failed）
//   logger_error      logger 自身が event を出せなかった（./logger.ts が出す。呼び出し側は使わない）
export const LOG_EVENT_NAMES = [
  "page_request",
  "api_request",
  "db_write",
  "db_pool_error",
  "server_error",
  "health_check",
  "app_start_failed",
  "notification",
  "logger_error",
] as const;

export type LogEventName = (typeof LOG_EVENT_NAMES)[number];

// 種類ごとの行の形。logger は event.name でここから 1 つを選び、parse した結果だけを出す。
// WHY z.object（.strict() にしない）: z.object は一覧に無いキーを既定で落とす（allowlist）。項目を足し忘れた値は出ないほうに
//   倒れる（fail closed）。.strict() は一覧に無いキーで parse を失敗させ、行そのもの（種類・段階など役に立つ項目）を失う。
// WHY message をすべて freeText にする: 多くは固定の文言だが、リクエストログはパスを含み、呼び出し側が変数を埋め込んでも
//   出口で網にかかるようにする。
// WHY 種類を足すときはここと LOG_EVENT_NAMES を同じ変更で直す（satisfies が過不足を型で止める）。
// 限界: この表は最上位の値なので、Stryker の static な変異になり ignoreStatic で検査から外れる。項目と印は logger.test.ts の
//   種類ごとの行の丸ごとの比較（番兵の値を含む）で固定する。
export const LOG_EVENT_SCHEMAS = {
  page_request: RequestLogSchema.of("page_request"),
  api_request: RequestLogSchema.of("api_request"),
  // 書き込みの 1 文ごとの前後と失敗（apps/backend/shared/drizzle/writer.ts）。表名・操作・行の id・制約の名前・SQLSTATE は DB と
  //   コードが決める名前で、利用者の値を含まない。DB のエラーの message は、Writer が pg のエラーの message の引用符の部分
  //   （入力値が入る）を *** にしてから error に渡す（DrizzleQueryError の message（SQL と値）は渡さない）。
  db_write: z.object({
    message: LogFieldMarks.freeText(),
    event: z.object({
      name: z.literal("db_write"),
      phase: z.enum(["start", "done", "failed"]),
      duration_ms: z.number().optional(),
    }),
    db: z.object({
      collection: z.object({ name: z.string() }),
      operation: z.object({ name: z.string() }),
      response: z.object({ status_code: z.string() }).optional(),
    }),
    row_id: z.string().optional(),
    // WHY .readonly(): 呼び出し側（Writer）は行の id を readonly の配列で持つ。入力の型を readonly にして、渡すための写しを要らなくする。
    row_ids: z.array(z.string()).readonly().optional(),
    constraint: z.string().optional(),
    // DB のエラー（DrizzleQueryError）の params（SQL に渡した値）。
    // WHY 要素をすべて sensitive にする（配列ごと落とさない）: 値は行の値そのもので、どれが個人情報かは分からない。個数（何個の
    //   値を渡した文か）だけは調査の手がかりに残す。Writer は生の params を渡し、ここで必ず *** になる。
    //   .readonly() は row_ids と同じ（Writer は readonly の配列のまま渡す）。
    params: z.array(LogFieldMarks.sensitive(z.unknown())).readonly().optional(),
    error: LogFieldMarks.error().optional(),
    // 後のログの、書いた行ごとの記録。before / after は DB の列名 → 値（insert の before・delete の after は null）。
    // WHY before / after に sensitive の印を付けない: どの列が個人情報かは表ごとに違い、このスキーマは表を知らない。Writer が
    //   schema.ts の列の分類表（public / sensitive。apps/backend/shared/drizzle/column-classification.ts）で sensitive の列と分類の
    //   無い列を *** にしてから渡す（分類は表の定義の隣で決め、書き忘れは型と rule-tests/schema.test.ts の
    //   column-classification が止める）。
    // WHY 必須（nullable）にする（optional にしない）: Writer は必ず渡す。省けると「値が無い」と「渡し忘れ」を見分けられない。
    changes: z
      .array(
        z.object({
          table: z.string(),
          row_id: z.string(),
          operation: z.string(),
          before: z.record(z.string(), z.unknown()).nullable(),
          after: z.record(z.string(), z.unknown()).nullable(),
        }),
      )
      .optional(),
  }),
  db_pool_error: z.object({
    message: LogFieldMarks.freeText(),
    event: z.object({ name: z.literal("db_pool_error") }),
    error: LogFieldMarks.error(),
  }),
  server_error: z.object({
    message: LogFieldMarks.freeText(),
    event: z.object({ name: z.literal("server_error") }),
    error: LogFieldMarks.error(),
  }),
  // ヘルスチェックで DB に問い合わせられなかった（Issue #107）。error は ping が投げた例外。
  // WHY server_error と分ける: 応答は 500 ではなく 503 で、例外は ProblemResponse.from を通らない（handler が捕まえずに報告で
  //   受け取る）。監視が DB の不通を「API の想定外の例外」と別の種類で引けるようにする。
  // WHY phase を必須にする: 行を出すのは失敗のときだけ（成功のたびに出すと監視の回数だけ行が増える）。名前に段階を入れない
  //   （冒頭）ので、notification と同じく失敗は phase: failed で表す。
  health_check: z.object({
    message: LogFieldMarks.freeText(),
    event: z.object({
      name: z.literal("health_check"),
      phase: z.literal("failed"),
    }),
    error: LogFieldMarks.error(),
  }),
  // 起動時の検証の失敗。環境変数の検証の失敗は error（欠けた変数の名前が message に入る）、タイムゾーンは time_zone。
  app_start_failed: z.object({
    message: LogFieldMarks.freeText(),
    event: z.object({ name: z.literal("app_start_failed") }),
    error: LogFieldMarks.error().optional(),
    time_zone: z.string().optional(),
  }),
  // 通知の送信と失敗。notification は送った本文（自由文）。
  notification: z.object({
    message: LogFieldMarks.freeText(),
    event: z.object({
      name: z.literal("notification"),
      phase: z.literal("failed").optional(),
    }),
    notification: LogFieldMarks.freeText().optional(),
    error: LogFieldMarks.error().optional(),
  }),
  // logger が出す行。failed_name は parse に失敗した種類の名前（一覧にある名前のときだけ）。
  // WHY message も freeText: 呼び出し側も logger_error を emit できる（型で止めていない）。logger の固定の文言は網に一致しない。
  logger_error: z.object({
    message: LogFieldMarks.freeText(),
    event: z.object({
      name: z.literal("logger_error"),
      failed_name: z.enum(LOG_EVENT_NAMES).optional(),
    }),
  }),
} satisfies { [Name in LogEventName]: z.ZodType };

type LogEventSchemas = typeof LOG_EVENT_SCHEMAS;

// logger.emit が受け取る値（parse の前。呼び出し側は生の値を渡す）。event.name で判別する union。
// WHY z.input（z.infer = z.output にしない）: 出力の型は sensitive の項目が "***" で、Error は { type, message } になった後の形。
//   呼び出し側が渡すのは変換の前の値（文字列・unknown の例外）なので、入力の型で縛る。
export type LogEvent = {
  [Name in LogEventName]: z.input<LogEventSchemas[Name]>;
}[LogEventName];

// parse した後の値（logger が 1 行にするもの）。
export type ParsedLogEvent = {
  [Name in LogEventName]: z.output<LogEventSchemas[Name]>;
}[LogEventName];

export type Severity = "INFO" | "WARNING" | "ERROR";
