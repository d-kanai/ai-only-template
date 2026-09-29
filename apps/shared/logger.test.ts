// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logger } from "./logger";

// logger（サーバ側のログの唯一の出口。Issue #85）の仕様。出力先は console の各メソッドを spy して確かめる。
// WHY console を spy する（stdout / stderr のストリームを直接見ない）: logger は console.log / console.warn / console.error
//   に 1 行の文字列を渡すだけで、ストリームへの書き込みは Node の console に任せている。呼び出し側のテスト
//   （http-error.test.ts など）も同じく console を spy して、ログに残したことを確かめる。

const NOW = "2026-09-29T01:02:03.456Z";

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("logger", () => {
  // WHY info は stdout、warn / error は stderr: 実行環境（コンテナのログ収集など）が stderr を異常の出力として扱えるようにする。
  //   Node の console.log は stdout、console.warn / console.error は stderr に書く。
  test.each([
    ["info", "log"],
    ["warn", "warn"],
    ["error", "error"],
  ] as const)(
    "logger.%s は console.%s にだけ 1 行の JSON を 1 回渡し、level と timestamp（ISO 8601、UTC）を先頭に付ける",
    (level, method) => {
      const spies = spyConsole();

      logger[level]({ event: "todo.created", id: "t-1" });

      for (const other of consoleMethods.filter((m) => m !== method)) {
        expect(spies[other]).not.toHaveBeenCalled();
      }
      const parsed = JSON.parse(onlyLine(spies, method)) as Record<
        string,
        unknown
      >;
      expect(parsed).toEqual({
        level,
        timestamp: NOW,
        event: "todo.created",
        id: "t-1",
      });
      // 行を目で追うとき、どの行も先頭が level・timestamp の順にそろう。
      expect(Object.keys(parsed)).toEqual([
        "level",
        "timestamp",
        "event",
        "id",
      ]);
    },
  );

  test("event に timestamp があればそれを使う（リクエストログの受信時刻など、出来事の時刻を優先する）", () => {
    const spies = spyConsole();

    logger.info({ timestamp: "2026-01-01T00:00:00.000Z", path: "/" });

    expect(JSON.parse(onlyLine(spies, "log"))).toEqual({
      level: "info",
      timestamp: "2026-01-01T00:00:00.000Z",
      path: "/",
    });
  });

  test("event の timestamp が undefined なら現在時刻を使う（どの行も先頭に level と timestamp が残る）", () => {
    const spies = spyConsole();

    logger.info({ timestamp: undefined, a: 1 });

    const parsed = JSON.parse(onlyLine(spies, "log")) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ level: "info", timestamp: NOW, a: 1 });
    expect(Object.keys(parsed)).toEqual(["level", "timestamp", "a"]);
  });

  test("event のプロパティ（getter）が例外を投げても呼び出し側に伝えず、失敗した旨の 1 行を出す", () => {
    const spies = spyConsole();
    const event = {
      get boom(): string {
        throw new Error("getter");
      },
    };

    expect(() => logger.error(event)).not.toThrow();

    expect(JSON.parse(onlyLine(spies, "error"))).toEqual({
      level: "error",
      timestamp: NOW,
      message:
        "logger: event could not be serialized to JSON (circular reference, BigInt, etc.)",
    });
  });

  test("event に level があっても、呼んだメソッドの level で上書きする（出力先と level を食い違わせない）", () => {
    const spies = spyConsole();

    logger.error({ level: "info", message: "x" });

    expect(JSON.parse(onlyLine(spies, "error"))).toEqual({
      level: "error",
      timestamp: NOW,
      message: "x",
    });
  });

  test("値に改行を含んでも 1 行で出す（NDJSON。改行は JSON の中でエスケープされる）", () => {
    const spies = spyConsole();

    logger.info({ message: "1 行目\n2 行目\r\n3 行目" });

    const line = onlyLine(spies, "log");
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line)).toMatchObject({
      message: "1 行目\n2 行目\r\n3 行目",
    });
  });

  test("Error は { name, message } にして出し、stack は出さない（ネストや配列の中も同じ）", () => {
    const spies = spyConsole();
    class RepositoryError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "RepositoryError";
      }
    }

    logger.error({
      message: "想定外の例外",
      error: new Error("connection refused"),
      detail: { causes: [new TypeError("x is not a function")] },
      custom: new RepositoryError("not found"),
    });

    const line = onlyLine(spies, "error");
    expect(JSON.parse(line)).toEqual({
      level: "error",
      timestamp: NOW,
      message: "想定外の例外",
      error: { name: "Error", message: "connection refused" },
      detail: {
        causes: [{ name: "TypeError", message: "x is not a function" }],
      },
      custom: { name: "RepositoryError", message: "not found" },
    });
    // WHY stack を出さない: 1 行が長くなり、ファイルのパスなど内部の情報も含む。原因の特定は name と message で足りる前提。
    expect(line).not.toContain("stack");
    expect(line).not.toContain("logger.test.ts");
  });

  test.each([
    [
      "循環参照",
      (() => {
        const event: Record<string, unknown> = { id: "t-1" };
        event.self = event;
        return event;
      })(),
    ],
    ["BigInt", { count: BigInt(1) }],
  ])(
    "%s で JSON にできない event は、例外で落とさず、失敗した旨と level・timestamp だけの 1 行を出す",
    (_kind, event) => {
      const spies = spyConsole();

      expect(() => logger.warn(event)).not.toThrow();

      expect(JSON.parse(onlyLine(spies, "warn"))).toEqual({
        level: "warn",
        timestamp: NOW,
        message:
          "logger: event could not be serialized to JSON (circular reference, BigInt, etc.)",
      });
    },
  );
});
