// @vitest-environment node
import { describe, expect, test } from "vitest";
import { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";
import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";
import { ListTodosQuery } from "./list-todos.query";

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

  test("リポジトリが返した配列は並べ替えない（キャッシュした配列を返す実装でも中身を書き換えない）", async () => {
    const newer = Todo.create("新しい", new Date("2026-09-28T10:00:00.000Z"));
    const older = Todo.create("古い", new Date("2026-09-28T09:00:00.000Z"));
    const cached = [newer, older];
    // findAll が毎回同じ配列を返す実装を模す。InMemory は毎回新しい配列を返すので、この性質は確かめられない。
    const repository: TodoRepository = {
      findAll: async () => cached,
      findById: async () => undefined,
      save: async () => undefined,
      delete: async () => undefined,
    };

    await new ListTodosQuery(repository).execute();

    expect(cached).toEqual([newer, older]);
  });
});
