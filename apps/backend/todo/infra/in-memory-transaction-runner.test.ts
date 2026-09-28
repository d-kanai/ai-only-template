// @vitest-environment node
import { describe, expect, test } from "vitest";
import { Todo } from "../domain/todo";
import { InMemoryTransactionRunner } from "./in-memory-transaction-runner";
import { InMemoryTodoRepository } from "./todo-repository.in-memory";

// テストから任意のタイミングで resolve できる Promise（rules/code/test.md の「テストダブル」）。
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("InMemoryTransactionRunner", () => {
  test("fn にリポジトリを渡し、fn の戻り値をそのまま返す", async () => {
    const repository = new InMemoryTodoRepository();
    const runner = new InMemoryTransactionRunner(repository);

    const result = await runner.run(async (tx) => {
      expect(tx).toBe(repository);
      return "done";
    });

    expect(result).toBe("done");
  });

  test("fn が正常に終わると、fn の中で保存した Todo が残る（commit）", async () => {
    const repository = new InMemoryTodoRepository();
    const runner = new InMemoryTransactionRunner(repository);
    const todo = Todo.create("牛乳を買う");

    await runner.run((tx) => tx.save(todo));

    await expect(repository.findAll()).resolves.toEqual([todo]);
  });

  test("fn が例外を投げると、fn の中の変更を取り消して（rollback）同じ例外を投げ直す", async () => {
    const repository = new InMemoryTodoRepository();
    const existing = Todo.create("牛乳を買う");
    await repository.save(existing);
    const runner = new InMemoryTransactionRunner(repository);
    const error = new Error("途中で失敗");

    await expect(
      runner.run(async (tx) => {
        await tx.save(existing.rename("卵を買う"));
        await tx.save(Todo.create("パンを買う"));
        throw error;
      }),
    ).rejects.toBe(error);

    await expect(repository.findAll()).resolves.toEqual([existing]);
  });

  test("前の run が終わるまで次の run の fn を始めない（失敗した run の rollback が、並行して commit した変更を消さない）", async () => {
    const repository = new InMemoryTodoRepository();
    const runner = new InMemoryTransactionRunner(repository);
    const gate = deferred<void>();
    const committed = Todo.create("卵を買う");
    let secondStarted = false;

    const first = runner.run(async (tx) => {
      await tx.save(Todo.create("牛乳を買う"));
      await gate.promise;
      throw new Error("途中で失敗");
    });
    const second = runner.run(async (tx) => {
      secondStarted = true;
      await tx.save(committed);
    });
    // first の fn が止まっている間は、second の fn は始まらない。
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    gate.resolve();
    await expect(first).rejects.toEqual(new Error("途中で失敗"));
    await second;

    expect(secondStarted).toBe(true);
    await expect(repository.findAll()).resolves.toEqual([committed]);
  });

  test("前の run が失敗しても、次の run は実行される", async () => {
    const repository = new InMemoryTodoRepository();
    const runner = new InMemoryTransactionRunner(repository);

    await expect(
      runner.run(async () => {
        throw new Error("失敗");
      }),
    ).rejects.toEqual(new Error("失敗"));

    await expect(runner.run(async () => "next")).resolves.toBe("next");
  });
});
