// @vitest-environment node
import { describe, expect, test } from "vitest";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import { inMemoryTransaction } from "../../../../test-support/transaction-runner.in-memory";
import { Todo } from "../domain/todo";
import { ListTodosQuery } from "./list-todos.query";

describe("ListTodosQuery", () => {
  test("Todo が無ければ空配列を返す", async () => {
    // given
    const query = new ListTodosQuery(new InMemoryTodoRepository());

    // when
    const todos = query.execute();

    // then
    await expect(todos).resolves.toEqual([]);
  });

  // WHY 並び順をここで確かめない: 並び順（作成日時の昇順、同じなら id の昇順）は Repository の findAll の契約で、
  //   Postgres と InMemory の両方のテストが同じ名前で固定する（todo-repository.*.test.ts）。query は取り出すだけ。
  test("Repository の findAll が返した Todo をそのまま返す", async () => {
    // given
    const repository = new InMemoryTodoRepository();
    const first = Todo.create("牛乳を買う");
    const second = Todo.create("卵を買う");
    await repository.insert(first, inMemoryTransaction);
    await repository.insert(second, inMemoryTransaction);

    // when
    const todos = await new ListTodosQuery(repository).execute();

    // then
    await expect(repository.findAll()).resolves.toEqual(todos);
    expect(todos.map((todo) => todo.title)).toEqual(["牛乳を買う", "卵を買う"]);
  });
});
