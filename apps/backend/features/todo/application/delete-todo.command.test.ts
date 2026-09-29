// @vitest-environment node
import { describe, expect, test } from "vitest";
import { Todo } from "../domain/todo";
import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";
import { DeleteTodoCommand } from "./delete-todo.command";

describe("DeleteTodoCommand", () => {
  test("id に一致する Todo を削除する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    await new DeleteTodoCommand(repository).execute(todo.id);

    await expect(repository.findById(todo.id)).resolves.toBeUndefined();
  });

  test("無い id なら、その id を示す message 付きの DomainError(not_found) を投げる", async () => {
    const command = new DeleteTodoCommand(new InMemoryTodoRepository());

    await expect(command.execute("missing")).rejects.toMatchObject({
      code: "not_found",
      message: "Todo（id: missing）が見つかりません",
    });
  });
});
