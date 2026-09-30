// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LOG_EVENT_NAMES } from "./log-event";
import { type LogEvent, logger } from "./logger";
import { now } from "./now";

// logger（サーバ側のログの唯一の出口。Issue #85）の仕様。出力先は console の各メソッドを spy して確かめる。
// 行の形は Cloud Logging の特別フィールド（severity / time / message）と OTel semconv の名前（Issue #209。ADR
//   docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）。
// WHY console を spy する（stdout / stderr のストリームを直接見ない）: logger は console.log / console.warn / console.error
//   に 1 行の文字列を渡すだけで、ストリームへの書き込みは Node の console に任せている。呼び出し側のテスト
//   （problem.test.ts など）も同じく console を spy して、ログに残したことを確かめる。

const NOW = "2026-09-29T01:02:03.456Z";

// WHY 時計（now）を差し替える: 行の time は現在時刻の唯一の出口 now() から取る。決まった時刻で行を丸ごと比べるため。
vi.mock("./now");

const consoleMethods = ["log", "warn", "error"] as const;
type ConsoleMethod = (typeof consoleMethods)[number];

function spyConsole(): Record<ConsoleMethod, ReturnType<typeof vi.spyOn>> {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

// 1 回の呼び出しで、method に 1 つだけ渡された文字列（1 行）。
function onlyLine(
  spies: Record<ConsoleMethod, ReturnType<typeof vi.spyOn>>,
  method: ConsoleMethod,
): string {
  expect(spies[method].mock.calls).toHaveLength(1);
  const [args] = spies[method].mock.calls;
  expect(args).toHaveLength(1);
  const [line] = args as unknown[];
  expect(typeof line).toBe("string");
  return line as string;
}

function parsedLine(
  spies: Record<ConsoleMethod, ReturnType<typeof vi.spyOn>>,
  method: ConsoleMethod,
): Record<string, unknown> {
  return JSON.parse(onlyLine(spies, method)) as Record<string, unknown>;
}

// JSON にできなかったときの 1 行（severity だけが呼んだメソッドで変わる）。
function unserializableLine(severity: string): Record<string, unknown> {
  return {
    severity,
    time: NOW,
    message:
      "logger: event could not be serialized to JSON (circular reference, BigInt, etc.)",
    event: { name: "logger_error" },
  };
}

beforeEach(() => {
  vi.mocked(now).mockReturnValue(new Date(NOW));
});

afterEach(() => {
  vi.mocked(now).mockReset();
  vi.restoreAllMocks();
});

describe("logger", () => {
  // WHY info は stdout、warn / error は stderr: 実行環境（コンテナのログ収集など）が stderr を異常の出力として扱えるようにする。
  //   Node の console.log は stdout、console.warn / console.error は stderr に書く。
  // WHY severity は INFO / WARNING / ERROR: Cloud Logging が JSON の行から重大度として読むのは特別フィールド severity で、値は
  //   LogSeverity の名前（https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity 。warn は WARNING）。
  test.each([
    ["info", "log", "INFO"],
    ["warn", "warn", "WARNING"],
    ["error", "error", "ERROR"],
  ] as const)(
    "logger.%s は console.%s にだけ 1 行の JSON を 1 回渡し、先頭に severity（%s）と time（RFC 3339、UTC）を付ける",
    (level, method, severity) => {
      const spies = spyConsole();

      logger[level]({
        message: "todo created",
        event: { name: "db_write", phase: "done" },
        row_id: "t-1",
      });

      for (const other of consoleMethods.filter((m) => m !== method)) {
        expect(spies[other]).not.toHaveBeenCalled();
      }
      const parsed = parsedLine(spies, method);
      expect(parsed).toEqual({
        severity,
        time: NOW,
        message: "todo created",
        event: { name: "db_write", phase: "done" },
        row_id: "t-1",
      });
      // 行を目で追うとき、どの行も先頭が severity・time・message・event の順にそろう。
      expect(Object.keys(parsed)).toEqual([
        "severity",
        "time",
        "message",
        "event",
        "row_id",
      ]);
    },
  );

  test("呼び出し側のキーの順によらず、先頭は severity・time・message・event の順で、残りは渡した順のまま", () => {
    const spies = spyConsole();

    logger.info({
      b: 2,
      event: { name: "api_request" },
      a: 1,
      message: "GET /",
    });

    expect(Object.keys(parsedLine(spies, "log"))).toEqual([
      "severity",
      "time",
      "message",
      "event",
      "b",
      "a",
    ]);
  });

  test("event.name はキーを入れ子のまま出す（Logs Explorer で jsonPayload.event.name と書ける。ドット付きの平らなキーにしない）", () => {
    const spies = spyConsole();

    logger.info({ message: "x", event: { name: "page_request" } });

    const line = onlyLine(spies, "log");
    expect(line).toContain('"event":{"name":"page_request"}');
    expect(line).not.toContain('"event.name"');
  });

  test("event に time があればそれを使う（リクエストログの受信時刻など、出来事の時刻を優先する）", () => {
    const spies = spyConsole();

    logger.info({
      message: "GET /",
      event: { name: "page_request" },
      time: "2026-01-01T00:00:00.000Z",
    });

    expect(parsedLine(spies, "log")).toEqual({
      severity: "INFO",
      time: "2026-01-01T00:00:00.000Z",
      message: "GET /",
      event: { name: "page_request" },
    });
  });

  test("event の time が undefined なら現在時刻を使う（どの行も先頭に severity と time が残る）", () => {
    const spies = spyConsole();

    logger.info({
      message: "x",
      event: { name: "notification" },
      time: undefined,
    });

    const parsed = parsedLine(spies, "log");
    expect(parsed).toEqual({
      severity: "INFO",
      time: NOW,
      message: "x",
      event: { name: "notification" },
    });
    expect(Object.keys(parsed)).toEqual([
      "severity",
      "time",
      "message",
      "event",
    ]);
  });

  test("event に severity があっても、呼んだメソッドの severity で上書きする（出力先と重大度を食い違わせない）", () => {
    const spies = spyConsole();

    logger.error({
      severity: "INFO",
      message: "x",
      event: { name: "server_error" },
    });

    expect(parsedLine(spies, "error")).toEqual({
      severity: "ERROR",
      time: NOW,
      message: "x",
      event: { name: "server_error" },
    });
  });

  test("値に改行を含んでも 1 行で出す（NDJSON。改行は JSON の中でエスケープされる）", () => {
    const spies = spyConsole();

    logger.info({
      message: "1 行目\n2 行目\r\n3 行目",
      event: { name: "notification" },
    });

    const line = onlyLine(spies, "log");
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line)).toMatchObject({
      message: "1 行目\n2 行目\r\n3 行目",
    });
  });

  // WHY type と message: OTel semconv の exception.type / exception.message、ECS の error.type / error.message と同じ名前にする。
  test("Error は { type, message } にして出し、stack は出さない（ネストや配列の中も同じ）", () => {
    const spies = spyConsole();
    class RepositoryError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "RepositoryError";
      }
    }

    logger.error({
      message: "想定外の例外",
      event: { name: "server_error" },
      error: new Error("connection refused"),
      detail: { causes: [new TypeError("x is not a function")] },
      custom: new RepositoryError("not found"),
    });

    const line = onlyLine(spies, "error");
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR",
      time: NOW,
      message: "想定外の例外",
      event: { name: "server_error" },
      error: { type: "Error", message: "connection refused" },
      detail: {
        causes: [{ type: "TypeError", message: "x is not a function" }],
      },
      custom: { type: "RepositoryError", message: "not found" },
    });
    // WHY stack を出さない: 1 行が長くなり、ファイルのパスなど内部の情報も含む。原因の特定は type と message で足りる前提。
    expect(line).not.toContain("stack");
    expect(line).not.toContain("logger.test.ts");
  });

  test("event のプロパティ（getter）が例外を投げても呼び出し側に伝えず、失敗した旨の 1 行を出す", () => {
    const spies = spyConsole();
    const event = {
      message: "x",
      event: { name: "db_write" as const },
      get boom(): string {
        throw new Error("getter");
      },
    };

    expect(() => logger.error(event)).not.toThrow();

    expect(parsedLine(spies, "error")).toEqual(unserializableLine("ERROR"));
  });

  test.each([
    [
      "循環参照",
      (() => {
        const event: LogEvent = {
          message: "x",
          event: { name: "db_write" },
        };
        event.self = event;
        return event;
      })(),
    ],
    [
      "BigInt",
      { message: "x", event: { name: "db_write" as const }, count: BigInt(1) },
    ],
  ])(
    "%s で JSON にできない event は、例外で落とさず、失敗した旨と severity・time・event.name（logger_error）だけの 1 行を出す",
    (_kind, event) => {
      const spies = spyConsole();

      expect(() => logger.warn(event)).not.toThrow();

      expect(parsedLine(spies, "warn")).toEqual(unserializableLine("WARNING"));
    },
  );
});

