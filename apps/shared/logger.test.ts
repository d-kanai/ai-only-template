// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LogEventName } from "./log-event";
import { type LogEvent, logger } from "./logger";
import { Clock } from "./now";

// logger（サーバ側のログの唯一の出口。Issue #85）の仕様。出力先は console の各メソッドを spy して確かめる。
// 行の形は Cloud Logging の特別フィールド（severity / time / message）と OTel semconv の名前（Issue #209。ADR
//   docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）。種類ごとの項目は ./log-event.ts のスキーマで決まり、
//   一覧に無いキーは落ち、印（sensitive / freeText）の付いた値は *** にマスクされる（Issue #216）。
// WHY console を spy する（stdout / stderr のストリームを直接見ない）: logger は console.log / console.warn / console.error
//   に 1 行の文字列を渡すだけで、ストリームへの書き込みは Node の console に任せている。呼び出し側のテスト
//   （problem.test.ts など）も同じく console を spy して、ログに残したことを確かめる。

const NOW = "2026-09-29T01:02:03.456Z";

// 番兵の値。マスクされるべき項目と、一覧に無いキーに入れ、出力の 1 行に含まれないことを確かめる。
// WHY freeText の正規表現に一致しない文字列にする: 正規表現（最後の網）ではなく、スキーマの印（sensitive）と allowlist で
//   落ちていることを確かめるため。
const SENTINEL = "SENTINEL-PII";

// WHY 時計（Clock.now）を差し替える: 行の time は現在時刻の唯一の出口 Clock.now() から取る。決まった時刻で行を丸ごと比べるため。
vi.mock("./now");

const consoleMethods = ["log", "warn", "error"] as const;
type ConsoleMethod = (typeof consoleMethods)[number];
type Spies = Record<ConsoleMethod, ReturnType<typeof vi.spyOn>>;

