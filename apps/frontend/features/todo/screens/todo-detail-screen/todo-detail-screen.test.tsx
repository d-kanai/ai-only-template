import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TodoDetailScreen } from "@/features/todo";
import { getTodo, updateTodo } from "@/features/todo/api/todo-api";

// 画面は「hook の状態を描き、操作を hook に渡す」ことを検証する。API は差し替え、操作の結果として呼ばれたかで見る。
// 状態遷移の細かい仕様は todo-detail-screen.hook.test.ts で固定している。
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

test("取得中は読み込み中と表示され、取得後は level 1 の見出しに title が表示される", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);

  render(<TodoDetailScreen todoId={milk.id} />);

  expect(screen.getByText("読み込み中…")).toBeDefined();
  expect(
    await screen.findByRole("heading", { level: 1, name: "牛乳を買う" }),
  ).toBeDefined();
  expect(screen.queryByText("読み込み中…")).toBeNull();
  expect(getTodo).toHaveBeenCalledWith("todo-1");
});

test("エラーが無いときは alert を表示しない", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);

  render(<TodoDetailScreen todoId={milk.id} />);

  expect(
    await screen.findByRole("heading", { level: 1, name: "牛乳を買う" }),
  ).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

// fireEvent.submit は、ハンドラが preventDefault したときだけ false を返す（dispatchEvent の戻り値）。
test("title のフォームを送信しても、ブラウザの既定の送信（ページの再読み込み）はしない", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);
  vi.mocked(updateTodo).mockResolvedValue(milk);
  render(<TodoDetailScreen todoId={milk.id} />);

  const form = (await screen.findByRole("button", { name: "保存" })).closest(
    "form",
  );
  if (form === null) throw new Error("保存ボタンが form の中にない");

  expect(fireEvent.submit(form)).toBe(false);
  // 送信で始まった保存（updateTodo）の反映を待ってからテストを終える（終了後の state 更新を残さないため）。
  await waitFor(() =>
    expect(updateTodo).toHaveBeenCalledWith("todo-1", { title: "牛乳を買う" }),
  );
});

test("一覧へ戻るリンクは / を指す", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);

  render(<TodoDetailScreen todoId={milk.id} />);

  expect(
    (await screen.findByRole("link", { name: "一覧へ戻る" })).getAttribute(
      "href",
    ),
  ).toBe("/");
});

test("取得に失敗すると（not_found など）、エラーの message が alert として表示され、一覧へ戻るリンクは残る", async () => {
  vi.mocked(getTodo).mockRejectedValue(new Error("Todo が見つかりません"));

  render(<TodoDetailScreen todoId="missing" />);

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Todo が見つかりません",
  );
  expect(screen.getByRole("link", { name: "一覧へ戻る" })).toBeDefined();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("title を編集して保存ボタンを押すと、その title で更新され見出しに反映される", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);
  vi.mocked(updateTodo).mockResolvedValue({ ...milk, title: "豆乳を買う" });
  render(<TodoDetailScreen todoId={milk.id} />);

  const input = (await screen.findByRole("textbox", {
    name: "title",
  })) as HTMLInputElement;
  expect(input.value).toBe("牛乳を買う");
  fireEvent.change(input, { target: { value: "豆乳を買う" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  expect(
    await screen.findByRole("heading", { level: 1, name: "豆乳を買う" }),
  ).toBeDefined();
  expect(updateTodo).toHaveBeenCalledWith("todo-1", { title: "豆乳を買う" });
});

test("完了チェックボックスを押すと、完了に更新されチェックが付く", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);
  vi.mocked(updateTodo).mockResolvedValue({ ...milk, completed: true });
  render(<TodoDetailScreen todoId={milk.id} />);

  fireEvent.click(await screen.findByRole("checkbox", { name: "完了" }));

  await waitFor(() =>
    expect(
      (screen.getByRole("checkbox", { name: "完了" }) as HTMLInputElement)
        .checked,
    ).toBe(true),
  );
  expect(updateTodo).toHaveBeenCalledWith("todo-1", { completed: true });
});
