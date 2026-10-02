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
import { TodoApi } from "@/features/todo/api/todo-api";
import { todoItemMessages } from "@/features/todo/components/todo-item.messages";
import { commonMessages } from "@/shared/i18n/common.messages";
import { LocaleProvider } from "@/shared/i18n/i18n";
import { DesignSystem } from "@/test-support/design-system";
import { JaLocale, tJa } from "@/test-support/i18n";
import { todoScreenMessages } from "./todo-screen.messages";

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
  // given
  vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });

  // when
  render(<TodoScreen />, { wrapper: JaLocale });

  // then
  expect(
    screen.getByRole("heading", {
      level: 1,
      name: tJa(todoScreenMessages, "title"),
    }),
  ).toBeDefined();
  // 初回の取得が終わるのを待ってからテストを終える（終了後の state 更新を残さないため）。
  expect(await screen.findByRole("list")).toBeDefined();
});

test("一覧の取得中は読み込み中と表示され、取得後は Todo が表示される", async () => {
  // given
  vi.mocked(TodoApi.list).mockResolvedValue({ todos: [milk] });

  // when
  render(<TodoScreen />, { wrapper: JaLocale });

  // then
  expect(screen.getByText(tJa(todoScreenMessages, "loading"))).toBeDefined();
  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(screen.queryByText(tJa(todoScreenMessages, "loading"))).toBeNull();
});

test("エラーが無いときは alert を表示しない", async () => {
  // given
  vi.mocked(TodoApi.list).mockResolvedValue({ todos: [milk] });

  // when
  render(<TodoScreen />, { wrapper: JaLocale });

  // then
  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

// fireEvent.submit は、ハンドラが preventDefault したときだけ false を返す（dispatchEvent の戻り値）。
test("追加のフォームを送信しても、ブラウザの既定の送信（ページの再読み込み）はしない", async () => {
  // given
  vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });
  render(<TodoScreen />, { wrapper: JaLocale });
  await screen.findByRole("list");
  const form = screen
    .getByRole("button", { name: tJa(todoScreenMessages, "form.submit") })
    .closest("form");
  if (form === null) throw new Error("追加ボタンが form の中にない");

  // when
  const notPrevented = fireEvent.submit(form);

  // then
  expect(notPrevented).toBe(false);
});

test("一覧の取得に失敗すると、エラーのキーを翻訳した文言が alert として表示される", async () => {
  // given
  vi.mocked(TodoApi.list).mockRejectedValue(
    new ApiError({
      status: 500,
      type: "/problems/internal-error",
      key: "server.internalError",
    }),
  );

  // when
  render(<TodoScreen />, { wrapper: JaLocale });

  // then
  expect((await screen.findByRole("alert")).textContent).toBe(
    tJa(commonMessages, "server.internalError"),
  );
});

// 画面の文言が LocaleProvider のロケールに従うこと（ja と en で違う文言のキーで見る）。
test("LocaleProvider のロケールが en なら、英語の文言で表示する", async () => {
  // given
  vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });

  // when
  render(
    <LocaleProvider locale="en">
      <TodoScreen />
    </LocaleProvider>,
    { wrapper: DesignSystem },
  );

  // then
  expect(screen.getByText("Loading…")).toBeDefined();
  expect(await screen.findByRole("list")).toBeDefined();
  expect(screen.getByRole("textbox", { name: "New todo" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Add" })).toBeDefined();
});

test("title を入力して追加ボタンを押すと、その title で作成され一覧に表示される", async () => {
  // given
  vi.mocked(TodoApi.list)
    .mockResolvedValueOnce({ todos: [] })
    .mockResolvedValueOnce({ todos: [milk] });
  vi.mocked(TodoApi.create).mockResolvedValue(milk);
  render(<TodoScreen />, { wrapper: JaLocale });
  await screen.findByRole("list");
  const titleInput = screen.getByRole("textbox", {
    name: tJa(todoScreenMessages, "form.newTitle"),
  });
  const submitButton = screen.getByRole("button", {
    name: tJa(todoScreenMessages, "form.submit"),
  });

  // when
  fireEvent.change(titleInput, {
    target: { value: "牛乳を買う" },
  });
  fireEvent.click(submitButton);

  // then
  expect(await screen.findByRole("link", { name: "牛乳を買う" })).toBeDefined();
  expect(TodoApi.create).toHaveBeenCalledWith({ title: "牛乳を買う" });
  expect(
    (
      screen.getByRole("textbox", {
        name: tJa(todoScreenMessages, "form.newTitle"),
      }) as HTMLInputElement
    ).value,
  ).toBe("");
});

test("完了チェックボックスを押すと、その Todo が完了に更新される", async () => {
  // given
  vi.mocked(TodoApi.list)
    .mockResolvedValueOnce({ todos: [milk] })
    .mockResolvedValueOnce({ todos: [{ ...milk, completed: true }] });
  vi.mocked(TodoApi.changeCompletion).mockResolvedValue({
    ...milk,
    completed: true,
  });
  render(<TodoScreen />, { wrapper: JaLocale });
  const checkbox = await screen.findByRole("checkbox", {
    name: tJa(todoItemMessages, "toggle", { title: "牛乳を買う" }),
  });

  // when
  fireEvent.click(checkbox);

  // then
  expect(
    await screen.findByRole("checkbox", {
      name: tJa(todoItemMessages, "toggle", { title: "牛乳を買う" }),
      checked: true,
    }),
  ).toBeDefined();
  expect(TodoApi.changeCompletion).toHaveBeenCalledWith("todo-1", true);
});

test("削除ボタンを押すと、その Todo が削除され一覧から消える", async () => {
  // given
  vi.mocked(TodoApi.list)
    .mockResolvedValueOnce({ todos: [milk] })
    .mockResolvedValueOnce({ todos: [] });
  vi.mocked(TodoApi.delete).mockResolvedValue(undefined);
  render(<TodoScreen />, { wrapper: JaLocale });
  const deleteButton = await screen.findByRole("button", {
    name: tJa(todoItemMessages, "deleteAria", { title: "牛乳を買う" }),
  });

  // when
  fireEvent.click(deleteButton);

  // then
  // 削除後の再取得が反映されるまで待つ。
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "牛乳を買う" })).toBeNull(),
  );
  expect(TodoApi.delete).toHaveBeenCalledWith("todo-1");
});

