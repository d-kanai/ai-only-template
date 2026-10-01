// @vitest-environment node
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  freeText,
  LOG_EVENT_NAMES,
  LOG_EVENT_SCHEMAS,
  maskFreeText,
  sensitive,
} from "./log-event";

// ログの種類（event.name）ごとのスキーマと、マスクの印（sensitive / freeText）の仕様（Issue #216）。
// 行の出力（logger.emit を通した 1 行。番兵の値が出ないこと・一覧に無いキーが落ちること・parse の失敗）は logger.test.ts。
// ここは印そのものの振る舞い（何を *** にし、何を残すか・時間の上限）を固定する。

// 番兵の値。出てはいけない値に入れ、parse した結果の JSON に含まれないことを確かめる（正規表現に一致しない文字列）。
const SENTINEL = "SENTINEL-PII";

describe("LOG_EVENT_NAMES（event.name の一覧）", () => {
  // WHY 一覧を固定する: event.name は Logs Explorer で jsonPayload.event.name="<名前>" と引くための値で、名前を変えると
  //   保存したクエリ・アラートが黙って空になる。足す・変えるときはこのテストと ADR を同じ変更で直す。
  test("event.name に使える名前は、決めた一覧だけ（snake_case）", () => {
    expect(LOG_EVENT_NAMES).toEqual([
      "page_request",
      "api_request",
      "db_write",
      "db_pool_error",
      "db_backfill",
      "server_error",
      "app_start_failed",
      "notification",
      "logger_error",
    ]);
  });

  // WHY スキーマの登録と一覧を突き合わせる: 一覧に名前を足してスキーマを足し忘れると、その種類の行はすべて parse できず
  //   logger_error になる（型でも satisfies が止めるが、実行時の値でも確かめる）。
  test("LOG_EVENT_SCHEMAS は一覧のすべての名前のスキーマを持ち、それ以外を持たない", () => {
    expect(Object.keys(LOG_EVENT_SCHEMAS)).toEqual([...LOG_EVENT_NAMES]);
  });
});

describe("sensitive（値を *** にする印）", () => {
  test("どんな文字列も *** にする", () => {
    const schema = sensitive(z.string());
    expect(schema.parse("alice@example.com")).toBe("***");
    expect(schema.parse("")).toBe("***");
  });

  // WHY null はそのまま: 値が無いことは個人情報ではない（Issue #216 の既定の判断）。nullable を外側に付けて書く。
  test("nullable を外側に付けると null は null のまま出し、文字列だけを *** にする", () => {
    const schema = sensitive(z.string()).nullable();
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse("http://localhost/?q=1")).toBe("***");
  });

  // WHY 包んだスキーマの検査は残す: 印を付けても、形の違う値（数値など）は通さない（allowlist の型の検査を緩めない）。
  test("包んだスキーマに合わない値は parse に失敗する", () => {
    expect(sensitive(z.string()).safeParse(1).success).toBe(false);
  });
});

