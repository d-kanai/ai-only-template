// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "../../shared/presentation/http-error";
import { createInMemoryTodoContainer } from "../infra/container";
import { deleteTodoApi } from "./delete-todo.api";

function setup() {
  const container = createInMemoryTodoContainer();
  return { container, DELETE: deleteTodoApi(container) };
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function deleteRequest(id: string): Request {
  return new Request(`http://localhost/api/todos/${id}`, { method: "DELETE" });
}

describe("DELETE /api/todos/:id", () => {
  test("204 と空の本文を返し、Todo が消える", async () => {
    const { container, DELETE } = setup();
    const todo = await container.createTodo.execute({ title: "牛乳を買う" });

    const response = await DELETE(deleteRequest(todo.id), context(todo.id));

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
    await expect(container.listTodos.execute()).resolves.toEqual([]);
  });

  test("無い id なら 404 と not_found を返す", async () => {
    const { DELETE } = setup();

    const response = await DELETE(deleteRequest("missing"), context("missing"));

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error.code).toBe("not_found");
  });
});
