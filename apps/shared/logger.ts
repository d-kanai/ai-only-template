// サーバ側のログの唯一の出口（Issue #85。環境変数の唯一の入口 env.ts と同じ位置づけ）。
// console.* を直接書いてよいのはこのファイルだけ（テストは除く）。Biome の suspicious/noConsole（biome.json の overrides）と
// rule-tests/architecture.test.ts の規則 console-direct-access の 2 系統で強制している（.claude/rules/backend.md・lint.md）。
// 置き場所は frontend と backend で共通の workspace パッケージ apps/shared（@repo/shared/logger。Issue #90 で apps/backend/shared/infra/
// から移した。frontend 直下の proxy.ts・instrumentation-node.ts と backend が使う。.claude/rules/shared.md）。
//
// WHY 1 か所に集める:
//   - 行の形（1 呼び出し = JSON 1 行。先頭に severity・time・message・event）をここで決め、呼び出し側ごとにずれないようにする。
//   - 出力先を変える（ファイル・外部のログ基盤に送る）ときに、直すのがこのファイルだけで済む。
// WHY 行の形を Cloud Logging の特別フィールドと OTel semconv の名前にする（Issue #209。ADR
//   docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）: デプロイ先の Cloud Run では、stdout / stderr の JSON の行
//   のうち基盤が読むのは特別フィールド（severity・time・message・logging.googleapis.com/trace など）だけ
//   （https://docs.cloud.google.com/logging/docs/agent/logging/configuration#special-fields 、https://docs.cloud.google.com/run/docs/logging ）。以前の level / timestamp（文字列）は
//   この一覧に無く、重大度と時刻が効かない。それ以外の項目は OTel semconv の名前（error.type など）にそろえ、別の基盤に
//   移っても意味が通るようにする。
// WHY 依存（pino など）を足さない: 今要るのは「1 行の JSON を stdout / stderr に出す」だけで、console で足りる。
//   ログの収集（ファイルへの保存・転送）は実行環境に任せる（ADR docs/adr/architecture/20260929-request-log-in-proxy.md と同じ方針）。
// WHY 中で console.log / console.warn / console.error を使う（process.stdout.write にしない）: 呼び出し側のテストが
//   vi.spyOn(console, ...) で「ログに残したこと」を確かめられるようにする。

import type { LogEventName } from "./log-event";
import { now } from "./now";

export type LogLevel = "info" | "warn" | "error";

// 1 行に載せる出来事（logger の引数。以下 entry）。キーと値はそのまま JSON にする（Error は { type, message } に変える）。
// WHY message と event.name を型で必須にする: message は Logs Explorer の一覧に出る表示の行（Cloud Logging の特別フィールド）、
//   event.name はログの種類（./log-event.ts の一覧）。どちらかが無い行は、一覧で何の行か分からず、種類で引いても拾えない。
//   書き忘れを実行時でなく型チェックで止める（logger.test.ts の @ts-expect-error が型を緩めると落ちる）。
// WHY event を入れ子のオブジェクトにする（"event.name" の平らなキーにしない）: Logs Explorer で jsonPayload.event.name と
//   書ける。平らなキーにすると jsonPayload."event.name" のように引用符が要る。段階（phase）や所要時間（duration_ms）も
//   event の中に置き、種類ごとの項目を 1 か所にまとめる。
// WHY 任意のキーを許す（[key: string]: unknown）: 種類ごとに載せる項目（http・db・error など）が違い、ここで全部を型にすると
//   logger が呼び出し側の事情を知ることになる。項目の名前は各呼び出し側のテストが行を丸ごと比べて固定する。
export type LogEvent = {
  message: string;
  event: { name: LogEventName; [key: string]: unknown };
  // 出来事の時刻（RFC 3339）。無ければ logger が現在時刻を入れる（下の toLine）。
  time?: string;
  [key: string]: unknown;
};

// level に対する Cloud Logging の LogSeverity の名前（https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity ）。
// WHY warn を WARNING にする: LogSeverity に WARN は無く、WARNING が正しい名前。一覧に無い値は重大度として読まれない
//   （DEFAULT になる）。
// WHY 対応表を関数の中に置く（最上位の定数にしない）: 最上位の値は Stryker の static な変異になり、ignoreStatic で検査から外れる
//   （.claude/rules/testing.md の mutation testing）。
function severityOf(level: LogLevel): "INFO" | "WARNING" | "ERROR" {
  const severities = {
    info: "INFO",
    warn: "WARNING",
    error: "ERROR",
  } as const satisfies Record<LogLevel, string>;
  return severities[level];
}

