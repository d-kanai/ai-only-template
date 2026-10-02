import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core";

// デザインシステム（Mantine。Issue #292）が <html> と <head> に要るもの。app/layout.tsx が使う。
// WHY shared/ui から出す: 画面とルーティング（features/・app/）は Mantine を直接 import しない
//   （rule-tests/design-system.test.ts の design-system-mantine-boundary）。ライブラリを替えるときに直すのを shared/ui/ の中だけにする。
// 中身は Mantine の Next の設定（https://mantine.dev/guides/next/）: 描画の前に配色を html に付けて、ちらつきを防ぐ。
//   配色は DesignSystemProvider の forceColorScheme と同じ light にそろえる（ダークモードはまだ作っていない）。

// <html> に付ける属性（data-mantine-color-scheme と suppressHydrationWarning）。
export const designSystemHtmlProps = mantineHtmlProps;

// <head> に置く、配色を付けるスクリプト。
export function DesignSystemHead() {
  return <ColorSchemeScript forceColorScheme="light" />;
}