describe("LogEvent の型（event.name の一覧と message の必須）", () => {
  // WHY 一覧を固定する: event.name は Logs Explorer で jsonPayload.event.name="<名前>" と引くための値で、名前を変えると
  //   保存したクエリ・アラートが黙って空になる。足す・変えるときはこのテストと ADR を同じ変更で直す。
  test("event.name に使える名前は、決めた一覧だけ（snake_case）", () => {
    expect(LOG_EVENT_NAMES).toEqual([
      "page_request",
      "api_request",
      "db_write",
      "db_pool_error",
      "server_error",
      "app_start_failed",
      "notification",
      "logger_error",
    ]);
  });

  // 型の検査（pnpm typecheck）で固定する。下の各行の ts-expect-error の指示の行が型エラーにならなければ、tsc が「使われていない
  //   指示」（TS2578）で失敗するので、型を緩めると typecheck が落ちる。実行時の出力は見ない（呼ぶだけ）。
  test("一覧に無い event.name・event の無い呼び出し・message の無い呼び出しは型エラーになる", () => {
    spyConsole();

    // @ts-expect-error 一覧に無い名前
    logger.info({ message: "x", event: { name: "todo_created" } });
    // @ts-expect-error event が無い
    logger.info({ message: "x" });
    // @ts-expect-error event.name が無い
    logger.info({ message: "x", event: { phase: "start" } });
    // @ts-expect-error message が無い
    logger.info({ event: { name: "db_write" } });
    // @ts-expect-error message が文字列でない
    logger.info({ message: 1, event: { name: "db_write" } });

    expect(console.log).toHaveBeenCalledTimes(5);
  });
});
