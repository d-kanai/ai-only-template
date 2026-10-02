import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { Checkbox } from "./checkbox";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("label を名前にしたチェックボックスに checked を反映する", () => {
  // given: 前提なし
  // when
  render(<Checkbox label="完了" checked={true} onChange={vi.fn()} />, {
    wrapper: DesignSystem,
  });

  // then
  expect(
    (screen.getByRole("checkbox", { name: "完了" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

test("見える label の代わりに aria-label を名前にできる", () => {
  // given: 前提なし
  // when
  render(
    <Checkbox
      aria-label="「牛乳を買う」を完了にする"
      checked={false}
      onChange={vi.fn()}
    />,
    { wrapper: DesignSystem },
  );

  // then
  expect(
    (
      screen.getByRole("checkbox", {
        name: "「牛乳を買う」を完了にする",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
});

test.each([
  [false, true],
  [true, false],
])(
  "checked が %s のときに押すと、onChange が切り替え後の値 %s で呼ばれる（画面はイベントを受け取らない）",
  (checked, next) => {
    // given
    const onChange = vi.fn();
    render(<Checkbox label="完了" checked={checked} onChange={onChange} />, {
      wrapper: DesignSystem,
    });

    // when
    fireEvent.click(screen.getByRole("checkbox", { name: "完了" }));

    // then
    expect(onChange).toHaveBeenCalledWith(next);
  },
);

test("テーマが Checkbox に決めた見た目のクラスがチェックボックスに付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(<Checkbox label="完了" checked={false} onChange={vi.fn()} />, {
    wrapper: DesignSystem,
  });

  // then
  expect(screen.getByRole("checkbox").classList).toContain(
    activeTheme.theme.components.Checkbox.classNames.input,
  );
});
