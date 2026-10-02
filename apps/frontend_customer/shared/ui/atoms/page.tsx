import { Container } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 画面の本文（main）の外枠。画面ごとに 1 つ置く。
// WHY main として描く: 画面の主な内容の範囲を読み上げ・テストで見つけられるようにする（role="main"）。
// WHY props は中身だけ: 幅（size）・余白はテーマの Container が決める。
export function Page({ children }: { children: ReactNode }) {
  return <Container component="main">{children}</Container>;
}
