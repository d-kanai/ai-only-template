// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ErrorResponse } from "../../../shared/presentation/http-error";
import { CreateTodoCommand } from "../application/create-todo.command";
import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";
import {
  CreateTodoApi,
  type CreateTodoResponse,
  POST as productionPost,
} from "./create-todo.api";

// テストごとに空の InMemory のリポジトリで組み立てる（本番の POST は Postgres を使い、テストの順序で結果が変わるため）。
function setup() {
  const repository = new InMemoryTodoRepository();
  return {
    repository,
    POST: new CreateTodoApi(new CreateTodoCommand(repository)).handle,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function postRequest(body: string): Request {
  return new Request("http://localhost/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/todos", () => {
  test("201 と作成した TodoDto を返し、保存される", async () => {
    const { repository, POST } = setup();

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
    await expect(repository.findById(body.id)).resolves.toMatchObject({
      title: "牛乳を買う",
    });
  });

  // WHY 本番の POST（モジュールの最下部で組み立てたもの）を確かめる: InMemory に切り替える分岐を持たない（Issue #59）
  //   ことを、Postgres の Repository に保存されることで固定する。save を差し替えるので DB には接続しない。
  test("本番の POST は Postgres の Repository に保存する", async () => {
    const save = vi
      .spyOn(PostgresTodoRepository.prototype, "save")
      .mockResolvedValue();

    const response = await productionPost(
      postRequest(JSON.stringify({ title: "牛乳を買う" })),
    );

    expect(response.status).toBe(201);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ title: "牛乳を買う" });
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
      const { repository, POST } = setup();

      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: expected,
      });
      await expect(repository.findAll()).resolves.toEqual([]);
    },
  );
});
