import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { Activity, type ActivityProps, createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useFeatureFlag } from "@/features/feature-flag";
import { ApiError } from "@/features/todo/api/api-error";
import { TodoApi } from "@/features/todo/api/todo-api";
import { useTodoScreen } from "@/features/todo/screens/todo-screen/todo-screen.hook";
import { commonMessages } from "@/shared/i18n/common.messages";
import { formatMessage, LocaleProvider } from "@/shared/i18n/i18n";
import { JaLocale, tJa } from "@/test-support/i18n";

// hook の関心は「いつ・何で API を呼び、結果をどの状態に反映するか」なので、HTTP の詳細（todo-api.test.ts で検証済み）は差し替える。
vi.mock("@/features/todo/api/todo-api");
// フィーチャーフラグ（Issue #156）は feature-flag feature の公開 API（index）で差し替え、値をテストで決める。
// WHY OpenFeature の provider を登録しない: hook の関心は「フラグの値をどう返すか」で、フラグの読み方（provider・準備・OFREP）は
//   features/feature-flag/ のテストで固定している。境界の index で切ると、todo のテストが OpenFeature の状態に依存しない。
vi.mock("@/features/feature-flag");

// globals 無効のため Testing Library の自動 cleanup が働かない。renderHook のコンポーネントもテストごとに unmount する。
afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
  // 本番の一覧（backend の FEATURE_FLAGS）と同じく、詳細画面のフラグは on を前提にする。off は「詳細画面のフラグ」の describe で見る。
  vi.mocked(useFeatureFlag).mockReturnValue(true);
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
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [milk] });

    // when
    const { result } = renderHook(() => useTodoScreen(), { wrapper: JaLocale });

    // then
    expect(result.current.isLoading).toBe(true);
    expect(result.current.newTitle).toBe("");
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.error).toBeNull();
  });

  // StrictMode（Next の App Router は開発時に有効）では、mount 時の effect が「実行 → 片付け → 実行」と 2 回動き、
  // 一覧の GET も 2 回送られる。応答の順序は送った順とは限らないので、後に送った GET の結果だけを正とする。
  test("StrictMode で 2 回送った GET のうち、先に送った方の応答が後から届いても反映しない", async () => {
    // given
    const firstResponse = deferred<{ todos: (typeof milk)[] }>();
    vi.mocked(TodoApi.list)
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce({ todos: [milk] });
    const { result } = renderHook(() => useTodoScreen(), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.todos).toEqual([milk]));

    // when
    await act(async () => firstResponse.resolve({ todos: [] }));

    // then
    expect(TodoApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.isLoading).toBe(false);
  });

  // Next 16 は cacheComponents を有効にすると、画面遷移で前のページを unmount せずに React の <Activity> で隠す
  // （Next.js 16.3.6 同梱ドキュメント node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md）。
  // 隠すときは effect の片付けが走り、隠れている間に届いた応答の state 更新も反映される（unmount と違って捨てられない）。
  // 片付けで送信中の GET を古い扱いにしないと、隠れている間に届いた古い一覧が、再表示後に一瞬表示されてしまう。
  test("Activity で隠れている間に届いた GET の応答は反映せず、再表示したときに取り直す", async () => {
    // given
    const firstResponse = deferred<ListResponse>();
    vi.mocked(TodoApi.list)
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

    // when
    view.rerender(withActivity("hidden"));
    await act(async () => firstResponse.resolve({ todos: [milk] }));
    view.rerender(withActivity("visible"));

    // then
    await waitFor(() => expect(TodoApi.list).toHaveBeenCalledTimes(2));
    expect(latest?.todos).toEqual([]);
    expect(latest?.isLoading).toBe(true);
  });

  test("StrictMode で先に送った GET が先に返っても、後に送った GET が返るまで読み込み中のまま", async () => {
    // given
    const firstResponse = deferred<{ todos: (typeof milk)[] }>();
    const secondResponse = deferred<{ todos: (typeof milk)[] }>();
    vi.mocked(TodoApi.list)
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const { result } = renderHook(() => useTodoScreen(), {
      wrapper: StrictMode,
    });

    // when
    await act(async () => firstResponse.resolve({ todos: [milk] }));

    // then
    expect(result.current.isLoading).toBe(true);
    expect(result.current.todos).toEqual([]);

    // when
    await act(async () => secondResponse.resolve({ todos: [bread] }));

    // then
    expect(result.current.isLoading).toBe(false);
    expect(result.current.todos).toEqual([bread]);
  });

  test("初回の取得が遅れて届いても、追加後に取り直した一覧を上書きしない", async () => {
    // given
    const initialResponse = deferred<{ todos: (typeof milk)[] }>();
    vi.mocked(TodoApi.list)
      .mockReturnValueOnce(initialResponse.promise)
      .mockResolvedValueOnce({ todos: [milk] });
    vi.mocked(TodoApi.create).mockResolvedValue(milk);
    const { result } = renderHook(() => useTodoScreen(), { wrapper: JaLocale });

    // when
    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    // then
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.isLoading).toBe(false);

    // when
    await act(async () => initialResponse.resolve({ todos: [] }));

    // then
    expect(result.current.todos).toEqual([milk]);
  });

  test("初回の取得が遅れて失敗しても、追加後に取り直した一覧を残し、エラーも出さない", async () => {
    // given
    const initialResponse = deferred<void>();
    vi.mocked(TodoApi.list)
      .mockReturnValueOnce(
        initialResponse.promise.then(() => {
          throw new Error("初回の取得に失敗しました");
        }),
      )
      .mockResolvedValueOnce({ todos: [milk] });
    vi.mocked(TodoApi.create).mockResolvedValue(milk);
    const { result } = renderHook(() => useTodoScreen(), { wrapper: JaLocale });

    // when
    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    // then
    expect(result.current.todos).toEqual([milk]);

    // when
    await act(async () => initialResponse.resolve());

    // then
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  test("一覧の取得に失敗すると、ApiError のキーと params を翻訳した文言が error に入る", async () => {
    // given
    vi.mocked(TodoApi.list).mockRejectedValue(
      new ApiError({
        status: 503,
        key: "error.unknown",
        params: { status: 503 },
      }),
    );

    // when
    const { result } = await renderLoaded();

    // then
    expect(result.current.error).toBe(
      tJa(commonMessages, "error.unknown", { status: 503 }),
    );
    expect(result.current.todos).toEqual([]);
  });

  // WHY 翻訳は描画のときに LocaleProvider のロケールで行う（hook はキーと params を持つ失敗を保持する）。
  test("LocaleProvider のロケールが en なら、error は英語の文言になる", async () => {
    // given
    vi.mocked(TodoApi.list).mockRejectedValue(
      new ApiError({
        status: 500,
        type: "/problems/internal-error",
        key: "server.internalError",
      }),
    );

    // when
    const { result } = renderHook(() => useTodoScreen(), {
      wrapper: ({ children }) =>
        createElement(LocaleProvider, { locale: "en", children }),
    });

    // then
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
      // given
      vi.mocked(TodoApi.list).mockRejectedValue(reason);

      // when
      const { result } = await renderLoaded();

      // then
      expect(result.current.error).toBe(
        tJa(commonMessages, "error.unexpected"),
      );
    },
  );
});

