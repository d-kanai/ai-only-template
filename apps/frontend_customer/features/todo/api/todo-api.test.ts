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

// backend の失敗の応答（RFC 9457 の Problem Details。apps/backend/shared/presentation/problem.ts）。Content-Type も本番と同じにし、
//   application/problem+json でも response.json() で読めることを確かめる。
function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

// 項目ごとの誤り（errors）を持ちうる 400 の本文。errors は各テストで足す。
const validationProblem = {
  type: "/problems/validation-error",
  title: "Validation error",
  status: 400,
  detail: "title must be a string.",
  instance: "/api/todos",
  key: "request.field.notString",
  params: { path: "title" },
};

const validTitleError = {
  pointer: "#/title",
  key: "request.field.notString",
  params: { path: "title" },
  detail: "title must be a string.",
};

const notFoundProblem = {
  type: "/problems/not-found",
  title: "Not found",
  status: 404,
  detail: "Todo missing was not found.",
  instance: "/api/todos/missing",
  key: "todo.notFound",
  params: { id: "missing" },
};

// WHY 失敗の検証は rejects.toEqual(new ApiError(...)) で書く（rejects.toThrow("文字列") を使わない）:
//   Vitest 5.0.1 の rejects.toThrow("文字列") は、reject された値が undefined だと文字列を照合せずに通る
//   （toError が undefined を返す変異が mutation testing で生き残る）。
//   toEqual なら undefined や別のクラスの例外（判定の書き間違いで投げた TypeError など）では失敗する。
//   status・type・key・params は toEqual でも比べるが、Error の独自プロパティを比べるかは Vitest の実装に依るので、
//   toMatchObject でも明示する。
describe("エラー時", () => {
  test("Problem Details が返ったら、HTTP ステータスと、本文の type・key・params を持つ ApiError を投げる（detail は読まない）", async () => {
    fetchMock.mockResolvedValue(problemResponse(notFoundProblem, 404));

    const failure = getTodo("missing");

    await expect(failure).rejects.toEqual(
      new ApiError({
        status: 404,
        type: "/problems/not-found",
        key: "todo.notFound",
        params: { id: "missing" },
      }),
    );
    await expect(failure).rejects.toMatchObject({
      status: 404,
      type: "/problems/not-found",
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });

  test("Problem Details に params が無ければ、空の params の ApiError を投げる", async () => {
    fetchMock.mockResolvedValue(
      problemResponse(
        {
          type: "/problems/validation-error",
          title: "Validation error",
          status: 400,
          detail: "Title must not be empty.",
          instance: "/api/todos",
          key: "todo.title.empty",
        },
        400,
      ),
    );

    const failure = createTodo({ title: "" });

    await expect(failure).rejects.toEqual(
      new ApiError({
        status: 400,
        type: "/problems/validation-error",
        key: "todo.title.empty",
      }),
    );
    await expect(failure).rejects.toMatchObject({
      status: 400,
      type: "/problems/validation-error",
      key: "todo.title.empty",
      params: {},
    });
  });

  // 400 の項目ごとの誤り（拡張メンバー errors。apps/backend/shared/presentation/problem.ts の ProblemError）。
  //   detail は読まない（ApiError のコンストラクタが落とす）。params の無い要素は空の params にする。
  test("Problem Details に errors があれば、各要素の pointer・key・params を持つ ApiError を投げる", async () => {
    fetchMock.mockResolvedValue(
      problemResponse(
        {
          ...validationProblem,
          errors: [
            {
              pointer: "#/title",
              key: "request.field.notString",
              params: { path: "title" },
              detail: "title must be a string.",
            },
            {
              pointer: "#",
              key: "request.body.notObject",
              detail: "Request body must be a JSON object.",
            },
          ],
        },
        400,
      ),
    );

    const reason = await createTodo({ title: "" }).catch(
      (error: unknown) => error,
    );

    expect(reason).toBeInstanceOf(ApiError);
    expect((reason as ApiError).errors).toStrictEqual([
      {
        pointer: "#/title",
        key: "request.field.notString",
        params: { path: "title" },
      },
      { pointer: "#", key: "request.body.notObject", params: {} },
    ]);
    expect(reason).toMatchObject({
      status: 400,
      type: "/problems/validation-error",
      key: "request.field.notString",
      params: { path: "title" },
    });
  });

  test.each([
    ["errors が無い", undefined],
    ["errors が空の配列", []],
  ])(
    "Problem Details の %s なら、項目ごとの誤りが空の ApiError を投げる",
    async (_label, errors) => {
      fetchMock.mockResolvedValue(
        problemResponse({ ...validationProblem, errors }, 400),
      );

      const reason = await createTodo({ title: "" }).catch(
        (error: unknown) => error,
      );

      expect(reason).toMatchObject({
        status: 400,
        key: "request.field.notString",
      });
      expect((reason as ApiError).errors).toStrictEqual([]);
    },
  );

  // RFC 9457 の 3.1.2 節: 本文の status は参考（advisory）で、途中の中継（プロキシ・キャッシュ）がステータスを変えることがある。
  //   画面が受け取った HTTP の応答のステータスを正とし、本文が読めない失敗（error.unknown）と同じ値の取り方にそろえる。
  test("ApiError の status は HTTP の応答のステータスにする（本文の status は使わない）", async () => {
    fetchMock.mockResolvedValue(problemResponse(notFoundProblem, 410));

    await expect(getTodo("missing")).rejects.toMatchObject({ status: 410 });
  });

  // backend を通らないエラー（プロキシや Next のエラーページなど）は、本文が JSON でないことも、
  // JSON でも Problem Details の形でないこともある。どちらもキーを取り出せないので、HTTP ステータスを error.unknown で伝える。
  test("本文が JSON でなければ、HTTP ステータスを持つ error.unknown の ApiError を投げる（type は無い）", async () => {
    fetchMock.mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const failure = listTodos();

    await expect(failure).rejects.toEqual(
      new ApiError({
        status: 500,
        key: "error.unknown",
        params: { status: 500 },
      }),
    );
    await expect(failure).rejects.toMatchObject({
      status: 500,
      type: undefined,
      key: "error.unknown",
      params: { status: 500 },
    });
  });

  test.each([
    ["key を持たないオブジェクト", {}],
    ["null", null],
    ["文字列", "Bad Gateway"],
    ["数値", 502],
    // key の無い Problem Details（このアプリの拡張メンバーを持たない、ほかのサーバの応答）。翻訳できない。
    ["key が無い", { ...notFoundProblem, key: undefined }],
    ["key が文字列でない", { ...notFoundProblem, key: 1 }],
    // 配列は文字列に変換すると "todo.notFound" になり、プロパティ名としては辞書のキーに一致してしまう（文字列かの検査が要る）。
    [
      "key が辞書のキー 1 つの配列",
      { ...notFoundProblem, key: ["todo.notFound"] },
    ],
    // 版の違う backend が新しいキーを返したときなど。翻訳できないので、ステータスだけを伝える。
    ["key が辞書に無い", { ...notFoundProblem, key: "todo.nope" }],
    ["key が Object.prototype の名前", { ...notFoundProblem, key: "toString" }],
    ["params がオブジェクトでない", { ...notFoundProblem, params: "missing" }],
    ["params が null", { ...notFoundProblem, params: null }],
    // 配列は typeof が object なので、配列でないことの検査が要る（{id} が置き換わらないまま画面に出る）。
    ["params が配列", { ...notFoundProblem, params: ["missing"] }],
    // type・status は RFC 9457 の標準のメンバー。どちらかが無い・型が違う本文は Problem Details とみなさない。
    ["type が無い", { ...notFoundProblem, type: undefined }],
    ["type が文字列でない", { ...notFoundProblem, type: 404 }],
    ["status が無い", { ...notFoundProblem, status: undefined }],
    ["status が数値でない", { ...notFoundProblem, status: "404" }],
    // errors（項目ごとの誤り）の形が崩れた本文。1 件でも崩れていれば、本文全体を Problem Details とみなさない
    //   （todo-api.ts の isProblem の WHY）。正しい要素（validTitleError）と並べ、崩れた 1 件だけで外れることを見る。
    ["errors がオブジェクト", { ...notFoundProblem, errors: validTitleError }],
    ["errors が null", { ...notFoundProblem, errors: null }],
    ["errors が文字列", { ...notFoundProblem, errors: "#/title" }],
    [
      "errors の要素が null",
      { ...notFoundProblem, errors: [validTitleError, null] },
    ],
    [
      "errors の要素が文字列",
      { ...notFoundProblem, errors: [validTitleError, "#/title"] },
    ],
    [
      "errors の要素の pointer が無い",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, pointer: undefined }],
      },
    ],
    [
      "errors の要素の pointer が文字列でない",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, pointer: ["#/title"] }],
      },
    ],
    [
      "errors の要素の key が無い",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, key: undefined }],
      },
    ],
    [
      "errors の要素の key が辞書のキー 1 つの配列",
      {
        ...notFoundProblem,
        errors: [
          validTitleError,
          { ...validTitleError, key: ["todo.title.empty"] },
        ],
      },
    ],
    [
      "errors の要素の key が辞書に無い",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, key: "todo.nope" }],
      },
    ],
    [
      "errors の要素の key が Object.prototype の名前",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, key: "toString" }],
      },
    ],
    [
      "errors の要素の params がオブジェクトでない",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, params: "title" }],
      },
    ],
    [
      "errors の要素の params が null",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, params: null }],
      },
    ],
    [
      "errors の要素の params が配列",
      {
        ...notFoundProblem,
        errors: [validTitleError, { ...validTitleError, params: ["title"] }],
      },
    ],
    // key が error の中にあり、type・status が無い本文は Problem Details とみなさない。
    [
      "以前の形（{ error: { code, key, params } }）",
      {
        error: {
          code: "not_found",
          key: "todo.notFound",
          params: { id: "missing" },
        },
      },
    ],
  ])(
    "本文が JSON でも Problem Details の形でなければ（%s）、HTTP ステータスを持つ error.unknown の ApiError を投げる",
    async (_label, body) => {
      fetchMock.mockResolvedValue(problemResponse(body, 502));

      const failure = listTodos();

      await expect(failure).rejects.toEqual(
        new ApiError({
          status: 502,
          key: "error.unknown",
          params: { status: 502 },
        }),
      );
      await expect(failure).rejects.toMatchObject({
        status: 502,
        type: undefined,
        key: "error.unknown",
        params: { status: 502 },
      });
    },
  );

  test("削除に失敗したら、Problem Details の type・key・params を持つ ApiError を投げる", async () => {
    fetchMock.mockResolvedValue(problemResponse(notFoundProblem, 404));

    const failure = deleteTodo("missing");

    await expect(failure).rejects.toEqual(
      new ApiError({
        status: 404,
        type: "/problems/not-found",
        key: "todo.notFound",
        params: { id: "missing" },
      }),
    );
    await expect(failure).rejects.toMatchObject({
      status: 404,
      type: "/problems/not-found",
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });
});
