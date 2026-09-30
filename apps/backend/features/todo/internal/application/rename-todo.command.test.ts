// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import type { TransactionRunner } from "../../../../shared/application/transaction";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "../../../../test-support/transaction-runner.in-memory";
import { Todo } from "../domain/todo";
import { RenameTodoCommand } from "./rename-todo.command";

// run の work が終わった（COMMIT した）ことを events に記録する runner（create-todo.command.test.ts と同じ）。
function committingRunner(events: string[]): TransactionRunner {
  return {
    async run(work) {
      const result = await work(inMemoryTransaction);
      events.push("commit");
      return result;
    },
  };
}

async function setup() {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.insert(todo, inMemoryTransaction);
  return {
    repository,
    todo,
    command: new RenameTodoCommand(repository, new InMemoryTransactionRunner()),
  };
}

describe("RenameTodoCommand", () => {
  test("title を変えて保存し、変えた Todo を返す（completed はそのまま）", async () => {
    const { repository, todo, command } = await setup();

    const renamed = await command.execute({ id: todo.id, title: "卵を買う" });

    expect(renamed).toMatchObject({
      id: todo.id,
      title: "卵を買う",
      completed: false,
    });
    await expect(repository.findById(todo.id)).resolves.toEqual(renamed);
  });

  // WHY 読み込み（行ロック）と書き込みを同じ tx で行う（Issue #215）: 読んでから書くまでの間に、別の要求が同じ Todo を変えられない。
  test("findByIdOrThrow と update を、runner の run が渡した同じ tx で、run の中（COMMIT の前）で行う", async () => {
    const { repository, todo } = await setup();
    const events: string[] = [];
    const loaded = (await repository.findById(todo.id)) as Todo;
    const find = vi
      .spyOn(repository, "findByIdOrThrow")
      .mockImplementation(async () => {
        events.push("findByIdOrThrow");
        return loaded;
      });
    const update = vi
      .spyOn(repository, "update")
      .mockImplementation(async () => {
        events.push("update");
      });

    const renamed = await new RenameTodoCommand(
      repository,
      committingRunner(events),
    ).execute({ id: todo.id, title: "卵を買う" });

    expect(find.mock.calls).toEqual([[todo.id, inMemoryTransaction]]);
    expect(update.mock.calls).toEqual([[renamed, inMemoryTransaction]]);
    expect(events).toEqual(["findByIdOrThrow", "update", "commit"]);
  });

  test("無い id なら、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const { command } = await setup();

    await expect(
      command.execute({ id: "missing", title: "卵を買う" }),
    ).rejects.toMatchObject({
      code: "not_found",
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });

  test("title が不変条件を満たさなければ validation_error を投げ、保存済みの Todo は変わらない", async () => {
    const { repository, todo, command } = await setup();

    await expect(
      command.execute({ id: todo.id, title: " " }),
    ).rejects.toMatchObject({
      code: "validation_error",
      key: "todo.title.empty",
      params: undefined,
    });
    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });
});
