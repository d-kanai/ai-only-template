// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DeleteTodoCommand } from "@/backend/todo/application/delete-todo.command";
import { Todo } from "@/backend/todo/domain/todo";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";

describe("DeleteTodoCommand", () => {
  test("id に一致する Todo を削除する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    await new DeleteTodoCommand(repository).execute(todo.id);

    await expect(repository.findById(todo.id)).resolves.toBeUndefined();
  });

  test("無い id なら DomainError(not_found) を投げる", async () => {
    const command = new DeleteTodoCommand(new InMemoryTodoRepository());

    await expect(command.execute("missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
