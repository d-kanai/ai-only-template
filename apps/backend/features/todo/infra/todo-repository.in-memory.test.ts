// @vitest-environment node
import { now } from "@repo/shared/now";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DomainError } from "../../../shared/domain/domain-error";
import { Todo } from "../domain/todo";
import { InMemoryTodoRepository } from "./todo-repository.in-memory";

// WHY 時計（now）を差し替える: 並び順のテストで作成日時を決めるため（Todo.create は now() から作成日時を入れる）。
//   ほかのテストは実時刻のままでよいので spy: true で本物を残し、時刻を決めるテストだけ mockReturnValueOnce する。
vi.mock("@repo/shared/now", { spy: true });

afterEach(() => {
  vi.mocked(now).mockReset();
});

// 作成日時を指定して Todo を作る（now() が次に返す時刻を決めてから create する）。
function createTodoAt(title: string, createdAt: string): Todo {
  vi.mocked(now).mockReturnValueOnce(new Date(createdAt));
  return Todo.create(title);
}

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

  // 並び順は Repository の契約（todo-repository.ts の findAll）。Postgres のテストと同じ名前で固定する。
  test("findAll は作成日時の昇順で返す（保存した順・id の順によらない）", async () => {
    const repository = new InMemoryTodoRepository();
    const newer = createTodoAt("新しい", "2026-09-28T10:00:00.000Z");
    const older = createTodoAt("古い", "2026-09-28T09:00:00.000Z");
    const middle = createTodoAt("真ん中", "2026-09-28T09:30:00.000Z");
    // わざと新しい方から保存し、保存順ではなく作成日時で並ぶことを確かめる。
    await repository.save(newer);
    await repository.save(older);
    await repository.save(middle);

    const todos = await repository.findAll();

    expect(todos.map((todo) => todo.title)).toEqual([
      "古い",
      "真ん中",
      "新しい",
    ]);
  });

  test("作成日時が同じ Todo は id の昇順で返す（保存した順によらず、毎回同じ順になる）", async () => {
    const repository = new InMemoryTodoRepository();
    const createdAt = "2026-09-28T09:00:00.000Z";
    const a = createTodoAt("a", createdAt);
    const b = createTodoAt("b", createdAt);
    // id は randomUUID で決まるので、大小を見てから両方の順で保存し、どちらでも id の順に並ぶことを確かめる
    //   （片方の順だけだと、常に -1 を返す比較でも保存順のまま通ってしまう）。
    const [smaller, larger] = a.id < b.id ? [a, b] : [b, a];
    await repository.save(larger);
    await repository.save(smaller);
    const reversed = new InMemoryTodoRepository();
    await reversed.save(smaller);
    await reversed.save(larger);

    const todos = await repository.findAll();
    const todosReversed = await reversed.findAll();

    expect(todos.map((todo) => todo.id)).toEqual([smaller.id, larger.id]);
    expect(todosReversed.map((todo) => todo.id)).toEqual([
      smaller.id,
      larger.id,
    ]);
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

  // WHY 読み込んでから変える: create した Todo（新規）を変えて save し直すと新規の 2 回目（エラー）になる。
  //   本番の rename / change-todo-completion の command と同じく、findByIdOrThrow で読み込んだ Todo（origin を持つ）を変えて save する。
  test("読み込んだ Todo を変えて save すると上書きされ、行は増えない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    const renamed = (await repository.findByIdOrThrow(todo.id)).rename(
      "卵を買う",
    );
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

  // Postgres の一意制約違反と同じ契約（2 回目はエラー、行は増えない）。
  test("新規の Todo（create したもの）を 2 回 save すると、2 回目はエラーになり行は 1 件のまま", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await repository.save(todo);
    const second = repository.save(todo);

    await expect(second).rejects.toBeInstanceOf(Error);
    await expect(second).rejects.toMatchObject({
      message: `todo already exists: ${todo.id}`,
    });
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
