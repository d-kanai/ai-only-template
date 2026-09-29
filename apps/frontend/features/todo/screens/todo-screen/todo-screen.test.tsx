import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TodoScreen } from "@/features/todo";
import { ApiError } from "@/features/todo/api/api-error";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
} from "@/features/todo/api/todo-api";
import { JaLocale, tJa } from "@/shared/i18n/i18n.test-support";
import { LocaleProvider } from "@/shared/i18n/locale-provider";

// 画面は「hook の状態を描き、操作を hook に渡す」ことを検証する。API は差し替え、操作の結果として呼ばれたかで見る。
// 再取得などの細かいロジックは todo-screen.hook.test.ts で固定している。
vi.mock("@/features/todo/api/todo-api");

// globals 無効のため Testing Library の自動 cleanup が働かない。テストごとに DOM を片付ける。
afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
});

const milk = {
  id: "todo-1",
  title: "牛乳を買う",
  completed: false,
  createdAt: "2026-09-28T00:00:00.000Z",
};

test("level 1 の見出しに Todo が表示される", async () => {
  vi.mocked(listTodos).mockResolvedValue({ todos: [] });

  render(<TodoScreen />, { wrapper: JaLocale });

  expect(
    screen.getByRole("heading", { level: 1, name: tJa("todo.list.title") }),
  ).toBeDefined();
  // 初回の取得が終わるのを待ってからテストを終える（終了後の state 更新を残さないため）。
  expect(await screen.findByRole("list")).toBeDefined();
});

test("一覧の取得中は読み込み中と表示され、取得後は Todo が表示される", async () => {
  vi.mocked(listTodos).mockResolvedValue({ todos: [milk] });

  render(<TodoScreen />, { wrapper: JaLocale });

  expect(screen.getByText(tJa("todo.loading"))).toBeDefined();
  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(screen.queryByText(tJa("todo.loading"))).toBeNull();
});

test("エラーが無いときは alert を表示しない", async () => {
  vi.mocked(listTodos).mockResolvedValue({ todos: [milk] });

  render(<TodoScreen />, { wrapper: JaLocale });

  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

// fireEvent.submit は、ハンドラが preventDefault したときだけ false を返す（dispatchEvent の戻り値）。
test("追加のフォームを送信しても、ブラウザの既定の送信（ページの再読み込み）はしない", async () => {
  vi.mocked(listTodos).mockResolvedValue({ todos: [] });
  render(<TodoScreen />, { wrapper: JaLocale });
  await screen.findByRole("list");

  const form = screen
    .getByRole("button", { name: tJa("todo.form.submit") })
    .closest("form");
  if (form === null) throw new Error("追加ボタンが form の中にない");

  expect(fireEvent.submit(form)).toBe(false);
});

test("一覧の取得に失敗すると、エラーのキーを翻訳した文言が alert として表示される", async () => {
  vi.mocked(listTodos).mockRejectedValue(new ApiError("server.internalError"));

  render(<TodoScreen />, { wrapper: JaLocale });

  expect((await screen.findByRole("alert")).textContent).toBe(
    tJa("server.internalError"),
  );
});

// 画面の文言が LocaleProvider のロケールに従うこと（ja と en で違う文言のキーで見る）。
test("LocaleProvider のロケールが en なら、英語の文言で表示する", async () => {
  vi.mocked(listTodos).mockResolvedValue({ todos: [] });

  render(
    <LocaleProvider locale="en">
      <TodoScreen />
    </LocaleProvider>,
  );

  expect(screen.getByText("Loading…")).toBeDefined();
  expect(await screen.findByRole("list")).toBeDefined();
  expect(screen.getByRole("textbox", { name: "New todo" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Add" })).toBeDefined();
});

test("title を入力して追加ボタンを押すと、その title で作成され一覧に表示される", async () => {
  vi.mocked(listTodos)
    .mockResolvedValueOnce({ todos: [] })
    .mockResolvedValueOnce({ todos: [milk] });
  vi.mocked(createTodo).mockResolvedValue(milk);
  render(<TodoScreen />, { wrapper: JaLocale });
  await screen.findByRole("list");

  fireEvent.change(
    screen.getByRole("textbox", { name: tJa("todo.form.newTitle") }),
    {
      target: { value: "牛乳を買う" },
    },
  );
  fireEvent.click(
    screen.getByRole("button", { name: tJa("todo.form.submit") }),
  );

  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(createTodo).toHaveBeenCalledWith({ title: "牛乳を買う" });
  expect(
    (
      screen.getByRole("textbox", {
        name: tJa("todo.form.newTitle"),
      }) as HTMLInputElement
    ).value,
  ).toBe("");
});

test("完了チェックボックスを押すと、その Todo が完了に更新される", async () => {
  vi.mocked(listTodos)
    .mockResolvedValueOnce({ todos: [milk] })
    .mockResolvedValueOnce({ todos: [{ ...milk, completed: true }] });
  vi.mocked(updateTodo).mockResolvedValue({ ...milk, completed: true });
  render(<TodoScreen />, { wrapper: JaLocale });

  fireEvent.click(
    await screen.findByRole("checkbox", {
      name: tJa("todo.item.toggle", { title: "牛乳を買う" }),
    }),
  );

  expect(
    await screen.findByRole("checkbox", {
      name: tJa("todo.item.toggle", { title: "牛乳を買う" }),
      checked: true,
    }),
  ).toBeDefined();
  expect(updateTodo).toHaveBeenCalledWith("todo-1", { completed: true });
});

test("削除ボタンを押すと、その Todo が削除され一覧から消える", async () => {
  vi.mocked(listTodos)
    .mockResolvedValueOnce({ todos: [milk] })
    .mockResolvedValueOnce({ todos: [] });
  vi.mocked(deleteTodo).mockResolvedValue(undefined);
  render(<TodoScreen />, { wrapper: JaLocale });

  fireEvent.click(
    await screen.findByRole("button", {
      name: tJa("todo.item.deleteAria", { title: "牛乳を買う" }),
    }),
  );

  // 削除後の再取得が反映されるまで待つ。
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "牛乳を買う" })).toBeNull(),
  );
  expect(deleteTodo).toHaveBeenCalledWith("todo-1");
});
