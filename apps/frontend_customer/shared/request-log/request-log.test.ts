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
    // given
    const requestInput = input({
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
    });

    // when
    const log = buildRequestLog(requestInput);

    // then
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
      url: { path: "/todo/abc", query: { tab: "detail", sort: "asc" } },
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
    // given: 前提なし
    // when
    const log = buildRequestLog(
      input({ method: "POST", url: "http://localhost:3100/api/todos" }),
    );

    // then
    expect(log).toStrictEqual({
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
      url: { path: "/api/todos", query: {} },
      client: { address: null },
      user_agent: { original: null },
      server: { address: null },
      user: { id: null },
    } satisfies RequestLog);
  });

  test("headers は Headers でも受け取り、名前の大文字・小文字を区別しない", () => {
    // given
    const headers = new Headers({
      "User-Agent": "curl/8.5.0",
      Host: "example.com",
      Accept: "*/*",
    });

    // when
    const log = buildRequestLog(input({ headers }));

    // then
    expect(log.user_agent.original).toBe("curl/8.5.0");
    expect(log.server.address).toBe("example.com");
    expect(log.http.request.header.accept).toBe("*/*");
  });

  test("record のヘッダ名が大文字でも読む", () => {
    // given
    const headers = { "Content-Type": "application/json" };

    // when
    const log = buildRequestLog(input({ headers }));

    // then
    expect(log.http.request.header["content-type"]).toBe("application/json");
  });

  test("user.id は認証が入るまで常に null（ヘッダに何があっても埋めない）", () => {
    // given
    const headers = { "x-user-id": "u-1", authorization: "Bearer t" };

    // when
    const log = buildRequestLog(input({ headers }));

    // then
    expect(log.user).toEqual({ id: null });
  });

  test("time は受信時刻の RFC 3339（ISO 8601、UTC）", () => {
    // given
    const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));

    // when
    const log = buildRequestLog(input({ receivedAt: at }));

    // then
    expect(log.time).toBe("2026-01-02T03:04:05.006Z");
  });

  test("method は受け取った値のまま出し、message は「<method> <path>」（クエリを含めない）", () => {
    // given
    const requestInput = input({
      method: "DELETE",
      url: "http://localhost/api/todos/abc?x=1",
    });

    // when
    const log = buildRequestLog(requestInput);

    // then
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
    // given: 前提なし（url は test.each の引数）
    // when
    const log = buildRequestLog(input({ url }));

    // then
    expect(log.event).toEqual({
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
    // given: 前提なし（url は test.each の引数）
    // when
    const log = buildRequestLog(input({ url }));

    // then
    expect(log.event).toEqual({
      name: "page_request",
    });
  });
});

// WHY 値もそのまま出す（ここではマスクしない）: マスクはログの唯一の出口 logger（apps/shared/log-event.ts の page_request /
//   api_request のスキーマ）が行い、url.query の値は *** に、キーは自由文の網（メールアドレスなど）を通して出す（Issue #216）。
//   ここで値を落とすと、logger のスキーマでマスクされていることを確かめる意味が無くなり、マスクの判断が 2 か所に分かれる。
//   画面側の shared/ は apps/shared を参照できない（規則 screen-to-shared）ので、マスクの済んだ行の形は logger.test.ts と
//   E2E（apps/e2e/request-log.spec.ts。stdout にクエリの値が出ないこと）で確かめる。
describe("buildRequestLog: url.path と url.query（キーと値の組。マスクは logger が行う）", () => {
  test("クエリをキーと値の組（デコードした値）にして、出現順に出す", () => {
    // given
    const url =
      "http://localhost/api/todos?email=secret%40example.com&token=s3cr3t";

    // when
    const log = buildRequestLog(input({ url }));

    // then
    expect(log.url).toEqual({
      path: "/api/todos",
      query: { email: "secret@example.com", token: "s3cr3t" },
    });
    expect(Object.keys(log.url.query)).toEqual(["email", "token"]);
  });

  // WHY 後の値を使う: 値は logger が *** にするので、どの値を残すかは行の中身に影響しない。キーの種類と順（最初に出た位置）が
  //   分かれば足りる。
  test("同じキーが複数回あっても 1 回だけ出す（位置は最初に出た所、値は後のもの）", () => {
    // given
    const url = "http://localhost/?a=1&b=2&a=3";

    // when
    const { query } = buildRequestLog(input({ url })).url;

    // then
    expect(query).toEqual({ a: "3", b: "2" });
    expect(Object.keys(query)).toEqual(["a", "b"]);
  });

  test("値の無いキー・空のクエリ・フラグメントを扱う", () => {
    // given: 前提なし（input はヘッダなどの既定値を持つヘルパー）
    // when
    const withFlag = buildRequestLog(
      input({ url: "http://localhost/x?flag#frag" }),
    );
    const emptyQuery = buildRequestLog(input({ url: "http://localhost/x?" }))
      .url.query;

    // then
    expect(withFlag).toMatchObject({
      url: { path: "/x", query: { flag: "" } },
    });
    expect(emptyQuery).toEqual({});
  });
});

