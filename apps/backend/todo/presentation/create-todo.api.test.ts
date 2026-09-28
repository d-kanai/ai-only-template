// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "../../shared/presentation/http-error";
import { createInMemoryTodoContainer } from "../infra/container";
import { type CreateTodoResponse, createTodoApi } from "./create-todo.api";

function setup() {
  const container = createInMemoryTodoContainer();
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
    const body = (await response.json()) as CreateTodoResponse;
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

  // message は画面に出る（クライアントとの契約）ので、どの誤りかが分かる文言まで検証する。
  test.each([
    ["JSON でない", "{title:", "リクエスト本文が JSON ではありません"],
    [
      "オブジェクトでない",
      '["牛乳を買う"]',
      "リクエスト本文は JSON のオブジェクトで指定してください",
    ],
    ["title が無い", "{}", "title は文字列で指定してください"],
    [
      "title が文字列でない",
      JSON.stringify({ title: 1 }),
      "title は文字列で指定してください",
    ],
    ["title が空", JSON.stringify({ title: "" }), "タイトルを入力してください"],
    [
      "title が空白だけ",
      JSON.stringify({ title: "  " }),
      "タイトルを入力してください",
    ],
    [
      "title が 101 文字",
      JSON.stringify({ title: "a".repeat(101) }),
      "タイトルは 100 文字以内で入力してください",
    ],
  ])(
    "%s なら 400 と validation_error を、理由の message 付きで返し、何も保存しない",
    async (_label, body, message) => {
      const { container, POST } = setup();

      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      const error = (await response.json()) as ErrorResponse;
      expect(error.error).toEqual({ code: "validation_error", message });
      await expect(container.listTodos.execute()).resolves.toEqual([]);
    },
  );
});
