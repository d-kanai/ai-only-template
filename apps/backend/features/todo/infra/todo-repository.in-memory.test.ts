// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "../../../shared/domain/domain-error";
import { Todo } from "../domain/todo";
import { InMemoryTodoRepository } from "./todo-repository.in-memory";

describe("InMemoryTodoRepository", () => {
  test("空の状態では findAll が空配列を返す", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("save した Todo を findById / findAll で取り出せる", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await repository.save(todo);

    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
    await expect(repository.findAll()).resolves.toEqual([todo]);
  });

  test("無い id の findById は undefined を返す", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(repository.findById("missing")).resolves.toBeUndefined();
  });

  test("findByIdOrThrow は id に一致する Todo を返す", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    await expect(repository.findByIdOrThrow(todo.id)).resolves.toEqual(todo);
  });

  test("無い id の findByIdOrThrow は、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(repository.findByIdOrThrow("missing")).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: "missing" }),
    );
  });

  test("同じ id で save すると上書きする", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    const renamed = todo.rename("卵を買う");
    await repository.save(renamed);

    await expect(repository.findAll()).resolves.toEqual([renamed]);
  });

  test("delete すると取り出せなくなる。無い id の delete は何もしない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    await repository.delete(todo.id);
    await repository.delete("missing");

    await expect(repository.findById(todo.id)).resolves.toBeUndefined();
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("インスタンスごとに別のデータを持つ（テスト同士が干渉しない）", async () => {
    const first = new InMemoryTodoRepository();
    const second = new InMemoryTodoRepository();

    await first.save(Todo.create("牛乳を買う"));

    await expect(second.findAll()).resolves.toEqual([]);
  });

  test("findAll が返した配列を書き換えても、保持しているデータは変わらない", async () => {
    const repository = new InMemoryTodoRepository();
    await repository.save(Todo.create("牛乳を買う"));

    const todos = await repository.findAll();
    todos.pop();

    await expect(repository.findAll()).resolves.toHaveLength(1);
  });
});
