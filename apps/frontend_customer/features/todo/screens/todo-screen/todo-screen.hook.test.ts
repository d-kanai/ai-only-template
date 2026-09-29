import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { Activity, type ActivityProps, createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/features/todo/api/api-error";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
} from "@/features/todo/api/todo-api";
import { useTodoScreen } from "@/features/todo/screens/todo-screen/todo-screen.hook";
import { commonMessages } from "@/shared/i18n/common.messages";
import { formatMessage, LocaleProvider } from "@/shared/i18n/i18n";
import { JaLocale, tJa } from "@/shared/i18n/i18n.test-support";

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
  const view = renderHook(() => useTodoScreen(), { wrapper: JaLocale });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

describe("初回の読み込み", () => {
  test("読み込み中は isLoading が true で、一覧を取得すると todos に入り isLoading が false になる", async () => {
    vi.mocked(listTodos).mockResolvedValue({ todos: [milk] });

    const { result } = renderHook(() => useTodoScreen(), { wrapper: JaLocale });

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

  // Next 16 は cacheComponents を有効にすると、画面遷移で前のページを unmount せずに React の <Activity> で隠す
  // （Next.js 16.3.6 同梱ドキュメント node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md）。
  // 隠すときは effect の片付けが走り、隠れている間に届いた応答の state 更新も反映される（unmount と違って捨てられない）。
  // 片付けで送信中の GET を古い扱いにしないと、隠れている間に届いた古い一覧が、再表示後に一瞬表示されてしまう。
  test("Activity で隠れている間に届いた GET の応答は反映せず、再表示したときに取り直す", async () => {
    const firstResponse = deferred<ListResponse>();
    vi.mocked(listTodos)
      .mockReturnValueOnce(firstResponse.promise)
      // 再表示で送り直す GET は返さずにおき、読み込み中のままであることを見る。
      .mockReturnValueOnce(deferred<ListResponse>().promise);
    let latest: ReturnType<typeof useTodoScreen> | undefined;
    function Probe() {
      latest = useTodoScreen();
      return null;
    }
    // テストファイルは .ts（hook のテストの命名）なので JSX を使わず createElement で組み立てる。
    // children は第 3 引数で渡す（Biome の noChildrenProp）。ActivityProps は children を必須にしているため、
    // props（{ mode }）だけでは型が合わない。children は第 3 引数で渡しているので ActivityProps として扱う。
    const withActivity = (mode: "visible" | "hidden") =>
      createElement(Activity, { mode } as ActivityProps, createElement(Probe));
    const view = render(withActivity("visible"));

    view.rerender(withActivity("hidden"));
    await act(async () => firstResponse.resolve({ todos: [milk] }));
    view.rerender(withActivity("visible"));

    await waitFor(() => expect(listTodos).toHaveBeenCalledTimes(2));
    expect(latest?.todos).toEqual([]);
    expect(latest?.isLoading).toBe(true);
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
    const { result } = renderHook(() => useTodoScreen(), { wrapper: JaLocale });

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
    const { result } = renderHook(() => useTodoScreen(), { wrapper: JaLocale });

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());
    expect(result.current.todos).toEqual([milk]);
    await act(async () => initialResponse.resolve());

    expect(result.current.todos).toEqual([milk]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  test("一覧の取得に失敗すると、ApiError のキーと params を翻訳した文言が error に入る", async () => {
    vi.mocked(listTodos).mockRejectedValue(
      new ApiError({
        status: 503,
        key: "error.unknown",
        params: { status: 503 },
      }),
    );

    const { result } = await renderLoaded();

    expect(result.current.error).toBe(
      tJa(commonMessages, "error.unknown", { status: 503 }),
    );
    expect(result.current.todos).toEqual([]);
  });

  // WHY 翻訳は描画のときに LocaleProvider のロケールで行う（hook はキーと params を持つ失敗を保持する）。
  test("LocaleProvider のロケールが en なら、error は英語の文言になる", async () => {
    vi.mocked(listTodos).mockRejectedValue(
      new ApiError({
        status: 500,
        type: "/problems/internal-error",
        key: "server.internalError",
      }),
    );

    const { result } = renderHook(() => useTodoScreen(), {
      wrapper: ({ children }) =>
        createElement(LocaleProvider, { locale: "en", children }),
    });

    await waitFor(() =>
      expect(result.current.error).toBe(
        formatMessage(commonMessages, "en", "server.internalError"),
      ),
    );
  });

  // fetch そのものの失敗（ネットワークの切断で TypeError）など、API の応答ではない失敗。
  test.each([
    ["ApiError でない Error", new TypeError("Failed to fetch")],
    ["Error でない値", "network down"],
  ])(
    "%s で失敗すると、固定の文言（error.unexpected）が error に入る",
    async (_label, reason) => {
      vi.mocked(listTodos).mockRejectedValue(reason);

      const { result } = await renderLoaded();

      expect(result.current.error).toBe(
        tJa(commonMessages, "error.unexpected"),
      );
    },
  );
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
      .mockRejectedValueOnce(
        new ApiError({
          status: 500,
          type: "/problems/internal-error",
          key: "server.internalError",
        }),
      );
    vi.mocked(createTodo).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    expect(createTodo).toHaveBeenCalledWith({ title: "牛乳を買う" });
    expect(result.current.error).toBe(
      tJa(commonMessages, "server.internalError"),
    );
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
    vi.mocked(createTodo).mockRejectedValue(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      }),
    );
    const { result } = await renderLoaded();

    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.title.tooLong", { max: 100 }),
    );
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
      .mockRejectedValueOnce(
        new ApiError({
          status: 404,
          type: "/problems/not-found",
          key: "todo.notFound",
          params: { id: "todo-1" },
        }),
      )
      .mockResolvedValueOnce(undefined);
    const { result } = await renderLoaded();

    await act(() => result.current.deleteTodo("todo-1"));
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
    );

    await act(() => result.current.deleteTodo("todo-1"));
    expect(result.current.error).toBeNull();
  });
});