function spyConsole(): Spies {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

// 1 回の呼び出しで、method にだけ 1 つ渡された文字列（1 行）。ほかのメソッドは呼ばれていないことも確かめる。
function onlyLine(spies: Spies, method: ConsoleMethod): string {
  for (const other of consoleMethods.filter((m) => m !== method)) {
    expect(spies[other]).not.toHaveBeenCalled();
  }
  expect(spies[method].mock.calls).toHaveLength(1);
  const [args] = spies[method].mock.calls;
  expect(args).toHaveLength(1);
  const [line] = args as unknown[];
  expect(typeof line).toBe("string");
  return line as string;
}

function parsedLine(spies: Spies, method: ConsoleMethod): unknown {
  return JSON.parse(onlyLine(spies, method));
}

// 一覧に無いキーを足す。WHY 関数で足す: オブジェクトリテラルに直接書くと、型の余分なプロパティの検査（excess property
//   check）で型エラーになる。実行時に余分なキーが来る（型の外の値・any から来る）場合を再現する。
function withExtra<T extends object>(event: T, extra: object): T {
  return { ...event, ...extra };
}

// 種類ごとの入力（番兵の値を sensitive の項目と一覧に無いキーに入れたもの）と、出力の 1 行の期待値。
// WHY Record<LogEventName, ...> にする: 種類を足すと、ここに例を足さない限り型エラーになり、番兵のテストが全種類を網羅する。
const CASES: Record<
  LogEventName,
  { input: LogEvent; method: ConsoleMethod; expected: object }
> = {
  page_request: {
    input: withExtra(
      {
        message: "GET /todo/1",
        event: { name: "page_request" },
        time: "2026-01-01T00:00:00.000Z",
        http: {
          request: {
            id: "req-1",
            method: "GET",
            header: {
              referer: `http://localhost/?q=${SENTINEL}`,
              accept: "text/html",
              "content-type": null,
            },
            body: { size: null },
          },
        },
        url: { path: "/todo/1", query: { q: SENTINEL, tab: SENTINEL } },
        client: { address: SENTINEL },
        user_agent: { original: "Mozilla/5.0" },
        server: { address: "localhost:3100" },
        user: { id: null },
        "logging.googleapis.com/trace": "projects/p/traces/t",
        "logging.googleapis.com/spanId": "00f067aa0ba902b7",
        "logging.googleapis.com/trace_sampled": true,
      },
      { cookie: SENTINEL },
    ),
    method: "log",
    expected: {
      severity: "INFO",
      time: "2026-01-01T00:00:00.000Z",
      message: "GET /todo/1",
      event: { name: "page_request" },
      http: {
        request: {
          id: "req-1",
          method: "GET",
          header: { referer: "***", accept: "text/html", "content-type": null },
          body: { size: null },
        },
      },
      url: { path: "/todo/1", query: { q: "***", tab: "***" } },
      client: { address: "***" },
      user_agent: { original: "Mozilla/5.0" },
      server: { address: "localhost:3100" },
      user: { id: null },
      "logging.googleapis.com/trace": "projects/p/traces/t",
      "logging.googleapis.com/spanId": "00f067aa0ba902b7",
      "logging.googleapis.com/trace_sampled": true,
    },
  },
  api_request: {
    input: withExtra(
      {
        message: "POST /api/todos",
        event: { name: "api_request" },
        time: "2026-01-01T00:00:00.000Z",
        http: {
          request: {
            id: "req-2",
            method: "POST",
            header: {
              referer: SENTINEL,
              accept: "*/*",
              "content-type": "application/json",
            },
            body: { size: 12 },
          },
        },
        url: { path: "/api/todos", query: {} },
        client: { address: null },
        user_agent: { original: null },
        server: { address: null },
        user: { id: null },
      },
      { body: SENTINEL },
    ),
    method: "log",
    expected: {
      severity: "INFO",
      time: "2026-01-01T00:00:00.000Z",
      message: "POST /api/todos",
      event: { name: "api_request" },
      http: {
        request: {
          id: "req-2",
          method: "POST",
          header: {
            referer: "***",
            accept: "*/*",
            "content-type": "application/json",
          },
          body: { size: 12 },
        },
      },
      url: { path: "/api/todos", query: {} },
      client: { address: null },
      user_agent: { original: null },
      server: { address: null },
      user: { id: null },
    },
  },
  db_write: {
    input: withExtra(
      {
        message: "db write done",
        event: { name: "db_write", phase: "done", duration_ms: 3 },
        db: { collection: { name: "todos" }, operation: { name: "update" } },
        row_id: "t-1",
        // before / after は Writer が列の分類表でマスクしてから渡す（スキーマは値をそのまま出す）。params は値をすべて *** にする。
        changes: [
          {
            table: "todos",
            row_id: "t-1",
            operation: "update",
            before: { title: "***", completed: false },
            after: { title: "***", completed: true },
          },
        ],
        params: [SENTINEL, 1],
      },
      { before: { title: SENTINEL } },
    ),
    method: "log",
    expected: {
      severity: "INFO",
      time: NOW,
      message: "db write done",
      event: { name: "db_write", phase: "done", duration_ms: 3 },
      db: { collection: { name: "todos" }, operation: { name: "update" } },
      row_id: "t-1",
      params: ["***", "***"],
      changes: [
        {
          table: "todos",
          row_id: "t-1",
          operation: "update",
          before: { title: "***", completed: false },
          after: { title: "***", completed: true },
        },
      ],
    },
  },
  db_pool_error: {
    input: withExtra(
      {
        message: "idle Postgres connection error",
        event: { name: "db_pool_error" },
        error: new Error("connection terminated"),
      },
      { params: [SENTINEL] },
    ),
    method: "error",
    expected: {
      severity: "ERROR",
      time: NOW,
      message: "idle Postgres connection error",
      event: { name: "db_pool_error" },
      error: { type: "Error", message: "connection terminated" },
    },
  },
  server_error: {
    input: withExtra(
      {
        message: "unexpected error",
        event: { name: "server_error" },
        error: new TypeError("x is not a function"),
      },
      { request: { body: SENTINEL } },
    ),
    method: "error",
    expected: {
      severity: "ERROR",
      time: NOW,
      message: "unexpected error",
      event: { name: "server_error" },
      error: { type: "TypeError", message: "x is not a function" },
    },
  },
  health_check_failed: {
    input: withExtra(
      {
        message: "health check failed: database unavailable",
        event: { name: "health_check_failed" },
        error: new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      },
      { params: [SENTINEL] },
    ),
    method: "error",
    expected: {
      severity: "ERROR",
      time: NOW,
      message: "health check failed: database unavailable",
      event: { name: "health_check_failed" },
      error: { type: "Error", message: "connect ECONNREFUSED 127.0.0.1:5432" },
    },
  },
  app_start_failed: {
    input: withExtra(
      {
        message: "The server time zone must be UTC",
        event: { name: "app_start_failed" },
        time_zone: "Asia/Tokyo",
      },
      { env: { DATABASE_URL: SENTINEL } },
    ),
    method: "error",
    expected: {
      severity: "ERROR",
      time: NOW,
      message: "The server time zone must be UTC",
      event: { name: "app_start_failed" },
      time_zone: "Asia/Tokyo",
    },
  },
  notification: {
    input: withExtra(
      {
        message: "notification",
        event: { name: "notification" },
        notification: "Todo completed: t-1",
      },
      { recipient: SENTINEL },
    ),
    method: "log",
    expected: {
      severity: "INFO",
      time: NOW,
      message: "notification",
      event: { name: "notification" },
      notification: "Todo completed: t-1",
    },
  },
  logger_error: {
    input: withExtra(
      {
        message: "logger: event does not match the schema of its event.name",
        event: { name: "logger_error", failed_name: "db_write" },
      },
      { raw: SENTINEL },
    ),
    method: "error",
    expected: {
      severity: "ERROR",
      time: NOW,
      message: "logger: event does not match the schema of its event.name",
      event: { name: "logger_error", failed_name: "db_write" },
    },
  },
};

// parse に失敗したときの 1 行（生の event の値は出さず、失敗した種類の名前だけを出す）。
function schemaMismatchLine(failedName?: LogEventName): object {
  return {
    severity: "ERROR",
    time: NOW,
    message: "logger: event does not match the schema of its event.name",
    event:
      failedName === undefined
        ? { name: "logger_error" }
        : { name: "logger_error", failed_name: failedName },
  };
}

beforeEach(() => {
  vi.mocked(Clock.now).mockReturnValue(new Date(NOW));
});

afterEach(() => {
  vi.mocked(Clock.now).mockReset();
  vi.restoreAllMocks();
});

describe("logger.emit: 種類ごとのスキーマ（allowlist とマスク）", () => {
  // WHY 行を丸ごと比べる: 種類ごとに残す項目・*** にする項目・落とす項目を 1 つの期待値で固定する。番兵が出ないことだけを
  //   見ると、parse に失敗して logger_error になった行（番兵を含まない）でも通ってしまう。
  test.each(Object.entries(CASES))(
    "%s: スキーマの項目だけを出し、sensitive の項目は *** にし、一覧に無いキーは落とす（番兵の値が 1 行に含まれない）",
    (_name, { input, method, expected }) => {
      // given
      const spies = spyConsole();

      // when
      logger.emit(input);

      // then
      const line = onlyLine(spies, method);
      expect(JSON.parse(line)).toEqual(expected);
      expect(line).not.toContain(SENTINEL);
    },
  );

  // WHY 先頭の並び: 行を目で追うとき、どの行も先頭が severity・time・message・event の順にそろう（apps/e2e/spec/request-log.steps.ts も見る）。
  //   残りはスキーマに書いた順（呼び出し側のキーの順によらない）。
  test("先頭は severity・time・message・event の順で、残りはスキーマの順（呼び出し側のキーの順によらない）", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit({
      changes: [],
      row_id: "t-1",
      db: { operation: { name: "insert" }, collection: { name: "todos" } },
      event: { phase: "done", name: "db_write", duration_ms: 1 },
      message: "db write done",
    });

    // then
    const parsed = parsedLine(spies, "log") as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "severity",
      "time",
      "message",
      "event",
      "db",
      "row_id",
      "changes",
    ]);
  });

  test("event.name はキーを入れ子のまま出す（Logs Explorer で jsonPayload.event.name と書ける。ドット付きの平らなキーにしない）", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit({ message: "notification", event: { name: "notification" } });

    // then
    const line = onlyLine(spies, "log");
    expect(line).toContain('"event":{"name":"notification"}');
    expect(line).not.toContain('"event.name"');
  });

  // WHY 入れ子の一覧に無いキーも落とす: z.object は入れ子でも既定で一覧に無いキーを落とす（.strict() にしない。本番で落とさない）。
  test("入れ子のオブジェクトの一覧に無いキー（event・http.request.header の中など）も落とす", () => {
    // given
    const spies = spyConsole();
    const { input } = CASES.page_request;
    const request = input as Extract<
      LogEvent,
      { event: { name: "page_request" } }
    >;

    // when
    logger.emit({
      ...request,
      event: withExtra(request.event, { extra: SENTINEL }),
      http: {
        request: {
          ...request.http.request,
          header: withExtra(request.http.request.header, { cookie: SENTINEL }),
        },
      },
    });

    // then
    const line = onlyLine(spies, "log");
    expect(JSON.parse(line)).toEqual(CASES.page_request.expected);
    expect(line).not.toContain(SENTINEL);
  });
});

