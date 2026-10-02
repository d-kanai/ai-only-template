import { Text as MantineText } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 日時を出す <time>。見える文字（ロケールの書式）と、機械が読む日時（datetime 属性）を
// 分けて受け取る。
// WHY Text と別の atom にする: 画面が Mantine の component="time" と dateTime の組み合わせを知らずに済む。見た目はテーマの Text
//   （補足の文字）と同じ。
type TimeProps = {
  // ISO 8601 の日時（API の createdAt をそのまま渡す）。
  dateTime: string;
  children: ReactNode;
};

export function Time({ dateTime, children }: TimeProps) {
  return (
    <MantineText component="time" dateTime={dateTime}>
      {children}
    </MantineText>
  );
}
