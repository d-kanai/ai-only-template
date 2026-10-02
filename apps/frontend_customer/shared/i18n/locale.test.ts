import { describe, expect, test } from "vitest";
import {
  DEFAULT_LOCALE,
  Locales,
  SUPPORTED_LOCALES,
} from "@/shared/i18n/locale";

describe("対応するロケール", () => {
  test("ja と en に対応し、既定は ja", () => {
    // given: 前提なし
    // when
    const supported = SUPPORTED_LOCALES;
    const defaultLocale = DEFAULT_LOCALE;

    // then
    expect(supported).toEqual(["ja", "en"]);
    expect(defaultLocale).toBe("ja");
  });

  test.each([
    ["ja", true],
    ["en", true],
    ["fr", false],
    ["JA", false],
    ["en-US", false],
    ["", false],
    [null, false],
  ])("Locales.is(%j) は %s", (value, expected) => {
    // given: 前提なし（value は test.each の引数）
    // when
    const result = Locales.is(value);

    // then
    expect(result).toBe(expected);
  });
});

describe("Locales.negotiate（Cookie NEXT_LOCALE → Accept-Language の順で決める）", () => {
  test("Cookie が対応するロケールなら、Accept-Language より優先する", () => {
    // given: 前提なし
    // when
    const cookieEn = Locales.negotiate("ja,en;q=0.9", "en");
    const cookieJa = Locales.negotiate("en", "ja");

    // then
    expect(cookieEn).toBe("en");
    expect(cookieJa).toBe("ja");
  });

  // Cookie は利用者が書き換えられる値なので、対応していない値は無かったものとして Accept-Language で決める。
  test("Cookie が対応していない値なら、Accept-Language で決める", () => {
    // given: 前提なし
    // when
    const unsupported = Locales.negotiate("en", "fr");
    const empty = Locales.negotiate("en", "");

    // then
    expect(unsupported).toBe("en");
    expect(empty).toBe("en");
  });

  test("Cookie が無ければ、Accept-Language で決める", () => {
    // given: 前提なし
    // when
    const locale = Locales.negotiate("en", null);

    // then
    expect(locale).toBe("en");
  });

  test("地域の付いたタグ（en-US・ja-JP）は言語の部分で照合する", () => {
    // given: 前提なし
    // when
    const en = Locales.negotiate("en-US", null);
    const ja = Locales.negotiate("ja-JP", null);

    // then
    expect(en).toBe("en");
    expect(ja).toBe("ja");
  });

  test("大文字・前後の空白を含むタグも照合する", () => {
    // given: 前提なし
    // when
    const locale = Locales.negotiate(" EN-us ", null);

    // then
    expect(locale).toBe("en");
  });

  test("q 値の高い順に、最初に対応するロケールを選ぶ（書いた順ではない）", () => {
    // given: 前提なし
    // when
    const en = Locales.negotiate("ja;q=0.5, en;q=0.8", null);
    const ja = Locales.negotiate("en;q=0.1,ja", null);

    // then
    expect(en).toBe("en");
    expect(ja).toBe("ja");
  });

  test("q 値が同じなら、書いた順で先のものを選ぶ", () => {
    // given: 前提なし
    // when
    const en = Locales.negotiate("en;q=0.5,ja;q=0.5", null);
    const ja = Locales.negotiate("ja,en", null);

    // then
    expect(en).toBe("en");
    expect(ja).toBe("ja");
  });

  // 空白を許さないと "en ; q=0.1" の q が読めず q=1 扱いになり、先に書いた en が選ばれてしまう。
  test("q 値の前後の空白を許す", () => {
    // given: 前提なし
    // when
    const locale = Locales.negotiate("en ; q=0.1, ja", null);

    // then
    expect(locale).toBe("ja");
  });

  test("対応していない言語は飛ばし、次に対応するロケールを選ぶ", () => {
    // given: 前提なし
    // when
    const locale = Locales.negotiate("fr-FR,fr;q=0.9,en;q=0.8,ja;q=0.7", null);

    // then
    expect(locale).toBe("en");
  });

  // q=0 は「受け付けない」の意味（RFC 9110 の 12.4.2）。
  test("q=0 の言語は選ばない", () => {
    // given: 前提なし
    // when
    const fallbackToJa = Locales.negotiate("en;q=0,ja;q=0.1", null);
    const onlyRejected = Locales.negotiate("en;q=0", null);

    // then
    expect(fallbackToJa).toBe("ja");
    expect(onlyRejected).toBe(DEFAULT_LOCALE);
  });

  // RFC 9110 の 12.4.2: weight = OWS ";" OWS "q=" qvalue。"q" は大文字・小文字を区別しない（5.6.6 のパラメータ名）。
  // 区別すると "en;Q=0.1" の q が読めず q=1 扱いになり、先に書いた en が選ばれてしまう。
  test("q 値の q は大文字でもよい", () => {
    // given: 前提なし
    // when
    const locale = Locales.negotiate("en;Q=0.1, ja", null);

    // then
    expect(locale).toBe("ja");
  });

  // qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )（RFC 9110 の 12.4.2）。範囲外は書き方の誤りで、その言語の
  //   重みが分からないので候補から外す（en だけを並べ、en が選ばれず既定の ja になることで確かめる）。
  // WHY en だけを並べる（低い q の ja を並べない）: "0.0001" のように 0 に近い値を誤って受け付けても、ja より低いと
  //   結果が同じになり見逃す。en だけなら、受け付ければ en、外せば既定の ja になる。
  test.each([
    ["1 より大きい", "2"],
    ["1 より大きい小数", "1.5"],
    ["負の数", "-0.5"],
  ])("q 値が 0〜1 の範囲外（%s）なら、その言語は選ばない", (_label, q) => {
    // given: 前提なし（q は test.each の引数）
    // when
    const locale = Locales.negotiate(`en;q=${q}`, null);

    // then
    expect(locale).toBe(DEFAULT_LOCALE);
  });

  // Number() は "0x1"（16 進）や "1e0"（指数）も数にするので、数に変換できるかではなく qvalue の書き方で判定する。
  test.each([
    ["16 進", "0x1"],
    ["指数", "1e0"],
    ["文字", "abc"],
    ["小数点以下が 4 桁", "0.0001"],
    ["先頭に余分な 0", "00.5"],
  ])(
    "q 値が qvalue の書き方でない（%s）なら、その言語は選ばない",
    (_label, q) => {
      // given: 前提なし（q は test.each の引数）
      // when
      const locale = Locales.negotiate(`en;q=${q}`, null);

      // then
      expect(locale).toBe(DEFAULT_LOCALE);
    },
  );

  test.each([
    ["1", "1"],
    ["1.", "1."],
    ["1.000", "1.000"],
    ["0.001", "0.001"],
  ])("q 値 %s は有効な qvalue として扱う", (_label, q) => {
    // given: 前提なし（q は test.each の引数）
    // when
    const locale = Locales.negotiate(`ja;q=0, en;q=${q}`, null);

    // then
    expect(locale).toBe("en");
  });

  test("q 以外のパラメータは無視する", () => {
    // given: 前提なし
    // when
    const locale = Locales.negotiate("en;level=1", null);

    // then
    expect(locale).toBe("en");
  });

  test.each([
    ["Accept-Language が無い", null],
    ["空", ""],
    ["対応する言語が無い", "fr,de;q=0.9"],
    ["* だけ", "*"],
    ["区切りだけ", " , ;q=1"],
  ])("%s ときは既定の ja", (_label, acceptLanguage) => {
    // given: 前提なし（acceptLanguage は test.each の引数）
    // when
    const locale = Locales.negotiate(acceptLanguage, null);

    // then
    expect(locale).toBe(DEFAULT_LOCALE);
  });
});

describe("Locales.fromHeader（Proxy が載せた x-locale を layout で読む）", () => {
  test("対応するロケールならそのまま返す", () => {
    // given: 前提なし
    // when
    const en = Locales.fromHeader("en");
    const ja = Locales.fromHeader("ja");

    // then
    expect(en).toBe("en");
    expect(ja).toBe("ja");
  });

  // Proxy を通らないリクエスト（matcher の外・テスト）や、クライアントが直接送った不正な値のとき。
  test("無い・対応していない値なら既定の ja", () => {
    // given: 前提なし
    // when
    const missing = Locales.fromHeader(null);
    const unsupported = Locales.fromHeader("fr");

    // then
    expect(missing).toBe(DEFAULT_LOCALE);
    expect(unsupported).toBe(DEFAULT_LOCALE);
  });
});
