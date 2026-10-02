import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TodoItem } from "@/features/todo/components/todo-item";
import { LocaleProvider } from "@/shared/i18n/i18n";
import type { Locale } from "@/shared/i18n/locale";
import { JaLocale, tJa } from "@/test-support/i18n";
import { todoItemMessages } from "./todo-item.messages";

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
    { wrapper: JaLocale },
  );
  return { onToggle, onDelete };
}

function renderItemIn(locale: Locale) {
  render(
    <LocaleProvider locale={locale}>
      <ul>
        <TodoItem todo={todo} onToggle={vi.fn()} onDelete={vi.fn()} />
      </ul>
    </LocaleProvider>,
  );
}

test("title は詳細画面 /todo/<id> へのリンクとして表示される", () => {
  // given: 前提なし（todo はモジュールの定数）
  // when
  renderItem();

  // then
  expect(
    screen.getByRole("link", { name: "牛乳を買う" }).getAttribute("href"),
  ).toBe("/todo/todo-1");
});

test("完了チェックボックスは Todo の completed を反映する", () => {
  // given
  const completedTodo = { completed: true };

  // when
  renderItem(completedTodo);

  // then
  expect(
    (
      screen.getByRole("checkbox", {
        name: tJa(todoItemMessages, "toggle", { title: "牛乳を買う" }),
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test("完了チェックボックスを押すと、id と切り替え後の completed で onToggle が呼ばれる", () => {
  // given
  const { onToggle } = renderItem({ completed: false });
  const checkbox = screen.getByRole("checkbox", {
    name: tJa(todoItemMessages, "toggle", { title: "牛乳を買う" }),
  });

  // when
  fireEvent.click(checkbox);

  // then
  expect(onToggle).toHaveBeenCalledWith("todo-1", true);
});

test("削除ボタンを押すと、id で onDelete が呼ばれる", () => {
  // given
  const { onDelete } = renderItem();
  const deleteButton = screen.getByRole("button", {
    name: tJa(todoItemMessages, "deleteAria", { title: "牛乳を買う" }),
  });

  // when
  fireEvent.click(deleteButton);

  // then
  expect(onDelete).toHaveBeenCalledWith("todo-1");
});

// aria-label は title を含む（行の数だけ並ぶ削除ボタンを区別する）が、見えるのは「削除」だけ。
test("削除ボタンには、辞書の削除の文言が見える文字として出る", () => {
  // given: 前提なし（todo はモジュールの定数）
  // when
  renderItem();

  // then
  expect(
    screen.getByRole("button", {
      name: tJa(todoItemMessages, "deleteAria", { title: "牛乳を買う" }),
    }).textContent,
  ).toBe(tJa(todoItemMessages, "delete"));
});

// テストの実行環境のタイムゾーンは UTC（vitest.config.mts の test.env.TZ）。画面はブラウザのタイムゾーンで出す。
test("作成日時を、ロケールの書式とブラウザのタイムゾーンで <time> に出す", () => {
  // given: 前提なし（todo はモジュールの定数）
  // when
  renderItem();

  // then
  const time = screen.getByText("2026/09/28 0:00");
  expect(time.tagName).toBe("TIME");
  expect(time.getAttribute("datetime")).toBe("2026-09-28T00:00:00.000Z");
});

test("LocaleProvider のロケールが en なら、英語の文言と書式で表示する", () => {
  // given: 前提なし（ロケールは引数で渡す）
  // when
  renderItemIn("en");

  // then
  expect(
    screen.getByRole("checkbox", { name: "Mark “牛乳を買う” as completed" }),
  ).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Delete “牛乳を買う”" }).textContent,
  ).toBe("Delete");
  expect(screen.getByText("Sep 28, 2026, 12:00 AM")).toBeDefined();
});
