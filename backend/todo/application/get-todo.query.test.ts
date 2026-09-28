// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "@/backend/shared/domain/domain-error";
import { GetTodoQuery } from "@/backend/todo/application/get-todo.query";
import { Todo } from "@/backend/todo/domain/todo";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";

describe("GetTodoQuery", () => {
  test("id に一致する Todo を返す", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    await expect(
      new GetTodoQuery(repository).execute(todo.id),
    ).resolves.toEqual(todo);
  });

  test("無ければ DomainError(not_found) を投げる", async () => {
    const query = new GetTodoQuery(new InMemoryTodoRepository());

    await expect(query.execute("missing")).rejects.toBeInstanceOf(DomainError);
    await expect(query.execute("missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
