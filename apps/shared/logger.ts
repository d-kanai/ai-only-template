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

import {
  LOG_EVENT_NAMES,
  LOG_EVENT_SCHEMAS,
  type LogEvent,
  type LogEventName,
  LogSeverity,
  type ParsedLogEvent,
  type Severity,
} from "./log-event";
import { Clock } from "./now";

// WHY 型を ./log-event.ts から export し直す: 呼び出し側（とテスト）は logger から LogEvent を読み、log-event.ts は公開しない
//   （apps/shared/package.json の exports に ./log-event を置かない。.claude/rules/shared.md）。
export type { LogEvent };

// parse に失敗した（event がスキーマに合わない・event.name が一覧に無い）ときに出す文言。
const SCHEMA_MISMATCH_MESSAGE =
  "logger: event does not match the schema of its event.name";
// event の読み取り（getter など）が例外を投げたときに出す文言。
const UNREADABLE_MESSAGE = "logger: reading the event threw an exception";

// WHY クラスにする（Issue #262）: apps/shared も最上位に関数を置かない（規則 class-based。ADR
//   docs/adr/architecture/20261002-class-based-shared-and-test-support.md）。補助は状態を使わないが、
//   private のインスタンスのメソッドにする（インスタンスで使うクラスに static を置かない（規則 no-static-in-instance-class。Issue #300））。
// WHY emit をインスタンスのメソッドにし、export するのはインスタンス logger だけにする: 呼び出し側の logger.emit(...) と
//   テストの vi.spyOn(logger, "emit") の書き方を変えない。クラスは export しない（logger を 1 つにし、別のインスタンスを作らせない）。
class Logger {
  // WHY 口を emit の 1 つにする（info / warn / error を置かない。Issue #216）: 重大度は種類（と phase）が決める（log-event.ts の
  //   LogSeverity.of）。呼び出し側が選べると、同じ種類の行が呼び出し側ごとに違う重大度になる。
  emit(event: LogEvent): void {
    const { severity, line } = this.toLine(event);
    this.writerOf(severity)(line);
  }

  // severity に対する console のメソッド。
  // WHY severity ごとに console のメソッドを分ける: INFO は stdout（console.log）、WARNING / ERROR は stderr（console.warn /
  //   console.error）。実行環境が stderr を異常の出力として扱えるようにする。
  // WHY 対応表をメソッドの中に置く（最上位の定数・static フィールドにしない）: 最上位の値は Stryker の static な変異になり、
  //   ignoreStatic で検査から外れる（.claude/rules/testing.md の mutation testing）。クラスの static フィールドの初期化も読み込み時に
  //   1 回だけ評価されるので、同じく外れるおそれがある（未確認。ADR docs/adr/architecture/20261002-class-based-backend.md）。
  private writerOf(severity: Severity): (line: string) => void {
    const writers = {
      INFO: (line: string) => console.log(line),
      WARNING: (line: string) => console.warn(line),
      ERROR: (line: string) => console.error(line),
    } satisfies Record<Severity, (line: string) => void>;
    return writers[severity];
  }

  // event.name に対するスキーマ。一覧に無い名前なら undefined。
  // WHY Object.hasOwn: "toString" のような Object.prototype のプロパティの名前で、スキーマでない値を引かないようにする。
  // WHY 型を z.ZodType の safeParse の形に広げる: スキーマの union のままだと、呼び出しのシグネチャが種類ごとに違い 1 つに
  //   まとまらない（どの種類でも「unknown を受けて成否と値を返す」ことだけを使う）。
  private schemaOf(
    name: unknown,
  ):
    | { safeParse: (value: unknown) => { success: boolean; data?: unknown } }
    | undefined {
    return typeof name === "string" && Object.hasOwn(LOG_EVENT_SCHEMAS, name)
      ? LOG_EVENT_SCHEMAS[name as LogEventName]
      : undefined;
  }

  // logger 自身が出す logger_error の 1 行。項目は固定（文言・event.name と、一覧にある名前なら失敗した種類の名前）で、
  //   呼び出し側の event の値を含めない。
  // WHY event.name を専用の logger_error にする（元の event.name を使わない）: 元の名前（db_write など）で出すと、その種類で
  //   引いたときに種類ごとの項目（db など）の無い行が混ざる。専用の名前なら「ログを出せなかった」ことを 1 つの条件で引け、
  //   アラートにもできる。
  private loggerErrorLine(
    time: string,
    message: string,
    failedName?: LogEventName,
  ): { severity: Severity; line: string } {
    return {
      severity: "ERROR",
      line: JSON.stringify({
        severity: "ERROR",
        time,
        message,
        event: { name: "logger_error", failed_name: failedName },
      }),
    };
  }

  private knownName(name: unknown): LogEventName | undefined {
    return LOG_EVENT_NAMES.find((known) => known === name);
  }

  private toLine(event: LogEvent): { severity: Severity; line: string } {
    // WHY Clock.now() から取る: 現在時刻の唯一の出口（now.ts）を通し、テストが時刻を差し替えて行を丸ごと比べられるようにする。
    // WHY toISOString: RFC 3339 の文字列（UTC の Z 付き）で、Cloud Logging の特別フィールド time が受け付ける形。
    const time = Clock.now().toISOString();
    try {
      // WHY スキーマで parse した結果だけを出す（Issue #216）: 一覧に無いキーは落ち（allowlist）、sensitive の項目は ***、自由文は
      //   正規表現を通る。呼び出し側は生の値を渡すだけで、マスクの判断はここ（と log-event.ts）に閉じる。
      // WHY parse の失敗で例外にしない（safeParse）: ログの失敗で本来の処理（応答を返すなど）を止めない。生の event は出さない
      //   （どの項目が sensitive かを決められない形なので）。
      const name: unknown = event.event?.name;
      const result = this.schemaOf(name)?.safeParse(event);
      if (!result?.success) {
        return this.loggerErrorLine(
          time,
          SCHEMA_MISMATCH_MESSAGE,
          this.knownName(name),
        );
      }
      const parsed = result.data as ParsedLogEvent;
      const severity = LogSeverity.of(parsed);
      // WHY { severity, time, message, event, ...rest } の順: 先頭に severity・time・message・event を置き、どの行も同じ並びで
      //   読めるようにする。残りはスキーマに書いた順（parse の結果の順）。rest に time があれば（リクエストの受信時刻など、
      //   出来事の時刻）それで上書きする。既にあるキーへの上書きなので、並びは先頭のまま。
      const { message, event: kind, ...rest } = parsed;
      return {
        severity,
        line: JSON.stringify({ severity, time, message, event: kind, ...rest }),
      };
    } catch {
      // WHY 例外で落とさない: event の getter が例外を投げても、呼び出し側に伝えず、読めなかった旨の 1 行を残す。元の event の
      //   読み取り自体が例外を投げうるので、失敗した種類の名前も出さない。
      return this.loggerErrorLine(time, UNREADABLE_MESSAGE);
    }
  }
}

export const logger = new Logger();