describe("logger.emit: severity と出力先（種類と phase が決める）", () => {
  // WHY 種類が severity を決める（呼び出し側が選ばない）: 同じ種類の行が呼び出し側ごとに違う重大度になると、重大度で絞った
  //   アラートが一部の行を拾わない（Issue #216）。INFO は stdout（console.log）、WARNING / ERROR は stderr（console.warn /
  //   console.error）。Cloud Logging の LogSeverity の名前（https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#logseverity ）。
  test.each([
    [
      "db_write の start",
      {
        message: "db write start",
        event: { name: "db_write", phase: "start" },
        db: { collection: { name: "todos" }, operation: { name: "insert" } },
      },
      "log",
      "INFO",
    ],
    [
      "db_write の failed",
      {
        message: "db write failed",
        event: { name: "db_write", phase: "failed", duration_ms: 1 },
        db: { collection: { name: "todos" }, operation: { name: "insert" } },
      },
      "warn",
      "WARNING",
    ],
    [
      "notification の failed",
      {
        message: "notification failed",
        event: { name: "notification", phase: "failed" },
        error: new Error("send failed"),
      },
      "error",
      "ERROR",
    ],
  ] satisfies [string, LogEvent, ConsoleMethod, string][])(
    "%s は console.%s に severity %s で出す",
    (_kind, event, method, severity) => {
      // given
      const spies = spyConsole();

      // when
      logger.emit(event);

      // then
      expect(parsedLine(spies, method)).toMatchObject({ severity });
    },
  );
});

