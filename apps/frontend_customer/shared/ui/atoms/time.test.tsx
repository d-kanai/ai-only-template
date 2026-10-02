import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { Time } from "./time";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子の文字を <time> に出し、機械が読む日時を datetime に付ける", () => {
  // given: 前提なし
  // when
  render(<Time dateTime="2026-09-28T00:00:00.000Z">2026/09/28 0:00</Time>, {
    wrapper: DesignSystem,
  });

  // then
  const time = screen.getByText("2026/09/28 0:00");
  expect(time.tagName).toBe("TIME");
  expect(time.getAttribute("datetime")).toBe("2026-09-28T00:00:00.000Z");
});

test("テーマが Text に決めた見た目のクラスが付く（補足の文字と同じ見た目）", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(<Time dateTime="2026-09-28T00:00:00.000Z">x</Time>, {
    wrapper: DesignSystem,
  });

  // then
  expect(screen.getByText("x").classList).toContain(
    activeTheme.theme.components.Text.classNames.root,
  );
});
