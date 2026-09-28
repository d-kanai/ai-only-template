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

  test("無い id なら 404 と not_found を返す", async () => {
    const { PUT } = await setup();

    const response = await PUT(
      putRequest("missing", JSON.stringify({ completed: true })),
      context("missing"),
    );

    expect(response.status).toBe(404);
    const body: ErrorResponse = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  test.each([
    ["JSON でない", "{completed:"],
    ["オブジェクトでない", "null"],
    ["title が文字列でない", JSON.stringify({ title: null })],
    ["title が空", JSON.stringify({ title: "" })],
    ["title が 101 文字", JSON.stringify({ title: "a".repeat(101) })],
    ["completed が boolean でない", JSON.stringify({ completed: "true" })],
  ])(
    "%s なら 400 と validation_error を返し、Todo は変わらない",
    async (_label, body) => {
      const { container, todo, PUT } = await setup();

      const response = await PUT(putRequest(todo.id, body), context(todo.id));

      expect(response.status).toBe(400);
      const error: ErrorResponse = await response.json();
      expect(error.error.code).toBe("validation_error");
      await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
    },
  );
});
