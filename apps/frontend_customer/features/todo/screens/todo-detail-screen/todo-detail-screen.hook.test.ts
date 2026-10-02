import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/features/todo/api/api-error";
import { TodoApi } from "@/features/todo/api/todo-api";
import { useTodoDetailScreen } from "@/features/todo/screens/todo-detail-screen/todo-detail-screen.hook";
import { commonMessages } from "@/shared/i18n/common.messages";
import { formatMessage, LocaleProvider } from "@/shared/i18n/i18n";
import { JaLocale, tJa } from "@/test-support/i18n";

// HTTP の詳細は todo-api.test.ts で検証済みなので差し替え、hook が API をいつ何で呼び、結果をどう状態に反映するかを見る。
vi.mock("@/features/todo/api/todo-api");

// globals 無効のため Testing Library の自動 cleanup が働かない。renderHook のコンポーネントもテストごとに unmount する。
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
const bread = { ...milk, id: "todo-2", title: "パンを買う" };

// テストから任意のタイミングで resolve できる Promise。即時 resolve のモックでは「古い応答が後から届く」順序を再現できないため使う。
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise の初期化前に resolve が呼ばれた");
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// todo-1 → todo-2 の遷移を再現するため、todoId を props で変えられる形で描画する。
function renderWithTodoId(todoId: string) {
  return renderHook(
    (props: { todoId: string }) => useTodoDetailScreen(props.todoId),
    {
      initialProps: { todoId },
      wrapper: JaLocale,
    },
  );
}

