import { Paper } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 中身をまとめて置く面（一覧を載せる白い面など）。
// WHY props は中身だけ: 影・角丸・枠（shadow / radius / withBorder）はテーマの Paper が決める。
export function Surface({ children }: { children: ReactNode }) {
  return <Paper>{children}</Paper>;
}
