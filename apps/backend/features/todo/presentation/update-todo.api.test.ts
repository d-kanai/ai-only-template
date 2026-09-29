// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { ErrorResponse } from "../../../shared/presentation/http-error";
import { createInMemoryTodoContainer } from "../infra/container";
import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";
import { type UpdateTodoResponse, updateTodoApi } from "./update-todo.api";

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

// 問い合わせを記録するリポジトリ。uuid の形でない id で、presentation が query / command に渡す前に
//   404 にしていること（parseUuidParam）を、Repository が呼ばれないことで確かめる。
// WHY spy で確かめる（その id の Todo を置いて「あっても 404」を見ない）: Issue #94 から Todo は常に不変条件
//   （id は uuid の形）を満たすので、uuid の形でない id の Todo は作れない。空のリポジトリで 404 を見るだけだと、
//   id をそのまま渡しても「無い」の 404 になり、presentation の検査を外しても通ってしまう。
function spiedRepository() {
  const repository = new InMemoryTodoRepository();
  return {
    repository,
    findById: vi.spyOn(repository, "findById"),
    save: vi.spyOn(repository, "save"),
    delete: vi.spyOn(repository, "delete"),
  };
}

// id の形の検査は z.uuid()（RFC 9562 の形。版の桁は 1〜8、variant の桁は 8 / 9 / a / b）。
const NOT_UUID_IDS = [
  ["uuid の形でない", "missing"],
  // Postgres の uuid 型は受け付けるが、RFC 9562 の形ではない（版の桁が 0）。Todo の id は randomUUID（v4）で作る。
  ["版の桁が 0", "8d0f4f39-6f0b-0a39-9d53-0a3f8b1c2d4e"],
] as const;

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
    const body = (await response.json()) as UpdateTodoResponse;
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

  test("本文が空のオブジェクト（{}）なら何も変えず、200 と今の TodoDto を返す", async () => {
    const { todo, PUT } = await setup();

    const response = await PUT(putRequest(todo.id, "{}"), context(todo.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: todo.id,
      title: "牛乳を買う",
      completed: false,
      createdAt: todo.createdAt.toISOString(),
    });
  });

  test("uuid の形だが存在しない id なら 404 と not_found を、todo.notFound と id の params 付きで返す", async () => {
    const { PUT } = await setup();
    const id = randomUUID();

    const response = await PUT(
      putRequest(id, JSON.stringify({ completed: true })),
      context(id),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { code: "not_found", key: "todo.notFound", params: { id } },
    });
  });

  // WHY id を本文より先に確かめる: URL が指す Todo が存在しえないなら、本文の誤りを直しても成功しない。
  //   先に 404 を返し、直しても意味の無い 400 を返さない。
  test.each(
    NOT_UUID_IDS.flatMap(([idLabel, id]) =>
      [
        ["本文が正しい", JSON.stringify({ completed: true })],
        ["本文が JSON でない", "{completed:"],
        ["本文の形が違う", JSON.stringify({ completed: "true" })],
      ].map(([bodyLabel, requestBody]) => [
        idLabel,
        bodyLabel,
        id,
        requestBody,
      ]),
    ),
  )(
    "id が %s なら、%sときも、Repository に問い合わせずに 404 と not_found（todo.notFound と id の params）を返す",
    async (_idLabel, _bodyLabel, id, requestBody) => {
      const { repository, ...spies } = spiedRepository();
      const PUT = updateTodoApi(createInMemoryTodoContainer(repository));

      const response = await PUT(putRequest(id, requestBody), context(id));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toStrictEqual({
        error: { code: "not_found", key: "todo.notFound", params: { id } },
      });
      expect(spies.findById).not.toHaveBeenCalled();
      expect(spies.save).not.toHaveBeenCalled();
      expect(spies.delete).not.toHaveBeenCalled();
    },
  );

  // key・params・issues は画面が翻訳する（クライアントとの契約。Issue #116）ので、本文全体を toStrictEqual で検証する
  //   （WHY は create-todo.api.test.ts と同じ）。issues はリクエストの形（presentation の zod スキーマ）の誤りだけに付く。
  test.each<[string, string, ErrorResponse["error"]]>([
    [
      "JSON でない",
      "{completed:",
      { code: "validation_error", key: "request.body.notJson" },
    ],
    [
      "オブジェクトでない",
      "null",
      {
        code: "validation_error",
        key: "request.body.notObject",
        issues: [{ path: "", key: "request.body.notObject" }],
      },
    ],
    [
      "title が文字列でない",
      JSON.stringify({ title: null }),
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
      "completed が boolean でない",
      JSON.stringify({ completed: "true" }),
      {
        code: "validation_error",
        key: "request.field.notBoolean",
        params: { path: "completed" },
        issues: [
          {
            path: "completed",
            key: "request.field.notBoolean",
            params: { path: "completed" },
          },
        ],
      },
    ],
    [
      "title と completed の両方の型が違う",
      JSON.stringify({ title: 1, completed: 1 }),
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
          {
            path: "completed",
            key: "request.field.notBoolean",
            params: { path: "completed" },
          },
        ],
      },
    ],
    [
      // WHY 未知のキーを拒否する: 部分更新なので、項目名を打ち間違えた本文（{ complete: true }）を黙って捨てると
      //   「何も変えない」200 になり、誤りに気づけない。
      "定義されていない項目がある（項目名の打ち間違い）",
      JSON.stringify({ complete: true }),
      {
        code: "validation_error",
        key: "request.body.unknownKeys",
        params: { keys: "complete" },
        issues: [
          {
            path: "",
            key: "request.body.unknownKeys",
            params: { keys: "complete" },
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
      "title が 101 文字",
      JSON.stringify({ title: "a".repeat(101) }),
      {
        code: "validation_error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      },
    ],
  ])(
    "%s なら 400 と validation_error を、理由の key（と params・issues）付きで返し、Todo は変わらない",
    async (_label, body, expected) => {
      const { container, todo, PUT } = await setup();

      const response = await PUT(putRequest(todo.id, body), context(todo.id));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toStrictEqual({
        error: expected,
      });
      await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
    },
  );
});
