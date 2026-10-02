// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import { inMemoryTransaction } from "../../../../test-support/transaction-runner.in-memory";
import { ListTodosQuery } from "../application/list-todos.query";
import { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";
import {
  ListTodosApi,
  type ListTodosResponse,
  GET as productionGet,
} from "./list-todos.api";

// テストごとに空の InMemory のリポジトリで組み立てる（本番の GET は Postgres を使い、テストの順序で結果が変わるため）。
// handle をインスタンスから取り出して呼ぶ: 本番（`export const GET = new ListTodosApi(...).handle`）と同じ渡し方にし、
//   this が外れても動くこと（handle がアロー関数のプロパティであること）も確かめる。
function setup() {
  const repository = new InMemoryTodoRepository();
  return {
    repository,
    GET: new ListTodosApi(new ListTodosQuery(repository)).handle,
  };
}

// 想定外の例外（DB の接続断など）を再現するため、一覧の取得が必ず失敗するリポジトリ。
// InMemory の実装は失敗しないので、500 の経路はこのスタブでしか通せない。
function failingRepository(error: Error): TodoRepository {
  return {
    findAll: () => Promise.reject(error),
    findById: () => Promise.reject(error),
    findByIdForUpdate: () => Promise.reject(error),
    insert: () => Promise.reject(error),
    update: () => Promise.reject(error),
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

  // WHY 本番の GET（モジュールの最下部で組み立てたもの）を確かめる: 環境変数などで InMemory に切り替える分岐を持たない
  //   （Issue #59）ことを、Postgres の Repository が呼ばれることで固定する。findAll を差し替えるので DB には接続しない。
  test("本番の GET は Postgres の Repository で組み立てている", async () => {
    const findAll = vi
      .spyOn(PostgresTodoRepository.prototype, "findAll")
      .mockResolvedValue([]);

    const response = await productionGet(listRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ todos: [] });
    expect(findAll).toHaveBeenCalledTimes(1);
  });

  test("作成した Todo を ListTodosResponse の形で、作成した順（作成日時の昇順）に返す", async () => {
    const { repository, GET } = setup();
    const first = Todo.create("牛乳を買う");
    const second = Todo.create("卵を買う").changeCompletion(true);
    await repository.insert(first, inMemoryTransaction);
    await repository.insert(second, inMemoryTransaction);

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

  test("一覧の取得で想定外の例外が起きたら、500 と内部の情報を含まない /problems/internal-error を返し、例外をログに残す", async () => {
    // ProblemResponse.from が想定外の例外を logger.emit（server_error。ERROR なので中で console.error）に出す。テストの出力を汚さないよう抑制し、
    //   例外の type と message が 1 行に入ったことだけを確かめる（行の形は logger.test.ts で固定している）。
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const cause = new Error("connection refused: db.internal:5432");
    const failingGet = new ListTodosApi(
      new ListTodosQuery(failingRepository(cause)),
    ).handle;

    const response = await failingGet(listRequest());

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    // RFC 9457 の Problem Details。detail は固定の英語で、例外の message（接続先など内部の情報）を含めない。
    await expect(response.json()).resolves.toStrictEqual({
      type: "/problems/internal-error",
      title: "Internal error",
      status: 500,
      detail: "Internal server error.",
      instance: "/api/todos",
      key: "server.internalError",
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toMatchObject({
      severity: "ERROR",
      event: { name: "server_error" },
      error: { type: "Error", message: "connection refused: db.internal:5432" },
    });
  });
});
