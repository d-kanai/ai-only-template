import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/features/todo/api/api-error";
import {
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  updateTodo,
} from "@/features/todo/api/todo-api";

// fetch を差し替えて、画面側が送る HTTP リクエスト（URL / method / body）と、返ってきたレスポンスの扱いを検証する。
// 実際の Route Handler には繋がないため、HTTP 契約（backend 側と共通）を満たすリクエストを作れているかをここで固定する。
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const todo = {
  id: "todo-1",
  title: "牛乳を買う",
  completed: false,
  createdAt: "2026-09-28T00:00:00.000Z",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("listTodos", () => {
  test("GET /api/todos を呼び、レスポンスの { todos } を返す", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ todos: [todo] }, 200));

    await expect(listTodos()).resolves.toEqual({ todos: [todo] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/todos",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("getTodo", () => {
  test("GET /api/todos/:id を呼び、1 件の Todo を返す", async () => {
    fetchMock.mockResolvedValue(jsonResponse(todo, 200));

    await expect(getTodo("todo-1")).resolves.toEqual(todo);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/todos/todo-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("id に URL で意味を持つ文字が含まれていてもエンコードしてパスに入れる", async () => {
    fetchMock.mockResolvedValue(jsonResponse(todo, 200));

    await getTodo("a/b?c");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/todos/a%2Fb%3Fc",
      expect.anything(),
    );
  });
});

describe("createTodo", () => {
  test("POST /api/todos に JSON の { title } を送り、作成された Todo を返す", async () => {
    fetchMock.mockResolvedValue(jsonResponse(todo, 201));

    await expect(createTodo({ title: "牛乳を買う" })).resolves.toEqual(todo);
    expect(fetchMock).toHaveBeenCalledWith("/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "牛乳を買う" }),
    });
  });
});

describe("updateTodo", () => {
  test("PUT /api/todos/:id に JSON の変更内容を送り、更新後の Todo を返す", async () => {
    const updated = { ...todo, completed: true };
    fetchMock.mockResolvedValue(jsonResponse(updated, 200));

    await expect(updateTodo("todo-1", { completed: true })).resolves.toEqual(
      updated,
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/todos/todo-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
  });
});

describe("deleteTodo", () => {
  test("DELETE /api/todos/:id を呼び、204（本文なし）なら undefined で終わる", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteTodo("todo-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/todos/todo-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

// WHY 失敗の検証は rejects.toEqual(new ApiError(...)) で書く（rejects.toThrow("文字列") を使わない）:
//   Vitest 5.0.1 の rejects.toThrow("文字列") は、reject された値が undefined だと文字列を照合せずに通る
//   （2026-09-28 実測。Issue #55 の mutation testing で、toError が undefined を返す変異が生き残って判明）。
//   toEqual なら undefined や別のクラスの例外（判定の書き間違いで投げた TypeError など）では失敗する。
//   key と params は toEqual でも比べるが、Error の独自プロパティを比べるかは Vitest の実装に依るので、toMatchObject でも明示する。
describe("エラー時", () => {
  test("ErrorResponse が返ったら、その key と params を持つ ApiError を投げる", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "not_found",
            key: "todo.notFound",
            params: { id: "missing" },
          },
        },
        404,
      ),
    );

    const failure = getTodo("missing");

    await expect(failure).rejects.toEqual(
      new ApiError("todo.notFound", { id: "missing" }),
    );
    await expect(failure).rejects.toMatchObject({
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });

  test("ErrorResponse に params が無ければ、空の params の ApiError を投げる", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "validation_error", key: "todo.title.empty" } },
        400,
      ),
    );

    const failure = createTodo({ title: "" });

    await expect(failure).rejects.toEqual(new ApiError("todo.title.empty"));
    await expect(failure).rejects.toMatchObject({
      key: "todo.title.empty",
      params: {},
    });
  });

  // backend を通らないエラー（プロキシや Next のエラーページなど）は、本文が JSON でないことも、
  // JSON でも ErrorResponse の形でないこともある。どちらもキーを取り出せないので、HTTP ステータスを error.unknown で伝える。
  test("本文が JSON でなければ、HTTP ステータスを持つ error.unknown の ApiError を投げる", async () => {
    fetchMock.mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const failure = listTodos();

    await expect(failure).rejects.toEqual(
      new ApiError("error.unknown", { status: 500 }),
    );
    await expect(failure).rejects.toMatchObject({
      key: "error.unknown",
      params: { status: 500 },
    });
  });

  test.each([
    ["error を持たないオブジェクト", {}],
    ["null", null],
    ["文字列", "Bad Gateway"],
    ["数値", 502],
    ["error が null", { error: null }],
    ["error が文字列", { error: "Bad Gateway" }],
    ["error.key が無い", { error: { code: "x" } }],
    ["error.key が文字列でない", { error: { code: "x", key: 1 } }],
    // 配列は文字列に変換すると "todo.notFound" になり、プロパティ名としては辞書のキーに一致してしまう（文字列かの検査が要る）。
    [
      "error.key が辞書のキー 1 つの配列",
      { error: { code: "x", key: ["todo.notFound"] } },
    ],
    // 版の違う backend が新しいキーを返したときなど。翻訳できないので、ステータスだけを伝える。
    ["error.key が辞書に無い", { error: { code: "x", key: "todo.nope" } }],
    [
      "error.key が Object.prototype の名前",
      { error: { code: "x", key: "toString" } },
    ],
    [
      "error.params がオブジェクトでない",
      { error: { code: "x", key: "todo.notFound", params: "missing" } },
    ],
    [
      "error.params が null",
      { error: { code: "x", key: "todo.notFound", params: null } },
    ],
    // 以前の契約（Issue #116 の前）の本文。key が無いので ErrorResponse とみなさない。
    [
      "error.message だけを持つ",
      { error: { code: "x", message: "Todo が見つかりません" } },
    ],
  ])(
    "本文が JSON でも ErrorResponse の形でなければ（%s）、HTTP ステータスを持つ error.unknown の ApiError を投げる",
    async (_label, body) => {
      fetchMock.mockResolvedValue(jsonResponse(body, 502));

      const failure = listTodos();

      await expect(failure).rejects.toEqual(
        new ApiError("error.unknown", { status: 502 }),
      );
      await expect(failure).rejects.toMatchObject({
        key: "error.unknown",
        params: { status: 502 },
      });
    },
  );

  test("削除に失敗したら、ErrorResponse の key と params を持つ ApiError を投げる", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "not_found",
            key: "todo.notFound",
            params: { id: "missing" },
          },
        },
        404,
      ),
    );

    const failure = deleteTodo("missing");

    await expect(failure).rejects.toEqual(
      new ApiError("todo.notFound", { id: "missing" }),
    );
    await expect(failure).rejects.toMatchObject({
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });
});
