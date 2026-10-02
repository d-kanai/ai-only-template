import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { List } from "./list";
import { ListItem } from "./list-item";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子を一覧（ul）として描き、テーマが List に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(
    <List>
      <ListItem>a</ListItem>
    </List>,
    { wrapper: DesignSystem },
  );

  // then
  const list = screen.getByRole("list");
  expect(list.tagName).toBe("UL");
  expect(list.classList).toContain(
    activeTheme.theme.components.List.classNames.root,
  );
});
