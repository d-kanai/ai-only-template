// @vitest-environment node
import { describe, expect, test } from "vitest";
import { SameOrigin } from "./same-origin";

// API は同じオリジンの画面からだけ呼ぶ前提（Issue #106。ADR docs/adr/architecture/20261003-security-headers-and-same-origin-api.md）。
// 書き込みのリクエストに、別のオリジンのブラウザが付ける Origin が付いていたら拒否する（CSRF の対策）。
describe("SameOrigin.rejects", () => {
  test.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s で Origin のホストが Host と違えば拒否する",
    (method) => {
      // given
      const request = apiRequest(method, {
        host: "app.example.com",
        origin: "https://evil.example.com",
      });

      // when
      const rejected = SameOrigin.rejects(request);

      // then
      expect(rejected).toBe(true);
    },
  );

  test("Origin のホストが Host と同じなら拒否しない（スキームは見ない）", () => {
    // given: Cloud Run の前段で TLS が終わり、アプリには http で届いても、ブラウザの Origin は https になる
    const request = apiRequest("POST", {
      host: "app.example.com",
      origin: "https://app.example.com",
    });

    // when
    const rejected = SameOrigin.rejects(request);

    // then
    expect(rejected).toBe(false);
  });

  test("ホスト名とポートが Host と同じなら拒否しない（ポート付き）", () => {
    // given
    const request = apiRequest("POST", {
      host: "localhost:3100",
      origin: "http://localhost:3100",
    });

    // when
    const rejected = SameOrigin.rejects(request);

    // then
    expect(rejected).toBe(false);
  });

  test("ポートが違えば別のオリジンとして拒否する", () => {
    // given
    const request = apiRequest("POST", {
      host: "localhost:3100",
      origin: "http://localhost:3000",
    });

    // when
    const rejected = SameOrigin.rejects(request);

    // then
    expect(rejected).toBe(true);
  });

  test("Origin が null（サンドボックスの iframe や file:// のページ）なら拒否する", () => {
    // given
    const request = apiRequest("POST", {
      host: "app.example.com",
      origin: "null",
    });

    // when
    const rejected = SameOrigin.rejects(request);

    // then
    expect(rejected).toBe(true);
  });

  test("Host が無ければ、Origin と比べられないので拒否する", () => {
    // given
    const request = apiRequest("POST", { origin: "https://app.example.com" });

    // when
    const rejected = SameOrigin.rejects(request);

    // then
    expect(rejected).toBe(true);
  });

  test("Origin が null で Host も無ければ拒否する（どちらも無いホストとして一致させない）", () => {
    // given
    const request = apiRequest("POST", { origin: "null" });

    // when
    const rejected = SameOrigin.rejects(request);

    // then
    expect(rejected).toBe(true);
  });

  test("Origin が無い書き込み（curl やサーバからの呼び出し）は拒否しない", () => {
    // given
    const request = apiRequest("POST", { host: "app.example.com" });

    // when
    const rejected = SameOrigin.rejects(request);

    // then
    expect(rejected).toBe(false);
  });

  test.each(["GET", "HEAD", "OPTIONS"])(
    "%s（読み取り）は Origin が違っても拒否しない",
    (method) => {
      // given
      const request = apiRequest(method, {
        host: "app.example.com",
        origin: "https://evil.example.com",
      });

      // when
      const rejected = SameOrigin.rejects(request);

      // then
      expect(rejected).toBe(false);
    },
  );
});

function apiRequest(method: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/todos", { method, headers });
}
