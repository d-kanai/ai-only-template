// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "../../../../shared/domain/domain-error";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import { inMemoryTransaction } from "../../../../test-support/transaction-runner.in-memory";
import { Todo } from "../domain/todo";
import { GetTodoQuery } from "./get-todo.query";

describe("GetTodoQuery", () => {
  test("id に一致する Todo を返す", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, inMemoryTransaction);

    await expect(
      new GetTodoQuery(repository).execute(todo.id),
    ).resolves.toEqual(todo);
  });

  test("無ければ、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const query = new GetTodoQuery(new InMemoryTodoRepository());

    await expect(query.execute("missing")).rejects.toBeInstanceOf(DomainError);
    await expect(query.execute("missing")).rejects.toMatchObject({
      code: "not_found",
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });
});
