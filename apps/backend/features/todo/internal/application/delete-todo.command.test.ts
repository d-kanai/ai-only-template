// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import type { TransactionRunner } from "../../../../shared/application/transaction";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "../../../../test-support/transaction-runner.in-memory";
import { Todo } from "../domain/todo";
import { DeleteTodoCommand } from "./delete-todo.command";

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
  return { repository, todo };
}

describe("DeleteTodoCommand", () => {
  test("id に一致する Todo を削除する", async () => {
    const { repository, todo } = await setup();

    await new DeleteTodoCommand(
      repository,
      new InMemoryTransactionRunner(),
    ).execute(todo.id);

    await expect(repository.findById(todo.id)).resolves.toBeUndefined();
  });

  // WHY 読み込み（行ロック）と削除を同じ tx で行う（Issue #215）: 確かめてから消すまでの間に、別の要求がその Todo を変えられない。
  test("findByIdOrThrow と delete を、runner の run が渡した同じ tx で、run の中（COMMIT の前）で行う", async () => {
    const { repository, todo } = await setup();
    const events: string[] = [];
    const find = vi
      .spyOn(repository, "findByIdOrThrow")
      .mockImplementation(async () => {
        events.push("findByIdOrThrow");
        return todo;
      });
    const remove = vi
      .spyOn(repository, "delete")
      .mockImplementation(async () => {
        events.push("delete");
      });

    await new DeleteTodoCommand(repository, committingRunner(events)).execute(
      todo.id,
    );

    expect(find.mock.calls).toEqual([[todo.id, inMemoryTransaction]]);
    expect(remove.mock.calls).toEqual([[todo.id, inMemoryTransaction]]);
    expect(events).toEqual(["findByIdOrThrow", "delete", "commit"]);
  });

  test("無い id なら、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const command = new DeleteTodoCommand(
      new InMemoryTodoRepository(),
      new InMemoryTransactionRunner(),
    );

    await expect(command.execute("missing")).rejects.toMatchObject({
      code: "not_found",
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });
});
