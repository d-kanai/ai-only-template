import { describe, expect, test } from "vitest";
import {
  buildRequestLog,
  type RequestLog,
  type RequestLogInput,
} from "@/shared/request-log/request-log";

// リクエストログ（1 リクエスト = JSON 1 行、5W1H）の 1 行の中身を固定する仕様。
// proxy.ts（Next の規約ファイル。カバレッジの対象外）は、この関数に NextRequest の値を渡して出力するだけにしている。
// WHY 受信時刻と requestId の生成を引数で受け取る: 時刻と乱数をテストから固定し、出力を toEqual で丸ごと比べるため。

const receivedAt = new Date("2026-09-29T01:02:03.456Z");

function input(overrides: Partial<RequestLogInput> = {}): RequestLogInput {
  return {
    method: "GET",
    url: "http://localhost:3100/",
    headers: {},
    receivedAt,
    generateRequestId: () => "generated-id",
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
      requestId: "req-1",
      client: {
        ip: "203.0.113.5",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      },
      user: { id: null },
      kind: "page",
      method: "GET",
      path: "/todo/abc",
      queryKeys: ["tab", "sort"],
      timestamp: "2026-09-29T01:02:03.456Z",
      host: "localhost:3100",
      referer: "http://localhost:3100/",
      accept: "text/html,application/xhtml+xml",
      contentType: "text/plain",
      requestBytes: 12,
    } satisfies RequestLog);
  });

  test("ヘッダが 1 つも無いときは、ヘッダ由来の項目をすべて null にし、requestId を生成する", () => {
    expect(
      buildRequestLog(
        input({ method: "POST", url: "http://localhost:3100/api/todos" }),
      ),
    ).toEqual({
      requestId: "generated-id",
      client: { ip: null, userAgent: null },
      user: { id: null },
      kind: "api",
      method: "POST",
      path: "/api/todos",
      queryKeys: [],
      timestamp: "2026-09-29T01:02:03.456Z",
      host: null,
      referer: null,
      accept: null,
      contentType: null,
      requestBytes: null,
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
    expect(log.client.userAgent).toBe("curl/8.5.0");
    expect(log.host).toBe("example.com");
    expect(log.accept).toBe("*/*");
  });

  test("record のヘッダ名が大文字でも読む", () => {
    const log = buildRequestLog(
      input({ headers: { "Content-Type": "application/json" } }),
    );
    expect(log.contentType).toBe("application/json");
  });

  test("user.id は認証が入るまで常に null（ヘッダに何があっても埋めない）", () => {
    const log = buildRequestLog(
      input({ headers: { "x-user-id": "u-1", authorization: "Bearer t" } }),
    );
    expect(log.user).toEqual({ id: null });
  });

  test("timestamp は受信時刻の ISO 8601（UTC）", () => {
    const log = buildRequestLog(
      input({ receivedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)) }),
    );
    expect(log.timestamp).toBe("2026-01-02T03:04:05.006Z");
  });

  test("method は受け取った値のまま出す", () => {
    expect(buildRequestLog(input({ method: "DELETE" })).method).toBe("DELETE");
  });
});

describe("buildRequestLog: kind の判定（/api/** は api、それ以外は page）", () => {
  // must pass（api と判定する）
  test.each([
    "http://localhost/api",
    "http://localhost/api/",
    "http://localhost/api/todos",
    "http://localhost/api/todos/abc?x=1",
  ])("%s は api", (url) => {
    expect(buildRequestLog(input({ url })).kind).toBe("api");
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
  ])("%s は page", (url) => {
    expect(buildRequestLog(input({ url })).kind).toBe("page");
  });
});

describe("buildRequestLog: path と queryKeys（クエリの値は出さない）", () => {
  test("クエリの値はどの項目にも出さず、キーだけを出現順に出す", () => {
    const log = buildRequestLog(
      input({
        url: "http://localhost/api/todos?email=secret%40example.com&token=s3cr3t",
      }),
    );
    expect(log.path).toBe("/api/todos");
    expect(log.queryKeys).toEqual(["email", "token"]);
    const line = JSON.stringify(log);
    expect(line).not.toContain("secret");
    expect(line).not.toContain("s3cr3t");
  });

  test("同じキーが複数回あっても 1 回だけ出す", () => {
    expect(
      buildRequestLog(input({ url: "http://localhost/?a=1&b=2&a=3" }))
        .queryKeys,
    ).toEqual(["a", "b"]);
  });

  test("値の無いキー・空のクエリ・フラグメントを扱う", () => {
    expect(
      buildRequestLog(input({ url: "http://localhost/x?flag#frag" })),
    ).toMatchObject({ path: "/x", queryKeys: ["flag"] });
    expect(
      buildRequestLog(input({ url: "http://localhost/x?" })).queryKeys,
    ).toEqual([]);
  });
});

describe("buildRequestLog: requestId", () => {
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
    expect(log.requestId).toBe("from-upstream");
    expect(calls).toBe(0);
  });

  test("x-request-id が無いときと空のときは生成した値を使う", () => {
    expect(buildRequestLog(input()).requestId).toBe("generated-id");
    expect(
      buildRequestLog(input({ headers: { "x-request-id": "" } })).requestId,
    ).toBe("generated-id");
  });
});

describe("buildRequestLog: client.ip（x-forwarded-for の先頭 → x-real-ip → null）", () => {
  test("x-forwarded-for の先頭（前後の空白を除く）を使い、x-real-ip より優先する", () => {
    expect(
      buildRequestLog(
        input({
          headers: {
            "x-forwarded-for": "  198.51.100.7 ,203.0.113.5",
            "x-real-ip": "10.0.0.9",
          },
        }),
      ).client.ip,
    ).toBe("198.51.100.7");
  });

  test("x-forwarded-for が 1 件だけならそれを使う", () => {
    expect(
      buildRequestLog(input({ headers: { "x-forwarded-for": "::1" } })).client
        .ip,
    ).toBe("::1");
  });

  test("x-forwarded-for が無いときは x-real-ip を使う", () => {
    expect(
      buildRequestLog(input({ headers: { "x-real-ip": "10.0.0.9" } })).client
        .ip,
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
      ).client.ip,
    ).toBe("10.0.0.9");
  });

  test("どちらも無い・空なら null", () => {
    expect(buildRequestLog(input()).client.ip).toBeNull();
    expect(
      buildRequestLog(
        input({ headers: { "x-forwarded-for": "", "x-real-ip": "" } }),
      ).client.ip,
    ).toBeNull();
  });
});

describe("buildRequestLog: requestBytes（Content-Length）", () => {
  test.each([
    ["0", 0],
    ["12", 12],
    ["1048576", 1048576],
  ])("Content-Length %s は %d バイト", (value, bytes) => {
    expect(
      buildRequestLog(input({ headers: { "content-length": value } }))
        .requestBytes,
    ).toBe(bytes);
  });

  // 数値として読めない値は推測で埋めず null にする（負の数・小数・数字以外・空）。
  test.each(["", "-1", "1.5", "abc", "12abc", " "])(
    "Content-Length %j は null",
    (value) => {
      expect(
        buildRequestLog(input({ headers: { "content-length": value } }))
          .requestBytes,
      ).toBeNull();
    },
  );
});
