import { Stack as MantineStack } from "@mantine/core";
import type { ReactNode } from "react";
import type { SpacingStep } from "@/shared/ui/themes/theme-definition";

// atom（Issue #292。WHY は button.tsx の冒頭）: 中身を縦に並べる。
// WHY 画面がまだ使っていないのに用意する: 余白を段階名で書く仕組み（daiki が同意、2026-10-02）の入口で、画面が並べ方を
//   書き始めたときに Mantine の Stack / Group を直接使わせないため（ほかの atom は「使わない口を先に開けない」）。
type StackProps = {
  // WHY 間隔を段階名（SpacingStep）だけで受ける: 部品の並べ方（どこを詰め、どこを空けるか）は画面の構造なので画面に書くが、
  //   値（rem）の正はテーマの spacing に残す（rule-tests/design-system.test.ts の design-system-no-direct-style の余白の例外と同じ）。
  //   数値や px を型で書けなくする。渡さなければテーマの Stack の defaultProps の段階になる。
  gap?: SpacingStep;
  children: ReactNode;
};

export function Stack({ gap, children }: StackProps) {
  return <MantineStack gap={gap}>{children}</MantineStack>;
}
