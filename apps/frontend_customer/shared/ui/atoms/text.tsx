import { Text as MantineText } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 補足の文字（読み込み中など）の段落。
// WHY props は文字だけ: 大きさ・色（size / c / fw など）を画面に選ばせると、テーマを替えても残る。見た目はテーマの Text が決める。
export function Text({ children }: { children: ReactNode }) {
  return <MantineText>{children}</MantineText>;
}
