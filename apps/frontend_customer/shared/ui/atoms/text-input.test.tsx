import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { activeTheme } from "@/shared/ui/active-theme";
import { DesignSystem } from "@/test-support/design-system";
import { TextInput } from "./text-input";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("label を名前にした入力欄に value を出し、項目のエラーが無ければ不正の印を付けない", () => {
  // given: 前提なし
  // when
  render(<TextInput label="タイトル" value="牛乳" onChange={vi.fn()} />, {
    wrapper: DesignSystem,
  });

  // then
  const input = screen.getByRole("textbox", { name: "タイトル" });
  expect((input as HTMLInputElement).value).toBe("牛乳");
  // Mantine はエラーが無いとき aria-invalid を付けない（属性が無い = 不正でない）。
  expect(input.getAttribute("aria-invalid")).toBeNull();
});

test("入力すると、onChange が入力後の文字列で呼ばれる（画面はイベントを受け取らない）", () => {
  // given
  const onChange = vi.fn();
  render(<TextInput label="タイトル" value="" onChange={onChange} />, {
    wrapper: DesignSystem,
  });

  // when
  fireEvent.change(screen.getByRole("textbox", { name: "タイトル" }), {
    target: { value: "牛乳を買う" },
  });

  // then
  expect(onChange).toHaveBeenCalledWith("牛乳を買う");
});

test("error を渡すと入力の下に出し、aria-invalid と aria-describedby で入力と結び付ける（role=alert は付けない）", () => {
  // given: 前提なし
  // when
  render(
    <TextInput
      label="タイトル"
      value=""
      onChange={vi.fn()}
      error="入力してください"
    />,
    { wrapper: DesignSystem },
  );

  // then
  const input = screen.getByRole("textbox", { name: "タイトル" });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const describedBy = input.getAttribute("aria-describedby") ?? "";
  expect(document.getElementById(describedBy)?.textContent).toBe(
    "入力してください",
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("テーマが TextInput に決めた見た目のクラスが入力欄に付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(<TextInput label="タイトル" value="" onChange={vi.fn()} />, {
    wrapper: DesignSystem,
  });

  // then
  expect(screen.getByRole("textbox").classList).toContain(
    activeTheme.theme.components.TextInput.classNames.input,
  );
});
