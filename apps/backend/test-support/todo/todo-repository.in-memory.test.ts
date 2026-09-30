// @vitest-environment node
import { now } from "@repo/shared/now";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Todo } from "../../features/todo/internal/domain/todo";
import { DomainError } from "../../shared/domain/domain-error";
import { inMemoryTransaction } from "../transaction-runner.in-memory";
import { InMemoryTodoRepository } from "./todo-repository.in-memory";

// WHY 時計（now）を差し替える: 並び順のテストで作成日時を決めるため（Todo.create は now() から作成日時を入れる）。
//   ほかのテストは実時刻のままでよいので spy: true で本物を残し、時刻を決めるテストだけ mockReturnValueOnce する。
vi.mock("@repo/shared/now", { spy: true });

afterEach(() => {
  vi.mocked(now).mockReset();
});

// InMemory は tx を使わない（test-support/transaction-runner.in-memory.ts）ので、どの呼び出しにも同じ inMemoryTransaction を渡す。
const tx = inMemoryTransaction;

// 作成日時を指定して Todo を作る（now() が次に返す時刻を決めてから create する）。
function createTodoAt(title: string, createdAt: string): Todo {
  vi.mocked(now).mockReturnValueOnce(new Date(createdAt));
  return Todo.create(title);
}

// ロックせずに読む（Postgres のテストの findById で読む場合と同じ。InMemory にロックは無い）。
async function read(repository: InMemoryTodoRepository, id: string) {
  return (await repository.findById(id)) as Todo;
}