// 400 の項目ごとの誤り（ApiError の errors）は、その入力の直下に出し、aria-describedby と aria-invalid で入力と結び付ける。
// WHY role="alert" はフォーム全体の文言だけ: 項目の文言は入力の説明（accessible description）として読まれる。
async function submitTitleWithFailure(reason: unknown) {
  vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });
  vi.mocked(TodoApi.create).mockRejectedValue(reason);
  render(<TodoScreen />, { wrapper: JaLocale });
  await screen.findByRole("list");
  fireEvent.change(
    screen.getByRole("textbox", {
      name: tJa(todoScreenMessages, "form.newTitle"),
    }),
    { target: { value: "牛乳を買う" } },
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: tJa(todoScreenMessages, "form.submit"),
    }),
  );
}

test("エラーが無いときは、title の入力は invalid でなく、説明も無い", async () => {
  // given
  vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });

  // when
  render(<TodoScreen />, { wrapper: JaLocale });
  await screen.findByRole("list");

  // then
  const input = screen.getByRole("textbox", {
    name: tJa(todoScreenMessages, "form.newTitle"),
    description: "",
  });
  // aria-invalid は付けない（Mantine の TextInput は誤りが無いと属性を出さない。Issue #292 で "false" から変わった）。
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(input.getAttribute("aria-describedby")).toBeNull();
  // 項目のエラーの文言の要素も描画しない（フォームの文字はラベルとボタンだけ）。WHY: aria-invalid / aria-describedby だけを
  //   見ると、エラーが無いのに空の要素を描画しても通ってしまう（Issue #202 で、描画の条件を常に偽にする変異が生き残った）。
  expect(input.closest("form")?.textContent).toBe(
    tJa(todoScreenMessages, "form.newTitle") +
      tJa(todoScreenMessages, "form.submit"),
  );
});

test("空タイトルの 400（#/title）は、title の入力の説明として直下に出し、alert は出さない", async () => {
  // given
  const message = tJa(commonMessages, "todo.title.empty");
  const failure = new ApiError({
    status: 400,
    type: "/problems/validation-error",
    key: "todo.title.empty",
    errors: [{ pointer: "#/title", key: "todo.title.empty" }],
  });

  // when
  await submitTitleWithFailure(failure);

  // then
  const input = await screen.findByRole("textbox", {
    name: tJa(todoScreenMessages, "form.newTitle"),
    description: message,
  });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  // 直下: 説明の要素（aria-describedby が指す要素）は、入力より後ろにあり、label の外にある。
  // WHY label の中に置かない: label の中の文字はすべて入力の名前（accessible name）になり、名前にエラーの文言が混ざる。
  //   部品の DOM の組み立て（label が入力を包むか）は Mantine が決めるので、兄弟の位置ではなく前後関係と label の外かを見る。
  const description = document.getElementById(
    input.getAttribute("aria-describedby") ?? "",
  );
  expect(description?.textContent).toBe(message);
  expect(
    input.compareDocumentPosition(description as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(description?.closest("label")).toBeNull();
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("title の型の誤り（#/title）と未知の項目（#）の 2 件は、title の入力の下に 1 件、未知の項目は alert に出す", async () => {
  // given
  const failure = new ApiError({
    status: 400,
    type: "/problems/validation-error",
    key: "request.field.notString",
    params: { path: "title" },
    errors: [
      {
        pointer: "#/title",
        key: "request.field.notString",
        params: { path: "title" },
      },
      {
        pointer: "#",
        key: "request.body.unknownKeys",
        params: { keys: "extra" },
      },
    ],
  });

  // when
  await submitTitleWithFailure(failure);

  // then
  expect(
    await screen.findByRole("textbox", {
      name: tJa(todoScreenMessages, "form.newTitle"),
      description: tJa(commonMessages, "request.field.notString", {
        path: "title",
      }),
    }),
  ).toBeDefined();
  expect(screen.getByRole("alert").textContent).toBe(
    tJa(commonMessages, "request.body.unknownKeys", { keys: "extra" }),
  );
});

test("errors の無い 404 は、alert に全体の文言だけを出し、title の入力は invalid にしない", async () => {
  // given
  const failure = new ApiError({
    status: 404,
    type: "/problems/not-found",
    key: "todo.notFound",
    params: { id: "todo-1" },
  });

  // when
  await submitTitleWithFailure(failure);

  // then
  expect((await screen.findByRole("alert")).textContent).toBe(
    tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
  );
  const input = screen.getByRole("textbox", {
    name: tJa(todoScreenMessages, "form.newTitle"),
    description: "",
  });
  expect(input.getAttribute("aria-invalid")).toBeNull();
});
