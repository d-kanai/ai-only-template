// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createTodoContainer } from "@/backend/todo/infra/container";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";
import {
  type ListTodosResponse,
  listTodosApi,
} from "@/backend/todo/presentation/list-todos.api";

// テストごとに空のリポジトリで組み立てる（アプリ共有のコンテナを使うとテストの順序で結果が変わるため）。
function setup() {
  const container = createTodoContainer(new InMemoryTodoRepository());
  return { container, GET: listTodosApi(container) };
}

function listRequest(): Request {
  return new Request("http://localhost/api/todos");
}

describe("GET /api/todos", () => {
  test("Todo が無ければ 200 と空の一覧を返す", async () => {
    const { GET } = setup();

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    const body: ListTodosResponse = await response.json();
    expect(body).toEqual({ todos: [] });
  });

  test("作成した Todo を TodoDto の形で、作成した順（作成日時の昇順）に返す", async () => {
    const { container, GET } = setup();
    const first = await container.createTodo.execute({ title: "牛乳を買う" });
    const second = await container.createTodo.execute({ title: "卵を買う" });
    await container.updateTodo.execute({ id: second.id, completed: true });

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    const body: ListTodosResponse = await response.json();
    expect(body).toEqual({
      todos: [
        {
          id: first.id,
          title: "牛乳を買う",
          completed: false,
          createdAt: first.createdAt.toISOString(),
        },
        {
          id: second.id,
          title: "卵を買う",
          completed: true,
          createdAt: second.createdAt.toISOString(),
        },
      ],
    });
  });
});