describe("logger.emit: time", () => {
  test("event に time があればそれを使う（リクエストログの受信時刻など、出来事の時刻を優先する）", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit(CASES.api_request.input);

    // then
    expect(parsedLine(spies, "log")).toMatchObject({
      time: "2026-01-01T00:00:00.000Z",
    });
  });

  test("time を持たない種類は現在時刻（Clock.now()）を使う", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit({ message: "notification", event: { name: "notification" } });

    // then
    expect(parsedLine(spies, "log")).toEqual({
      severity: "INFO",
      time: NOW,
      message: "notification",
      event: { name: "notification" },
    });
  });
});

describe("logger.emit: 自由文（message・error.message など）", () => {
  test("値に改行を含んでも 1 行で出す（NDJSON。改行は JSON の中でエスケープされる）", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit({
      message: "1 行目\n2 行目\r\n3 行目",
      event: { name: "notification" },
    });

    // then
    const line = onlyLine(spies, "log");
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line)).toMatchObject({
      message: "1 行目\n2 行目\r\n3 行目",
    });
  });

  // WHY 置換は logger の中だけ: 呼び出し側は生の値を渡し、出口で必ず通る（Issue #216）。
  test("message・error.message・notification・url.path のメールアドレスなどを *** にする（freeText）", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit({
      message: "notification for a@b.io",
      event: { name: "notification", phase: "failed" },
      notification: "sent to c@d.io",
      error: new Error("rejected: Bearer abc.def"),
    });

    // then
    expect(parsedLine(spies, "error")).toEqual({
      severity: "ERROR",
      time: NOW,
      message: "notification for ***",
      event: { name: "notification", phase: "failed" },
      notification: "sent to ***",
      error: { type: "Error", message: "rejected: ***" },
    });
  });

  test("url.path の自由文もマスクする（パスは利用者が決められる）", () => {
    // given
    const spies = spyConsole();
    const request = CASES.page_request.input as Extract<
      LogEvent,
      { event: { name: "page_request" } }
    >;

    // when
    logger.emit({
      ...request,
      message: "GET /users/a@b.io",
      url: { path: "/users/a@b.io", query: {} },
    });

    // then
    expect(parsedLine(spies, "log")).toMatchObject({
      message: "GET /users/***",
      url: { path: "/users/***", query: {} },
    });
  });

  test("url.query のキーも自由文としてマスクし、値はすべて *** にする", () => {
    // given
    const spies = spyConsole();
    const request = CASES.page_request.input as Extract<
      LogEvent,
      { event: { name: "page_request" } }
    >;

    // when
    logger.emit({ ...request, url: { path: "/", query: { "a@b.io": "1" } } });

    // then
    expect(parsedLine(spies, "log")).toMatchObject({
      url: { path: "/", query: { "***": "***" } },
    });
  });
});

