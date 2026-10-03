import { describe, expect, test } from "vitest";
import { SecurityHeaders } from "./security-headers";

// 応答に付けるセキュリティヘッダ（Issue #106）。値の WHY は security-headers.ts、決定は
//   ADR docs/adr/architecture/20261003-security-headers-and-same-origin-api.md。
describe("SecurityHeaders.contentSecurityPolicy", () => {
  test("本番では、スクリプトをこの要求の nonce と自分のオリジンだけに絞り、eval を許さない", () => {
    // given
    const nonce = "bm9uY2U=";

    // when
    const policy = SecurityHeaders.contentSecurityPolicy(nonce, false);

    // then
    expect(policy).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-bm9uY2U=' 'strict-dynamic'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  });

  test("開発（next dev）では、React のデバッグ情報のために script-src に 'unsafe-eval' を足す", () => {
    // given
    const nonce = "bm9uY2U=";

    // when
    const policy = SecurityHeaders.contentSecurityPolicy(nonce, true);

    // then
    expect(policy).toContain(
      "script-src 'self' 'nonce-bm9uY2U=' 'strict-dynamic' 'unsafe-eval';",
    );
  });
});

describe("SecurityHeaders.nonce", () => {
  test("乱数の UUID を base64 にした値を返す（要求ごとに違う値）", () => {
    // given
    const uuid = "123e4567-e89b-42d3-a456-426614174000";

    // when
    const nonce = SecurityHeaders.nonce(() => uuid);

    // then
    expect(nonce).toBe(btoa(uuid));
  });
});

describe("SecurityHeaders.common", () => {
  test("すべての応答に付けるヘッダの名前と値の一覧を返す", () => {
    // given: 前提なし

    // when
    const headers = SecurityHeaders.common();

    // then
    expect(headers).toEqual([
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()",
      },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ]);
  });
});
