import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DesignSystem } from "@/test-support/design-system";
import { activeTheme } from "../active-theme";
import { Form } from "./form";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("送信すると、ページの遷移（既定の動作）を止めて onSubmit を引数なしで呼ぶ", () => {
  // given
  const onSubmit = vi.fn();
  render(
    <Form onSubmit={onSubmit}>
      <button type="submit">送信</button>
    </Form>,
    { wrapper: DesignSystem },
  );
  const form = screen.getByRole("button", { name: "送信" }).closest("form");

  // when
  // fireEvent は、ハンドラが preventDefault を呼ぶと false を返す（dispatchEvent の戻り値）。
  const notPrevented = fireEvent.submit(form as HTMLFormElement);

  // then
  expect(notPrevented).toBe(false);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith();
});

test("フォームを面として描き、テーマが Paper に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(
    <Form onSubmit={vi.fn()}>
      <span>中身</span>
    </Form>,
    { wrapper: DesignSystem },
  );

  // then
  const form = screen.getByText("中身").parentElement;
  expect(form?.tagName).toBe("FORM");
  expect(form?.classList).toContain(
    activeTheme.theme.components.Paper.classNames.root,
  );
});
