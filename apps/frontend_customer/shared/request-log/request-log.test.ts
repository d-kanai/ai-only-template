import { describe, expect, test } from "vitest";
import {
  buildRequestLog,
  type RequestLog,
  type RequestLogInput,
} from "@/shared/request-log/request-log";

// リクエストログ（1 リクエスト = JSON 1 行、5W1H）の 1 行の中身を固定する仕様（Issue #80）。キーの名前は OTel semconv の HTTP の
//   名前を入れ子にしたもの、trace は Cloud Logging の特別フィールド（Issue #209。ADR
//   docs/adr/architecture/20260930-log-format-cloud-logging-otel.md）。
// proxy.ts（Next の規約ファイル。カバレッジの対象外）は、この関数に NextRequest の値を渡して出力するだけにしている。
// WHY 受信時刻と request id の生成を引数で受け取る: 時刻と乱数をテストから固定し、出力を toEqual で丸ごと比べるため。

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

const receivedAt = new Date("2026-09-29T01:02:03.456Z");

function input(overrides: Partial<RequestLogInput> = {}): RequestLogInput {
  return {
    method: "GET",
    url: "http://localhost:3100/",
    headers: {},
    receivedAt,
    generateRequestId: () => "generated-id",
    projectId: "my-project",
    ...overrides,
  };
}

describe("buildRequestLog: 5W1H の各項目", () => {
  test("ブラウザの画面アクセスのヘッダから、1 行のすべての項目を組み立てる", () => {
    const log = buildRequestLog(
      input({
        method: "GET",
        url: "http://localhost:3100/todo/abc?tab=detail&sort=asc",
        headers: {
          "x-request-id": "req-1",
          traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
          "x-forwarded-for": "203.0.113.5, 10.0.0.1",
          "x-real-ip": "10.0.0.9",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64)",
          host: "localhost:3100",
          referer: "http://localhost:3100/",
          accept: "text/html,application/xhtml+xml",
          "content-type": "text/plain",
          "content-length": "12",
        },
      }),
    );
    expect(log).toEqual({
      message: "GET /todo/abc",
      event: { name: "page_request" },
      time: "2026-09-29T01:02:03.456Z",
      http: {
        request: {
          id: "req-1",
          method: "GET",
          header: {
            referer: "http://localhost:3100/",
            accept: "text/html,application/xhtml+xml",
            "content-type": "text/plain",
          },
          body: { size: 12 },
        },
      },
      url: { path: "/todo/abc", query_keys: ["tab", "sort"] },
      client: { address: "203.0.113.5" },
      user_agent: { original: "Mozilla/5.0 (X11; Linux x86_64)" },
      server: { address: "localhost:3100" },
      user: { id: null },
      "logging.googleapis.com/trace": `projects/my-project/traces/${TRACE_ID}`,
      "logging.googleapis.com/spanId": SPAN_ID,
      "logging.googleapis.com/trace_sampled": true,
    } satisfies RequestLog);
  });

  test("ヘッダが 1 つも無いときは、ヘッダ由来の項目をすべて null にし、http.request.id を生成し、trace のキーを出さない", () => {
    expect(
      buildRequestLog(
        input({ method: "POST", url: "http://localhost:3100/api/todos" }),
      ),
    ).toStrictEqual({
      message: "POST /api/todos",
      event: { name: "api_request" },
      time: "2026-09-29T01:02:03.456Z",
      http: {
        request: {
          id: "generated-id",
          method: "POST",
          header: { referer: null, accept: null, "content-type": null },
          body: { size: null },
        },
      },
      url: { path: "/api/todos", query_keys: [] },
      client: { address: null },
      user_agent: { original: null },
      server: { address: null },
      user: { id: null },
    } satisfies RequestLog);
  });

  test("headers は Headers でも受け取り、名前の大文字・小文字を区別しない", () => {
    const log = buildRequestLog(
      input({
        headers: new Headers({
          "User-Agent": "curl/8.5.0",
          Host: "example.com",
          Accept: "*/*",
        }),
      }),
    );
    expect(log.user_agent.original).toBe("curl/8.5.0");
    expect(log.server.address).toBe("example.com");
    expect(log.http.request.header.accept).toBe("*/*");
  });

  test("record のヘッダ名が大文字でも読む", () => {
    const log = buildRequestLog(
      input({ headers: { "Content-Type": "application/json" } }),
    );
    expect(log.http.request.header["content-type"]).toBe("application/json");
  });

  test("user.id は認証が入るまで常に null（ヘッダに何があっても埋めない）", () => {
    const log = buildRequestLog(
      input({ headers: { "x-user-id": "u-1", authorization: "Bearer t" } }),
    );
    expect(log.user).toEqual({ id: null });
  });

  test("time は受信時刻の RFC 3339（ISO 8601、UTC）", () => {
    const log = buildRequestLog(
      input({ receivedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)) }),
    );
    expect(log.time).toBe("2026-01-02T03:04:05.006Z");
  });

  test("method は受け取った値のまま出し、message は「<method> <path>」（クエリを含めない）", () => {
    const log = buildRequestLog(
      input({ method: "DELETE", url: "http://localhost/api/todos/abc?x=1" }),
    );
    expect(log.http.request.method).toBe("DELETE");
    expect(log.message).toBe("DELETE /api/todos/abc");
  });
});

