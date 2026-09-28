// @vitest-environment node
import { describe, expect, test } from "vitest";
import { UpdateTodoCommand } from "@/backend/todo/application/update-todo.command";
import { Todo } from "@/backend/todo/domain/todo";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";

async function setup() {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.save(todo);
  return { repository, todo, command: new UpdateTodoCommand(repository) };
}

describe("UpdateTodoCommand", () => {
  test("title だけ指定すると title だけ変わり、保存される", async () => {
    const { repository, todo, command } = await setup();

    const updated = await command.execute({ id: todo.id, title: "卵を買う" });

    expect(updated).toMatchObject({
      id: todo.id,
      title: "卵を買う",
      completed: false,
    });
    await expect(repository.findById(todo.id)).resolves.toEqual(updated);
  });

  test("completed だけ指定すると completed だけ変わり、保存される", async () => {
    const { repository, todo, command } = await setup();

    const updated = await command.execute({ id: todo.id, completed: true });

    expect(updated).toMatchObject({ title: "牛乳を買う", completed: true });
    await expect(repository.findById(todo.id)).resolves.toEqual(updated);
  });

  test("title と completed を同時に変えられる", async () => {
    const { todo, command } = await setup();

    const updated = await command.execute({
      id: todo.id,
      title: "卵を買う",
      completed: true,
    });

    expect(updated).toMatchObject({ title: "卵を買う", completed: true });
  });

  test("無い id なら、その id を示す message 付きの DomainError(not_found) を投げる", async () => {
    const { command } = await setup();

    await expect(
      command.execute({ id: "missing", completed: true }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Todo（id: missing）が見つかりません",
    });
  });

  test("title が不変条件を満たさなければ validation_error を投げ、保存済みの Todo は変わらない", async () => {
    const { repository, todo, command } = await setup();

    await expect(
      command.execute({ id: todo.id, title: " ", completed: true }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });
});
