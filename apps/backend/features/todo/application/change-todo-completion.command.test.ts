// @vitest-environment node
import { describe, expect, test } from "vitest";
import { Todo } from "../domain/todo";
import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";
import { ChangeTodoCompletionCommand } from "./change-todo-completion.command";

async function setup() {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.save(todo);
  return {
    repository,
    todo,
    command: new ChangeTodoCompletionCommand(repository),
  };
}

describe("ChangeTodoCompletionCommand", () => {
  test("completed を true にして保存し、変えた Todo を返す（title はそのまま）", async () => {
    const { repository, todo, command } = await setup();

    const changed = await command.execute({ id: todo.id, completed: true });

    expect(changed).toMatchObject({
      id: todo.id,
      title: "牛乳を買う",
      completed: true,
    });
    await expect(repository.findById(todo.id)).resolves.toEqual(changed);
  });

  // WHY false に戻す場合も見る: 引数を無視して常に true にする実装を通さないため。
  test("完了済みの Todo の completed を false に戻して保存する", async () => {
    const { repository, todo, command } = await setup();
    await command.execute({ id: todo.id, completed: true });

    const changed = await command.execute({ id: todo.id, completed: false });

    expect(changed).toMatchObject({ id: todo.id, completed: false });
    await expect(repository.findById(todo.id)).resolves.toEqual(changed);
  });

  test("無い id なら、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const { command } = await setup();

    await expect(
      command.execute({ id: "missing", completed: true }),
    ).rejects.toMatchObject({
      code: "not_found",
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });
});