describe("buildRequestLog: event.name の判定（/api/** は api_request、それ以外は page_request）", () => {
  // must pass（api と判定する）
  test.each([
    "http://localhost/api",
    "http://localhost/api/",
    "http://localhost/api/todos",
    "http://localhost/api/todos/abc?x=1",
  ])("%s は api_request", (url) => {
    expect(buildRequestLog(input({ url })).event).toEqual({
      name: "api_request",
    });
  });

  // must reject（api と取り違えない。前方一致だけが同じ別パス、途中に api を含むパス）
  test.each([
    "http://localhost/",
    "http://localhost/todo/abc",
    "http://localhost/apis",
    "http://localhost/api-docs",
    "http://localhost/todo/api/x",
    "http://localhost/API/todos",
    "http://localhost/?next=/api/todos",
  ])("%s は page_request", (url) => {
    expect(buildRequestLog(input({ url })).event).toEqual({
      name: "page_request",
    });
  });
});

describe("buildRequestLog: url.path と url.query_keys（クエリの値は出さない）", () => {
  test("クエリの値はどの項目にも出さず、キーだけを出現順に出す", () => {
    const log = buildRequestLog(
      input({
        url: "http://localhost/api/todos?email=secret%40example.com&token=s3cr3t",
      }),
    );
    expect(log.url).toEqual({
      path: "/api/todos",
      query_keys: ["email", "token"],
    });
    const line = JSON.stringify(log);
    expect(line).not.toContain("secret");
    expect(line).not.toContain("s3cr3t");
  });

  test("同じキーが複数回あっても 1 回だけ出す", () => {
    expect(
      buildRequestLog(input({ url: "http://localhost/?a=1&b=2&a=3" })).url
        .query_keys,
    ).toEqual(["a", "b"]);
  });

  test("値の無いキー・空のクエリ・フラグメントを扱う", () => {
    expect(
      buildRequestLog(input({ url: "http://localhost/x?flag#frag" })),
    ).toMatchObject({ url: { path: "/x", query_keys: ["flag"] } });
    expect(
      buildRequestLog(input({ url: "http://localhost/x?" })).url.query_keys,
    ).toEqual([]);
  });
});

describe("buildRequestLog: http.request.id（x-request-id）", () => {
  test("x-request-id があればそれを使い、生成しない", () => {
    let calls = 0;
    const log = buildRequestLog(
      input({
        headers: { "x-request-id": "from-upstream" },
        generateRequestId: () => {
          calls += 1;
          return "generated-id";
        },
      }),
    );
    expect(log.http.request.id).toBe("from-upstream");
    expect(calls).toBe(0);
  });

  test("x-request-id が無いときと空のときは生成した値を使う", () => {
    expect(buildRequestLog(input()).http.request.id).toBe("generated-id");
    expect(
      buildRequestLog(input({ headers: { "x-request-id": "" } })).http.request
        .id,
    ).toBe("generated-id");
  });
});

describe("buildRequestLog: client.address（x-forwarded-for の先頭 → x-real-ip → null）", () => {
  test("x-forwarded-for の先頭（前後の空白を除く）を使い、x-real-ip より優先する", () => {
    expect(
      buildRequestLog(
        input({
          headers: {
            "x-forwarded-for": "  198.51.100.7 ,203.0.113.5",
            "x-real-ip": "10.0.0.9",
          },
        }),
      ).client.address,
    ).toBe("198.51.100.7");
  });

  test("x-forwarded-for が 1 件だけならそれを使う", () => {
    expect(
      buildRequestLog(input({ headers: { "x-forwarded-for": "::1" } })).client
        .address,
    ).toBe("::1");
  });

  test("x-forwarded-for が無いときは x-real-ip を使う", () => {
    expect(
      buildRequestLog(input({ headers: { "x-real-ip": "10.0.0.9" } })).client
        .address,
    ).toBe("10.0.0.9");
  });

  test("x-forwarded-for の先頭が空なら x-real-ip を使う", () => {
    expect(
      buildRequestLog(
        input({
          headers: {
            "x-forwarded-for": " , 203.0.113.5",
            "x-real-ip": "10.0.0.9",
          },
        }),
      ).client.address,
    ).toBe("10.0.0.9");
  });

  test("どちらも無い・空なら null", () => {
    expect(buildRequestLog(input()).client.address).toBeNull();
    expect(
      buildRequestLog(
        input({ headers: { "x-forwarded-for": "", "x-real-ip": "" } }),
      ).client.address,
    ).toBeNull();
  });
});

