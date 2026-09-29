// 画面の表示言語（ロケール）の一覧と、リクエストからロケールを決める純粋関数（Issue #116）。
// 流れ: proxy.ts が negotiateLocale でロケールを決めてリクエストヘッダ x-locale に載せ → app/layout.tsx が
//   localeFromHeader で読み → LocaleProvider（i18n.tsx）で画面に配る。URL のパスは変えない（ADR
//   docs/adr/architecture/20260929-i18n-without-library.md）。
// WHY ライブラリ（@formatjs/intl-localematcher など）を使わない: 対応言語は 2 つで、照合は「言語の部分が一致するか」だけで足りる。
//   依存を増やさず、決め方をこのファイルのテストで固定する。

// 対応するロケール。先頭が既定ではない（既定は DEFAULT_LOCALE で明示する）。
// 足すときは i18n.tsx の Messages・defineMessages と、各 *.messages.ts の辞書にも足す（Messages に足せば、辞書を足すまで型エラーになる）。
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

// q 値の文字列を重みにする。qvalue の書き方でなければ NaN（parseAcceptLanguage が候補から外す）。
// qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )（RFC 9110 の 12.4.2）。0〜1、小数点以下 3 桁まで。
//   これを「0 か 1 で始まり、小数点以下は 3 桁までの数字」（正規表現）と「1 以下」（1.001〜1.999 を外す）に分けて判定する。
// WHY 書き方で判定する（Number() に変換してから 0〜1 の範囲だけを見ない）: Number() は "0x1"（16 進）・"1e0"（指数）・
//   " 1"（空白）も数にするので、qvalue ではない値を有効な重みとして扱ってしまう。
// WHY 文法どおりの 1 本の正規表現（0(\.\d{0,3})?|1(\.0{0,3})?）にしない: "0" の後ろの小数部を必須にする変異が、
//   q=0 も書き方の誤りもどちらも候補から外すので結果を変えず、mutation testing で消せない（等価な変異。
//   .claude/rules/testing.md）。分けた形なら、どの変異も有効な値か無効な値のどちらかの結果を変える。
// WHY 書き方の誤りを候補から外す（q=1 扱いにしない）: 重みの分からない言語を最優先にすると、利用者が低くしたつもりの
//   言語が選ばれる。外しても、他に対応する言語が無ければ既定の ja になるだけ。
// WHY 正規表現を関数の中に書く（最上位の定数にしない）: 最上位の式は static な変異になり mutation testing で数えない
//   （stryker.config.mjs の ignoreStatic）。関数の中なら、正規表現の変異（桁数・アンカー）をテストで検出できる。
function parseQuality(value: string): number {
  const quality = Number(value);
  return /^[01](?:\.\d{0,3})?$/.test(value) && quality <= 1
    ? quality
    : Number.NaN;
}

// Accept-Language を「タグと q 値」の一覧にし、q 値の高い順に並べる（同じ q 値は書いた順のまま。Array.prototype.sort は安定）。
// q=0（受け付けない。RFC 9110 の 12.4.2）と、q 値が qvalue の書き方でないもの（NaN）は除く。
// WHY "q=" を大文字・小文字を区別せずに探す: パラメータ名は大文字・小文字を区別しない（RFC 9110 の 5.6.6）。
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
        .find((parameter) => parameter.toLowerCase().startsWith("q="));
      return {
        tag: tag.trim().toLowerCase(),
        quality: q === undefined ? 1 : parseQuality(q.slice("q=".length)),
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
