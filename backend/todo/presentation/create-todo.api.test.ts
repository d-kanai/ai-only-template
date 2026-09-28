// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "@/backend/shared/presentation/http-error";
import { createTodoContainer } from "@/backend/todo/infra/container";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";
import {
  type CreateTodoResponse,
  createTodoApi,
} from "@/backend/todo/presentation/create-todo.api";

function setup() {
  const container = createTodoContainer(new InMemoryTodoRepository());
  return { container, POST: createTodoApi(container) };
}

function postRequest(body: string): Request {
  return new Request("http://localhost/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/todos", () => {
  test("201 と作成した TodoDto を返し、保存される", async () => {
    const { container, POST } = setup();

    const response = await POST(
      postRequest(JSON.stringify({ title: " 牛乳を買う " })),
    );

    expect(response.status).toBe(201);
    const body: CreateTodoResponse = await response.json();
    expect(body).toEqual({
      id: expect.any(String),
      title: "牛乳を買う",
      completed: false,
      createdAt: expect.any(String),
    });
    // createdAt は ISO 8601（Date#toISOString の形）で返す。
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
    await expect(container.getTodo.execute(body.id)).resolves.toMatchObject({
      title: "牛乳を買う",
    });
  });

  test.each([
    ["JSON でない", "{title:"],
    ["オブジェクトでない", '["牛乳を買う"]'],
    ["title が無い", "{}"],
    ["title が文字列でない", JSON.stringify({ title: 1 })],
    ["title が空", JSON.stringify({ title: "" })],
    ["title が空白だけ", JSON.stringify({ title: "  " })],
    ["title が 101 文字", JSON.stringify({ title: "a".repeat(101) })],
  ])(
    "%s なら 400 と validation_error を返し、何も保存しない",
    async (_label, body) => {
      const { container, POST } = setup();

      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      const error: ErrorResponse = await response.json();
      expect(error.error.code).toBe("validation_error");
      expect(error.error.message).toEqual(expect.any(String));
      await expect(container.listTodos.execute()).resolves.toEqual([]);
    },
  );
});
