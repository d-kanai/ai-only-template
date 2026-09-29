// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { ErrorResponse } from "../../../shared/presentation/http-error";
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

  test("uuid の形だが存在しない id なら 404 と not_found を、その id を示す message 付きで返す", async () => {
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
    "id が %s なら、Repository に問い合わせずに 404 と not_found を返す",
    async (_label, id) => {
      const { repository, ...spies } = spiedRepository();
      const GET = getTodoApi(createInMemoryTodoContainer(repository));

      const response = await GET(getRequest(id), context(id));

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toEqual({
        code: "not_found",
        message: `Todo（id: ${id}）が見つかりません`,
      });
      expect(spies.findById).not.toHaveBeenCalled();
      expect(spies.save).not.toHaveBeenCalled();
      expect(spies.delete).not.toHaveBeenCalled();
    },
  );
});
