// @vitest-environment node
import { describe, expect, test } from "vitest";
import { InMemoryTodoRepository } from "../../../test-support/todo/todo-repository.in-memory";
import { Todo } from "../domain/todo";
import { RenameTodoCommand } from "./rename-todo.command";

async function setup() {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.save(todo);
  return { repository, todo, command: new RenameTodoCommand(repository) };
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
