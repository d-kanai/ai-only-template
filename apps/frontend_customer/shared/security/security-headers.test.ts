import { CspEvaluator, DEFAULT_CHECKS, STRICTCSP_CHECKS } from "csp_evaluator";
import { Severity, Type } from "csp_evaluator/dist/finding.js";
import { CspParser } from "csp_evaluator/dist/parser.js";
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
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ]);
  });
});

// CSP を Google の CSP Evaluator（npm csp_evaluator。https://csp-evaluator.withgoogle.com/ と同じ検査）で評価する（Issue #379）。
// WHY 値の丸ごとの固定（上の toBe）に加えて評価する: toBe は「今の値から変わった」ことしか分からず、変えた値が弱いかどうかは
//   レビューの目に頼る。評価器は弱い書き方（'unsafe-inline'・短い nonce・base-uri の欠け・抜け道のあるホスト）を種類で名指しする。
// WHY 既定の検査（DEFAULT_CHECKS）と strict CSP の検査（STRICTCSP_CHECKS）の両方: Web 版の CSP Evaluator が既定で行う組み合わせで、
//   strict CSP の検査は nonce と 'strict-dynamic' の書き方（フォールバックの有無）を見る。
// WHY 重大度 MEDIUM_MAYBE（50）以上で止める: 値が小さいほど重い（HIGH=10・SYNTAX=20・MEDIUM=30・HIGH_MAYBE=40・STRICT_CSP=45・
//   MEDIUM_MAYBE=50・INFO=60・NONE=100。csp_evaluator 1.1.8 の dist/finding.d.ts）。INFO（Trusted Types を勧める指摘）は見送った
//   （Turbopack の実行時のチャンク読み込みと Mantine が文字列を DOM に入れる。ADR docs/adr/quality/20261003-csp-evaluator-and-cross-origin-isolation.md）。
// 除く指摘（種類と値で名指しする。ほかの指摘は、同じ種類でも値が違えば止める）。どれも、Next.js 16 が対応するブラウザ
//   （Chrome / Edge / Firefox 111+・Safari 16.4+。node_modules/next/dist/docs/03-architecture/supported-browsers.md）がすべて
//   'strict-dynamic' を解する（Chrome / Firefox 52・Safari 15.4。MDN の browser-compat-data）ので、効く場面が無いもの。
// - SCRIPT_ALLOWLIST_BYPASS の 'self'（「JSONP・AngularJS・利用者のアップロードを置くと抜け道になる」）: 'strict-dynamic' の
//   下では 'self' は無視される（評価器自身が IGNORED を出す）。'self' は 'strict-dynamic' を解さない古いブラウザ向けの互換で、
//   Next の CSP の文書の例と同じ。どれも置いていない。
// - UNSAFE_INLINE_FALLBACK・ALLOWLIST_FALLBACK（古いブラウザ向けに 'unsafe-inline'・https: を足せという勧め）: nonce と
//   'strict-dynamic' を解するブラウザは無視する値で、足しても対応ブラウザでは何も変わらず、値を読む人には弱く見える。
// WHY 'self' の除外は script-src に 'strict-dynamic' があるときだけ（reviewer の指摘、PR #397）: 'self' が無視されるのは
//   'strict-dynamic' の下だけ。条件を付けないと、'strict-dynamic' を消して CSP を弱めても評価器のテストが緑のままになる。
//   UNSAFE_INLINE_FALLBACK・ALLOWLIST_FALLBACK は、評価器が nonce / hash と 'strict-dynamic' のあるときにしか出さないので条件は要らない。
const ACCEPTED_FINDINGS: readonly {
  type: Type;
  value?: string;
  onlyWithStrictDynamic?: true;
}[] = [
  {
    type: Type.SCRIPT_ALLOWLIST_BYPASS,
    value: "'self'",
    onlyWithStrictDynamic: true,
  },
  { type: Type.UNSAFE_INLINE_FALLBACK },
  { type: Type.ALLOWLIST_FALLBACK },
];

// 重大度 MEDIUM_MAYBE 以上で、除く指摘に当たらないものを [種類, 値] で返す（toEqual で丸ごと比べるため）。
function seriousFindings(policy: string): [Type, string | undefined][] {
  const csp = new CspParser(policy).csp;
  const strictDynamic =
    csp.directives["script-src"]?.includes("'strict-dynamic'") === true;
  const findings = new CspEvaluator(csp).evaluate(
    DEFAULT_CHECKS,
    STRICTCSP_CHECKS,
  );
  return findings
    .filter((finding) => finding.severity <= Severity.MEDIUM_MAYBE)
    .filter(
      (finding) =>
        !ACCEPTED_FINDINGS.some(
          (accepted) =>
            accepted.type === finding.type &&
            accepted.value === finding.value &&
            (accepted.onlyWithStrictDynamic !== true || strictDynamic),
        ),
    )
    .map((finding) => [finding.type, finding.value]);
}

describe("SecurityHeaders.contentSecurityPolicy を CSP Evaluator で評価する", () => {
  test("本番の CSP には、重大度 MEDIUM_MAYBE 以上の指摘が無い（名指しで除いた古いブラウザ向けの指摘を除く）", () => {
    // given
    const policy = SecurityHeaders.contentSecurityPolicy(
      "bm9uY2UxMjM0NTY3OA==",
      false,
    );

    // when
    const findings = seriousFindings(policy);

    // then
    expect(findings).toEqual([]);
  });

  test("開発の CSP は、script-src の 'unsafe-eval' を指摘される（本番だけに評価を通す理由）", () => {
    // given
    const policy = SecurityHeaders.contentSecurityPolicy(
      "bm9uY2UxMjM0NTY3OA==",
      true,
    );

    // when
    const findings = seriousFindings(policy);

    // then
    expect(findings).toEqual([[Type.SCRIPT_UNSAFE_EVAL, "'unsafe-eval'"]]);
  });

  test("script-src に 'unsafe-inline' を足し 'strict-dynamic' と nonce を外した CSP は、'unsafe-inline' を指摘される", () => {
    // given
    const policy =
      "default-src 'self'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'self'";

    // when
    const findings = seriousFindings(policy);

    // then
    expect(findings).toEqual([[Type.SCRIPT_UNSAFE_INLINE, "'unsafe-inline'"]]);
  });

  test("'strict-dynamic' を外した CSP は、script-src の 'self' を指摘される（'self' を除くのは 'strict-dynamic' の下だけ）", () => {
    // given: 'strict-dynamic' が無いと、どのブラウザも 'self' を読み、同じオリジンに置いたスクリプトが抜け道になる
    const policy =
      "default-src 'self'; script-src 'self' 'nonce-bm9uY2UxMjM0NTY3OA=='; object-src 'none'; base-uri 'self'";

    // when
    const findings = seriousFindings(policy);

    // then
    expect(findings).toEqual([[Type.SCRIPT_ALLOWLIST_BYPASS, "'self'"]]);
  });

  test("除く指摘と同じ種類でも、値が 'self' でなければ止める（script-src のほかのホスト）", () => {
    // given
    const policy =
      "default-src 'self'; script-src https://cdn.example.com; object-src 'none'; base-uri 'self'";

    // when
    const findings = seriousFindings(policy);

    // then
    expect(findings).toEqual([
      [Type.SCRIPT_ALLOWLIST_BYPASS, "https://cdn.example.com"],
      [Type.STRICT_DYNAMIC, undefined],
    ]);
  });
});
