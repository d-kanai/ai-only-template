import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TodoScreen } from "@/features/todo";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
} from "@/features/todo/api/todo-api";

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

  render(<TodoScreen />);

  expect(screen.getByRole("heading", { level: 1, name: "Todo" })).toBeDefined();
  // 初回の取得が終わるのを待ってからテストを終える（終了後の state 更新を残さないため）。
  expect(await screen.findByRole("list")).toBeDefined();
});

test("一覧の取得中は読み込み中と表示され、取得後は Todo が表示される", async () => {
  vi.mocked(listTodos).mockResolvedValue({ todos: [milk] });

  render(<TodoScreen />);

  expect(screen.getByText("読み込み中…")).toBeDefined();
  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(screen.queryByText("読み込み中…")).toBeNull();
});

test("一覧の取得に失敗すると、エラーの message が alert として表示される", async () => {
  vi.mocked(listTodos).mockRejectedValue(new Error("サーバエラー"));

  render(<TodoScreen />);

  expect((await screen.findByRole("alert")).textContent).toBe("サーバエラー");
});

test("title を入力して追加ボタンを押すと、その title で作成され一覧に表示される", async () => {
  vi.mocked(listTodos)
    .mockResolvedValueOnce({ todos: [] })
    .mockResolvedValueOnce({ todos: [milk] });
  vi.mocked(createTodo).mockResolvedValue(milk);
  render(<TodoScreen />);
  await screen.findByRole("list");

  fireEvent.change(screen.getByRole("textbox", { name: "新しい Todo" }), {
    target: { value: "牛乳を買う" },
  });
  fireEvent.click(screen.getByRole("button", { name: "追加" }));

  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(createTodo).toHaveBeenCalledWith({ title: "牛乳を買う" });
  expect(
    (screen.getByRole("textbox", { name: "新しい Todo" }) as HTMLInputElement)
      .value,
  ).toBe("");
});

test("完了チェックボックスを押すと、その Todo が完了に更新される", async () => {
  vi.mocked(listTodos)
    .mockResolvedValueOnce({ todos: [milk] })
    .mockResolvedValueOnce({ todos: [{ ...milk, completed: true }] });
  vi.mocked(updateTodo).mockResolvedValue({ ...milk, completed: true });
  render(<TodoScreen />);

  fireEvent.click(
    await screen.findByRole("checkbox", { name: "「牛乳を買う」を完了にする" }),
  );

  expect(
    await screen.findByRole("checkbox", {
      name: "「牛乳を買う」を完了にする",
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
  render(<TodoScreen />);

  fireEvent.click(
    await screen.findByRole("button", { name: "「牛乳を買う」を削除" }),
  );

  // 削除後の再取得が反映されるまで待つ。
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "牛乳を買う" })).toBeNull(),
  );
  expect(deleteTodo).toHaveBeenCalledWith("todo-1");
});
