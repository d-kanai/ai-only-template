import { Container } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 画面の本文（main）の外枠。画面ごとに 1 つ置く。
// WHY 名前を Layout にする（daiki の依頼 2026-10-02）: 画面の関数は `<Layout>` の下に Section / Form を並べた骨組みだけにする
//   （rule-tests/screen-outline.test.ts）。骨組みを読んだときに「画面の外枠」と分かる名前にする。
// WHY main として描く: 画面の主な内容の範囲を読み上げ・テストで見つけられるようにする（role="main"）。
// WHY props は中身だけ: 幅（size）・余白はテーマの Container が決める。
export function Layout({ children }: { children: ReactNode }) {
  return <Container component="main">{children}</Container>;
}
