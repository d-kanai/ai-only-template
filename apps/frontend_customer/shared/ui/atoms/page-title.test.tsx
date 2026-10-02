import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DesignSystem } from "@/test-support/design-system";
import { activeTheme } from "../active-theme";
import { PageTitle } from "./page-title";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子の文字を画面の見出し（h1）として描き、テーマが Title に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(<PageTitle>Todo</PageTitle>, { wrapper: DesignSystem });

  // then
  const heading = screen.getByRole("heading", { level: 1, name: "Todo" });
  expect(heading.classList).toContain(
    activeTheme.theme.components.Title.classNames.root,
  );
});
