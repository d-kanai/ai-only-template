import type { Metadata } from "next";
import { headers } from "next/headers";
import { LOCALE_HEADER, localeFromHeader } from "@/shared/i18n/locale";
import { LocaleProvider } from "@/shared/i18n/locale-provider";

export const metadata: Metadata = {
  title: "ai-only-template",
};

// props の型は Next 16 のグローバル型 LayoutProps<"/"> ではなく明示的に書く。
// LayoutProps は next build / next dev が .next/types に生成する型で、ビルド前（clone 直後の tsc やエディタ、Vitest）には存在せず型エラーになるため。
//
// ロケール（Issue #116）: proxy.ts が Cookie / Accept-Language から決めてリクエストヘッダ x-locale に載せた値を読み、
//   <html lang> と LocaleProvider（画面の t と日付の書式が使う）に渡す。URL のパスは変えない（app/[lang] にしない）。
//   決定と採用しなかった案は ADR docs/adr/architecture/20260929-i18n-without-library.md。
// WHY ここ（root layout）で読む: 全画面で同じ値を 1 か所で決め、<html lang> もサーバの HTML で正しい言語にする。
// WHY headers() を使うと全画面が動的レンダリングになる（ビルド時の prerender をしない）ことを受け入れる: ロケールはリクエストごとに
//   決まるので、パスを分けない限り静的な HTML にできない（Next.js 16.3.6 同梱
//   node_modules/next/dist/docs/01-app/03-api-reference/04-functions/headers.md の「Good to know」）。
// ヘッダが無い（Proxy を通らない）・対応していない値のときは既定の ja（localeFromHeader）。
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = localeFromHeader((await headers()).get(LOCALE_HEADER));
  return (
    <html lang={locale}>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
