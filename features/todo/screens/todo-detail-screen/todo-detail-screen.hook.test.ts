import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getTodo, updateTodo } from "@/features/todo/api/todo-api";
import { useTodoDetailScreen } from "@/features/todo/screens/todo-detail-screen/todo-detail-screen.hook";

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
    },
  );
}

async function renderLoaded(todoId = "todo-1") {
  const view = renderHook(() => useTodoDetailScreen(todoId));
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

describe("初回の読み込み", () => {
  test("id の Todo を取得し、todo と編集中の title に入れる", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);

    const { result } = renderHook(() => useTodoDetailScreen("todo-1"));

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getTodo).toHaveBeenCalledWith("todo-1");
    expect(result.current.todo).toEqual(milk);
    expect(result.current.title).toBe("牛乳を買う");
    expect(result.current.error).toBeNull();
  });

  test("取得に失敗すると（not_found など）、todo は null のまま error に message が入る", async () => {
    vi.mocked(getTodo).mockRejectedValue(new Error("Todo が見つかりません"));

    const { result } = await renderLoaded("missing");

    expect(result.current.todo).toBeNull();
    expect(result.current.error).toBe("Todo が見つかりません");
  });

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
});

describe("todoId が変わった後に届いた前の Todo の更新結果", () => {
  test("title の保存の結果で、新しい Todo の表示と編集中の title を上書きしない", async () => {
    const putResponse = deferred<typeof milk>();
    vi.mocked(getTodo).mockImplementation(async (id) =>
      id === "todo-1" ? milk : bread,
    );
    vi.mocked(updateTodo).mockReturnValue(putResponse.promise);
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
    vi.mocked(updateTodo).mockReturnValue(putResponse.promise);
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
    vi.mocked(updateTodo).mockReturnValue(
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

describe("title の保存", () => {
  test("編集した title（前後の空白は除く）で更新し、更新後の Todo を反映する", async () => {
    const renamed = { ...milk, title: "豆乳を買う" };
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(updateTodo).mockResolvedValue(renamed);
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("  豆乳を買う  "));
    await act(() => result.current.saveTitle());

    expect(updateTodo).toHaveBeenCalledWith("todo-1", { title: "豆乳を買う" });
    expect(result.current.todo).toEqual(renamed);
    expect(result.current.title).toBe("豆乳を買う");
  });

  test("空白だけの title は送らない", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("   "));
    await act(() => result.current.saveTitle());

    expect(updateTodo).not.toHaveBeenCalled();
  });

  test("更新に失敗すると error に message が入り、編集中の title は残る", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(updateTodo).mockRejectedValue(new Error("title が長すぎます"));
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("豆乳を買う"));
    await act(() => result.current.saveTitle());

    expect(result.current.error).toBe("title が長すぎます");
    expect(result.current.title).toBe("豆乳を買う");
    expect(result.current.todo).toEqual(milk);
  });
});

describe("完了の切り替え", () => {
  test("現在の completed を反転して更新し、更新後の Todo を反映する", async () => {
    const completedMilk = { ...milk, completed: true };
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(updateTodo).mockResolvedValue(completedMilk);
    const { result } = await renderLoaded();

    await act(() => result.current.toggleCompleted());

    expect(updateTodo).toHaveBeenCalledWith("todo-1", { completed: true });
    expect(result.current.todo).toEqual(completedMilk);
  });

  test("切り替えでは編集中（未保存）の title を上書きしない", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(updateTodo).mockResolvedValue({ ...milk, completed: true });
    const { result } = await renderLoaded();

    act(() => result.current.setTitle("編集中"));
    await act(() => result.current.toggleCompleted());

    expect(result.current.title).toBe("編集中");
  });

  test("前の操作のエラーは、次の操作が成功すると消える", async () => {
    vi.mocked(getTodo).mockResolvedValue(milk);
    vi.mocked(updateTodo)
      .mockRejectedValueOnce(new Error("更新に失敗しました"))
      .mockResolvedValueOnce({ ...milk, completed: true });
    const { result } = await renderLoaded();

    await act(() => result.current.toggleCompleted());
    expect(result.current.error).toBe("更新に失敗しました");

    await act(() => result.current.toggleCompleted());
    expect(result.current.error).toBeNull();
  });
});
