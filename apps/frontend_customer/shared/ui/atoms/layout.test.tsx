import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { Layout } from "./layout";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子を画面の本文（main）として描き、テーマが Container に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(
    <Layout>
      <span>中身</span>
    </Layout>,
    { wrapper: DesignSystem },
  );

  // then
  const main = screen.getByRole("main");
  expect(main.textContent).toBe("中身");
  expect(main.classList).toContain(
    activeTheme.theme.components.Container.classNames.root,
  );
});