async function renderLoaded(todoId = "todo-1") {
  const view = renderHook(() => useTodoDetailScreen(todoId), {
    wrapper: JaLocale,
  });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

describe("初回の読み込み", () => {
  // 最初の描画（effect が動く前）の値も見るため、描画のたびに戻り値を記録する。
  // WHY: 最初の描画で isLoading が false だと、取得前の一瞬だけ「読み込み中」ではない画面（Todo の無い画面）が出る。
  test("最初の描画から読み込み中で、編集中の title は空", async () => {
    // given
    const todoResponse = deferred<typeof milk>();
    vi.mocked(TodoApi.get).mockReturnValue(todoResponse.promise);
    const renders: { isLoading: boolean; title: string }[] = [];

    // when
    renderHook(() => {
      const state = useTodoDetailScreen("todo-1");
      renders.push({ isLoading: state.isLoading, title: state.title });
      return state;
    });

    // then
    expect(renders[0]).toEqual({ isLoading: true, title: "" });
    expect(renders.at(-1)).toEqual({ isLoading: true, title: "" });
    await act(async () => todoResponse.resolve(milk));
  });

  test("id の Todo を取得し、todo と編集中の title に入れる", async () => {
    // given
    vi.mocked(TodoApi.get).mockResolvedValue(milk);

    // when
    const { result } = renderHook(() => useTodoDetailScreen("todo-1"), {
      wrapper: JaLocale,
    });

    // then
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(TodoApi.get).toHaveBeenCalledWith("todo-1");
    expect(result.current.todo).toEqual(milk);
    expect(result.current.title).toBe("牛乳を買う");
    expect(result.current.error).toBeNull();
  });

  test("取得に失敗すると（not_found など）、todo は null のまま、ApiError のキーと params を翻訳した文言が error に入る", async () => {
    // given
    vi.mocked(TodoApi.get).mockRejectedValue(
      new ApiError({
        status: 404,
        type: "/problems/not-found",
        key: "todo.notFound",
        params: { id: "missing" },
      }),
    );

    // when
    const { result } = await renderLoaded("missing");

    // then
    expect(result.current.todo).toBeNull();
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.notFound", { id: "missing" }),
    );
  });

  // WHY 翻訳は描画のときに LocaleProvider のロケールで行う（hook はキーと params を持つ失敗を保持する）。
  test("LocaleProvider のロケールが en なら、error は英語の文言になる", async () => {
    // given
    vi.mocked(TodoApi.get).mockRejectedValue(
      new ApiError({
        status: 404,
        type: "/problems/not-found",
        key: "todo.notFound",
        params: { id: "missing" },
      }),
    );

    // when
    const { result } = renderHook(() => useTodoDetailScreen("missing"), {
      wrapper: ({ children }) =>
        createElement(LocaleProvider, { locale: "en", children }),
    });

    // then
    await waitFor(() =>
      expect(result.current.error).toBe(
        formatMessage(commonMessages, "en", "todo.notFound", { id: "missing" }),
      ),
    );
  });

  // fetch そのものの失敗（ネットワークの切断で TypeError）など、API の応答ではない失敗。
  test.each([
    ["ApiError でない Error", new TypeError("Failed to fetch")],
    ["Error でない値", "network down"],
  ])(
    "%s で取得に失敗すると、固定の文言（error.unexpected）が error に入る",
    async (_label, reason) => {
      // given
      vi.mocked(TodoApi.get).mockRejectedValue(reason);

      // when
      const { result } = await renderLoaded();

      // then
      expect(result.current.todo).toBeNull();
      expect(result.current.error).toBe(
        tJa(commonMessages, "error.unexpected"),
      );
    },
  );

  test("todoId が変わると、新しい todoId の Todo を取得し直す", async () => {
    // given
    vi.mocked(TodoApi.get).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

    // when
    rerender({ todoId: "todo-2" });

    // then
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    expect(result.current.title).toBe("パンを買う");
  });

  test("todoId が変わると、新しい Todo の取得を待つ間は前の Todo とエラーを消して読み込み中にする", async () => {
    // given
    const breadResponse = deferred<typeof bread>();
    vi.mocked(TodoApi.get)
      .mockRejectedValueOnce(
        new ApiError({
          status: 404,
          type: "/problems/not-found",
          key: "todo.notFound",
          params: { id: "todo-1" },
        }),
      )
      .mockReturnValueOnce(breadResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() =>
      expect(result.current.error).toBe(
        tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
      ),
    );

    // when
    rerender({ todoId: "todo-2" });

    // then
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    // when
    await act(async () => breadResponse.resolve(bread));

    // then
    expect(result.current.todo).toEqual(bread);
  });

  test("todoId が変わると、新しい Todo が届くまで前の Todo を表示しない", async () => {
    // given
    const breadResponse = deferred<typeof bread>();
    vi.mocked(TodoApi.get)
      .mockResolvedValueOnce(milk)
      .mockReturnValueOnce(breadResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

    // when
    rerender({ todoId: "todo-2" });

    // then
    expect(result.current.todo).toBeNull();
    expect(result.current.isLoading).toBe(true);

    // when
    await act(async () => breadResponse.resolve(bread));

    // then
    expect(result.current.todo).toEqual(bread);
  });

  test("todoId が変わった後に前の todoId の取得が終わっても、新しい Todo の取得が終わるまで読み込み中のまま", async () => {
    // given
    const milkResponse = deferred<typeof milk>();
    const breadResponse = deferred<typeof bread>();
    vi.mocked(TodoApi.get)
      .mockReturnValueOnce(milkResponse.promise)
      .mockReturnValueOnce(breadResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");

    // when
    rerender({ todoId: "todo-2" });
    await act(async () => milkResponse.resolve(milk));

    // then
    expect(result.current.isLoading).toBe(true);
    expect(result.current.todo).toBeNull();

    // when
    await act(async () => breadResponse.resolve(bread));

    // then
    expect(result.current.isLoading).toBe(false);
  });

  test("todoId が変わった後に前の todoId の取得結果が届いても、新しい Todo の表示を上書きしない", async () => {
    // given
    const milkResponse = deferred<typeof milk>();
    vi.mocked(TodoApi.get).mockImplementation((id) =>
      id === "todo-1" ? milkResponse.promise : Promise.resolve(bread),
    );
    const { result, rerender } = renderWithTodoId("todo-1");

    // when
    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    await act(async () => milkResponse.resolve(milk));

    // then
    expect(result.current.todo).toEqual(bread);
    expect(result.current.title).toBe("パンを買う");
  });

  test("todoId が変わった後に前の todoId の取得が失敗しても、新しい Todo の画面にエラーを出さない", async () => {
    // given
    const milkResponse = deferred<void>();
    vi.mocked(TodoApi.get).mockImplementation((id) =>
      id === "todo-1"
        ? milkResponse.promise.then(() => {
            throw new Error("Todo が見つかりません");
          })
        : Promise.resolve(bread),
    );
    const { result, rerender } = renderWithTodoId("todo-1");

    // when
    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    await act(async () => milkResponse.resolve());

    // then
    expect(result.current.todo).toEqual(bread);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});

describe("todoId が変わった後に届いた前の Todo の更新結果", () => {
  test("title の保存の結果で、新しい Todo の表示と編集中の title を上書きしない", async () => {
    // given
    const putResponse = deferred<typeof milk>();
    vi.mocked(TodoApi.get).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(TodoApi.rename).mockReturnValue(putResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

    // when
    act(() => result.current.setTitle("豆乳を買う"));
    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.saveTitle();
    });
    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    await act(async () => {
      putResponse.resolve({ ...milk, title: "豆乳を買う" });
      await saving;
    });

    // then
    expect(result.current.todo).toEqual(bread);
    expect(result.current.title).toBe("パンを買う");
  });

  test("完了の切り替えの結果で、新しい Todo の表示を上書きしない", async () => {
    // given
    const putResponse = deferred<typeof milk>();
    vi.mocked(TodoApi.get).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(TodoApi.changeCompletion).mockReturnValue(putResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

    // when
    let toggling: Promise<void> = Promise.resolve();
    act(() => {
      toggling = result.current.toggleCompleted();
    });
    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    await act(async () => {
      putResponse.resolve({ ...milk, completed: true });
      await toggling;
    });

    // then
    expect(result.current.todo).toEqual(bread);
  });

  test("更新の失敗で、新しい Todo の画面に前の Todo のエラーを出さない", async () => {
    // given
    const putResponse = deferred<typeof milk>();
    vi.mocked(TodoApi.get).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(TodoApi.changeCompletion).mockReturnValue(
      putResponse.promise.then(() => {
        throw new Error("更新に失敗しました");
      }),
    );
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

    // when
    let toggling: Promise<void> = Promise.resolve();
    act(() => {
      toggling = result.current.toggleCompleted();
    });
    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    await act(async () => {
      putResponse.resolve(milk);
      await toggling;
    });

    // then
    expect(result.current.error).toBeNull();
  });
});

describe("todoId が変わった後の更新", () => {
  test("完了の切り替えは、新しい todoId の Todo に送る", async () => {
    // given
    vi.mocked(TodoApi.get).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(TodoApi.changeCompletion).mockResolvedValue({
      ...bread,
      completed: true,
    });
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));
    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));

    // when
    await act(() => result.current.toggleCompleted());

    // then
    expect(TodoApi.changeCompletion).toHaveBeenCalledWith("todo-2", true);
    expect(result.current.todo).toEqual({ ...bread, completed: true });
  });
});

