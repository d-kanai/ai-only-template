import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DesignSystem } from "@/test-support/design-system";
import { activeTheme } from "../active-theme";
import { Stack } from "./stack";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("gap を渡さなければ、テーマが Stack に決めた既定の段階の間隔で並べる", () => {
  // given
  const gap = activeTheme.theme.components.Stack.defaultProps.gap;

  // when
  render(
    <Stack>
      <span>a</span>
      <span>b</span>
    </Stack>,
    { wrapper: DesignSystem },
  );

  // then
  expect(
    screen.getByText("a").parentElement?.style.getPropertyValue("--stack-gap"),
  ).toBe(`var(--mantine-spacing-${gap})`);
});

test.each(["xs", "xl"] as const)(
  "gap に段階名 %s を渡すと、その段階の間隔（値はテーマの spacing）で並べる",
  (gap) => {
    // given: 前提なし（段階名は test.each の引数）
    // when
    render(
      <Stack gap={gap}>
        <span>a</span>
      </Stack>,
      { wrapper: DesignSystem },
    );

    // then
    expect(
      screen
        .getByText("a")
        .parentElement?.style.getPropertyValue("--stack-gap"),
    ).toBe(`var(--mantine-spacing-${gap})`);
  },
);
