import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/features/todo/api/api-error";
import {
  changeTodoCompletion,
  getTodo,
  renameTodo,
} from "@/features/todo/api/todo-api";
import { useTodoDetailScreen } from "@/features/todo/screens/todo-detail-screen/todo-detail-screen.hook";
import { commonMessages } from "@/shared/i18n/common.messages";
import { formatMessage, LocaleProvider } from "@/shared/i18n/i18n";
import { JaLocale, tJa } from "@/shared/i18n/i18n.test-support";

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
    const todoResponse = deferred<typeof milk>();
    vi.mocked(getTodo).mockReturnValue(todoResponse.promise);
    const renders: { isLoading: boolean; title: string }[] = [];

    renderHook(() => {
      const state = useTodoDetailScreen("todo-1");
      renders.push({ isLoading: state.isLoading, title: state.title });
      return state;
    });

    expect(renders[0]).toEqual({ isLoading: true, title: "" });
    expect(renders.at(-1)).toEqual({ isLoading: true, title: "" });
    await act(async () => todoResponse.resolve(milk));
  });

  test("id の Todo を取得し、todo と編集中の title に入れる", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);

    const { result } = renderHook(() => useTodoDetailScreen("todo-1"), {
      wrapper: JaLocale,
    });

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getTodo).toHaveBeenCalledWith("todo-1");
    expect(result.current.todo).toEqual(milk);
    expect(result.current.title).toBe("牛乳を買う");
    expect(result.current.error).toBeNull();
  });

  test("取得に失敗すると（not_found など）、todo は null のまま、ApiError のキーと params を翻訳した文言が error に入る", async () => {
    vi.mocked(getTodo).mockRejectedValue(
      new ApiError({
        status: 404,
        type: "/problems/not-found",
        key: "todo.notFound",
        params: { id: "missing" },
      }),
    );

    const { result } = await renderLoaded("missing");

    expect(result.current.todo).toBeNull();
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.notFound", { id: "missing" }),
    );
  });

  // WHY 翻訳は描画のときに LocaleProvider のロケールで行う（hook はキーと params を持つ失敗を保持する）。
  test("LocaleProvider のロケールが en なら、error は英語の文言になる", async () => {
    vi.mocked(getTodo).mockRejectedValue(
      new ApiError({
        status: 404,
        type: "/problems/not-found",
        key: "todo.notFound",
        params: { id: "missing" },
      }),
    );

    const { result } = renderHook(() => useTodoDetailScreen("missing"), {
      wrapper: ({ children }) =>
        createElement(LocaleProvider, { locale: "en", children }),
    });

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
      vi.mocked(getTodo).mockRejectedValue(reason);

      const { result } = await renderLoaded();

      expect(result.current.todo).toBeNull();
      expect(result.current.error).toBe(
        tJa(commonMessages, "error.unexpected"),
      );
    },
  );

  test("todoId が変わると、新しい todoId の Todo を取得し直す", async () => {
    vi.mocked(getTodo).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

    rerender({ todoId: "todo-2" });

    await waitFor(() => expect(result.current.todo).toEqual(bread));
    expect(result.current.title).toBe("パンを買う");
  });

  test("todoId が変わると、新しい Todo の取得を待つ間は前の Todo とエラーを消して読み込み中にする", async () => {
    const breadResponse = deferred<typeof bread>();
    vi.mocked(getTodo)
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

    rerender({ todoId: "todo-2" });

    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await act(async () => breadResponse.resolve(bread));
    expect(result.current.todo).toEqual(bread);
  });

  test("todoId が変わると、新しい Todo が届くまで前の Todo を表示しない", async () => {
    const breadResponse = deferred<typeof bread>();
    vi.mocked(getTodo)
      .mockResolvedValueOnce(milk)
      .mockReturnValueOnce(breadResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

    rerender({ todoId: "todo-2" });

    expect(result.current.todo).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await act(async () => breadResponse.resolve(bread));
    expect(result.current.todo).toEqual(bread);
  });

  test("todoId が変わった後に前の todoId の取得が終わっても、新しい Todo の取得が終わるまで読み込み中のまま", async () => {
    const milkResponse = deferred<typeof milk>();
    const breadResponse = deferred<typeof bread>();
    vi.mocked(getTodo)
      .mockReturnValueOnce(milkResponse.promise)
      .mockReturnValueOnce(breadResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");

    rerender({ todoId: "todo-2" });
    await act(async () => milkResponse.resolve(milk));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.todo).toBeNull();
    await act(async () => breadResponse.resolve(bread));
    expect(result.current.isLoading).toBe(false);
  });

  test("todoId が変わった後に前の todoId の取得結果が届いても、新しい Todo の表示を上書きしない", async () => {
    const milkResponse = deferred<typeof milk>();
    vi.mocked(getTodo).mockImplementation((id) =>
      id === "todo-1" ? milkResponse.promise : Promise.resolve(bread),
    );
    const { result, rerender } = renderWithTodoId("todo-1");

    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    await act(async () => milkResponse.resolve(milk));

    expect(result.current.todo).toEqual(bread);
    expect(result.current.title).toBe("パンを買う");
  });

  test("todoId が変わった後に前の todoId の取得が失敗しても、新しい Todo の画面にエラーを出さない", async () => {
    const milkResponse = deferred<void>();
    vi.mocked(getTodo).mockImplementation((id) =>
      id === "todo-1"
        ? milkResponse.promise.then(() => {
            throw new Error("Todo が見つかりません");
          })
        : Promise.resolve(bread),
    );
    const { result, rerender } = renderWithTodoId("todo-1");

    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));
    await act(async () => milkResponse.resolve());

    expect(result.current.todo).toEqual(bread);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});

