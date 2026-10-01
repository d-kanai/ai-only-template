import { z } from "zod";

// ログの 1 行の種類（event.name）の一覧と、種類ごとの行の形（zod のスキーマ）とマスクの印（Issue #209・#216。ADR
//   docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）。logger（./logger.ts）は呼び出し側が渡した event を
//   ここのスキーマで parse した結果だけを出す。
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
//   db_write          Repository の書き込みの 1 文ごとの前後（apps/backend/shared/infra/writer.ts。event.phase が start / done / failed）
//   db_pool_error     アイドル中の Postgres の接続のエラー（apps/backend/shared/infra/database.ts）
//   server_error      API の想定外の例外（500。apps/backend/shared/presentation/problem.ts）
//   app_start_failed  起動時の検証の失敗（apps/frontend_customer/instrumentation-node.ts）
//   notification      通知の送信（notification モジュール。失敗は event.phase が failed）
//   logger_error      logger 自身が event を出せなかった（./logger.ts が出す。呼び出し側は使わない）
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

// マスクした値。WHY 固定の *** にする（ハッシュ・HMAC にしない）: 突き合わせの用途が今は無く、ハッシュは仮名化で GDPR 上は
//   個人データのまま（Issue #216 の採用しなかった案）。要るようになったら sensitive() の置換をここで差し替える。
export const MASK = "***";

// マスクの印 1: 値を常に *** にする（利用者の入力・利用者に由来するヘッダの値など、値そのものが個人情報になりうる項目）。
//   null を残すときは外側に .nullable() を付ける（sensitive(z.string()).nullable()。値が無いことは個人情報ではない。Issue #216 の
//   既定の判断）。
// WHY transform で置き換える（zod の .meta() で印を付けて logger が見る形にしない）: .meta() の印は .optional() などで包むと
//   外側のスキーマに引き継がれず、logger から見えなくなる（Issue #216 の調査）。transform なら、どう包んでも parse の結果が必ず
//   *** になり、印の読み落としが起きない。
// WHY 包んだスキーマの検査を残す（z.any() にしない）: 形の違う値（文字列のはずの項目に数値など）は parse の失敗にし、呼び出し側の
//   取り違えを logger_error の行で気づけるようにする。
export function sensitive<T extends z.ZodType>(schema: T) {
  return schema.transform((): typeof MASK => MASK);
}

// マスクの印 2: 自由文（例外の message など、決まった形の無い文）。値は出すが、maskFreeText の正規表現で既知の形の個人情報・
//   秘密を *** にする（最後の網）。
// WHY 自由文にだけ使う（全項目に正規表現をかけない）: 正規表現は見逃し・誤検知があり、値を出すかどうかの主な判断はスキーマの
//   一覧（allowlist）と sensitive の印で行う。形の決まった項目（id・表名など）に正規表現をかけても得るものが無い。
export function freeText() {
  return z.string().transform(maskFreeText);
}

// 自由文の上限の文字数と、切ったときに付ける印。
function freeTextLimit(): { maxLength: number; marker: string } {
  return { maxLength: 2000, marker: "...[truncated]" };
}

// 自由文から、メールアドレス・JWT・Bearer のトークン・Luhn に合う 13〜19 桁の番号を *** にする。長すぎる文は先に切る。
// WHY この 4 つ: 例外の message やパスに紛れ込みやすく、形で見分けられ、誤検知が少ないもの（Issue #216 の調査。電話番号は
//   桁と区切りの形がほかの数字（日付・id・件数）と重なり誤検知が多いので入れない）。
// WHY どの正規表現も入れ子の量指定子を使わない（(a+)+ のような形を書かない）: 入れ子の量指定子は、一致しかけて外れる入力で
//   バックトラックが指数的に増える（ReDoS。/^([a-zA-Z]+)*$/ は 31 文字で 60 秒。Issue #216 の実測）。logger は要求の処理の中で
//   同期に動くので、1 行のログで要求が止まる。各パターンは 1 つの量指定子の連続と固定の文字だけにし、開始位置は後読み（(?<!...)）で
//   連続の先頭に限る（連続の途中から始めて同じ文字を読み直さない）。時間の上限は log-event.test.ts が 10 万文字で測る。
// WHY 置換の順（Bearer → JWT → メール → 番号）: Bearer の後のトークンが JWT のときに、トークンごと（Bearer を含めて）1 つの ***
//   にする（先に JWT を置き換えると "Bearer ***" が残り、Bearer の正規表現が * に一致しない）。
// WHY 関数の中に正規表現を書く（最上位の定数にしない）: 最上位の値は Stryker の static な変異になり、ignoreStatic で検査から外れる
//   （.claude/rules/testing.md の mutation testing）。
export function maskFreeText(text: string): string {
  return truncate(text)
    .replace(/\bBearer\s+[\w.~+/-]+=*/gi, MASK)
    .replace(/eyJ[\w.-]+/g, MASK)
    .replace(/(?<![\w.%+-])[\w.%+-]+@[\w-]+\.[\w.-]+/g, MASK)
    .replace(
      /(?<!\d)(?:\d{13,19}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7})(?!\d)/g,
      (match) => (isCardNumber(match.replace(/[ -]/g, "")) ? MASK : match),
    );
}