describe("logger.emit: error 項目", () => {
  // WHY type と message: OTel semconv の exception.type / exception.message、ECS の error.type / error.message と同じ名前にする。
  // WHY stack を出さない: 1 行が長くなり、ファイルのパスなど内部の情報も含む。原因の特定は type と message で足りる前提。
  test("Error は { type, message } にして出し、stack と一覧に無いプロパティは出さない", () => {
    // given
    const spies = spyConsole();
    class RepositoryError extends Error {
      readonly detail = [SENTINEL];
      constructor(message: string) {
        super(message);
        this.name = "RepositoryError";
      }
    }

    // when
    logger.emit({
      message: "unexpected error",
      event: { name: "server_error" },
      error: new RepositoryError("not found"),
    });

    // then
    const line = onlyLine(spies, "error");
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR",
      time: NOW,
      message: "unexpected error",
      event: { name: "server_error" },
      error: { type: "RepositoryError", message: "not found" },
    });
    expect(line).not.toContain("stack");
    expect(line).not.toContain("logger.test.ts");
    expect(line).not.toContain(SENTINEL);
  });

  // WHY { type } のオブジェクトはそのまま: Writer（apps/backend/shared/drizzle/writer.ts）は DB のエラーを message の無い
  //   { type: <pg のエラーの name> } で渡す（message は SQL と値を含むので出さない）。
  test("type（文字列）を持つオブジェクトは、type と message だけを出す", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit({
      message: "unexpected error",
      event: { name: "server_error" },
      error: { type: "DatabaseError", detail: SENTINEL },
    });

    // then
    expect(parsedLine(spies, "error")).toMatchObject({
      error: { type: "DatabaseError" },
    });
  });

  // WHY 値を出さない（型の名前だけ）: throw は Error 以外の値（文字列・オブジェクト）も投げられ、中身が何かは分からない
  //   （利用者の入力を含みうる）。何が投げられたかの手がかりとして typeof だけを残す（fail closed）。
  test.each([
    ["文字列", `thrown ${SENTINEL}`, "string"],
    ["type の無いオブジェクト", { reason: SENTINEL }, "object"],
    ["null", null, "object"],
    ["undefined", undefined, "undefined"],
  ])(
    "Error でない値（%s）は、値を出さず { type: typeof } にする",
    (_kind, error, type) => {
      // given
      const spies = spyConsole();

      // when
      logger.emit({
        message: "unexpected error",
        event: { name: "server_error" },
        error,
      });

      // then
      const line = onlyLine(spies, "error");
      expect(JSON.parse(line)).toMatchObject({ error: { type } });
      expect(JSON.parse(line).error).toEqual({ type });
      expect(line).not.toContain(SENTINEL);
    },
  );
});

