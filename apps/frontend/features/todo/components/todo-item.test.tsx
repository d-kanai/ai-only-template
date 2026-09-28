import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TodoItem } from "@/features/todo/components/todo-item";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup（グローバルの afterEach に登録する仕組み）が働かない。
// 前のテストの DOM が残ると getByRole が複数一致で失敗するため、明示的に後片付けする。
afterEach(cleanup);

const todo = {
  id: "todo-1",
  title: "牛乳を買う",
  completed: false,
  createdAt: "2026-09-28T00:00:00.000Z",
};

function renderItem(overrides: Partial<typeof todo> = {}) {
  const onToggle = vi.fn();
  const onDelete = vi.fn();
  render(
    <ul>
      <TodoItem
        todo={{ ...todo, ...overrides }}
        onToggle={onToggle}
        onDelete={onDelete}
      />
    </ul>,
  );
  return { onToggle, onDelete };
}

test("title は詳細画面 /todo/<id> へのリンクとして表示される", () => {
  renderItem();

  expect(
    screen.getByRole("link", { name: "牛乳を買う" }).getAttribute("href"),
  ).toBe("/todo/todo-1");
});

test("完了チェックボックスは Todo の completed を反映する", () => {
  renderItem({ completed: true });

  expect(
    (
      screen.getByRole("checkbox", {
        name: "「牛乳を買う」を完了にする",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test("完了チェックボックスを押すと、id と切り替え後の completed で onToggle が呼ばれる", () => {
  const { onToggle } = renderItem({ completed: false });

  fireEvent.click(
    screen.getByRole("checkbox", { name: "「牛乳を買う」を完了にする" }),
  );

  expect(onToggle).toHaveBeenCalledWith("todo-1", true);
});

test("削除ボタンを押すと、id で onDelete が呼ばれる", () => {
  const { onDelete } = renderItem();

  fireEvent.click(screen.getByRole("button", { name: "「牛乳を買う」を削除" }));

  expect(onDelete).toHaveBeenCalledWith("todo-1");
});