describe("maskFreeText / freeText（自由文の最後の網）", () => {
  test.each([
    [
      "メールアドレス",
      "user alice.b+tag@mail.example.co.jp not found",
      "user *** not found",
    ],
    [
      "JWT（eyJ で始まる base64url の 3 つ組）",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-x was rejected",
      "token *** was rejected",
    ],
    [
      "Bearer のトークン（大文字・小文字を問わない）",
      "header Authorization: Bearer abc.DEF~ghi+/x== and bearer zzz",
      "header Authorization: *** and ***",
    ],
    [
      "Luhn に合う 16 桁（連続した数字）",
      "card 4111111111111111 declined",
      "card *** declined",
    ],
    [
      "Luhn に合う 16 桁（4 桁ずつ空白・ハイフンで区切る）",
      "card 4111 1111 1111 1111 / 5500-0000-0000-0004",
      "card *** / ***",
    ],
    ["Luhn に合う 13 桁", "id 4222222222222 x", "id *** x"],
    ["Luhn に合う 19 桁", "n 6011000000000000001 x", "n *** x"],
    [
      "複数の種類がまじっていても、すべて置き換える",
      "a@b.io and c@d.io paid with 4111111111111111",
      "*** and *** paid with ***",
    ],
  ])("%s を *** にする", (_kind, input, expected) => {
    expect(maskFreeText(input)).toBe(expected);
  });

  // WHY 残すものを固定する: 誤検知でログの手がかり（件数・id・時刻）が消えないようにする。
  //   電話番号は入れない（誤検知が多い。Issue #216）。
  test.each([
    ["Luhn に合わない 16 桁", "order 4111111111111112 failed"],
    ["12 桁（13 桁未満）", "order 411111111111 failed"],
    ["20 桁（19 桁を超える連続した数字）", "order 41111111111111111111 failed"],
    ["@ の無い語・ドメインの無いアドレス", "user@ and @example and a@b"],
    ["eyJ を含まない base64 風の文字列", "abc.def.ghi"],
    ["Bearer の後にトークンが無い", "Bearer "],
    ["電話番号", "call 090-1234-5678 or +81 3 1234 5678"],
    [
      "uuid",
      "items has no row to update: 0b9d6d4e-2f6c-4a8a-9b1e-123456789012",
    ],
    ["日本語の文", "環境変数 DATABASE_URL がありません"],
  ])("%s は残す", (_kind, input) => {
    expect(maskFreeText(input)).toBe(input);
  });

  // WHY 長さの上限: 正規表現は入れ子の量指定子を使わない線形のパターンにしているが、1 行が長すぎるとログの費用と読みにくさが
  //   増え、置換の時間も長さに比例する。上限で切り、切った位置にかかった語（途中で切れたメールアドレスなど。切れると正規表現に
  //   一致しない）は捨てる。
  test("2000 文字を超える入力は、2000 文字以内の最後の空白までに切り、[truncated] を付ける（途中で切れた語は出さない）", () => {
    const head = `${"word ".repeat(399)}`; // 1995 文字
    const input = `${head}alice@example.com tail`;

    expect(maskFreeText(input)).toBe(`${head.trimEnd()}...[truncated]`);
  });

  test("空白の無い 2000 文字を超える入力は、本文を出さず [truncated] だけにする", () => {
    expect(maskFreeText("a".repeat(2001))).toBe("...[truncated]");
  });

  test("ちょうど 2000 文字は切らない", () => {
    const input = "a".repeat(2000);
    expect(maskFreeText(input)).toBe(input);
  });

  // WHY 時間の上限を測る: 正規表現の置換はログを出す処理の中で同期に動くので、入力（利用者が決められる例外の message など）で
  //   時間が爆発すると、ログ 1 行で要求が止まる（ReDoS。/^([a-zA-Z]+)*$/ は 31 文字で 60 秒。Issue #216 の調査）。
  //   各パターンが最も苦手とする形（一致しかけて最後に外れる長い連続）を 10 万文字で与える。
  test.each([
    ["@ の無い長い語", "a".repeat(100_000)],
    ["@ が末尾だけ", `${"a".repeat(99_999)}@`],
    ["ドット付きの長いドメイン", `a@${"b.".repeat(50_000)}`],
    ["eyJ の繰り返し", "eyJ".repeat(33_334)],
    ["Bearer の後の長いトークン", `Bearer ${"x".repeat(99_990)}`],
    ["長い数字の連続", "1".repeat(100_000)],
    ["4 桁と区切りの繰り返し", "1234 ".repeat(20_000)],
  ])("%s（10 万文字）でも 50ms 以内に返る", (_kind, input) => {
    const startedAt = performance.now();
    maskFreeText(input);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });

  test("freeText() は文字列のスキーマで、maskFreeText を通した値を出す", () => {
    expect(freeText().parse("mail a@b.io")).toBe("mail ***");
    expect(freeText().safeParse(1).success).toBe(false);
  });
});

// db_write（apps/backend/shared/infra/writer.ts の書き込みのログ）の changes と params の形（Issue #216）。
describe("db_write の changes（before / after）と params", () => {
  const done = {
    message: "db write done",
    event: { name: "db_write", phase: "done", duration_ms: 1 },
    db: { collection: { name: "todos" }, operation: { name: "update" } },
    row_id: "t-1",
  } as const;

  // WHY before / after に sensitive の印を付けない: どの列が個人情報かは表ごとに違い、このスキーマは表を知らない。マスクは
  //   Writer が schema.ts の列の分類表（public / sensitive）で済ませてから渡す（apps/backend/shared/infra/column-classification.ts）。
  test("changes の各要素は table・row_id・operation と、列名 → 値の before / after（insert は before が null、delete は after が null）を持ち、値はそのまま出す", () => {
    const changes = [
      {
        table: "todos",
        row_id: "t-1",
        operation: "update",
        before: { title: "***", completed: false },
        after: { title: "***", completed: true },
      },
      {
        table: "todos",
        row_id: "t-2",
        operation: "insert",
        before: null,
        after: { id: "t-2", created_at: "2026-10-01T00:00:00.000Z" },
      },
      {
        table: "todos",
        row_id: "t-3",
        operation: "delete",
        before: { id: "t-3" },
        after: null,
      },
    ];

    expect(LOG_EVENT_SCHEMAS.db_write.parse({ ...done, changes })).toEqual({
      ...done,
      changes,
    });
  });

  // WHY before / after を必須にする: Writer は必ず渡す（無い側は null）。省くと値の有無と「渡し忘れ」を見分けられない。
  test("changes の要素に before / after が無ければ parse に失敗する", () => {
    expect(
      LOG_EVENT_SCHEMAS.db_write.safeParse({
        ...done,
        changes: [{ table: "todos", row_id: "t-1", operation: "update" }],
      }).success,
    ).toBe(false);
  });

  // WHY params は値をすべて *** にする（個数だけ残す）: DB のエラー（DrizzleQueryError）の params は SQL に渡した行の値そのもの。
  //   どの値が個人情報かは分からないので、構造（配列）で sensitive にする。個数は「何個の値を渡した文か」の手がかりになる。
  test("params は配列の要素をすべて ***（null も）にし、個数は残す", () => {
    const failed = {
      ...done,
      message: "db write failed",
      event: { name: "db_write", phase: "failed", duration_ms: 1 },
    } as const;

    expect(
      LOG_EVENT_SCHEMAS.db_write.parse({
        ...failed,
        params: ["alice@example.com", 3, null, { a: 1 }],
      }),
    ).toEqual({ ...failed, params: ["***", "***", "***", "***"] });
    expect(LOG_EVENT_SCHEMAS.db_write.parse({ ...failed, params: [] })).toEqual(
      { ...failed, params: [] },
    );
  });
});

