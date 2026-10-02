import { List as MantineList } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 行（ListItem）を並べる一覧（ul）。
// WHY props は中身だけ: 印の形・間隔（type / spacing / icon）はテーマの List が決める。
export function List({ children }: { children: ReactNode }) {
  return <MantineList>{children}</MantineList>;
}
