// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "../../../shared/presentation/http-error";
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

  test("title の前後の空白を除いて 100 文字（絵文字は 1 文字と数える）なら作れる", async () => {
    const { POST } = setup();
    const title = "🍎".repeat(100);

    const response = await POST(
      postRequest(JSON.stringify({ title: ` ${title} ` })),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ title });
  });

  // key・params・issues は画面が翻訳する（クライアントとの契約。Issue #116）ので、本文全体を検証する。
  // issues: リクエストの形（presentation の zod スキーマ）の誤りだけに付く。JSON として読めない誤りと、
  //   値の規則（domain の不変条件）の誤りには付かない（ErrorResponse のコメント）。
  // WHY toStrictEqual: toEqual は undefined のプロパティと無いプロパティを同じとみなす。params・issues の無い誤りで
  //   本文にそのキーが出ないこと（JSON は undefined を出さないので、出ていれば値がある）も確かめる。
  test.each<[string, string, ErrorResponse["error"]]>([
    [
      "JSON でない",
      "{title:",
      { code: "validation_error", key: "request.body.notJson" },
    ],
    [
      "オブジェクトでない",
      '["牛乳を買う"]',
      {
        code: "validation_error",
        key: "request.body.notObject",
        issues: [{ path: "", key: "request.body.notObject" }],
      },
    ],
    [
      "title が無い",
      "{}",
      {
        code: "validation_error",
        key: "request.field.notString",
        params: { path: "title" },
        issues: [
          {
            path: "title",
            key: "request.field.notString",
            params: { path: "title" },
          },
        ],
      },
    ],
    [
      "title が文字列でない",
      JSON.stringify({ title: 1 }),
      {
        code: "validation_error",
        key: "request.field.notString",
        params: { path: "title" },
        issues: [
          {
            path: "title",
            key: "request.field.notString",
            params: { path: "title" },
          },
        ],
      },
    ],
    [
      "定義されていない項目がある",
      JSON.stringify({ title: "牛乳を買う", completed: true }),
      {
        code: "validation_error",
        key: "request.body.unknownKeys",
        params: { keys: "completed" },
        issues: [
          {
            path: "",
            key: "request.body.unknownKeys",
            params: { keys: "completed" },
          },
        ],
      },
    ],
    [
      "title が空",
      JSON.stringify({ title: "" }),
      { code: "validation_error", key: "todo.title.empty" },
    ],
    [
      "title が空白だけ",
      JSON.stringify({ title: "  " }),
      { code: "validation_error", key: "todo.title.empty" },
    ],
    [
      "title が 101 文字",
      JSON.stringify({ title: "a".repeat(101) }),
      {
        code: "validation_error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      },
    ],
    [
      "title が絵文字 101 個",
      JSON.stringify({ title: "🍎".repeat(101) }),
      {
        code: "validation_error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      },
    ],
  ])(
    "%s なら 400 と validation_error を、理由の key（と params・issues）付きで返し、何も保存しない",
    async (_label, body, expected) => {
      const { container, POST } = setup();

      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: expected,
      });
      await expect(container.listTodos.execute()).resolves.toEqual([]);
    },
  );
});