describe("buildRequestLog: http.request.body.size（Content-Length）", () => {
  test.each([
    ["0", 0],
    ["12", 12],
    ["1048576", 1048576],
  ])("Content-Length %s は %d バイト", (value, bytes) => {
    expect(
      buildRequestLog(input({ headers: { "content-length": value } })).http
        .request.body.size,
    ).toBe(bytes);
  });

  // 数値として読めない値は推測で埋めず null にする（負の数・小数・数字以外・空）。
  test.each(["", "-1", "1.5", "abc", "12abc", " "])(
    "Content-Length %j は null",
    (value) => {
      expect(
        buildRequestLog(input({ headers: { "content-length": value } })).http
          .request.body.size,
      ).toBeNull();
    },
  );
});

// trace（Cloud Logging の特別フィールド。https://docs.cloud.google.com/logging/docs/agent/logging/configuration#special-fields ）。
// traceparent は W3C Trace Context（https://www.w3.org/TR/trace-context/#traceparent-header ）の
//   「00-<trace-id 32 桁>-<parent-id 16 桁>-<trace-flags 2 桁>」（16 進数は小文字だけ）。
describe("buildRequestLog: traceparent から logging.googleapis.com/trace・spanId・trace_sampled", () => {
  function traceOf(traceparent: string, projectId = "my-project") {
    const log = buildRequestLog(input({ headers: { traceparent }, projectId }));
    return {
      trace: log["logging.googleapis.com/trace"],
      spanId: log["logging.googleapis.com/spanId"],
      sampled: log["logging.googleapis.com/trace_sampled"],
    };
  }

  // must pass（trace を出す）
  test("trace は projects/<プロジェクト ID>/traces/<trace-id>、spanId は parent-id", () => {
    expect(traceOf(`00-${TRACE_ID}-${SPAN_ID}-01`, "prod-123")).toEqual({
      trace: `projects/prod-123/traces/${TRACE_ID}`,
      spanId: SPAN_ID,
      sampled: true,
    });
  });

  // すべて 0 だけが無効（W3C）。先頭・末尾が 0 でも、0 でない桁が 1 つでもあれば有効。
  test.each([
    [`${"0".repeat(31)}1`, `1${"0".repeat(15)}`],
    [`1${"0".repeat(31)}`, `${"0".repeat(15)}1`],
  ])(
    "trace-id %s・parent-id %s（すべて 0 ではない）なら出す",
    (traceId, spanId) => {
      expect(traceOf(`00-${traceId}-${spanId}-00`)).toEqual({
        trace: `projects/my-project/traces/${traceId}`,
        spanId,
        sampled: false,
      });
    },
  );

  // WHY flags の bit 0 だけを見る: sampled は最下位ビット（W3C の FLAG_SAMPLED = 1）。ほかのビット（random など）が立っていても
  //   sampled の判定は変わらない（マスクを忘れると 02 を sampled と取り違える）。
  test.each([
    ["00", false],
    ["01", true],
    ["02", false],
    ["03", true],
    ["09", true],
    ["fe", false],
    ["ff", true],
  ])("trace-flags %s の trace_sampled は %s", (flags, sampled) => {
    expect(traceOf(`00-${TRACE_ID}-${SPAN_ID}-${flags}`).sampled).toBe(sampled);
  });

  // must reject（形が違えば 3 つのキーをどれも出さない）
  test.each([
    ["空", ""],
    ["version が 00 でない", `01-${TRACE_ID}-${SPAN_ID}-01`],
    ["version が ff", `ff-${TRACE_ID}-${SPAN_ID}-01`],
    ["trace-id が 31 桁", `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`],
    ["trace-id が 33 桁", `00-${TRACE_ID}0-${SPAN_ID}-01`],
    ["parent-id が 15 桁", `00-${TRACE_ID}-${SPAN_ID.slice(1)}-01`],
    ["parent-id が 17 桁", `00-${TRACE_ID}-${SPAN_ID}0-01`],
    ["trace-flags が 1 桁", `00-${TRACE_ID}-${SPAN_ID}-1`],
    ["trace-flags が 3 桁", `00-${TRACE_ID}-${SPAN_ID}-011`],
    ["大文字の 16 進数", `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
    ["16 進数でない文字", `00-${"g".repeat(32)}-${SPAN_ID}-01`],
    ["trace-id がすべて 0", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["parent-id がすべて 0", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["区切りが足りない", `00-${TRACE_ID}${SPAN_ID}-01`],
    ["後ろに続きがある", `00-${TRACE_ID}-${SPAN_ID}-01-extra`],
    ["前に余分な文字がある", `x00-${TRACE_ID}-${SPAN_ID}-01`],
  ])("traceparent が%sなら trace のキーを出さない", (_label, traceparent) => {
    const log = buildRequestLog(input({ headers: { traceparent } }));
    expect(
      Object.keys(log).filter((key) => key.startsWith("logging.")),
    ).toEqual([]);
  });

  test("traceparent が無ければ trace のキーを出さない（null も入れない）", () => {
    expect(Object.keys(buildRequestLog(input()))).not.toContain(
      "logging.googleapis.com/trace",
    );
  });
});
