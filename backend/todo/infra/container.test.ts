// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { TransactionRunner } from "@/backend/shared/domain/transaction-runner";
import { closeDatabase } from "@/backend/shared/infra/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@/backend/shared/infra/database.test-support";
import { Todo } from "@/backend/todo/domain/todo";
import {
  createInMemoryTodoContainer,
  createPostgresTodoContainer,
  createTodoContainer,
  createTodoContainerFromEnv,
} from "@/backend/todo/infra/container";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";
import { PostgresTodoRepository } from "@/backend/todo/infra/todo-repository.postgres";

// command だけが runner を通ることを確かめるための偽の runner。
// Tx は文字列の目印にし、repositoryFor が「どの executor で」リポジトリを作ったかを記録できるようにする。
function recordingSetup() {
  const repository = new InMemoryTodoRepository();
  // run の呼び出しを数える。run 自体はジェネリックなので vi.fn にそのまま入れると型が合わず、記録用の vi.fn を別に持つ。
  const run = vi.fn();
  const runner: TransactionRunner<string> = {
    run: (fn) => {
      run();
      return fn("tx");
    },
  };
  const repositoryFor = vi.fn((_executor: string) => repository);
  const container = createTodoContainer({
    runner,
    repositoryFor,
    readExecutor: "read",
  });
  return { container, run, repositoryFor, repository };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
});

describe("createTodoContainer", () => {
  test("作成・更新・削除の command は、1 回ずつ runner.run の中で、トランザクションの executor で作ったリポジトリを使う", async () => {
    const { container, run, repositoryFor } = recordingSetup();

    const todo = await container.createTodo.execute({ title: "牛乳を買う" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(repositoryFor).toHaveBeenLastCalledWith("tx");

    await container.updateTodo.execute({ id: todo.id, completed: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(repositoryFor).toHaveBeenLastCalledWith("tx");

    await container.deleteTodo.execute(todo.id);
    expect(run).toHaveBeenCalledTimes(3);
    expect(repositoryFor).toHaveBeenLastCalledWith("tx");
  });

  test("command は結果（作った・更新した Todo）を runner.run 越しにそのまま返す", async () => {
    const { container, repository } = recordingSetup();

    const created = await container.createTodo.execute({ title: "牛乳を買う" });
    const updated = await container.updateTodo.execute({
      id: created.id,
      title: "卵を買う",
    });

    expect(created.title).toBe("牛乳を買う");
    expect(updated.title).toBe("卵を買う");
    await expect(repository.findById(created.id)).resolves.toEqual(updated);
  });

  test("一覧・1 件取得の query は runner を通らず、読み取り用の executor で作ったリポジトリを使う", async () => {
    const { container, run, repositoryFor, repository } = recordingSetup();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    await expect(container.listTodos.execute()).resolves.toEqual([todo]);
    await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);

    expect(run).not.toHaveBeenCalled();
    // 読み取り用のリポジトリは組み立てたときに 1 度だけ作り、query の間で共有する。
    expect(repositoryFor.mock.calls).toEqual([["read"]]);
  });
});

describe("createInMemoryTodoContainer", () => {
  test("渡した InMemory リポジトリに対して command / query が動く", async () => {
    const repository = new InMemoryTodoRepository();
    const container = createInMemoryTodoContainer(repository);

    const todo = await container.createTodo.execute({ title: "牛乳を買う" });

    await expect(repository.findAll()).resolves.toEqual([todo]);
    await expect(container.listTodos.execute()).resolves.toEqual([todo]);
  });

  test("リポジトリを省略すると空のリポジトリで組み立て、コンテナごとにデータを分ける", async () => {
    const first = createInMemoryTodoContainer();
    const second = createInMemoryTodoContainer();

    await first.createTodo.execute({ title: "牛乳を買う" });

    await expect(first.listTodos.execute()).resolves.toHaveLength(1);
    await expect(second.listTodos.execute()).resolves.toEqual([]);
  });

  test("command が途中で失敗すると、その command の変更は残らない（InMemory でも rollback する）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    // save の後で失敗させ、「保存はしたが command は失敗した」状態を作る。
    const originalSave = repository.save.bind(repository);
    vi.spyOn(repository, "save").mockImplementation(async (value) => {
      await originalSave(value);
      throw new Error("保存の後で失敗");
    });
    const container = createInMemoryTodoContainer(repository);

    await expect(
      container.updateTodo.execute({ id: todo.id, title: "卵を買う" }),
    ).rejects.toThrow("保存の後で失敗");

    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });
});

describe("createTodoContainerFromEnv", () => {
  test("DATABASE_URL が無ければ InMemory で組み立てる（DB を起動していなくても画面を触れる）", async () => {
    const container = createTodoContainerFromEnv({});

    const todo = await container.createTodo.execute({ title: "牛乳を買う" });

    await expect(container.listTodos.execute()).resolves.toEqual([todo]);
  });

  test("DATABASE_URL が空文字でも InMemory で組み立てる", async () => {
    const container = createTodoContainerFromEnv({ DATABASE_URL: "" });

    await expect(container.listTodos.execute()).resolves.toEqual([]);
  });

  test("DATABASE_URL があれば Postgres のリポジトリで組み立てる", async () => {
    const findAll = vi
      .spyOn(PostgresTodoRepository.prototype, "findAll")
      .mockResolvedValue([]);
    const container = createTodoContainerFromEnv({
      // 接続はしない（findAll を差し替えている）。プールは作るだけなら接続しない（node-postgres の Pool は最初のクエリで接続する）。
      DATABASE_URL: "postgresql://app:app@localhost:5432/app",
    });

    await expect(container.listTodos.execute()).resolves.toEqual([]);
    expect(findAll).toHaveBeenCalledTimes(1);
  });
});

// 実 Postgres（compose.yaml）に対して、組み立てた command がトランザクションで包まれていることを確かめる。
describe("createPostgresTodoContainer", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.migrate();
  });

  afterAll(async () => {
    await database.close();
  });

  test("command で保存した Todo を query で読める", async () => {
    const container = createPostgresTodoContainer(database.db);

    const todo = await container.createTodo.execute({ title: "牛乳を買う" });

    await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
  });

  test("command が保存の後で失敗すると、保存した変更は DB に残らない（rollback）", async () => {
    const container = createPostgresTodoContainer(database.db);
    const todo = await container.createTodo.execute({ title: "牛乳を買う" });
    const originalSave = PostgresTodoRepository.prototype.save;
    vi.spyOn(PostgresTodoRepository.prototype, "save").mockImplementation(
      async function (this: PostgresTodoRepository, value) {
        await originalSave.call(this, value);
        throw new Error("保存の後で失敗");
      },
    );

    await expect(
      container.updateTodo.execute({ id: todo.id, title: "卵を買う" }),
    ).rejects.toThrow("保存の後で失敗");

    vi.restoreAllMocks();
    await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
  });
});
