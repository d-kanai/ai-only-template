import { List } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 一覧（List）の 1 行（li）。List の中に置く。
// WHY List と別のファイルにする: 1 部品 1 ファイルにそろえる（画面は List と ListItem を名前で import する）。
//   Mantine の List.Item は Mantine の List の中で描くと、テーマの List の classNames（item など）が付く。
export function ListItem({ children }: { children: ReactNode }) {
  return <List.Item>{children}</List.Item>;
}
