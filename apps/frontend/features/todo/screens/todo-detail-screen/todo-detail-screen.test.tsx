import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TodoDetailScreen } from "@/features/todo";
import { ApiError } from "@/features/todo/api/api-error";
import { getTodo, updateTodo } from "@/features/todo/api/todo-api";
import { JaLocale, tJa } from "@/shared/i18n/i18n.test-support";
import { LocaleProvider } from "@/shared/i18n/locale-provider";

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

  render(<TodoDetailScreen todoId={milk.id} />, { wrapper: JaLocale });

  expect(screen.getByText(tJa("todo.loading"))).toBeDefined();
  expect(
    await screen.findByRole("heading", { level: 1, name: "牛乳を買う" }),
  ).toBeDefined();
  expect(screen.queryByText(tJa("todo.loading"))).toBeNull();
  expect(getTodo).toHaveBeenCalledWith("todo-1");
});

test("エラーが無いときは alert を表示しない", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);

  render(<TodoDetailScreen todoId={milk.id} />, { wrapper: JaLocale });

  expect(
    await screen.findByRole("heading", { level: 1, name: "牛乳を買う" }),
  ).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

// fireEvent.submit は、ハンドラが preventDefault したときだけ false を返す（dispatchEvent の戻り値）。
test("title のフォームを送信しても、ブラウザの既定の送信（ページの再読み込み）はしない", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);
  vi.mocked(updateTodo).mockResolvedValue(milk);
  render(<TodoDetailScreen todoId={milk.id} />, { wrapper: JaLocale });

  const form = (
    await screen.findByRole("button", { name: tJa("todo.detail.save") })
  ).closest("form");
  if (form === null) throw new Error("保存ボタンが form の中にない");

  expect(fireEvent.submit(form)).toBe(false);
  // 送信で始まった保存（updateTodo）の反映を待ってからテストを終える（終了後の state 更新を残さないため）。
  await waitFor(() =>
    expect(updateTodo).toHaveBeenCalledWith("todo-1", { title: "牛乳を買う" }),
  );
});

test("一覧へ戻るリンクは / を指す", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);

  render(<TodoDetailScreen todoId={milk.id} />, { wrapper: JaLocale });

  expect(
    (
      await screen.findByRole("link", { name: tJa("todo.detail.back") })
    ).getAttribute("href"),
  ).toBe("/");
});

test("取得に失敗すると（not_found など）、エラーのキーを翻訳した文言が alert として表示され、一覧へ戻るリンクは残る", async () => {
  vi.mocked(getTodo).mockRejectedValue(
    new ApiError("todo.notFound", { id: "missing" }),
  );

  render(<TodoDetailScreen todoId="missing" />, { wrapper: JaLocale });

  expect((await screen.findByRole("alert")).textContent).toBe(
    tJa("todo.notFound", { id: "missing" }),
  );
  expect(
    screen.getByRole("link", { name: tJa("todo.detail.back") }),
  ).toBeDefined();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("title を編集して保存ボタンを押すと、その title で更新され見出しに反映される", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);
  vi.mocked(updateTodo).mockResolvedValue({ ...milk, title: "豆乳を買う" });
  render(<TodoDetailScreen todoId={milk.id} />, { wrapper: JaLocale });

  const input = (await screen.findByRole("textbox", {
    name: tJa("todo.detail.titleLabel"),
  })) as HTMLInputElement;
  expect(input.value).toBe("牛乳を買う");
  fireEvent.change(input, { target: { value: "豆乳を買う" } });
  fireEvent.click(
    screen.getByRole("button", { name: tJa("todo.detail.save") }),
  );

  expect(
    await screen.findByRole("heading", { level: 1, name: "豆乳を買う" }),
  ).toBeDefined();
  expect(updateTodo).toHaveBeenCalledWith("todo-1", { title: "豆乳を買う" });
});

test("完了チェックボックスを押すと、完了に更新されチェックが付く", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);
  vi.mocked(updateTodo).mockResolvedValue({ ...milk, completed: true });
  render(<TodoDetailScreen todoId={milk.id} />, { wrapper: JaLocale });

  fireEvent.click(
    await screen.findByRole("checkbox", { name: tJa("todo.detail.completed") }),
  );

  await waitFor(() =>
    expect(
      (
        screen.getByRole("checkbox", {
          name: tJa("todo.detail.completed"),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true),
  );
  expect(updateTodo).toHaveBeenCalledWith("todo-1", { completed: true });
});

// 画面の文言が LocaleProvider のロケールに従うこと（ja と en で違う文言のキーで見る）。
test("LocaleProvider のロケールが en なら、英語の文言で表示する", async () => {
  vi.mocked(getTodo).mockResolvedValue(milk);

  render(
    <LocaleProvider locale="en">
      <TodoDetailScreen todoId={milk.id} />
    </LocaleProvider>,
  );

  expect(screen.getByText("Loading…")).toBeDefined();
  expect(await screen.findByRole("button", { name: "Save" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Back to list" })).toBeDefined();
  expect(screen.getByRole("textbox", { name: "Title" })).toBeDefined();
  expect(screen.getByRole("checkbox", { name: "Completed" })).toBeDefined();
});
