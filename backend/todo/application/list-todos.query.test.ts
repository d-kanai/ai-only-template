// @vitest-environment node
import { describe, expect, test } from "vitest";
import { ListTodosQuery } from "@/backend/todo/application/list-todos.query";
import { Todo } from "@/backend/todo/domain/todo";
import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";

describe("ListTodosQuery", () => {
  test("Todo が無ければ空配列を返す", async () => {
    const query = new ListTodosQuery(new InMemoryTodoRepository());

    await expect(query.execute()).resolves.toEqual([]);
  });

  test("保存した順によらず、作成日時の昇順で返す", async () => {
    const repository = new InMemoryTodoRepository();
    const newer = Todo.create("新しい", new Date("2026-09-28T10:00:00.000Z"));
    const older = Todo.create("古い", new Date("2026-09-28T09:00:00.000Z"));
    // わざと新しい方から保存し、保存順ではなく作成日時で並ぶことを確かめる。
    await repository.save(newer);
    await repository.save(older);

    const todos = await new ListTodosQuery(repository).execute();

    expect(todos.map((todo) => todo.title)).toEqual(["古い", "新しい"]);
  });
});
