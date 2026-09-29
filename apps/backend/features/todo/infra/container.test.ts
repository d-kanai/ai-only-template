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
import type { TransactionRunner } from "../../../shared/domain/transaction-runner";
import { closeDatabase } from "../../../shared/infra/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../shared/infra/database.test-support";
import { Todo } from "../domain/todo";
import {
  createInMemoryTodoContainer,
  createPostgresTodoContainer,
  createTodoContainer,
  todoContainer,
} from "./container";
import { InMemoryTodoRepository } from "./todo-repository.in-memory";
import { PostgresTodoRepository } from "./todo-repository.postgres";

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
    await container.updateTodo.execute({ id: todo.id, completed: true });
    expect(run).toHaveBeenCalledTimes(2);
    await container.deleteTodo.execute(todo.id);
    expect(run).toHaveBeenCalledTimes(3);

    // 呼び出しを丸ごと比べる: 組み立て時の読み取り用 1 回と、command ごとに tx で 1 回ずつ。
    //   最後の呼び出しだけを見ると、ある command が tx 以外（readExecutor）でリポジトリを作っても見逃す。
    expect(repositoryFor.mock.calls).toEqual([
      ["read"],
      ["tx"],
      ["tx"],
      ["tx"],
    ]);
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

  // save / delete の後で失敗させ、「書き込みはしたが command は失敗した」状態を作る。
  function failAfterWrite(repository: InMemoryTodoRepository) {
    const originalSave = repository.save.bind(repository);
    const originalDelete = repository.delete.bind(repository);
    vi.spyOn(repository, "save").mockImplementation(async (value) => {
      await originalSave(value);
      throw new Error("書き込みの後で失敗");
    });
    vi.spyOn(repository, "delete").mockImplementation(async (id) => {
      await originalDelete(id);
      throw new Error("書き込みの後で失敗");
    });
  }

  test("作成の command が保存の後で失敗すると、作った Todo は残らない（InMemory でも rollback する）", async () => {
    const repository = new InMemoryTodoRepository();
    failAfterWrite(repository);
    const container = createInMemoryTodoContainer(repository);

    await expect(
      container.createTodo.execute({ title: "牛乳を買う" }),
    ).rejects.toEqual(new Error("書き込みの後で失敗"));

    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("更新の command が保存の後で失敗すると、更新前の Todo のまま残る（InMemory でも rollback する）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    failAfterWrite(repository);
    const container = createInMemoryTodoContainer(repository);

    await expect(
      container.updateTodo.execute({ id: todo.id, title: "卵を買う" }),
    ).rejects.toEqual(new Error("書き込みの後で失敗"));

    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });

  test("削除の command が削除の後で失敗すると、Todo は消えずに残る（InMemory でも rollback する）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    failAfterWrite(repository);
    const container = createInMemoryTodoContainer(repository);

    await expect(container.deleteTodo.execute(todo.id)).rejects.toEqual(
      new Error("書き込みの後で失敗"),
    );

    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });
});

describe("todoContainer（アプリ共有のコンテナ）", () => {
  test("常に Postgres のリポジトリで組み立てる（DATABASE_URL が無いときに InMemory へ切り替えない）", async () => {
    const findAll = vi
      .spyOn(PostgresTodoRepository.prototype, "findAll")
      .mockResolvedValue([]);

    // findAll を差し替えているので接続はしない。
    await expect(todoContainer.listTodos.execute()).resolves.toEqual([]);
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

  // save / delete の後で失敗させ、「書き込みはしたが command は失敗した」状態を作る。
  function failAfterWrite() {
    const originalSave = PostgresTodoRepository.prototype.save;
    const originalDelete = PostgresTodoRepository.prototype.delete;
    vi.spyOn(PostgresTodoRepository.prototype, "save").mockImplementation(
      async function (this: PostgresTodoRepository, value) {
        await originalSave.call(this, value);
        throw new Error("書き込みの後で失敗");
      },
    );
    vi.spyOn(PostgresTodoRepository.prototype, "delete").mockImplementation(
      async function (this: PostgresTodoRepository, id) {
        await originalDelete.call(this, id);
        throw new Error("書き込みの後で失敗");
      },
    );
  }

  test("作成の command が保存の後で失敗すると、作った Todo は DB に残らない（rollback）", async () => {
    const container = createPostgresTodoContainer(database.db);
    const before = await container.listTodos.execute();
    failAfterWrite();

    await expect(
      container.createTodo.execute({ title: "rollback される作成" }),
    ).rejects.toEqual(new Error("書き込みの後で失敗"));

    vi.restoreAllMocks();
    await expect(container.listTodos.execute()).resolves.toEqual(before);
  });

  test("更新の command が保存の後で失敗すると、DB は更新前の Todo のまま（rollback）", async () => {
    const container = createPostgresTodoContainer(database.db);
    const todo = await container.createTodo.execute({ title: "牛乳を買う" });
    failAfterWrite();

    await expect(
      container.updateTodo.execute({ id: todo.id, title: "卵を買う" }),
    ).rejects.toEqual(new Error("書き込みの後で失敗"));

    vi.restoreAllMocks();
    await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
  });

  test("削除の command が削除の後で失敗すると、Todo は DB から消えずに残る（rollback）", async () => {
    const container = createPostgresTodoContainer(database.db);
    const todo = await container.createTodo.execute({ title: "牛乳を買う" });
    failAfterWrite();

    await expect(container.deleteTodo.execute(todo.id)).rejects.toEqual(
      new Error("書き込みの後で失敗"),
    );

    vi.restoreAllMocks();
    await expect(container.getTodo.execute(todo.id)).resolves.toEqual(todo);
  });
});