describe("logger.emit: 失敗しても落とさない（logger_error の 1 行）", () => {
  // WHY 生の event を出さない: parse に失敗した event は、どの項目が sensitive かを決められない（形が違う）。
  //   失敗した種類の名前だけを固定の項目で出し、「ログを出せなかった」ことを 1 つの条件（event.name="logger_error"）で引ける
  //   ようにする。本番で例外にしない: ログの失敗で本来の処理（応答を返すなど）を止めない。
  test("スキーマに合わない event（必須の項目が無い）は、生の値を出さず logger_error の 1 行（ERROR）にする", () => {
    // given
    const spies = spyConsole();
    const invalid = {
      message: `db write ${SENTINEL}`,
      event: { name: "db_write", phase: "start" },
      row_id: SENTINEL,
    } as unknown as LogEvent;

    // when
    const action = () => logger.emit(invalid);

    // then
    expect(action).not.toThrow();
    const line = onlyLine(spies, "error");
    expect(JSON.parse(line)).toEqual(schemaMismatchLine("db_write"));
    expect(line).not.toContain(SENTINEL);
  });

  test("値の型が違う event（数値の message）も logger_error の 1 行にする", () => {
    // given
    const spies = spyConsole();

    // when
    logger.emit({
      message: 1,
      event: { name: "server_error" },
      error: new Error(SENTINEL),
    } as unknown as LogEvent);

    // then
    const line = onlyLine(spies, "error");
    expect(JSON.parse(line)).toEqual(schemaMismatchLine("server_error"));
    expect(line).not.toContain(SENTINEL);
  });

  // WHY 一覧に無い名前は出さない: 名前そのものが型の外から来た値で、何が入っているか分からない。
  test.each([
    ["一覧に無い名前", { name: SENTINEL }],
    ["Object.prototype のプロパティの名前", { name: "toString" }],
    ["event が無い", undefined],
  ])(
    "event.name が %s なら、failed_name を付けずに logger_error の 1 行にする",
    (_kind, event) => {
      // given
      const spies = spyConsole();

      // when
      logger.emit({ message: SENTINEL, event } as unknown as LogEvent);

      // then
      const line = onlyLine(spies, "error");
      expect(JSON.parse(line)).toEqual(schemaMismatchLine());
      expect(line).not.toContain(SENTINEL);
    },
  );

  test("event のプロパティ（getter）が例外を投げても呼び出し側に伝えず、読めなかった旨の logger_error の 1 行を出す", () => {
    // given
    const spies = spyConsole();
    const event = {
      event: { name: "notification" as const },
      get message(): string {
        throw new Error(SENTINEL);
      },
    };

    // when
    const action = () => logger.emit(event);

    // then
    expect(action).not.toThrow();
    const line = onlyLine(spies, "error");
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR",
      time: NOW,
      message: "logger: reading the event threw an exception",
      event: { name: "logger_error" },
    });
    expect(line).not.toContain(SENTINEL);
  });
});

describe("LogEvent の型（種類ごとの必須項目）", () => {
  // 型の検査（pnpm typecheck）で固定する。下の各行の ts-expect-error の指示の行が型エラーにならなければ、tsc が「使われていない
  //   指示」（TS2578）で失敗するので、型を緩めると typecheck が落ちる。実行時は parse に失敗して logger_error の行になる。
  test("一覧に無い event.name・必須の項目が無い・値の型が違う呼び出しは型エラーになる", () => {
    // given
    const spies = spyConsole();

    // when
    // @ts-expect-error 一覧に無い名前
    logger.emit({ message: "x", event: { name: "todo_created" } });
    // @ts-expect-error event が無い
    logger.emit({ message: "x" });
    // @ts-expect-error event.name が無い
    logger.emit({ message: "x", event: { phase: "start" } });
    // @ts-expect-error message が無い
    logger.emit({ event: { name: "notification" } });
    // @ts-expect-error message が文字列でない
    logger.emit({ message: 1, event: { name: "notification" } });
    // @ts-expect-error db_write に db が無い
    logger.emit({ message: "x", event: { name: "db_write", phase: "start" } });
    logger.emit({
      message: "x",
      // @ts-expect-error db_write に phase が無い
      event: { name: "db_write" },
      db: { collection: { name: "t" }, operation: { name: "insert" } },
    });
    logger.emit({
      message: "x",
      // @ts-expect-error db_write の phase が一覧に無い
      event: { name: "db_write", phase: "begin" },
      db: { collection: { name: "t" }, operation: { name: "insert" } },
    });
    // @ts-expect-error server_error に error が無い
    logger.emit({ message: "x", event: { name: "server_error" } });
    // @ts-expect-error api_request に http などが無い
    logger.emit({ message: "x", event: { name: "api_request" } });

    // then
    expect(spies.error).toHaveBeenCalledTimes(10);
  });
});
