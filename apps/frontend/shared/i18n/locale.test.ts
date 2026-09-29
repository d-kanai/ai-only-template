import { describe, expect, test } from "vitest";
import {
  DEFAULT_LOCALE,
  isLocale,
  localeFromHeader,
  negotiateLocale,
  SUPPORTED_LOCALES,
} from "@/shared/i18n/locale";

describe("対応するロケール", () => {
  test("ja と en に対応し、既定は ja", () => {
    expect(SUPPORTED_LOCALES).toEqual(["ja", "en"]);
    expect(DEFAULT_LOCALE).toBe("ja");
  });

  test.each([
    ["ja", true],
    ["en", true],
    ["fr", false],
    ["JA", false],
    ["en-US", false],
    ["", false],
    [null, false],
  ])("isLocale(%j) は %s", (value, expected) => {
    expect(isLocale(value)).toBe(expected);
  });
});

describe("negotiateLocale（Cookie NEXT_LOCALE → Accept-Language の順で決める）", () => {
  test("Cookie が対応するロケールなら、Accept-Language より優先する", () => {
    expect(negotiateLocale("ja,en;q=0.9", "en")).toBe("en");
    expect(negotiateLocale("en", "ja")).toBe("ja");
  });

  // Cookie は利用者が書き換えられる値なので、対応していない値は無かったものとして Accept-Language で決める。
  test("Cookie が対応していない値なら、Accept-Language で決める", () => {
    expect(negotiateLocale("en", "fr")).toBe("en");
    expect(negotiateLocale("en", "")).toBe("en");
  });

  test("Cookie が無ければ、Accept-Language で決める", () => {
    expect(negotiateLocale("en", null)).toBe("en");
  });

  test("地域の付いたタグ（en-US・ja-JP）は言語の部分で照合する", () => {
    expect(negotiateLocale("en-US", null)).toBe("en");
    expect(negotiateLocale("ja-JP", null)).toBe("ja");
  });

  test("大文字・前後の空白を含むタグも照合する", () => {
    expect(negotiateLocale(" EN-us ", null)).toBe("en");
  });

  test("q 値の高い順に、最初に対応するロケールを選ぶ（書いた順ではない）", () => {
    expect(negotiateLocale("ja;q=0.5, en;q=0.8", null)).toBe("en");
    expect(negotiateLocale("en;q=0.1,ja", null)).toBe("ja");
  });

  test("q 値が同じなら、書いた順で先のものを選ぶ", () => {
    expect(negotiateLocale("en;q=0.5,ja;q=0.5", null)).toBe("en");
    expect(negotiateLocale("ja,en", null)).toBe("ja");
  });

  // 空白を許さないと "en ; q=0.1" の q が読めず q=1 扱いになり、先に書いた en が選ばれてしまう。
  test("q 値の前後の空白を許す", () => {
    expect(negotiateLocale("en ; q=0.1, ja", null)).toBe("ja");
  });

  test("対応していない言語は飛ばし、次に対応するロケールを選ぶ", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9,en;q=0.8,ja;q=0.7", null)).toBe(
      "en",
    );
  });

  // q=0 は「受け付けない」の意味（RFC 9110 の 12.4.2）。
  test("q=0 の言語は選ばない", () => {
    expect(negotiateLocale("en;q=0,ja;q=0.1", null)).toBe("ja");
    expect(negotiateLocale("en;q=0", null)).toBe(DEFAULT_LOCALE);
  });

  test("q 値が数でなければ、その言語は選ばない", () => {
    expect(negotiateLocale("en;q=abc", null)).toBe(DEFAULT_LOCALE);
  });

  test("q 以外のパラメータは無視する", () => {
    expect(negotiateLocale("en;level=1", null)).toBe("en");
  });

  test.each([
    ["Accept-Language が無い", null],
    ["空", ""],
    ["対応する言語が無い", "fr,de;q=0.9"],
    ["* だけ", "*"],
    ["区切りだけ", " , ;q=1"],
  ])("%s ときは既定の ja", (_label, acceptLanguage) => {
    expect(negotiateLocale(acceptLanguage, null)).toBe(DEFAULT_LOCALE);
  });
});

describe("localeFromHeader（Proxy が載せた x-locale を layout で読む）", () => {
  test("対応するロケールならそのまま返す", () => {
    expect(localeFromHeader("en")).toBe("en");
    expect(localeFromHeader("ja")).toBe("ja");
  });

  // Proxy を通らないリクエスト（matcher の外・テスト）や、クライアントが直接送った不正な値のとき。
  test("無い・対応していない値なら既定の ja", () => {
    expect(localeFromHeader(null)).toBe(DEFAULT_LOCALE);
    expect(localeFromHeader("fr")).toBe(DEFAULT_LOCALE);
  });
});