describe("todoId が変わった後に届いた前の Todo の更新結果", () => {
  test("title の保存の結果で、新しい Todo の表示と編集中の title を上書きしない", async () => {
    const putResponse = deferred<typeof milk>();
    vi.mocked(getTodo).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(renameTodo).mockReturnValue(putResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

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

    expect(result.current.todo).toEqual(bread);
    expect(result.current.title).toBe("パンを買う");
  });

  test("完了の切り替えの結果で、新しい Todo の表示を上書きしない", async () => {
    const putResponse = deferred<typeof milk>();
    vi.mocked(getTodo).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(changeTodoCompletion).mockReturnValue(putResponse.promise);
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

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

    expect(result.current.todo).toEqual(bread);
  });

  test("更新の失敗で、新しい Todo の画面に前の Todo のエラーを出さない", async () => {
    const putResponse = deferred<typeof milk>();
    vi.mocked(getTodo).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(changeTodoCompletion).mockReturnValue(
      putResponse.promise.then(() => {
        throw new Error("更新に失敗しました");
      }),
    );
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));

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

    expect(result.current.error).toBeNull();
  });
});

describe("todoId が変わった後の更新", () => {
  test("完了の切り替えは、新しい todoId の Todo に送る", async () => {
    vi.mocked(getTodo).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(changeTodoCompletion).mockResolvedValue({
      ...bread,
      completed: true,
    });
    const { result, rerender } = renderWithTodoId("todo-1");
    await waitFor(() => expect(result.current.todo).toEqual(milk));
    rerender({ todoId: "todo-2" });
    await waitFor(() => expect(result.current.todo).toEqual(bread));

    await act(() => result.current.toggleCompleted());

    expect(changeTodoCompletion).toHaveBeenCalledWith("todo-2", true);
    expect(result.current.todo).toEqual({ ...bread, completed: true });
  });
});

describe("title の保存", () => {
  test("編集した title（前後の空白は除く）で更新し、更新後の Todo を反映する", async () => {
    const renamed = { ...milk, title: "豆乳を買う" };
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(renameTodo).mockResolvedValue(renamed);
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("  豆乳を買う  "));
    await act(() => result.current.saveTitle());

    expect(renameTodo).toHaveBeenCalledWith("todo-1", "豆乳を買う");
    expect(changeTodoCompletion).not.toHaveBeenCalled();
    expect(result.current.todo).toEqual(renamed);
    expect(result.current.title).toBe("豆乳を買う");
  });

  test("空白だけの title は送らない", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("   "));
    await act(() => result.current.saveTitle());

    expect(renameTodo).not.toHaveBeenCalled();
  });

  test("更新に失敗すると error に message が入り、編集中の title は残る", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(renameTodo).mockRejectedValue(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      }),
    );
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("豆乳を買う"));
    await act(() => result.current.saveTitle());

    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.title.tooLong", { max: 100 }),
    );
    expect(result.current.title).toBe("豆乳を買う");
    expect(result.current.todo).toEqual(milk);
  });
});

