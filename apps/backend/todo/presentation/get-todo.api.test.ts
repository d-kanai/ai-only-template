// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "../../shared/presentation/http-error";
import { createInMemoryTodoContainer } from "../infra/container";
import { type GetTodoResponse, getTodoApi } from "./get-todo.api";

function setup() {
  const container = createInMemoryTodoContainer();
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
    const body = (await response.json()) as GetTodoResponse;
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
    const body = (await response.json()) as ErrorResponse;
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toEqual(expect.any(String));
  });
});
