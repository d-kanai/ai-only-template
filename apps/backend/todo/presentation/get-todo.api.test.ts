// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { ErrorResponse } from "../../shared/presentation/http-error";
import { Todo } from "../domain/todo";
import { createInMemoryTodoContainer } from "../infra/container";
import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";
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

  test("uuid の形で無い id なら 404 と not_found を、その id を示す message 付きで返す", async () => {
    const { GET } = setup();
    const id = randomUUID();

    const response = await GET(getRequest(id), context(id));

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error).toEqual({
      code: "not_found",
      message: `Todo（id: ${id}）が見つかりません`,
    });
  });

  test.each(NOT_UUID_IDS)(
    "id が %s なら、その id の Todo がリポジトリにあっても、問い合わせずに 404 と not_found を返す",
    async (_label, id) => {
      const repository = await repositoryWith(id);
      const GET = getTodoApi(createInMemoryTodoContainer(repository));

      const response = await GET(getRequest(id), context(id));

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toEqual({
        code: "not_found",
        message: `Todo（id: ${id}）が見つかりません`,
      });
    },
  );
});
