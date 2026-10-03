// 行の重大度（logger.ts が使う。Issue #216）。
// WHY log-event.ts から分けた（Issue #384）: 本番のコードは 1 ファイル 1 クラス（Biome の style/noExcessiveClassesPerFile）・
//   1 ファイル 300 行以内（style/noExcessiveLinesPerFile）にする。log-event.ts（種類の一覧とスキーマ）と同じく exports に
//   置かない内部のファイルで、apps/shared の中から相対パスで読む（.claude/rules/code/shared.md）。

import type { LogEventName, ParsedLogEvent, Severity } from "./log-event";

// 行の重大度（Cloud Logging の LogSeverity の名前。https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity ）。
// WHY 種類と phase が決める（呼び出し側が選ばない）: 同じ種類の行が呼び出し側ごとに違う重大度になると、重大度で絞ったアラートが
//   一部の行を拾わない（Issue #216）。
// WHY db_write の失敗は WARNING: 500 になる想定外の例外は presentation の ProblemResponse.from が server_error（ERROR）で別に残す。
//   書き込みの失敗の多くは制約違反など想定内（409 / 400 にする）もの。
// WHY notification の失敗は ERROR: 通知の失敗は応答を 500 にしないので server_error の行が出ず、この行が唯一の手がかり。
// WHY 対応表をメソッドの中に置く（最上位の定数・static フィールドにしない）: 最上位の値は Stryker の static な変異になり、
//   ignoreStatic で検査から外れる。static フィールドも同じく外れるおそれがある（未確認）。
// WHY クラスの static メソッドにする: LogFieldMarks と同じ（Issue #262）。
export class LogSeverity {
  static of(event: ParsedLogEvent): Severity {
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
}
