import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
} from "@/features/todo/api/todo-api";
import { useTodoScreen } from "@/features/todo/screens/todo-screen/todo-screen.hook";

// hook の関心は「いつ・何で API を呼び、結果をどの状態に反映するか」なので、HTTP の詳細（todo-api.test.ts で検証済み）は差し替える。
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
const bread = {
  id: "todo-2",
  title: "パンを買う",
  completed: false,
  createdAt: "2026-09-28T00:01:00.000Z",
};

// テストから任意のタイミングで resolve できる Promise。即時 resolve のモックでは「古い応答が後から届く」順序を再現できないため使う。
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise の初期化前に resolve が呼ばれた");
  };
  let reject: (reason: Error) => void = () => {
    throw new Error("Promise の初期化前に reject が呼ばれた");
  };
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Deferred<T> = ReturnType<typeof deferred<T>>;
type ListResponse = { todos: (typeof milk)[] };

async function renderLoaded() {
  const view = renderHook(() => useTodoScreen());
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

describe("初回の読み込み", () => {
  test("読み込み中は isLoading が true で、一覧を取得すると todos に入り isLoading が false になる", async () => {
    vi.mocked(listTodos).mockResolvedValue({ todos: [milk] });

    const { result } = renderHook(() => useTodoScreen());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.newTitle).toBe("");
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.error).toBeNull();
  });

  // StrictMode（Next の App Router は開発時に有効）では、mount 時の effect が「実行 → 片付け → 実行」と 2 回動き、
  // 一覧の GET も 2 回送られる。応答の順序は送った順とは限らないので、後に送った GET の結果だけを正とする。
  test("StrictMode で 2 回送った GET のうち、先に送った方の応答が後から届いても反映しない", async () => {
    const firstResponse = deferred<{ todos: (typeof milk)[] }>();
    vi.mocked(listTodos)
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce({ todos: [milk] });

    const { result } = renderHook(() => useTodoScreen(), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(result.current.todos).toEqual([milk]));
    expect(listTodos).toHaveBeenCalledTimes(2);
    await act(async () => firstResponse.resolve({ todos: [] }));

    expect(result.current.todos).toEqual([milk]);
    expect(result.current.isLoading).toBe(false);
  });

  test("StrictMode で先に送った GET が先に返っても、後に送った GET が返るまで読み込み中のまま", async () => {
    const firstResponse = deferred<{ todos: (typeof milk)[] }>();
    const secondResponse = deferred<{ todos: (typeof milk)[] }>();
    vi.mocked(listTodos)
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const { result } = renderHook(() => useTodoScreen(), {
      wrapper: StrictMode,
    });

    await act(async () => firstResponse.resolve({ todos: [milk] }));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.todos).toEqual([]);

    await act(async () => secondResponse.resolve({ todos: [bread] }));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.todos).toEqual([bread]);
  });

  test("初回の取得が遅れて届いても、追加後に取り直した一覧を上書きしない", async () => {
    const initialResponse = deferred<{ todos: (typeof milk)[] }>();
    vi.mocked(listTodos)
      .mockReturnValueOnce(initialResponse.promise)
      .mockResolvedValueOnce({ todos: [milk] });
    vi.mocked(createTodo).mockResolvedValue(milk);
    const { result } = renderHook(() => useTodoScreen());

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.isLoading).toBe(false);
    await act(async () => initialResponse.resolve({ todos: [] }));

    expect(result.current.todos).toEqual([milk]);
  });

  test("初回の取得が遅れて失敗しても、追加後に取り直した一覧を残し、エラーも出さない", async () => {
    const initialResponse = deferred<void>();
    vi.mocked(listTodos)
      .mockReturnValueOnce(
        initialResponse.promise.then(() => {
          throw new Error("初回の取得に失敗しました");
        }),
      )
      .mockResolvedValueOnce({ todos: [milk] });
    vi.mocked(createTodo).mockResolvedValue(milk);
    const { result } = renderHook(() => useTodoScreen());

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());
    expect(result.current.todos).toEqual([milk]);
    await act(async () => initialResponse.resolve());

    expect(result.current.todos).toEqual([milk]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  test("一覧の取得に失敗すると、エラーの message が error に入る", async () => {
    vi.mocked(listTodos).mockRejectedValue(new Error("サーバエラー"));

    const { result } = await renderLoaded();

    expect(result.current.error).toBe("サーバエラー");
    expect(result.current.todos).toEqual([]);
  });

  test("Error 以外の値で失敗すると、固定の文言が error に入る", async () => {
    vi.mocked(listTodos).mockRejectedValue("network down");

    const { result } = await renderLoaded();

    expect(result.current.error).toBe("予期しないエラーが発生しました");
  });
});