// 上限を超える文を、上限以内の最後の空白までに切り、印を付ける。
// WHY 先に切る: 正規表現の時間は文の長さに比例するので、上限で時間も決まる。ログの 1 行の大きさ（費用・読みやすさ）も抑える。
// WHY 切った位置にかかった語を捨てる: 途中で切れたメールアドレスやトークン（"alice@exa"）は正規表現に一致せず、断片が
//   そのまま出てしまう。空白の無い長い文は全体が 1 語なので、本文を出さず印だけにする。
// WHY 空白を後ろから 1 文字ずつ探す（/\s\S*$/ にしない）: /\S*$/ は各位置から末尾まで読み直し、空白の無い長い文で 2 乗の時間になる。
function truncate(text: string): string {
  const { maxLength, marker } = freeTextLimit();
  if (text.length <= maxLength) {
    return text;
  }
  const head = text.slice(0, maxLength);
  let end = head.length;
  while (end > 0 && !/\s/.test(head[end - 1])) {
    end -= 1;
  }
  return `${head.slice(0, end).trimEnd()}${marker}`;
}

// 数字の列が Luhn のチェックディジットに合うか（カード番号の形。ISO/IEC 7812）。
// WHY Luhn で確かめる: 13〜19 桁の数字だけで置き換えると、件数・時刻（ミリ秒の 13 桁）・注文番号なども消える。Luhn に偶然
//   合うのは 10 件に 1 件で、誤検知を減らせる。
// WHY 桁数をここで確かめない: 呼び出し元（maskFreeText）の正規表現が 13〜19 桁の列だけを渡す（4 桁ずつ区切る形も 13〜19 桁）。
function isCardNumber(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const digit = Number(digits[digits.length - 1 - i]);
    const doubled = i % 2 === 1 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

// 例外の項目（error）の形: { type, message }。message は自由文。
// WHY Error を { type, message } にする: Error の name / message は列挙できないプロパティで、そのまま parse・JSON にすると
//   空になる。名前は OTel semconv の exception.type / exception.message、ECS の error.type / error.message と同じにする。
// WHY stack は出さない（スキーマに無い）: 1 行が長くなり、サーバのファイルのパスなど内部の情報も含むため。
// WHY Error でない値は { type: typeof } にする（値を出さない）: throw は文字列・オブジェクトなど何でも投げられ、中身が何か
//   分からない（利用者の入力を含みうる）。type（文字列）を持つオブジェクトだけはそのまま渡す（Writer が DB のエラーを
//   { type: <pg のエラーの name>, message: <引用符の部分を *** にした pg の message> } で渡す。apps/backend/shared/infra/writer.ts）。
// WHY 入力の型を unknown にする（z.preprocess）: 呼び出し側は catch で受けた unknown をそのまま渡す。変換は logger の中で行う。
function errorField() {
  return z.preprocess(
    toErrorShape,
    z.object({ type: z.string(), message: freeText().optional() }),
  );
}

function toErrorShape(value: unknown): unknown {
  if (value instanceof Error) {
    return { type: value.name, message: value.message };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  ) {
    return value;
  }
  return { type: typeof value };
}

// リクエストログ（page_request / api_request）の形。項目と取り方は apps/frontend_customer/shared/request-log/request-log.ts。
// 印（Issue #216）:
//   - sensitive: url.query の値（検索語・メールアドレス・トークンなど利用者の入力）、referer（URL のクエリを含みうる）、
//     client.address（接続元の IP アドレス。GDPR では個人データ）。
//   - freeText: message と url.path（パスは利用者が決められ、/users/<メール> のような形がありうる）と url.query のキー。
//   - そのまま: method・accept・content-type・user_agent.original・host（server.address）・x-request-id（http.request.id。
//     応答ヘッダと突き合わせる相関 ID）・traceparent から作った trace の 3 つ（Cloud Trace との結び付けに要る）。
function requestSchema<Name extends "page_request" | "api_request">(
  name: Name,
) {
  return z.object({
    message: freeText(),
    event: z.object({ name: z.literal(name) }),
    time: z.string(),
    http: z.object({
      request: z.object({
        id: z.string(),
        method: z.string(),
        header: z.object({
          referer: sensitive(z.string()).nullable(),
          accept: z.string().nullable(),
          "content-type": z.string().nullable(),
        }),
        body: z.object({ size: z.number().nullable() }),
      }),
    }),
    url: z.object({
      path: freeText(),
      query: z.record(freeText(), sensitive(z.string())),
    }),
    client: z.object({ address: sensitive(z.string()).nullable() }),
    user_agent: z.object({ original: z.string().nullable() }),
    server: z.object({ address: z.string().nullable() }),
    user: z.object({ id: z.null() }),
    "logging.googleapis.com/trace": z.string().optional(),
    "logging.googleapis.com/spanId": z.string().optional(),
    "logging.googleapis.com/trace_sampled": z.boolean().optional(),
  });
}

// 種類ごとの行の形。logger は event.name でここから 1 つを選び、parse した結果だけを出す。
// WHY z.object（.strict() にしない）: z.object は一覧に無いキーを既定で落とす（allowlist）。項目を足し忘れた値は出ないほうに
//   倒れる（fail closed）。.strict() は一覧に無いキーで parse を失敗させ、行そのもの（種類・段階など役に立つ項目）を失う。
// WHY message をすべて freeText にする: 多くは固定の文言だが、リクエストログはパスを含み、呼び出し側が変数を埋め込んでも
//   出口で網にかかるようにする。
// WHY 種類を足すときはここと LOG_EVENT_NAMES を同じ変更で直す（satisfies が過不足を型で止める）。
// 限界: この表は最上位の値なので、Stryker の static な変異になり ignoreStatic で検査から外れる。項目と印は logger.test.ts の
//   種類ごとの行の丸ごとの比較（番兵の値を含む）で固定する。
export const LOG_EVENT_SCHEMAS = {
  page_request: requestSchema("page_request"),
  api_request: requestSchema("api_request"),
  // 書き込みの 1 文ごとの前後と失敗（apps/backend/shared/infra/writer.ts）。表名・操作・行の id・制約の名前・SQLSTATE は DB と
  //   コードが決める名前で、利用者の値を含まない。DB のエラーの message は、Writer が pg のエラーの message の引用符の部分
  //   （入力値が入る）を *** にしてから error に渡す（DrizzleQueryError の message（SQL と値）は渡さない）。
  db_write: z.object({
    message: freeText(),
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
    params: z.array(sensitive(z.unknown())).readonly().optional(),
    error: errorField().optional(),
    // 後のログの、書いた行ごとの記録。before / after は DB の列名 → 値（insert の before・delete の after は null）。
    // WHY before / after に sensitive の印を付けない: どの列が個人情報かは表ごとに違い、このスキーマは表を知らない。Writer が
    //   schema.ts の列の分類表（public / sensitive。apps/backend/shared/infra/column-classification.ts）で sensitive の列と分類の
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
    message: freeText(),
    event: z.object({ name: z.literal("db_pool_error") }),
    error: errorField(),
  }),
  server_error: z.object({
    message: freeText(),
    event: z.object({ name: z.literal("server_error") }),
    error: errorField(),
  }),
  // 起動時の検証の失敗。環境変数の検証の失敗は error（欠けた変数の名前が message に入る）、タイムゾーンは time_zone。
  app_start_failed: z.object({
    message: freeText(),
    event: z.object({ name: z.literal("app_start_failed") }),
    error: errorField().optional(),
    time_zone: z.string().optional(),
  }),
  // 通知の送信と失敗。notification は送った本文（自由文）。
  notification: z.object({
    message: freeText(),
    event: z.object({
      name: z.literal("notification"),
      phase: z.literal("failed").optional(),
    }),
    notification: freeText().optional(),
    error: errorField().optional(),
  }),
  // logger が出す行。failed_name は parse に失敗した種類の名前（一覧にある名前のときだけ）。
  logger_error: z.object({
    message: z.string(),
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

// 行の重大度（Cloud Logging の LogSeverity の名前。https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity ）。
// WHY 種類と phase が決める（呼び出し側が選ばない）: 同じ種類の行が呼び出し側ごとに違う重大度になると、重大度で絞ったアラートが
//   一部の行を拾わない（Issue #216）。
// WHY db_write の失敗は WARNING: 500 になる想定外の例外は presentation の toProblemResponse が server_error（ERROR）で別に残す。
//   書き込みの失敗の多くは制約違反など想定内（409 / 400 にする）もの。
// WHY notification の失敗は ERROR: 通知の失敗は応答を 500 にしないので server_error の行が出ず、この行が唯一の手がかり。
// WHY 対応表を関数の中に置く（最上位の定数にしない）: 最上位の値は Stryker の static な変異になり、ignoreStatic で検査から外れる。
export function severityOf(event: ParsedLogEvent): Severity {
  const severities = {
    page_request: "INFO",
    api_request: "INFO",
    db_write: "INFO",
    db_pool_error: "ERROR",
    server_error: "ERROR",
    app_start_failed: "ERROR",
    notification: "INFO",
    logger_error: "ERROR",
  } as const satisfies Record<LogEventName, Severity>;
  const { event: kind } = event;
  if ("phase" in kind && kind.phase === "failed") {
    return kind.name === "db_write" ? "WARNING" : "ERROR";
  }
  return severities[kind.name];
}
