import { Alert as MantineAlert } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 操作の結果として後から出るエラーの文言。
// Mantine の Alert は role="alert" を持つ: 後から出た文言を、スクリーンリーダーにも即座に読み上げさせる。
// WHY props は文字だけ: 色・variant はテーマの Alert の defaultProps が決める（今はエラーにしか使わないので赤）。
export function Alert({ children }: { children: ReactNode }) {
  return <MantineAlert>{children}</MantineAlert>;
}
