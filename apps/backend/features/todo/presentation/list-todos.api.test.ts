// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ErrorResponse } from "../../../shared/presentation/http-error";
import type { TodoRepository } from "../domain/todo-repository";
import {
  createInMemoryTodoContainer,
  createTodoContainer,
} from "../infra/container";
import { type ListTodosResponse, listTodosApi } from "./list-todos.api";

// テストごとに空のリポジトリで組み立てる（アプリ共有のコンテナを使うとテストの順序で結果が変わるため）。
function setup() {
  const container = createInMemoryTodoContainer();
  return { container, GET: listTodosApi(container) };
}

// 想定外の例外（DB の接続断など）を再現するため、一覧の取得が必ず失敗するリポジトリ。
// InMemory の実装は失敗しないので、500 の経路はこのスタブでしか通せない。
function failingRepository(error: Error): TodoRepository {
  return {
    findAll: () => Promise.reject(error),
    findById: () => Promise.reject(error),
    save: () => Promise.reject(error),
    delete: () => Promise.reject(error),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function listRequest(): Request {
  return new Request("http://localhost/api/todos");
}

describe("GET /api/todos", () => {
  test("Todo が無ければ 200 と空の一覧を返す", async () => {
    const { GET } = setup();

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as ListTodosResponse;
    expect(body).toEqual({ todos: [] });
  });

  test("作成した Todo を TodoDto の形で、作成した順（作成日時の昇順）に返す", async () => {
    const { container, GET } = setup();
    const first = await container.createTodo.execute({ title: "牛乳を買う" });
    const second = await container.createTodo.execute({ title: "卵を買う" });
    await container.updateTodo.execute({ id: second.id, completed: true });

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as ListTodosResponse;
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

  test("一覧の取得で想定外の例外が起きたら、500 と内部の情報を含まない internal_error を返し、例外をログに残す", async () => {
    // toErrorResponse が想定外の例外を logger.error（中で console.error）に出す。テストの出力を汚さないよう抑制し、
    //   例外の name と message が 1 行に入ったことだけを確かめる（行の形は logger.test.ts で固定している）。
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const cause = new Error("connection refused: db.internal:5432");
    // InMemory の runner はスナップショットを取れるリポジトリが要るので、失敗するリポジトリはそのまま渡す runner で組み立てる。
    const repository = failingRepository(cause);
    const GET = listTodosApi(
      createTodoContainer({
        runner: { run: (fn) => fn(repository) },
        repositoryFor: (executor: TodoRepository) => executor,
        readExecutor: repository,
      }),
    );

    const response = await GET(listRequest());

    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "サーバでエラーが発生しました",
      },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      error: { name: "Error", message: "connection refused: db.internal:5432" },
    });
  });
});
