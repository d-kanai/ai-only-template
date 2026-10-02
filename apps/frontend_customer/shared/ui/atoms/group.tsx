import { Group as MantineGroup } from "@mantine/core";
import type { ReactNode } from "react";
import type { SpacingStep } from "../themes/theme-definition";

// atom（Issue #292。WHY は button.tsx の冒頭）: 中身を横に並べる。
type GroupProps = {
  // WHY 間隔を段階名（SpacingStep）だけで受ける: 部品の並べ方（どこを詰め、どこを空けるか）は画面の構造なので画面に書くが、
  //   値（rem）の正はテーマの spacing に残す（rule-tests/design-system.test.ts の design-system-no-direct-style の余白の例外と同じ）。
  //   数値や px を型で書けなくする。渡さなければテーマの Group の defaultProps の段階になる。
  gap?: SpacingStep;
  children: ReactNode;
};

export function Group({ gap, children }: GroupProps) {
  return <MantineGroup gap={gap}>{children}</MantineGroup>;
}