describe("追加", () => {
  test("入力した title で作成し、入力を空にして一覧を再取得する", async () => {
    // given
    vi.mocked(TodoApi.list)
      .mockResolvedValueOnce({ todos: [] })
      .mockResolvedValueOnce({ todos: [milk] });
    vi.mocked(TodoApi.create).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    // then
    expect(TodoApi.create).toHaveBeenCalledWith({ title: "牛乳を買う" });
    expect(TodoApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.todos).toEqual([milk]);
    expect(result.current.newTitle).toBe("");
  });

  test("前後の空白を除いた title を送る", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });
    vi.mocked(TodoApi.create).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setNewTitle("  牛乳を買う  "));
    await act(() => result.current.addTodo());

    // then
    expect(TodoApi.create).toHaveBeenCalledWith({ title: "牛乳を買う" });
  });

  test("空白だけの title は送らない", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setNewTitle("   "));
    await act(() => result.current.addTodo());

    // then
    expect(TodoApi.create).not.toHaveBeenCalled();
    expect(TodoApi.list).toHaveBeenCalledTimes(1);
  });

  test("作成は成功しても、その後の一覧の再取得に失敗すると、error に message が入り、入力は残る", async () => {
    // given
    vi.mocked(TodoApi.list)
      .mockResolvedValueOnce({ todos: [] })
      .mockRejectedValueOnce(
        new ApiError({
          status: 500,
          type: "/problems/internal-error",
          key: "server.internalError",
        }),
      );
    vi.mocked(TodoApi.create).mockResolvedValue(milk);
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    // then
    expect(TodoApi.create).toHaveBeenCalledWith({ title: "牛乳を買う" });
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
      // given
      const staleReload = deferred<ListResponse>();
      vi.mocked(TodoApi.list)
        .mockResolvedValueOnce({ todos: [] })
        .mockReturnValueOnce(staleReload.promise)
        .mockResolvedValueOnce({ todos: [{ ...milk, completed: true }] });
      vi.mocked(TodoApi.create).mockResolvedValue(milk);
      vi.mocked(TodoApi.changeCompletion).mockResolvedValue({
        ...milk,
        completed: true,
      });
      const { result } = await renderLoaded();

      // when
      act(() => result.current.setNewTitle("牛乳を買う"));
      let adding: Promise<void> = Promise.resolve();
      act(() => {
        adding = result.current.addTodo();
      });
      await waitFor(() => expect(TodoApi.list).toHaveBeenCalledTimes(2));
      await act(() => result.current.toggleTodo("todo-1", true));
      await act(async () => {
        settle(staleReload);
        await adding;
      });

      // then
      expect(result.current.todos).toEqual([{ ...milk, completed: true }]);
      expect(result.current.error).toBeNull();
      expect(result.current.newTitle).toBe("");
    },
  );

  test("作成に失敗すると error に message が入り、入力は残る", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });
    vi.mocked(TodoApi.create).mockRejectedValue(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      }),
    );
    const { result } = await renderLoaded();

    // when
    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    // then
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.title.tooLong", { max: 100 }),
    );
    expect(result.current.newTitle).toBe("牛乳を買う");
  });
});

