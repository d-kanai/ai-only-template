import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { LocaleProvider } from "@/shared/i18n/i18n";
import { LOCALE_HEADER, Locales } from "@/shared/i18n/locale";
import { DesignSystemProvider } from "@/shared/ui/design-system-provider";

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
// ヘッダが無い（Proxy を通らない）・対応していない値のときは既定の ja（Locales.fromHeader）。
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = Locales.fromHeader((await headers()).get(LOCALE_HEADER));
  return (
    // デザインシステム（Mantine。Issue #292）: mantineHtmlProps（data-mantine-color-scheme と suppressHydrationWarning）と
    // ColorSchemeScript は、描画の前に配色（light）を html に付けてちらつきを防ぐ Mantine の Next の設定
    // （https://mantine.dev/guides/next/）。DesignSystemProvider の forceColorScheme と同じ light にそろえる。
    <html lang={locale} {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript forceColorScheme="light" />
      </head>
      <body>
        <DesignSystemProvider>
          <LocaleProvider locale={locale}>{children}</LocaleProvider>
        </DesignSystemProvider>
      </body>
    </html>
  );
}
