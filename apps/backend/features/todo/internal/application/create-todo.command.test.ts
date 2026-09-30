// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import type { TransactionRunner } from "../../../../shared/domain/transaction";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "../../../../test-support/transaction-runner.in-memory";
import { CreateTodoCommand } from "./create-todo.command";

// run の work が終わった（COMMIT した）ことを events に記録する runner。Repository の呼び出しが run の中（COMMIT の前）で行われた
//   ことを、events の順で確かめる。
function committingRunner(events: string[]): TransactionRunner {
  return {
    async run(work) {
      const result = await work(inMemoryTransaction);
      events.push("commit");
      return result;
    },
  };
}

describe("CreateTodoCommand", () => {
  test("未完了の Todo を作って保存し、作った Todo を返す", async () => {
    const repository = new InMemoryTodoRepository();

    const todo = await new CreateTodoCommand(
      repository,
      new InMemoryTransactionRunner(),
    ).execute({ title: " 牛乳を買う " });

    expect(todo.title).toBe("牛乳を買う");
    expect(todo.completed).toBe(false);
    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });

  // WHY command がトランザクションを張る（Issue #215）: 書き込みの範囲は command が決め、Repository は run が渡した tx で書く。
  test("Todo の insert を、runner の run が渡した tx で、run の中（COMMIT の前）で行う", async () => {
    const repository = new InMemoryTodoRepository();
    const events: string[] = [];
    const insert = vi
      .spyOn(repository, "insert")
      .mockImplementation(async () => {
        events.push("insert");
      });

    const todo = await new CreateTodoCommand(
      repository,
      committingRunner(events),
    ).execute({ title: "牛乳を買う" });

    expect(insert.mock.calls).toEqual([[todo, inMemoryTransaction]]);
    expect(events).toEqual(["insert", "commit"]);
  });

  test("タイトルが不変条件を満たさなければ validation_error を投げ、何も保存しない", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(
      new CreateTodoCommand(
        repository,
        new InMemoryTransactionRunner(),
      ).execute({ title: "" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      key: "todo.title.empty",
      params: undefined,
    });
    await expect(repository.findAll()).resolves.toEqual([]);
  });
});
