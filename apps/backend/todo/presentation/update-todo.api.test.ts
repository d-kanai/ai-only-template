// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "../../shared/presentation/http-error";
import { Todo } from "../domain/todo";
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

// uuid の形でない id の Todo を置いたリポジトリ。Todo.create の id は常に uuid なので、restore で置く
//   （DB に外から入れた行を想定）。リポジトリにあっても 404 になることで、presentation が id の形で弾き、
//   query / command に渡していないことを確かめる（InMemory は形を見ないので、渡せば見つかってしまう）。
async function repositoryWith(id: string): Promise<InMemoryTodoRepository> {
  const repository = new InMemoryTodoRepository();
  await repository.save(
    Todo.restore({
      id,
      title: "牛乳を買う",
      completed: false,
      createdAt: new Date("2026-09-28T00:00:00.000Z"),
    }),
  );
  return repository;
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

  test("uuid の形の無い id なら 404 と not_found を、その id を示す message 付きで返す", async () => {
    const { PUT } = await setup();
    const id = randomUUID();

    const response = await PUT(
      putRequest(id, JSON.stringify({ completed: true })),
      context(id),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error).toEqual({
      code: "not_found",
      message: `Todo（id: ${id}）が見つかりません`,
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
    "id が %s なら、%sときも、その id の Todo があっても 404 と not_found を返し、Todo は変わらない",
    async (_idLabel, _bodyLabel, id, requestBody) => {
      const repository = await repositoryWith(id);
      const PUT = updateTodoApi(createInMemoryTodoContainer(repository));

      const response = await PUT(putRequest(id, requestBody), context(id));

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toEqual({
        code: "not_found",
        message: `Todo（id: ${id}）が見つかりません`,
      });
      await expect(repository.findById(id)).resolves.toMatchObject({
        completed: false,
      });
    },
  );

  // message と issues は画面に出る（クライアントとの契約）ので、どの誤りかが分かる文言まで検証する。
  // issues はリクエストの形（presentation の zod スキーマ）の誤りだけに付く（create-todo.api.test.ts と同じ）。
  test.each([
    [
      "JSON でない",
      "{completed:",
      "リクエスト本文が JSON ではありません",
      undefined,
    ],
    [
      "オブジェクトでない",
      "null",
      "リクエスト本文は JSON のオブジェクトで指定してください",
      [
        {
          path: "",
          message: "リクエスト本文は JSON のオブジェクトで指定してください",
        },
      ],
    ],
    [
      "title が文字列でない",
      JSON.stringify({ title: null }),
      "title は文字列で指定してください",
      [{ path: "title", message: "title は文字列で指定してください" }],
    ],
    [
      "completed が boolean でない",
      JSON.stringify({ completed: "true" }),
      "completed は true か false で指定してください",
      [
        {
          path: "completed",
          message: "completed は true か false で指定してください",
        },
      ],
    ],
    [
      "title と completed の両方の型が違う",
      JSON.stringify({ title: 1, completed: 1 }),
      "title は文字列で指定してください",
      [
        { path: "title", message: "title は文字列で指定してください" },
        {
          path: "completed",
          message: "completed は true か false で指定してください",
        },
      ],
    ],
    [
      // WHY 未知のキーを拒否する: 部分更新なので、項目名を打ち間違えた本文（{ complete: true }）を黙って捨てると
      //   「何も変えない」200 になり、誤りに気づけない。
      "定義されていない項目がある（項目名の打ち間違い）",
      JSON.stringify({ complete: true }),
      "定義されていない項目は指定できません（complete）",
      [
        {
          path: "",
          message: "定義されていない項目は指定できません（complete）",
        },
      ],
    ],
    [
      "title が空",
      JSON.stringify({ title: "" }),
      "タイトルを入力してください",
      undefined,
    ],
    [
      "title が 101 文字",
      JSON.stringify({ title: "a".repeat(101) }),
      "タイトルは 100 文字以内で入力してください",
      undefined,
    ],
  ])(
    "%s なら 400 と validation_error を、理由の message（と issues）付きで返し、Todo は変わらない",
    async (_label, body, message, issues) => {
      const { container, todo, PUT } = await setup();

      const response = await PUT(putRequest(todo.id, body), context(todo.id));

      expect(response.status).toBe(400);
      const error = (await response.json()) as ErrorResponse;
      // toEqual は undefined のプロパティと無いプロパティを同じとみなす。issues が無いことは下で別に確かめる。
      expect(error.error).toEqual({
        code: "validation_error",
        message,
        issues,
      });
      expect("issues" in error.error).toBe(issues !== undefined);
      await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
    },
  );
});