// 400 の項目ごとの誤り（ApiError の errors）。入力の下に出す文言（fieldErrors）と、フォーム全体の文言（error）に分ける
//   （分け方の細部は api-error.test.ts の toErrorMessages で固定）。
describe("項目ごとのエラー", () => {
  async function saveWithFailure(reason: unknown) {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(renameTodo).mockRejectedValue(reason);
    const view = await renderLoaded();
    act(() => view.result.current.setTitle("豆乳を買う"));
    await act(() => view.result.current.saveTitle());
    return view;
  }

  test("エラーが無いときは、fieldErrors は空", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);

    const { result } = await renderLoaded();

    expect(result.current.fieldErrors).toStrictEqual({});
  });

  // WHY 全体の文言を出さない: 本文の key は errors の最初の 1 件と同じで、両方を出すと同じ文言が 2 回出る。
  test("空タイトルの 400（#/title）は、title の項目の文言になり、フォーム全体の error は null", async () => {
    const { result } = await saveWithFailure(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.empty",
        errors: [{ pointer: "#/title", key: "todo.title.empty" }],
      }),
    );

    expect(result.current.fieldErrors).toStrictEqual({
      title: tJa(commonMessages, "todo.title.empty"),
    });
    expect(result.current.error).toBeNull();
    expect(result.current.title).toBe("豆乳を買う");
  });

  test("title の型の誤り（#/title）と未知の項目（#）の 2 件は、title の項目の文言とフォーム全体の文言に分ける", async () => {
    const { result } = await saveWithFailure(
      new ApiError({
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
      }),
    );

    expect(result.current.fieldErrors).toStrictEqual({
      title: tJa(commonMessages, "request.field.notString", { path: "title" }),
    });
    expect(result.current.error).toBe(
      tJa(commonMessages, "request.body.unknownKeys", { keys: "extra" }),
    );
  });

  test("errors の無い 404 は、フォーム全体の文言だけで、fieldErrors は空", async () => {
    const { result } = await saveWithFailure(
      new ApiError({
        status: 404,
        type: "/problems/not-found",
        key: "todo.notFound",
        params: { id: "todo-1" },
      }),
    );

    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
    );
    expect(result.current.fieldErrors).toStrictEqual({});
  });

  test("項目のエラーは、次の操作が成功すると消える", async () => {
    const { result } = await saveWithFailure(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.empty",
        errors: [{ pointer: "#/title", key: "todo.title.empty" }],
      }),
    );
    vi.mocked(renameTodo).mockResolvedValue({ ...milk, title: "豆乳を買う" });

    await act(() => result.current.saveTitle());

    expect(result.current.fieldErrors).toStrictEqual({});
    expect(result.current.error).toBeNull();
  });

  test("LocaleProvider のロケールが en なら、項目の文言は英語になる", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(renameTodo).mockRejectedValue(
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

    await act(() => result.current.saveTitle());

    expect(result.current.fieldErrors).toStrictEqual({
      title: formatMessage(commonMessages, "en", "todo.title.empty"),
    });
  });
});

describe("完了の切り替え", () => {
  test("現在の completed を反転して更新し、更新後の Todo を反映する", async () => {
    const completedMilk = { ...milk, completed: true };
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(changeTodoCompletion).mockResolvedValue(completedMilk);
    const { result } = await renderLoaded();

    await act(() => result.current.toggleCompleted());

    expect(changeTodoCompletion).toHaveBeenCalledWith("todo-1", true);
    expect(renameTodo).not.toHaveBeenCalled();
    expect(result.current.todo).toEqual(completedMilk);
  });

  test("切り替えでは編集中（未保存）の title を上書きしない", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(changeTodoCompletion).mockResolvedValue({
      ...milk,
      completed: true,
    });
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("編集中"));
    await act(() => result.current.toggleCompleted());

    expect(result.current.title).toBe("編集中");
  });

  test("前の操作のエラーは、次の操作が成功すると消える", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(changeTodoCompletion)
      .mockRejectedValueOnce(
        new ApiError({
          status: 500,
          type: "/problems/internal-error",
          key: "server.internalError",
        }),
      )
      .mockResolvedValueOnce({ ...milk, completed: true });
    const { result } = await renderLoaded();

    await act(() => result.current.toggleCompleted());
    expect(result.current.error).toBe(
      tJa(commonMessages, "server.internalError"),
    );

    await act(() => result.current.toggleCompleted());
    expect(result.current.error).toBeNull();
  });

  test("Todo の取得が終わる前に切り替えても、反転元の completed が無いので更新を送らない", async () => {
    const todoResponse = deferred<typeof milk>();
    vi.mocked(getTodo).mockReturnValue(todoResponse.promise);
    const { result } = renderHook(() => useTodoDetailScreen("todo-1"), {
      wrapper: JaLocale,
    });

    await act(() => result.current.toggleCompleted());

    expect(changeTodoCompletion).not.toHaveBeenCalled();
    expect(result.current.todo).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });
});
