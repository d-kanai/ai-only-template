// @vitest-environment node
import { describe, expect, test } from "vitest";
import { CreateTodoCommand } from "@/backend/todo/application/create-todo.command";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";

describe("CreateTodoCommand", () => {
  test("未完了の Todo を作って保存し、作った Todo を返す", async () => {
    const repository = new InMemoryTodoRepository();

    const todo = await new CreateTodoCommand(repository).execute({
      title: " 牛乳を買う ",
    });

    expect(todo.title).toBe("牛乳を買う");
    expect(todo.completed).toBe(false);
    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });

  test("タイトルが不変条件を満たさなければ validation_error を投げ、何も保存しない", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(
      new CreateTodoCommand(repository).execute({ title: "" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(repository.findAll()).resolves.toEqual([]);
  });
});