describe("error 項目（Error を { type, message } にする）", () => {
  // WHY クエリのパラメータを抱えた例外の message を出さない（reviewer の指摘。Issue #216）: drizzle-orm の DrizzleQueryError の
  //   message は「Failed query: <SQL>\nparams: <生の値>」で、Writer が db_write の行でマスクした後に同じ例外を投げ直し、
  //   toProblemResponse の server_error にそのまま届く。どのライブラリの例外でも、query / params を持つ例外の message は生の値を
  //   含みうるので、呼び出し側に依らず logger の中で *** にする（fail closed）。
  test.each([
    ["query と params", { query: "insert into todos", params: [SENTINEL] }],
    ["params だけ", { params: [SENTINEL] }],
    ["query だけ", { query: `select '${SENTINEL}'` }],
  ])(
    "%s を持つ Error は message を *** にし、生の値を出さない",
    (_kind, extra) => {
      const error = Object.assign(
        new Error(`Failed query: insert into todos\nparams: ${SENTINEL}`),
        extra,
      );

      const parsed = LOG_EVENT_SCHEMAS.server_error.parse({
        message: "unexpected error",
        event: { name: "server_error" },
        error,
      });

      expect(parsed.error).toEqual({ type: "Error", message: "***" });
      expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
    },
  );

  test("query / params を持たない Error の message は自由文として出す", () => {
    expect(
      LOG_EVENT_SCHEMAS.server_error.parse({
        message: "unexpected error",
        event: { name: "server_error" },
        error: new Error("connection refused for a@b.io"),
      }).error,
    ).toEqual({ type: "Error", message: "connection refused for ***" });
  });

  // WHY type も自由文の網を通す: Error の name と { type } のオブジェクトの type は、投げた側が自由に決められる文字列。
  test("type も自由文として網を通す（Error の name・{ type } のオブジェクト）", () => {
    const named = Object.assign(new Error("x"), { name: "Err a@b.io" });
    expect(
      LOG_EVENT_SCHEMAS.server_error.parse({
        message: "unexpected error",
        event: { name: "server_error" },
        error: named,
      }).error,
    ).toEqual({ type: "Err ***", message: "x" });
    expect(
      LOG_EVENT_SCHEMAS.server_error.parse({
        message: "unexpected error",
        event: { name: "server_error" },
        error: { type: "c@d.io" },
      }).error,
    ).toEqual({ type: "***" });
  });
});

describe("logger_error の message", () => {
  // WHY 呼び出し側も logger_error を emit できるので、message は自由文の網を通す（logger の固定の文言は網に一致しない）。
  test("message を自由文として網に通す", () => {
    expect(
      LOG_EVENT_SCHEMAS.logger_error.parse({
        message: "failed for a@b.io",
        event: { name: "logger_error" },
      }).message,
    ).toBe("failed for ***");
  });
});

describe("印の無い文字列の項目の長さの上限（bounded）", () => {
  // WHY 上限を付ける: x-request-id・host・accept・content-type・user-agent・パス・クエリのキーはクライアントが自由に決められ、
  //   長さの制限が無い。parse を失敗させず（行を失わず）、256 文字で切って印を付ける。
  test("256 文字を超える値は 256 文字で切り、...[truncated] を付ける。256 文字ちょうどは切らない", () => {
    const long = "x".repeat(300);
    const exact = "y".repeat(256);
    const parsed = LOG_EVENT_SCHEMAS.page_request.parse({
      message: "GET /",
      event: { name: "page_request" },
      time: "2026-01-01T00:00:00.000Z",
      http: {
        request: {
          id: long,
          method: "GET",
          header: { referer: null, accept: long, "content-type": long },
          body: { size: null },
        },
      },
      url: { path: `/${long}`, query: { [long]: "v" } },
      client: { address: null },
      user_agent: { original: long },
      server: { address: exact },
      user: { id: null },
    });
    const cut = `${"x".repeat(256)}...[truncated]`;

    expect(parsed.http.request.id).toBe(cut);
    expect(parsed.http.request.header.accept).toBe(cut);
    expect(parsed.http.request.header["content-type"]).toBe(cut);
    expect(parsed.user_agent.original).toBe(cut);
    expect(parsed.url.path).toBe(`/${"x".repeat(255)}...[truncated]`);
    expect(Object.keys(parsed.url.query)).toEqual([cut]);
    expect(parsed.server.address).toBe(exact);
  });
});
