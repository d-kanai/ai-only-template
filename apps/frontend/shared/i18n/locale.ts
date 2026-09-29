// 画面の表示言語（ロケール）の一覧と、リクエストからロケールを決める純粋関数（Issue #116）。
// 流れ: proxy.ts が negotiateLocale でロケールを決めてリクエストヘッダ x-locale に載せ → app/layout.tsx が
//   localeFromHeader で読み → LocaleProvider（locale-provider.tsx）で画面に配る。URL のパスは変えない（ADR
//   docs/adr/architecture/20260929-i18n-without-library.md）。
// WHY ライブラリ（@formatjs/intl-localematcher など）を使わない: 対応言語は 2 つで、照合は「言語の部分が一致するか」だけで足りる。
//   依存を増やさず、決め方をこのファイルのテストで固定する。

// 対応するロケール。先頭が既定ではない（既定は DEFAULT_LOCALE で明示する）。
// 足すときは messages/<locale>.ts の辞書と、messages.ts の辞書の一覧にも足す（足さないと型エラーになる）。
export const SUPPORTED_LOCALES = ["ja", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

// Cookie も Accept-Language も対応するロケールを示さないとき、Proxy を通らないとき（テスト・matcher の外）の言語。
// WHY ja: 既存の画面の言語で、利用者の中心が日本語のため（Issue #116 のユーザー判断）。
export const DEFAULT_LOCALE: Locale = "ja";

// ロケールを載せるリクエストヘッダ（proxy.ts が書き、app/layout.tsx が読む）。
// WHY x- で始まる独自ヘッダ: Next の Proxy から後段（Server Components）へ値を渡す公式の方法が、
//   NextResponse.next({ request: { headers } }) でリクエストヘッダを足すこと（Next.js 16.3.6 同梱
//   node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md の「Setting Headers」）。
export const LOCALE_HEADER = "x-locale";

// 利用者が選んだロケールを覚える Cookie の名前。Accept-Language より優先する（今は画面に切り替えが無く、書くのは利用者・将来の切り替え）。
// WHY NEXT_LOCALE: Next の旧 Pages Router の i18n が使っていた名前で、同じ意味の Cookie として知られている。
export const LOCALE_COOKIE = "NEXT_LOCALE";

// WHY null も受け取る: Cookie やヘッダが無い（null）ときも「対応するロケールではない」として同じ判定で扱う。
//   呼び出し側で null を別に検査すると、その検査を消す変異が結果を変えない（等価な変異。.claude/rules/testing.md）。
export function isLocale(value: string | null): value is Locale {
  return (SUPPORTED_LOCALES as readonly (string | null)[]).includes(value);
}

type LanguageRange = { tag: string; quality: number };

// Accept-Language を「タグと q 値」の一覧にし、q 値の高い順に並べる（同じ q 値は書いた順のまま。Array.prototype.sort は安定）。
// q=0（受け付けない。RFC 9110 の 12.4.2）と、q 値が数でないもの（NaN）は除く。
// WHY 空のタグ（", ," など）を除く検査を書かない: 空のタグはどのロケールとも一致せず、結果を変えない。結果を変えない検査は
//   mutation testing で消しても落ちない（等価な変異。.claude/rules/testing.md）。
function parseAcceptLanguage(header: string | null): LanguageRange[] {
  if (header === null) {
    return [];
  }
  return header
    .split(",")
    .map((part): LanguageRange => {
      const [tag, ...parameters] = part.split(";");
      const q = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      return {
        tag: tag.trim().toLowerCase(),
        quality: q === undefined ? 1 : Number(q.slice("q=".length)),
      };
    })
    .filter((range) => range.quality > 0)
    .sort((a, b) => b.quality - a.quality);
}

// Cookie（NEXT_LOCALE の値）→ Accept-Language（q 値の高い順）→ 既定、の順でロケールを決める。
// Accept-Language のタグは言語の部分（"en-US" の "en"）で照合する。"*" や対応しない言語は飛ばす。
export function negotiateLocale(
  acceptLanguage: string | null,
  cookieLocale: string | null,
): Locale {
  if (isLocale(cookieLocale)) {
    return cookieLocale;
  }
  for (const range of parseAcceptLanguage(acceptLanguage)) {
    const language = range.tag.split("-")[0];
    if (isLocale(language)) {
      return language;
    }
  }
  return DEFAULT_LOCALE;
}

// layout が x-locale ヘッダの値からロケールを決める。
// WHY 値を検証する: Proxy を通らないリクエスト（テスト・matcher の外）では無く、クライアントが同名のヘッダを送ってきた値は
//   Proxy が上書きするが、ここでも対応するロケールかを確かめ、<html lang> や辞書の選択に任意の文字列が入らないようにする。
export function localeFromHeader(value: string | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