// 400 の項目ごとの誤り（ApiError の errors）。入力の下に出す文言（fieldErrors）と、フォーム全体の文言（error）に分ける
//   （分け方の細部は api-error.test.ts の ApiErrorMessage.toMessages で固定）。
describe("項目ごとのエラー", () => {
  async function addWithFailure(reason: unknown) {
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });
    vi.mocked(TodoApi.create).mockRejectedValue(reason);
    const view = await renderLoaded();
    act(() => view.result.current.setNewTitle("牛乳を買う"));
    await act(() => view.result.current.addTodo());
    return view;
  }

  test("エラーが無いときは、fieldErrors は空", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });

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
    const { result } = await addWithFailure(failure);

    // then
    expect(result.current.fieldErrors).toStrictEqual({
      title: tJa(commonMessages, "todo.title.empty"),
    });
    expect(result.current.error).toBeNull();
    expect(result.current.newTitle).toBe("牛乳を買う");
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
    const { result } = await addWithFailure(failure);

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
    const { result } = await addWithFailure(failure);

    // then
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
    );
    expect(result.current.fieldErrors).toStrictEqual({});
  });

  test("項目のエラーは、次の操作が成功すると消える", async () => {
    // given
    const { result } = await addWithFailure(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.empty",
        errors: [{ pointer: "#/title", key: "todo.title.empty" }],
      }),
    );
    vi.mocked(TodoApi.create).mockResolvedValue(milk);

    // when
    await act(() => result.current.addTodo());

    // then
    expect(result.current.fieldErrors).toStrictEqual({});
    expect(result.current.error).toBeNull();
  });

  test("LocaleProvider のロケールが en なら、項目の文言は英語になる", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [] });
    vi.mocked(TodoApi.create).mockRejectedValue(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.empty",
        errors: [{ pointer: "#/title", key: "todo.title.empty" }],
      }),
    );
    const { result } = renderHook(() => useTodoScreen(), {
      wrapper: ({ children }) =>
        createElement(LocaleProvider, { locale: "en", children }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // when
    act(() => result.current.setNewTitle("牛乳を買う"));
    await act(() => result.current.addTodo());

    // then
    expect(result.current.fieldErrors).toStrictEqual({
      title: formatMessage(commonMessages, "en", "todo.title.empty"),
    });
  });
});

