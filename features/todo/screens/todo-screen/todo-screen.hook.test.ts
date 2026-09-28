import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.error).toBeNull();
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

  test("一覧の取得に失敗すると、エラーの message が error に入る", async () => {
    vi.mocked(listTodos).mockRejectedValue(new Error("サーバエラー"));

    const { result } = await renderLoaded();

    expect(result.current.error).toBe("サーバエラー");
    expect(result.current.todos).toEqual([]);
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
