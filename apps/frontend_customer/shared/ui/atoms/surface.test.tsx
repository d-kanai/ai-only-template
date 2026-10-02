import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { Surface } from "./surface";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子を面の中に描き、テーマが Paper に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(
    <Surface>
      <span>中身</span>
    </Surface>,
    { wrapper: DesignSystem },
  );

  // then
  const surface = screen.getByText("中身").parentElement;
  expect(surface?.tagName).toBe("DIV");
  expect(surface?.classList).toContain(
    activeTheme.theme.components.Paper.classNames.root,
  );
});