// WHY level ごとに console のメソッドを分ける: info は stdout（console.log）、warn / error は stderr（console.warn /
//   console.error）。実行環境が stderr を異常の出力として扱えるようにする。
const WRITERS: Record<LogLevel, (line: string) => void> = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

// JSON.stringify で JSON にできなかったとき（循環参照・BigInt・toJSON が例外を投げるなど）に出す文言。
const UNSERIALIZABLE_MESSAGE =
  "logger: event could not be serialized to JSON (circular reference, BigInt, etc.)";

// JSON.stringify の replacer。Error は { type, message } にする。
// WHY 変換する: Error の name / message / stack は列挙できないプロパティなので、そのまま JSON.stringify すると {} になり、
//   何が起きたかが行に残らない。
// WHY type と message の名前: OTel semconv の exception.type / exception.message、ECS の error.type / error.message と同じにする
//   （Error の name を type に入れる）。
// WHY stack は出さない: 1 行が長くなり、サーバのファイルのパスなど内部の情報も含むため。原因の特定は type と message で
//   足りる前提（足りなくなったら、出す内容をここで決め直す。Error Reporting に拾わせるには stack が要る。別 Issue）。
function replaceError(_key: string, value: unknown): unknown {
  return value instanceof Error
    ? { type: value.name, message: value.message }
    : value;
}

function toLine(level: LogLevel, entry: LogEvent): string {
  const severity = severityOf(level);
  // WHY now() から取る: 現在時刻の唯一の出口（now.ts）を通し、テストが時刻を差し替えて行を丸ごと比べられるようにする。
  // WHY toISOString: RFC 3339 の文字列（UTC の Z 付き）で、Cloud Logging の特別フィールド time が受け付ける形。
  const time = now().toISOString();
  try {
    // WHY { severity, time, message, event, ...rest } の順: 先頭に severity・time・message・event を置き、呼び出し側のキーの順に
    //   よらず、どの行も同じ並びで読めるようにする。後の ...rest は値を上書きするが、既にあるキーの位置は変えない。
    //   time は entry にあればそれを使う（リクエストの受信時刻など、出来事の時刻を優先する）。entry の time が undefined なら
    //   現在時刻に戻す（spread で undefined に上書きされ、行から time が消えるのを防ぐ）。
    // WHY 後から severity を代入し直す: severity は entry にあっても呼んだメソッドのものにする（出力先と重大度を食い違わせない）。
    //   既にあるキーへの代入なので、並びは先頭のまま。
    // WHY 分割代入と spread も try の中: entry の getter が例外を投げても、下の catch で「失敗した旨の 1 行」にして呼び出し側に
    //   伝えない。
    const { message, event, ...rest } = entry;
    const line: Record<string, unknown> = {
      severity,
      time,
      message,
      event,
      ...rest,
    };
    line.severity = severity;
    line.time ??= time;
    return JSON.stringify(line, replaceError);
  } catch {
    // WHY 例外で落とさない: ログの失敗で本来の処理（応答を返すなど）を止めない。entry の中身は出せないので、失敗した旨だけを
    //   同じ形（severity・time・message・event.name）の 1 行で残す。
    // WHY event.name を専用の logger_error にする（元の event.name を使わない）: 元の entry の読み取り自体が例外を投げうる（getter）
    //   ので、元の名前を確実に取れない。また元の名前（db_write など）で出すと、その種類で引いたときに種類ごとの項目（db など）の
    //   無い行が混ざる。専用の名前なら「ログを出せなかった」ことを 1 つの条件で引け、アラートにもできる。
    const name: LogEventName = "logger_error";
    return JSON.stringify({
      severity,
      time,
      message: UNSERIALIZABLE_MESSAGE,
      event: { name },
    });
  }
}

function write(level: LogLevel, entry: LogEvent): void {
  WRITERS[level](toLine(level, entry));
}

export const logger = {
  info: (entry: LogEvent): void => write("info", entry),
  warn: (entry: LogEvent): void => write("warn", entry),
  error: (entry: LogEvent): void => write("error", entry),
};
