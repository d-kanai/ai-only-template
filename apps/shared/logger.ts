// サーバ側のログの唯一の出口（Issue #85。環境変数の唯一の入口 env.ts と同じ位置づけ）。
// console.* を直接書いてよいのはこのファイルだけ（テストは除く）。Biome の suspicious/noConsole（biome.json の overrides）と
// rule-tests/architecture.test.ts の規則 console-direct-access の 2 系統で強制している（.claude/rules/backend.md・lint.md）。
// 置き場所は frontend と backend で共通の workspace パッケージ apps/shared（@repo/shared/logger。Issue #90 で apps/backend/shared/infra/
// から移した。frontend 直下の proxy.ts・instrumentation-node.ts と backend が使う。.claude/rules/shared.md）。
//
// WHY 1 か所に集める:
//   - 行の形（1 呼び出し = JSON 1 行。先頭に level と timestamp）をここで決め、呼び出し側ごとにずれないようにする。
//   - 出力先を変える（ファイル・外部のログ基盤に送る）ときに、直すのがこのファイルだけで済む。
// WHY 依存（pino など）を足さない: 今要るのは「1 行の JSON を stdout / stderr に出す」だけで、console で足りる。
//   ログの収集（ファイルへの保存・転送）は実行環境に任せる（ADR docs/adr/architecture/20260929-request-log-in-proxy.md と同じ方針）。
// WHY 中で console.log / console.warn / console.error を使う（process.stdout.write にしない）: 呼び出し側のテストが
//   vi.spyOn(console, ...) で「ログに残したこと」を確かめられるようにする。

import { now } from "./now";

export type LogLevel = "info" | "warn" | "error";

// 1 行に載せる出来事。キーと値はそのまま JSON にする（Error は { name, message } に変える）。
export type LogEvent = Record<string, unknown>;

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

// JSON.stringify の replacer。Error は { name, message } にする。
// WHY 変換する: Error の name / message / stack は列挙できないプロパティなので、そのまま JSON.stringify すると {} になり、
//   何が起きたかが行に残らない。
// WHY stack は出さない: 1 行が長くなり、サーバのファイルのパスなど内部の情報も含むため。原因の特定は name と message で
//   足りる前提（足りなくなったら、出す内容をここで決め直す）。
function replaceError(_key: string, value: unknown): unknown {
  return value instanceof Error
    ? { name: value.name, message: value.message }
    : value;
}

function toLine(level: LogLevel, event: LogEvent): string {
  // WHY now() から取る: 現在時刻の唯一の出口（now.ts）を通し、テストが時刻を差し替えて行を丸ごと比べられるようにする。
  const timestamp = now().toISOString();
  try {
    // WHY { level, timestamp, ...event } の順: 先頭に level と timestamp を置き、どの行も同じ並びで読めるようにする。
    //   timestamp は event にあればそれを使う（リクエストの受信時刻など、出来事の時刻を優先する）。event の timestamp が
    //   undefined なら現在時刻に戻す（spread で undefined に上書きされ、行から timestamp が消えるのを防ぐ）。
    // WHY 後から level を代入し直す: level は event にあっても呼んだメソッドのものにする（出力先と level を食い違わせない）。
    //   既にあるキーへの代入なので、並びは先頭のまま。
    // WHY spread も try の中: event の getter が例外を投げても、下の catch で「失敗した旨の 1 行」にして呼び出し側に伝えない。
    const line: LogEvent = { level, timestamp, ...event };
    line.level = level;
    line.timestamp ??= timestamp;
    return JSON.stringify(line, replaceError);
  } catch {
    // WHY 例外で落とさない: ログの失敗で本来の処理（応答を返すなど）を止めない。event の中身は出せないので、失敗した旨だけを
    //   同じ形の 1 行で残す。
    return JSON.stringify({
      level,
      timestamp,
      message: UNSERIALIZABLE_MESSAGE,
    });
  }
}

function write(level: LogLevel, event: LogEvent): void {
  WRITERS[level](toLine(level, event));
}

export const logger = {
  info: (event: LogEvent): void => write("info", event),
  warn: (event: LogEvent): void => write("warn", event),
  error: (event: LogEvent): void => write("error", event),
};
