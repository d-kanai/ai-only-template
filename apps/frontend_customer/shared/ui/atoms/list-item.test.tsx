import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DesignSystem } from "@/test-support/design-system";
import { activeTheme } from "../active-theme";
import { List } from "./list";
import { ListItem } from "./list-item";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("一覧の中の 1 行として子を描き、テーマが List の行に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(
    <List>
      <ListItem>牛乳を買う</ListItem>
      <ListItem>卵を買う</ListItem>
    </List>,
    { wrapper: DesignSystem },
  );

  // then
  const items = screen.getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "牛乳を買う",
    "卵を買う",
  ]);
  expect(items[0]?.classList).toContain(
    activeTheme.theme.components.List.classNames.item,
  );
});