describe("buildRequestLog: http.request.id（x-request-id）", () => {
  test("x-request-id があればそれを使い、生成しない", () => {
    // given
    let calls = 0;
    const requestInput = input({
      headers: { "x-request-id": "from-upstream" },
      generateRequestId: () => {
        calls += 1;
        return "generated-id";
      },
    });

    // when
    const log = buildRequestLog(requestInput);

    // then
    expect(log.http.request.id).toBe("from-upstream");
    expect(calls).toBe(0);
  });

  test("x-request-id が無いときと空のときは生成した値を使う", () => {
    // given: 前提なし（input はヘッダなどの既定値を持つヘルパー）
    // when
    const missing = buildRequestLog(input()).http.request.id;
    const empty = buildRequestLog(input({ headers: { "x-request-id": "" } }))
      .http.request.id;

    // then
    expect(missing).toBe("generated-id");
    expect(empty).toBe("generated-id");
  });
});

describe("buildRequestLog: client.address（x-forwarded-for の先頭 → x-real-ip → null）", () => {
  test("x-forwarded-for の先頭（前後の空白を除く）を使い、x-real-ip より優先する", () => {
    // given
    const headers = {
      "x-forwarded-for": "  198.51.100.7 ,203.0.113.5",
      "x-real-ip": "10.0.0.9",
    };

    // when
    const address = buildRequestLog(input({ headers })).client.address;

    // then
    expect(address).toBe("198.51.100.7");
  });

  test("x-forwarded-for が 1 件だけならそれを使う", () => {
    // given
    const headers = { "x-forwarded-for": "::1" };

    // when
    const address = buildRequestLog(input({ headers })).client.address;

    // then
    expect(address).toBe("::1");
  });

  test("x-forwarded-for が無いときは x-real-ip を使う", () => {
    // given
    const headers = { "x-real-ip": "10.0.0.9" };

    // when
    const address = buildRequestLog(input({ headers })).client.address;

    // then
    expect(address).toBe("10.0.0.9");
  });

  test("x-forwarded-for の先頭が空なら x-real-ip を使う", () => {
    // given
    const headers = {
      "x-forwarded-for": " , 203.0.113.5",
      "x-real-ip": "10.0.0.9",
    };

    // when
    const address = buildRequestLog(input({ headers })).client.address;

    // then
    expect(address).toBe("10.0.0.9");
  });

  test("どちらも無い・空なら null", () => {
    // given: 前提なし（input はヘッダなどの既定値を持つヘルパー）
    // when
    const missing = buildRequestLog(input()).client.address;
    const empty = buildRequestLog(
      input({ headers: { "x-forwarded-for": "", "x-real-ip": "" } }),
    ).client.address;

    // then
    expect(missing).toBeNull();
    expect(empty).toBeNull();
  });
});

describe("buildRequestLog: http.request.body.size（Content-Length）", () => {
  test.each([
    ["0", 0],
    ["12", 12],
    ["1048576", 1048576],
  ])("Content-Length %s は %d バイト", (value, bytes) => {
    // given: 前提なし（value は test.each の引数）
    // when
    const size = buildRequestLog(
      input({ headers: { "content-length": value } }),
    ).http.request.body.size;

    // then
    expect(size).toBe(bytes);
  });

  // 数値として読めない値は推測で埋めず null にする（負の数・小数・数字以外・空）。
  test.each(["", "-1", "1.5", "abc", "12abc", " "])(
    "Content-Length %j は null",
    (value) => {
      // given: 前提なし（value は test.each の引数）
      // when
      const size = buildRequestLog(
        input({ headers: { "content-length": value } }),
      ).http.request.body.size;

      // then
      expect(size).toBeNull();
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
    // given: 前提なし
    // when
    const trace = traceOf(`00-${TRACE_ID}-${SPAN_ID}-01`, "prod-123");

    // then
    expect(trace).toEqual({
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
      // given: 前提なし（traceId・spanId は test.each の引数）
      // when
      const trace = traceOf(`00-${traceId}-${spanId}-00`);

      // then
      expect(trace).toEqual({
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
    // given: 前提なし（flags は test.each の引数）
    // when
    const trace = traceOf(`00-${TRACE_ID}-${SPAN_ID}-${flags}`);

    // then
    expect(trace.sampled).toBe(sampled);
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
    // given: 前提なし（traceparent は test.each の引数）
    // when
    const log = buildRequestLog(input({ headers: { traceparent } }));

    // then
    expect(
      Object.keys(log).filter((key) => key.startsWith("logging.")),
    ).toEqual([]);
  });

  test("traceparent が無ければ trace のキーを出さない（null も入れない）", () => {
    // given: 前提なし（input はヘッダなどの既定値を持つヘルパー）
    // when
    const keys = Object.keys(buildRequestLog(input()));

    // then
    expect(keys).not.toContain("logging.googleapis.com/trace");
  });
});
