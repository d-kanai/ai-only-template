import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { Text } from "./text";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子の文字を段落として描き、テーマが Text に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(<Text>読み込み中</Text>, { wrapper: DesignSystem });

  // then
  const text = screen.getByText("読み込み中");
  expect(text.tagName).toBe("P");
  expect(text.classList).toContain(
    activeTheme.theme.components.Text.classNames.root,
  );
});