describe("title の保存", () => {
  test("編集した title（前後の空白は除く）で更新し、更新後の Todo を反映する", async () => {
    // given
    const renamed = { ...milk, title: "豆乳を買う" };
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    vi.mocked(TodoApi.rename).mockResolvedValue(renamed);
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setTitle("  豆乳を買う  "));
    await act(() => result.current.saveTitle());

    // then
    expect(TodoApi.rename).toHaveBeenCalledWith("todo-1", "豆乳を買う");
    expect(TodoApi.changeCompletion).not.toHaveBeenCalled();
    expect(result.current.todo).toEqual(renamed);
    expect(result.current.title).toBe("豆乳を買う");
  });

  test("空白だけの title は送らない", async () => {
    // given
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setTitle("   "));
    await act(() => result.current.saveTitle());

    // then
    expect(TodoApi.rename).not.toHaveBeenCalled();
  });

  test("更新に失敗すると error に message が入り、編集中の title は残る", async () => {
    // given
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    vi.mocked(TodoApi.rename).mockRejectedValue(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      }),
    );
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setTitle("豆乳を買う"));
    await act(() => result.current.saveTitle());

    // then
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.title.tooLong", { max: 100 }),
    );
    expect(result.current.title).toBe("豆乳を買う");
    expect(result.current.todo).toEqual(milk);
  });
});

