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

  // ここから下の save のテストは todo-repository.postgres.test.ts と同じ契約で、同じテスト名にそろえる（Issue #165）。
  //   InMemory は application のテストで Postgres の代わりに使うので、同時更新・削除との競合でも同じ結果になることを確かめる。
  test("同じ Todo を 2 回読み、片方で完了にして save、もう片方で名前を変えて save すると、両方の変更が残る（別の列の同時更新を巻き戻さない）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const a = await repository.findByIdOrThrow(todo.id);
    const b = await repository.findByIdOrThrow(todo.id);

    await repository.save(a.changeCompletion(true));
    await repository.save(b.rename("x"));

    const saved = await repository.findByIdOrThrow(todo.id);
    expect({ title: saved.title, completed: saved.completed }).toEqual({
      title: "x",
      completed: true,
    });
  });

  test("同じ Todo を 2 回読み、両方で名前を変えて save すると、後から save した名前が残る（同じ列の同時更新は後勝ち）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const a = await repository.findByIdOrThrow(todo.id);
    const b = await repository.findByIdOrThrow(todo.id);

    await repository.save(b.rename("y"));
    await repository.save(a.rename("z"));

    await expect(repository.findByIdOrThrow(todo.id)).resolves.toMatchObject({
      title: "z",
    });
  });

  // 後勝ちの例外: 読み込んだときと同じ値に戻す変更は差分が無いので書かれない（version 列は入れない。ユーザー判断）。
  test("同じ Todo を 2 回読み、片方が名前を変えて save した後、もう片方が読み込んだときの名前に戻して save しても書かれず、先の変更が残る", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("x");
    await repository.save(todo);
    const a = await repository.findByIdOrThrow(todo.id);
    const b = await repository.findByIdOrThrow(todo.id);

    await repository.save(b.rename("y"));
    await repository.save(a.rename("y").rename("x"));

    await expect(repository.findByIdOrThrow(todo.id)).resolves.toMatchObject({
      title: "y",
    });
  });

  test("読み込んだ Todo を変えずに save しても、その間に別の save が書いた値を巻き戻さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const a = await repository.findByIdOrThrow(todo.id);
    const b = await repository.findByIdOrThrow(todo.id);

    await repository.save(a.rename("卵を買う").changeCompletion(true));
    await repository.save(b);

    const saved = await repository.findByIdOrThrow(todo.id);
    expect({ title: saved.title, completed: saved.completed }).toEqual({
      title: "卵を買う",
      completed: true,
    });
  });

  test("読み込んだ後に delete された Todo を変えて save すると、その id を params に持つ DomainError(not_found, todo.notFound) を投げ、Todo を戻さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const loaded = await repository.findByIdOrThrow(todo.id);
    await repository.delete(todo.id);

    await expect(repository.save(loaded.rename("卵を買う"))).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: todo.id }),
    );
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  // 変わった列が無ければ何も書かない（Postgres は SQL を発行しない）ので、消されたことにも気づかない。
  test("読み込んだ後に delete された Todo を変えずに save すると、何もしない（エラーにせず、Todo を戻さない）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const loaded = await repository.findByIdOrThrow(todo.id);
    await repository.delete(todo.id);

    await repository.save(loaded);

    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("新規の Todo（create したもの）を 2 回 save しても 1 件だけ保持する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await repository.save(todo);
    await repository.save(todo);

    await expect(repository.findAll()).resolves.toEqual([todo]);
  });

  // WHY: 読み込んだ Todo が origin を持たないと、save が新規として全体を上書きし、上の同時更新のテストの意味が無くなる。
  test("findById・findByIdOrThrow・findAll が返す Todo は、読み込んだときの値を origin に持つ", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await repository.save(todo);
    const values = {
      id: todo.id,
      title: "牛乳を買う",
      completed: true,
      createdAt: todo.createdAt,
    };

    expect((await repository.findById(todo.id))?.origin).toStrictEqual(values);
    expect((await repository.findByIdOrThrow(todo.id)).origin).toStrictEqual(
      values,
    );
    expect((await repository.findAll())[0]?.origin).toStrictEqual(values);
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