describe("InMemoryTodoRepository", () => {
  test("空の状態では findAll が空配列を返す", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("insert した Todo を findById / findAll で取り出せる", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await repository.insert(todo, tx);

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
    await repository.insert(newer, tx);
    await repository.insert(older, tx);
    await repository.insert(middle, tx);

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
    await repository.insert(larger, tx);
    await repository.insert(smaller, tx);
    const reversed = new InMemoryTodoRepository();
    await reversed.insert(smaller, tx);
    await reversed.insert(larger, tx);

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
    await repository.insert(todo, tx);

    await expect(repository.findByIdOrThrow(todo.id, tx)).resolves.toEqual(
      todo,
    );
  });

  test("無い id の findByIdOrThrow は、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const repository = new InMemoryTodoRepository();

    await expect(repository.findByIdOrThrow("missing", tx)).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: "missing" }),
    );
  });

  // 本番の rename / change-todo-completion の command と同じく、findByIdOrThrow で読み込んだ Todo（origin を持つ）を変えて update する。
  test("読み込んだ Todo を変えて update すると上書きされ、行は増えない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);

    const updated = (await repository.findByIdOrThrow(todo.id, tx))
      .rename("卵を買う")
      .changeCompletion(true);
    await repository.update(updated, tx);

    await expect(repository.findAll()).resolves.toEqual([updated]);
  });

  test("delete すると取り出せなくなる。無い id の delete は何もしない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);

    await repository.delete(todo.id, tx);
    await repository.delete("missing", tx);

    await expect(repository.findById(todo.id)).resolves.toBeUndefined();
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  // ここから下の insert / update のテストは features/todo/internal/infra/todo-repository.postgres.test.ts と同じ契約で、同じテスト名に
  //   そろえる（Issue #165・#215）。InMemory は application のテストで Postgres の代わりに使うので、同じ結果になることを確かめる。
  //   InMemory にロックは無いので、「ロックせずに読む」は findById で読む（Postgres のテストと同じ）。
  test("読み込み済みの Todo（origin がある）を insert すると Error を投げ、何も書かない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const loaded = await repository.findByIdOrThrow(todo.id, tx);

    await expect(
      repository.insert(loaded.rename("卵を買う"), tx),
    ).rejects.toEqual(
      new Error(
        `insert takes a new Todo (Todo.create), but got a loaded one: ${todo.id}`,
      ),
    );
    await expect(repository.findAll()).resolves.toEqual([loaded]);
  });

  test("新規の Todo（origin が undefined）を update すると Error を投げ、何も書かない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await expect(repository.update(todo, tx)).rejects.toEqual(
      new Error(
        `update takes a loaded Todo (findByIdOrThrow), but got a new one: ${todo.id}`,
      ),
    );
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("ロックせずに同じ Todo を 2 回読み、片方で完了にして update、もう片方で名前を変えて update すると、両方の変更が残る（別の列の変更を巻き戻さない）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const a = await read(repository, todo.id);
    const b = await read(repository, todo.id);

    await repository.update(a.changeCompletion(true), tx);
    await repository.update(b.rename("x"), tx);

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      title: "x",
      completed: true,
      createdAt: todo.createdAt,
    });
  });

  test("ロックせずに同じ Todo を 2 回読み、両方で名前を変えて update すると、後から update した名前が残る（同じ列は後勝ち）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const a = await read(repository, todo.id);
    const b = await read(repository, todo.id);

    await repository.update(b.rename("y"), tx);
    await repository.update(a.rename("z"), tx);

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      title: "z",
    });
  });

  test("ロックせずに同じ Todo を 2 回読み、片方が名前を変えて update した後、もう片方が読み込んだときの名前に戻して update しても書かれず、先の変更が残る", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("x");
    await repository.insert(todo, tx);
    const a = await read(repository, todo.id);
    const b = await read(repository, todo.id);

    await repository.update(b.rename("y"), tx);
    await repository.update(a.rename("y").rename("x"), tx);

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      title: "y",
    });
  });

  test("読み込んだ Todo を変えずに update しても、その間に別の update が書いた値を巻き戻さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const a = await read(repository, todo.id);
    const b = await read(repository, todo.id);

    await repository.update(a.rename("卵を買う").changeCompletion(true), tx);
    await repository.update(b, tx);

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      title: "卵を買う",
      completed: true,
    });
  });

  // Postgres は Writer が「表と id」の message の Error を投げる（shared/infra/writer.ts）。InMemory も同じ message にする。
  test("ロックせずに読んだ後に delete された Todo を変えて update すると、Error を投げ、Todo を戻さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const loaded = await read(repository, todo.id);
    await repository.delete(todo.id, tx);

    await expect(
      repository.update(loaded.rename("卵を買う"), tx),
    ).rejects.toEqual(new Error(`todos has no row to update: ${todo.id}`));
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  // WHY 保持中かを確かめない: Postgres は変わった列も増えた履歴も無ければ SQL を発行しないので、消されたことに気づかない。
  //   ここで先にエラーにすると、テスト（InMemory）と本番（Postgres）で結果が変わる。
  test("読み込んだ後に delete された Todo を変えずに update すると、何もしない（エラーにせず、Todo を戻さない）", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const loaded = await read(repository, todo.id);
    await repository.delete(todo.id, tx);

    await repository.update(loaded, tx);

    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("新規の Todo（create したもの）を 2 回 insert すると、2 回目はエラーになり行は 1 件のまま", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await repository.insert(todo, tx);

    await expect(repository.insert(todo, tx)).rejects.toEqual(
      new Error(`todo already exists: ${todo.id}`),
    );
    await expect(repository.findAll()).resolves.toEqual([todo]);
  });

  // WHY: 読み込んだ Todo が origin を持たないと、update が差分を取れない（Postgres と結果が変わる）。
  test("findById・findByIdOrThrow・findAll が返す Todo は、読み込んだときの値を origin に持つ", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await repository.insert(todo, tx);
    const values = {
      id: todo.id,
      title: "牛乳を買う",
      completed: true,
      createdAt: todo.createdAt,
      statusChanges: todo.statusChanges,
    };

    expect((await repository.findById(todo.id))?.origin).toStrictEqual(values);
    expect(
      (await repository.findByIdOrThrow(todo.id, tx)).origin,
    ).toStrictEqual(values);
    expect((await repository.findAll())[0]?.origin).toStrictEqual(values);
  });

  // ここから下の完了の履歴（Issue #188）のテストは features/todo/internal/infra/todo-repository.postgres.test.ts と同じ契約で、
  //   同じテスト名にそろえる。
  test("新規の Todo を insert すると完了の履歴（作成日時に未完了の 1 件）も保存され、読み出した Todo が同じ履歴を持つ", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await repository.insert(todo, tx);

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      statusChanges: [{ completed: false, changedAt: todo.createdAt }],
    });
  });

  test("新規の Todo を作ってすぐ完了にして insert すると、履歴の 2 件がどちらも保存される", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う").changeCompletion(true);

    await repository.insert(todo, tx);

    const loaded = await repository.findById(todo.id);
    expect(loaded).toEqual(todo);
    expect(loaded?.statusChanges).toHaveLength(2);
  });

  test("読み込んだ Todo の完了状態を変えて update すると、増えた履歴だけが足され、既存の履歴は変わらない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);

    const completed = (
      await repository.findByIdOrThrow(todo.id, tx)
    ).changeCompletion(true);
    await repository.update(completed, tx);
    const reopened = (
      await repository.findByIdOrThrow(todo.id, tx)
    ).changeCompletion(false);
    await repository.update(reopened, tx);

    await expect(repository.findById(todo.id)).resolves.toEqual(reopened);
    expect(reopened.statusChanges.map((change) => change.completed)).toEqual([
      false,
      true,
      false,
    ]);
    expect(reopened.statusChanges[0]).toStrictEqual(todo.statusChanges[0]);
  });

  test("読み込んだ Todo を完了にしてから未完了に戻して update すると、履歴の 2 件が足され、完了状態は変わらない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const toggled = (await repository.findByIdOrThrow(todo.id, tx))
      .changeCompletion(true)
      .changeCompletion(false);

    await repository.update(toggled, tx);

    await expect(repository.findById(todo.id)).resolves.toEqual(toggled);
    expect(toggled.statusChanges).toHaveLength(3);
  });

  test("findAll・findById・findByIdOrThrow は完了の履歴を足した順で返す", async () => {
    const repository = new InMemoryTodoRepository();
    const createdAt = "2026-09-28T00:00:00.000Z";
    // 作成・完了・未完了を同じ時刻にして、日時ではなく足した順で並ぶことを確かめる。
    vi.mocked(now).mockReturnValue(new Date(createdAt));
    const todo = Todo.create("牛乳を買う")
      .changeCompletion(true)
      .changeCompletion(false);
    await repository.insert(todo, tx);
    const expected = [false, true, false].map((completed) => ({
      completed,
      changedAt: new Date(createdAt),
    }));

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      statusChanges: expected,
    });
    await expect(
      repository.findByIdOrThrow(todo.id, tx),
    ).resolves.toMatchObject({ statusChanges: expected });
    const all = await repository.findAll();
    expect(all.map((loaded) => loaded.statusChanges)).toStrictEqual([expected]);
  });

  // Postgres の (todo_id, position) の一意制約違反と同じ契約（2 回目はエラー、1 回目の変更だけが残る。2 回目の名前の変更も残らない）。
  test("ロックせずに同じ Todo を 2 回読み、両方で完了状態を変えて update すると、2 回目はエラーになり、1 回目の変更だけが残る", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const a = await read(repository, todo.id);
    const b = await read(repository, todo.id);
    const first = a.changeCompletion(true);
    await repository.update(first, tx);

    await expect(
      repository.update(b.rename("x").changeCompletion(true), tx),
    ).rejects.toEqual(
      new Error(
        `todo status changes were appended by another update: ${todo.id}`,
      ),
    );
    await expect(repository.findById(todo.id)).resolves.toEqual(first);
  });

  // Postgres は履歴の INSERT の外部キー違反（23503）。InMemory は保持していなければ Error にする（どちらも履歴を足さない）。
  test("ロックせずに読んだ後に delete された Todo を、完了にして未完了に戻して update すると、エラー（Postgres では外部キー違反）を投げ、履歴を足さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.insert(todo, tx);
    const loaded = await read(repository, todo.id);
    await repository.delete(todo.id, tx);

    await expect(
      repository.update(
        loaded.changeCompletion(true).changeCompletion(false),
        tx,
      ),
    ).rejects.toEqual(new Error(`todos has no row to update: ${todo.id}`));
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("インスタンスごとに別のデータを持つ（テスト同士が干渉しない）", async () => {
    const first = new InMemoryTodoRepository();
    const second = new InMemoryTodoRepository();

    await first.insert(Todo.create("牛乳を買う"), tx);

    await expect(second.findAll()).resolves.toEqual([]);
  });

  test("findAll が返した配列を書き換えても、保持しているデータは変わらない", async () => {
    const repository = new InMemoryTodoRepository();
    await repository.insert(Todo.create("牛乳を買う"), tx);

    const todos = await repository.findAll();
    todos.pop();

    await expect(repository.findAll()).resolves.toHaveLength(1);
  });
});
