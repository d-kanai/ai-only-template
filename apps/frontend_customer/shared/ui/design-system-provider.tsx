"use client";

import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { activeTheme } from "./active-theme";
import type { ThemeDefinition } from "./themes/theme-definition";

// デザインシステム（Mantine。Issue #292）を画面全体に配る Provider。app/layout.tsx が body の中で包む。
// "use client": テーマ（CSS Modules のクラス名を含むオブジェクト）をサーバからクライアントへ props で渡さず、
//   クライアント側で import する。MantineProvider 自体もクライアントの部品。
// WHY theme を props で受けられる: テストでテーマを差し替えて、見た目がテーマから来ることを確かめるため。本番は既定の activeTheme。
// WHY forceColorScheme="light": ダークモードの見た目はまだ作っていない（テーマの dark の変数は空）。OS の設定で
//   Mantine の既定の暗い色に切り替わると、テーマの見た目と混ざる。
export function DesignSystemProvider({
  children,
  theme = activeTheme,
}: {
  children: ReactNode;
  theme?: ThemeDefinition;
}) {
  return (
    <MantineProvider
      theme={theme.theme}
      cssVariablesResolver={theme.cssVariablesResolver}
      forceColorScheme="light"
    >
      {children}
    </MantineProvider>
  );
}