describe("完了の切り替え", () => {
  test("指定した completed で更新し、一覧を再取得する", async () => {
    // given
    const completedMilk = { ...milk, completed: true };
    vi.mocked(TodoApi.list)
      .mockResolvedValueOnce({ todos: [milk] })
      .mockResolvedValueOnce({ todos: [completedMilk] });
    vi.mocked(TodoApi.changeCompletion).mockResolvedValue(completedMilk);
    const { result } = await renderLoaded();

    // when
    await act(() => result.current.toggleTodo("todo-1", true));

    // then
    expect(TodoApi.changeCompletion).toHaveBeenCalledWith("todo-1", true);
    expect(TodoApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.todos).toEqual([completedMilk]);
  });
});

describe("削除", () => {
  test("指定した id を削除し、一覧を再取得する", async () => {
    // given
    vi.mocked(TodoApi.list)
      .mockResolvedValueOnce({ todos: [milk, bread] })
      .mockResolvedValueOnce({ todos: [bread] });
    vi.mocked(TodoApi.delete).mockResolvedValue(undefined);
    const { result } = await renderLoaded();

    // when
    await act(() => result.current.deleteTodo("todo-1"));

    // then
    expect(TodoApi.delete).toHaveBeenCalledWith("todo-1");
    expect(TodoApi.list).toHaveBeenCalledTimes(2);
    expect(result.current.todos).toEqual([bread]);
  });

  test("前の操作のエラーは、次の操作が成功すると消える", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [milk] });
    vi.mocked(TodoApi.delete)
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

    // when
    await act(() => result.current.deleteTodo("todo-1"));

    // then
    expect(result.current.error).toBe(
      tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
    );

    // when
    await act(() => result.current.deleteTodo("todo-1"));

    // then
    expect(result.current.error).toBeNull();
  });
});

describe("詳細画面のフラグ", () => {
  test("todo-detail-screen のフラグが on なら、showsDetailLink が true になる", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [milk] });
    vi.mocked(useFeatureFlag).mockReturnValue(true);

    // when
    const { result } = await renderLoaded();

    // then
    expect(result.current.showsDetailLink).toBe(true);
    expect(useFeatureFlag).toHaveBeenCalledWith("todo-detail-screen");
  });

  test("todo-detail-screen のフラグが off なら、showsDetailLink が false になる", async () => {
    // given
    vi.mocked(TodoApi.list).mockResolvedValue({ todos: [milk] });
    vi.mocked(useFeatureFlag).mockReturnValue(false);

    // when
    const { result } = await renderLoaded();

    // then
    expect(result.current.showsDetailLink).toBe(false);
    expect(useFeatureFlag).toHaveBeenCalledWith("todo-detail-screen");
  });
});