describe("追加", () => {
  test("入力した title で作成し、入力を空にして一覧を再取得する", async () => {
    vi.mocked(listTodos)
      .mockResolvedValueOnce({ todos: [] })
      .mockResolvedValueOnce({ todos: [milk] });
    vi.mocked(createTodo).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    expect(createTodo).toHaveBeenCalledWith({ title: "牛乳を買う" });
    expect(listTodos).toHaveBeenCalledTimes(2);
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.newTitle).toBe("");
  });

  test("前後の空白を除いた title を送る", async () => {
    vi.mocked(listTodos).mockResolvedValue({ todos: [] });
    vi.mocked(createTodo).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    act(() => result.current.setNewTitle("  牛乳を買う  "));
    await act(() => result.current.addTodo());

    expect(createTodo).toHaveBeenCalledWith({ title: "牛乳を買う" });
  });

  test("空白だけの title は送らない", async () => {
    vi.mocked(listTodos).mockResolvedValue({ todos: [] });
    const { result } = await renderLoaded();

    act(() => result.current.setNewTitle("   "));
    await act(() => result.current.addTodo());

    expect(createTodo).not.toHaveBeenCalled();
    expect(listTodos).toHaveBeenCalledTimes(1);
  });

  test("作成は成功しても、その後の一覧の再取得に失敗すると、error に message が入り、入力は残る", async () => {
    vi.mocked(listTodos)
      .mockResolvedValueOnce({ todos: [] })
      .mockRejectedValueOnce(new Error("一覧の取得に失敗しました"));
    vi.mocked(createTodo).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    expect(createTodo).toHaveBeenCalledWith({ title: "牛乳を買う" });
    expect(result.current.error).toBe("一覧の取得に失敗しました");
    expect(result.current.newTitle).toBe("牛乳を買う");
  });

  // 追加の後の再取得（GET）を待つ間に、別の操作（完了の切り替え）の再取得が先に終わった場合。
  // 追加の再取得は古い応答なので一覧には反映しないが、追加そのものは成功しているので入力は空にする。
  test.each<[string, (response: Deferred<ListResponse>) => void]>([
    ["成功", (response) => response.resolve({ todos: [] })],
    [
      "失敗",
      (response) => response.reject(new Error("古い一覧の取得に失敗しました")),
    ],
  ])(
    "追加の後の再取得が、後から始めた再取得より遅れて%sしても、一覧とエラーには反映せず、追加は成功として入力を空にする",
    async (_label, settle) => {
      const staleReload = deferred<ListResponse>();
      vi.mocked(listTodos)
        .mockResolvedValueOnce({ todos: [] })
        .mockReturnValueOnce(staleReload.promise)
        .mockResolvedValueOnce({ todos: [{ ...milk, completed: true }] });
      vi.mocked(createTodo).mockResolvedValue(milk);
      vi.mocked(updateTodo).mockResolvedValue({ ...milk, completed: true });
      const { result } = await renderLoaded();

      act(() => result.current.setNewTitle("牛乳を買う"));
      let adding: Promise<void> = Promise.resolve();
      act(() => {
        adding = result.current.addTodo();
      });
      await waitFor(() => expect(listTodos).toHaveBeenCalledTimes(2));
      await act(() => result.current.toggleTodo("todo-1", true));
      await act(async () => {
        settle(staleReload);
        await adding;
      });

      expect(result.current.todos).toEqual([{ ...milk, completed: true }]);
      expect(result.current.error).toBeNull();
      expect(result.current.newTitle).toBe("");
    },
  );

  test("作成に失敗すると error に message が入り、入力は残る", async () => {
    vi.mocked(listTodos).mockResolvedValue({ todos: [] });
    vi.mocked(createTodo).mockRejectedValue(new Error("title は必須です"));
    const { result } = await renderLoaded();

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    expect(result.current.error).toBe("title は必須です");
    expect(result.current.newTitle).toBe("牛乳を買う");
  });
});

describe("完了の切り替え", () => {
  test("指定した completed で更新し、一覧を再取得する", async () => {
    const completedMilk = { ...milk, completed: true };
    vi.mocked(listTodos)
      .mockResolvedValueOnce({ todos: [milk] })
      .mockResolvedValueOnce({ todos: [completedMilk] });
    vi.mocked(updateTodo).mockResolvedValue(completedMilk);
    const { result } = await renderLoaded();

    await act(() => result.current.toggleTodo("todo-1", true));

    expect(updateTodo).toHaveBeenCalledWith("todo-1", { completed: true });
    expect(listTodos).toHaveBeenCalledTimes(2);
    expect(result.current.todos).toEqual([completedMilk]);
  });
});

describe("削除", () => {
  test("指定した id を削除し、一覧を再取得する", async () => {
    vi.mocked(listTodos)
      .mockResolvedValueOnce({ todos: [milk, bread] })
      .mockResolvedValueOnce({ todos: [bread] });
    vi.mocked(deleteTodo).mockResolvedValue(undefined);
    const { result } = await renderLoaded();

    await act(() => result.current.deleteTodo("todo-1"));

    expect(deleteTodo).toHaveBeenCalledWith("todo-1");
    expect(listTodos).toHaveBeenCalledTimes(2);
    expect(result.current.todos).toEqual([bread]);
  });

  test("前の操作のエラーは、次の操作が成功すると消える", async () => {
    vi.mocked(listTodos).mockResolvedValue({ todos: [milk] });
    vi.mocked(deleteTodo)
      .mockRejectedValueOnce(new Error("削除に失敗しました"))
      .mockResolvedValueOnce(undefined);
    const { result } = await renderLoaded();

    await act(() => result.current.deleteTodo("todo-1"));
    expect(result.current.error).toBe("削除に失敗しました");

    await act(() => result.current.deleteTodo("todo-1"));
    expect(result.current.error).toBeNull();
  });
});
