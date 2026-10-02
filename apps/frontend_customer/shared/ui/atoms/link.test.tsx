import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { Link } from "./link";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子の文字を名前にした、href へのリンクとして描く", () => {
  // given: 前提なし
  // when
  render(<Link href="/todo/todo-1">牛乳を買う</Link>, {
    wrapper: DesignSystem,
  });

  // then
  expect(
    screen.getByRole("link", { name: "牛乳を買う" }).getAttribute("href"),
  ).toBe("/todo/todo-1");
});

test("テーマが Anchor に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(<Link href="/">戻る</Link>, { wrapper: DesignSystem });

  // then
  expect(screen.getByRole("link").classList).toContain(
    activeTheme.theme.components.Anchor.classNames.root,
  );
});
