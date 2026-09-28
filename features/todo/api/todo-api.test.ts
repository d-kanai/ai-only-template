import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

// WHY 失敗の検証は rejects.toEqual(new Error(...)) で書く（rejects.toThrow("文字列") を使わない）:
//   Vitest 5.0.1 の rejects.toThrow("文字列") は、reject された値が undefined だと文字列を照合せずに通る
//   （2026-09-28 実測。Issue #55 の mutation testing で、toError が undefined を返す変異が生き残って判明）。
//   toEqual なら undefined や別のクラスの例外（判定の書き間違いで投げた TypeError など）では失敗する。
describe("エラー時", () => {
  test("ErrorResponse が返ったら、その error.message を message に持つ Error を投げる", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "not_found", message: "Todo が見つかりません" } },
        404,
      ),
    );

    await expect(getTodo("missing")).rejects.toEqual(
      new Error("Todo が見つかりません"),
    );
  });

  // backend を通らないエラー（プロキシや Next のエラーページなど）は、本文が JSON でないことも、
  // JSON でも ErrorResponse の形でないこともある。どちらも message を取り出せないので HTTP ステータスを伝える。
  test("本文が JSON でなければ、HTTP ステータスを message に持つ Error を投げる", async () => {
    fetchMock.mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(listTodos()).rejects.toEqual(new Error("HTTP 500"));
  });

  test.each([
    ["error を持たないオブジェクト", {}],
    ["null", null],
    ["文字列", "Bad Gateway"],
    ["数値", 502],
    ["error が null", { error: null }],
    ["error が文字列", { error: "Bad Gateway" }],
    ["error.message が無い", { error: { code: "x" } }],
    ["error.message が文字列でない", { error: { code: "x", message: 1 } }],
  ])(
    "本文が JSON でも ErrorResponse の形でなければ（%s）、HTTP ステータスを message に持つ Error を投げる",
    async (_label, body) => {
      fetchMock.mockResolvedValue(jsonResponse(body, 502));

      await expect(listTodos()).rejects.toEqual(new Error("HTTP 502"));
    },
  );

  test("削除に失敗したら、ErrorResponse の error.message を message に持つ Error を投げる", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "not_found", message: "Todo が見つかりません" } },
        404,
      ),
    );

    await expect(deleteTodo("missing")).rejects.toEqual(
      new Error("Todo が見つかりません"),
    );
  });
});
