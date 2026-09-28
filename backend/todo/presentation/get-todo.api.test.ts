// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "@/backend/shared/presentation/http-error";
import { createTodoContainer } from "@/backend/todo/infra/container";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";
import {
  type GetTodoResponse,
  getTodoApi,
} from "@/backend/todo/presentation/get-todo.api";

function setup() {
  const container = createTodoContainer(new InMemoryTodoRepository());
  return { container, GET: getTodoApi(container) };
}

// Next 16 では Route Handler の第 2 引数の params が Promise で渡される。本番と同じ形で渡す。
function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function getRequest(id: string): Request {
  return new Request(`http://localhost/api/todos/${id}`);
}

describe("GET /api/todos/:id", () => {
  test("200 と TodoDto を返す", async () => {
    const { container, GET } = setup();
    const todo = await container.createTodo.execute({ title: "牛乳を買う" });

    const response = await GET(getRequest(todo.id), context(todo.id));

    expect(response.status).toBe(200);
    const body: GetTodoResponse = await response.json();
    expect(body).toEqual({
      id: todo.id,
      title: "牛乳を買う",
      completed: false,
      createdAt: todo.createdAt.toISOString(),
    });
  });

  test("無い id なら 404 と not_found を返す", async () => {
    const { GET } = setup();

    const response = await GET(getRequest("missing"), context("missing"));

    expect(response.status).toBe(404);
    const body: ErrorResponse = await response.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toEqual(expect.any(String));
  });
});