// 400 の項目ごとの誤り（ApiError の errors）。入力の下に出す文言（fieldErrors）と、フォーム全体の文言（error）に分ける
//   （分け方の細部は api-error.test.ts の ApiErrorMessage.toMessages で固定）。
describe("項目ごとのエラー", () => {
  async function saveWithFailure(reason: unknown) {
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    vi.mocked(TodoApi.rename).mockRejectedValue(reason);
    const view = await renderLoaded();
    act(() => view.result.current.setTitle("豆乳を買う"));
    await act(() => view.result.current.saveTitle());
    return view;
  }

  test("エラーが無いときは、fieldErrors は空", async () => {
    // given
    vi.mocked(TodoApi.get).mockResolvedValue(milk);

    // when
    const { result } = await renderLoaded();

    // then
    expect(result.current.fieldErrors).toStrictEqual({});
  });

  // WHY 全体の文言を出さない: 本文の key は errors の最初の 1 件と同じで、両方を出すと同じ文言が 2 回出る。
  test("空タイトルの 400（#/title）は、title の項目の文言になり、フォーム全体の error は null", async () => {
    // given
    const failure = new ApiError({
      status: 400,
      type: "/problems/validation-error",
      key: "todo.title.empty",
      errors: [{ pointer: "#/title", key: "todo.title.empty" }],
    });

    // when
    const { result } = await saveWithFailure(failure);

    // then
    expect(result.current.fieldErrors).toStrictEqual({
      title: tJa(commonMessages, "todo.title.empty"),
    });
    expect(result.current.error).toBeNull();
    expect(result.current.title).toBe("豆乳を買う");
  });

  test("title の型の誤り（#/title）と未知の項目（#）の 2 件は、title の項目の文言とフォーム全体の文言に分ける", async () => {
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
    const { result } = await saveWithFailure(failure);

    // then
    expect(result.current.fieldErrors).toStrictEqual({
      title: tJa(commonMessages, "request.field.notString", { path: "title" }),
    });
    expect(result.current.error).toBe(
      tJa(commonMessages, "request.body.unknownKeys", { keys: "extra" }),
    );
  });

  test("errors の無い 404 は、フォーム全体の文言だけで、fieldErrors は空", async () => {
    // given
    const failure = new ApiError({
      status: 404,
      type: "/problems/not-found",
      key: "todo.notFound",
      params: { id: "todo-1" },
    });

    // when
    const { result } = await saveWithFailure(failure);

    // then
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
    );
    expect(result.current.fieldErrors).toStrictEqual({});
  });

  test("項目のエラーは、次の操作が成功すると消える", async () => {
    // given
    const { result } = await saveWithFailure(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.empty",
        errors: [{ pointer: "#/title", key: "todo.title.empty" }],
      }),
    );
    vi.mocked(TodoApi.rename).mockResolvedValue({
      ...milk,
      title: "豆乳を買う",
    });

    // when
    await act(() => result.current.saveTitle());

    // then
    expect(result.current.fieldErrors).toStrictEqual({});
    expect(result.current.error).toBeNull();
  });

  test("LocaleProvider のロケールが en なら、項目の文言は英語になる", async () => {
    // given
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    vi.mocked(TodoApi.rename).mockRejectedValue(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.empty",
        errors: [{ pointer: "#/title", key: "todo.title.empty" }],
      }),
    );
    const { result } = renderHook(() => useTodoDetailScreen("todo-1"), {
      wrapper: ({ children }) =>
        createElement(LocaleProvider, { locale: "en", children }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // when
    await act(() => result.current.saveTitle());

    // then
    expect(result.current.fieldErrors).toStrictEqual({
      title: formatMessage(commonMessages, "en", "todo.title.empty"),
    });
  });
});

describe("完了の切り替え", () => {
  test("現在の completed を反転して更新し、更新後の Todo を反映する", async () => {
    // given
    const completedMilk = { ...milk, completed: true };
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    vi.mocked(TodoApi.changeCompletion).mockResolvedValue(completedMilk);
    const { result } = await renderLoaded();

    // when
    await act(() => result.current.toggleCompleted());

    // then
    expect(TodoApi.changeCompletion).toHaveBeenCalledWith("todo-1", true);
    expect(TodoApi.rename).not.toHaveBeenCalled();
    expect(result.current.todo).toEqual(completedMilk);
  });

  test("切り替えでは編集中（未保存）の title を上書きしない", async () => {
    // given
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    vi.mocked(TodoApi.changeCompletion).mockResolvedValue({
      ...milk,
      completed: true,
    });
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setTitle("編集中"));
    await act(() => result.current.toggleCompleted());

    // then
    expect(result.current.title).toBe("編集中");
  });

  test("前の操作のエラーは、次の操作が成功すると消える", async () => {
    // given
    vi.mocked(TodoApi.get).mockResolvedValue(milk);
    vi.mocked(TodoApi.changeCompletion)
      .mockRejectedValueOnce(
        new ApiError({
          status: 500,
          type: "/problems/internal-error",
          key: "server.internalError",
        }),
      )
      .mockResolvedValueOnce({ ...milk, completed: true });
    const { result } = await renderLoaded();

    // when
    await act(() => result.current.toggleCompleted());

    // then
    expect(result.current.error).toBe(
      tJa(commonMessages, "server.internalError"),
    );

    // when
    await act(() => result.current.toggleCompleted());

    // then
    expect(result.current.error).toBeNull();
  });

  test("Todo の取得が終わる前に切り替えても、反転元の completed が無いので更新を送らない", async () => {
    // given
    const todoResponse = deferred<typeof milk>();
    vi.mocked(TodoApi.get).mockReturnValue(todoResponse.promise);
    const { result } = renderHook(() => useTodoDetailScreen("todo-1"), {
      wrapper: JaLocale,
    });

    // when
    await act(() => result.current.toggleCompleted());

    // then
    expect(TodoApi.changeCompletion).not.toHaveBeenCalled();
    expect(result.current.todo).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });
});
