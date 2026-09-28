import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ai-only-template",
};

// props の型は Next 16 のグローバル型 LayoutProps<"/"> ではなく明示的に書く。
// LayoutProps は next build / next dev が .next/types に生成する型で、ビルド前（clone 直後の tsc やエディタ、Vitest）には存在せず型エラーになるため。
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
