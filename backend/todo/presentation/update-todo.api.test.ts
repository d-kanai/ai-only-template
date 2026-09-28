// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "@/backend/shared/presentation/http-error";
import { createInMemoryTodoContainer } from "@/backend/todo/infra/container";
import {
  type UpdateTodoResponse,
  updateTodoApi,
} from "@/backend/todo/presentation/update-todo.api";

async function setup() {
  const container = createInMemoryTodoContainer();
  const todo = await container.createTodo.execute({ title: "牛乳を買う" });
  return { container, todo, PUT: updateTodoApi(container) };
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function putRequest(id: string, body: string): Request {
  return new Request(`http://localhost/api/todos/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("PUT /api/todos/:id", () => {
  test("title と completed を更新し、200 と更新後の TodoDto を返す", async () => {
    const { todo, PUT } = await setup();

    const response = await PUT(
      putRequest(
        todo.id,
        JSON.stringify({ title: "卵を買う", completed: true }),
      ),
      context(todo.id),
    );

    expect(response.status).toBe(200);
    const body: UpdateTodoResponse = await response.json();
    expect(body).toEqual({
      id: todo.id,
      title: "卵を買う",
      completed: true,
      createdAt: todo.createdAt.toISOString(),
    });
  });

  test("completed だけ送ると title はそのまま（部分更新）", async () => {
    const { container, todo, PUT } = await setup();

    const response = await PUT(
      putRequest(todo.id, JSON.stringify({ completed: true })),
      context(todo.id),
    );

    expect(response.status).toBe(200);
    await expect(container.getTodo.execute(todo.id)).resolves.toMatchObject({
      title: "牛乳を買う",
      completed: true,
    });
  });

  test("title だけ送ると completed はそのまま（部分更新）", async () => {
    const { container, todo, PUT } = await setup();

    const response = await PUT(
      putRequest(todo.id, JSON.stringify({ title: "卵を買う" })),
      context(todo.id),
    );

    expect(response.status).toBe(200);
    await expect(container.getTodo.execute(todo.id)).resolves.toMatchObject({
      title: "卵を買う",
      completed: false,
    });
  });

  test("無い id なら 404 と not_found を返す", async () => {
    const { PUT } = await setup();

    const response = await PUT(
      putRequest("missing", JSON.stringify({ completed: true })),
      context("missing"),
    );

    expect(response.status).toBe(404);
    const body: ErrorResponse = await response.json();
    expect(body.error).toEqual({
      code: "not_found",
      message: "Todo（id: missing）が見つかりません",
    });
  });

  // message は画面に出る（クライアントとの契約）ので、どの誤りかが分かる文言まで検証する。
  test.each([
    ["JSON でない", "{completed:", "リクエスト本文が JSON ではありません"],
    [
      "オブジェクトでない",
      "null",
      "リクエスト本文は JSON のオブジェクトで指定してください",
    ],
    [
      "title が文字列でない",
      JSON.stringify({ title: null }),
      "title は文字列で指定してください",
    ],
    ["title が空", JSON.stringify({ title: "" }), "タイトルを入力してください"],
    [
      "title が 101 文字",
      JSON.stringify({ title: "a".repeat(101) }),
      "タイトルは 100 文字以内で入力してください",
    ],
    [
      "completed が boolean でない",
      JSON.stringify({ completed: "true" }),
      "completed は true か false で指定してください",
    ],
  ])(
    "%s なら 400 と validation_error を、理由の message 付きで返し、Todo は変わらない",
    async (_label, body, message) => {
      const { container, todo, PUT } = await setup();

      const response = await PUT(putRequest(todo.id, body), context(todo.id));

      expect(response.status).toBe(400);
      const error: ErrorResponse = await response.json();
      expect(error.error).toEqual({ code: "validation_error", message });
      await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
    },
  );
});
