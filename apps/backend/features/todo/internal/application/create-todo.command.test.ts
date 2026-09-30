// @vitest-environment node
import { describe, expect, test } from "vitest";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import { CreateTodoCommand } from "./create-todo.command";

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

  // 変更履歴（Issue #189）は Repository の save が書く（command は意識しない）。作った Todo の行と完了の履歴の行の 2 件。
  test("作った Todo の変更履歴（todos と完了の履歴の insert の 2 件）が Repository に記録される", async () => {
    const repository = new InMemoryTodoRepository();

    const todo = await new CreateTodoCommand(repository).execute({
      title: "牛乳を買う",
    });

    expect(
      repository.changeLogs.map(({ tableName, operation, changes }) => ({
        tableName,
        operation,
        todoId: changes.todo_id?.after ?? changes.id?.after,
      })),
    ).toStrictEqual([
      { tableName: "todos", operation: "insert", todoId: todo.id },
      {
        tableName: "todo_status_changes",
        operation: "insert",
        todoId: todo.id,
      },
    ]);
  });

  test("タイトルが不変条件を満たさなければ validation_error を投げ、何も保存しない", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(
      new CreateTodoCommand(repository).execute({ title: "" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      key: "todo.title.empty",
      params: undefined,
    });
    await expect(repository.findAll()).resolves.toEqual([]);
    expect(repository.changeLogs).toEqual([]);
  });
});
