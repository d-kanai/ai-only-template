// @vitest-environment node
import { now } from "@repo/shared/now";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DomainError } from "../../../shared/domain/domain-error";
import type { ChangeEntry } from "../../../shared/infra/change-log";
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

// action の間に repository が積んだ変更履歴（changeLogs）を、id と occurredAt を除いた記録（ChangeEntry）にして返す。
//   todo-repository.postgres.test.ts の同名の補助と同じく、表の名前と changes で並べる。
async function changeLogsWrittenBy(
  repository: InMemoryTodoRepository,
  action: () => Promise<unknown>,
): Promise<ChangeEntry[]> {
  const before = repository.changeLogs.length;
  await action();
  return repository.changeLogs
    .slice(before)
    .map(({ id: _id, occurredAt: _occurredAt, ...entry }) => entry)
    .sort(
      (a, b) =>
        a.tableName.localeCompare(b.tableName) ||
        JSON.stringify(a.changes).localeCompare(JSON.stringify(b.changes)),
    );
}

// 完了の履歴の insert の記録の rowId。InMemory は履歴の行を持たないので、記録を積むときに randomUUID で作る（Postgres は DB が作る）。
//   記録の rowId と changes の id が同じ値であることを確かめて返す。
function statusChangeRowId(entry: ChangeEntry | undefined): string {
  expect(entry?.rowId).toEqual(expect.any(String));
  expect(entry?.changes.id).toEqual({ after: entry?.rowId });
  return entry?.rowId ?? "";
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
    // 名前だけを変えた save は、先の save が足した完了の履歴を消さない（Issue #188）。
    expect(saved.statusChanges.map((change) => change.completed)).toEqual([
      false,
      true,
    ]);
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

  // ここから下の完了の履歴（Issue #188）のテストは todo-repository.postgres.test.ts と同じ契約で、同じテスト名にそろえる。
  //   DB の行（todo_status_changes）を直接見る確認と、DB だけのテスト（外部キーの cascade）は Postgres だけ。
  test("新規の Todo を save すると完了の履歴（作成日時に未完了の 1 件）も保存され、読み出した Todo が同じ履歴を持つ", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    await repository.save(todo);

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      statusChanges: [{ completed: false, changedAt: todo.createdAt }],
    });
  });

  test("新規の Todo を作ってすぐ完了にして save すると、履歴の 2 件がどちらも保存される", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う").changeCompletion(true);

    await repository.save(todo);

    await expect(repository.findById(todo.id)).resolves.toEqual(todo);
  });

  // InMemory は保持中の履歴に増分を足す（読み込んだ Todo の履歴で置き換えない）。既存の要素は同じもの（参照）のまま残る。
  test("読み込んだ Todo の完了状態を変えて save すると、増えた履歴だけが足され、既存の履歴は変わらない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const [first] = (await repository.findByIdOrThrow(todo.id)).statusChanges;

    const completed = (
      await repository.findByIdOrThrow(todo.id)
    ).changeCompletion(true);
    await repository.save(completed);
    const reopened = (
      await repository.findByIdOrThrow(todo.id)
    ).changeCompletion(false);
    await repository.save(reopened);

    const saved = await repository.findByIdOrThrow(todo.id);
    expect(saved).toEqual(reopened);
    expect(saved.statusChanges.map((change) => change.completed)).toEqual([
      false,
      true,
      false,
    ]);
    expect(saved.statusChanges[0]).toStrictEqual(first);
  });

  test("読み込んだ Todo を完了にしてから未完了に戻して save すると、履歴の 2 件が足され、完了状態は変わらない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const toggled = (await repository.findByIdOrThrow(todo.id))
      .changeCompletion(true)
      .changeCompletion(false);

    await repository.save(toggled);

    await expect(repository.findById(todo.id)).resolves.toEqual(toggled);
    expect(toggled.statusChanges).toHaveLength(3);
  });

  test("findAll・findById は完了の履歴を足した順で返す", async () => {
    const repository = new InMemoryTodoRepository();
    const createdAt = "2026-09-28T00:00:00.000Z";
    // 作成・完了・未完了を同じ時刻にして、日時ではなく足した順で並ぶことを確かめる。
    vi.mocked(now).mockReturnValue(new Date(createdAt));
    const todo = Todo.create("牛乳を買う")
      .changeCompletion(true)
      .changeCompletion(false);
    await repository.save(todo);
    const expected = [false, true, false].map((completed) => ({
      completed,
      changedAt: new Date(createdAt),
    }));

    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      statusChanges: expected,
    });
    const all = await repository.findAll();
    expect(all.map((loaded) => loaded.statusChanges)).toStrictEqual([expected]);
  });

  // Postgres の (todo_id, position) の一意制約違反と同じ契約（2 回目はエラー、1 回目の変更だけが残る。2 回目の名前の変更も残らない）。
  test("同じ Todo を 2 回読み、両方で完了状態を変えて save すると、2 回目はエラーになり、1 回目の変更だけが残る", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const a = await repository.findByIdOrThrow(todo.id);
    const b = await repository.findByIdOrThrow(todo.id);
    const first = a.changeCompletion(true);
    await repository.save(first);

    const second = repository.save(b.rename("x").changeCompletion(true));

    await expect(second).rejects.toEqual(
      new Error(
        `todo status changes were appended by another save: ${todo.id}`,
      ),
    );
    await expect(repository.findById(todo.id)).resolves.toEqual(first);
  });

  test("読み込んだ後に delete された Todo の完了状態を変えて save すると、not_found を投げ、履歴を足さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const loaded = await repository.findByIdOrThrow(todo.id);
    await repository.delete(todo.id);

    await expect(
      repository.save(loaded.changeCompletion(true)),
    ).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: todo.id }),
    );
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  test("読み込んだ後に delete された Todo を、完了にして未完了に戻して save すると、not_found を投げ、履歴を足さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const loaded = await repository.findByIdOrThrow(todo.id);
    await repository.delete(todo.id);

    await expect(
      repository.save(loaded.changeCompletion(true).changeCompletion(false)),
    ).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: todo.id }),
    );
    await expect(repository.findAll()).resolves.toEqual([]);
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
      statusChanges: todo.statusChanges,
    };

    expect((await repository.findById(todo.id))?.origin).toStrictEqual(values);
    expect((await repository.findByIdOrThrow(todo.id)).origin).toStrictEqual(
      values,
    );
    expect((await repository.findAll())[0]?.origin).toStrictEqual(values);
  });

  // ここから下の変更履歴（Issue #189）のテストは todo-repository.postgres.test.ts と同じ契約で、同じテスト名にそろえる。
  test("新規の Todo を save すると、変更履歴に todos の insert（全列）と完了の履歴の insert（全列）の 2 件を記録する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");

    const written = await changeLogsWrittenBy(repository, () =>
      repository.save(todo),
    );

    const statusId = statusChangeRowId(written[0]);
    expect(written).toStrictEqual([
      {
        tableName: "todo_status_changes",
        rowId: statusId,
        operation: "insert",
        changes: {
          id: { after: statusId },
          todo_id: { after: todo.id },
          position: { after: 0 },
          completed: { after: false },
          changed_at: { after: todo.createdAt.toISOString() },
        },
        actorId: null,
      },
      {
        tableName: "todos",
        rowId: todo.id,
        operation: "insert",
        changes: {
          id: { after: todo.id },
          title: { after: "牛乳を買う" },
          completed: { after: false },
          created_at: { after: todo.createdAt.toISOString() },
        },
        actorId: null,
      },
    ]);
  });

  test("読み込んだ Todo の名前を変えて save すると、変更履歴に todos の update（title の前後だけ）の 1 件を記録する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const loaded = await repository.findByIdOrThrow(todo.id);

    const written = await changeLogsWrittenBy(repository, () =>
      repository.save(loaded.rename("卵を買う")),
    );

    expect(written).toStrictEqual([
      {
        tableName: "todos",
        rowId: todo.id,
        operation: "update",
        changes: { title: { before: "牛乳を買う", after: "卵を買う" } },
        actorId: null,
      },
    ]);
  });

  test("読み込んだ Todo を完了にして save すると、変更履歴に todos の update（completed の前後）と完了の履歴の insert の 2 件を記録する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const completed = (
      await repository.findByIdOrThrow(todo.id)
    ).changeCompletion(true);

    const written = await changeLogsWrittenBy(repository, () =>
      repository.save(completed),
    );

    const statusId = statusChangeRowId(written[0]);
    expect(written).toStrictEqual([
      {
        tableName: "todo_status_changes",
        rowId: statusId,
        operation: "insert",
        changes: {
          id: { after: statusId },
          todo_id: { after: todo.id },
          position: { after: 1 },
          completed: { after: true },
          changed_at: {
            after: completed.statusChanges[1]?.changedAt.toISOString(),
          },
        },
        actorId: null,
      },
      {
        tableName: "todos",
        rowId: todo.id,
        operation: "update",
        changes: { completed: { before: false, after: true } },
        actorId: null,
      },
    ]);
  });

  test("読み込んだ Todo を完了にしてから未完了に戻して save すると、変更履歴に完了の履歴の insert の 2 件だけを記録する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const toggled = (await repository.findByIdOrThrow(todo.id))
      .changeCompletion(true)
      .changeCompletion(false);

    const written = await changeLogsWrittenBy(repository, () =>
      repository.save(toggled),
    );

    const byPosition = written.sort(
      (a, b) =>
        Number(a.changes.position?.after) - Number(b.changes.position?.after),
    );
    expect(byPosition).toStrictEqual(
      [true, false].map((completed, index) => {
        const statusId = statusChangeRowId(byPosition[index]);
        return {
          tableName: "todo_status_changes",
          rowId: statusId,
          operation: "insert",
          changes: {
            id: { after: statusId },
            todo_id: { after: todo.id },
            position: { after: index + 1 },
            completed: { after: completed },
            changed_at: {
              after: toggled.statusChanges[index + 1]?.changedAt.toISOString(),
            },
          },
          actorId: null,
        };
      }),
    );
    expect(byPosition[0]?.rowId).not.toBe(byPosition[1]?.rowId);
  });

  test("delete すると、変更履歴に todos の delete（消す前の全列）の 1 件だけを記録する", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await repository.save(todo);

    const written = await changeLogsWrittenBy(repository, () =>
      repository.delete(todo.id),
    );

    expect(written).toStrictEqual([
      {
        tableName: "todos",
        rowId: todo.id,
        operation: "delete",
        changes: {
          id: { before: todo.id },
          title: { before: "牛乳を買う" },
          completed: { before: true },
          created_at: { before: todo.createdAt.toISOString() },
        },
        actorId: null,
      },
    ]);
  });

  test("読み込んだ Todo を変えずに save しても、無い id を delete しても、変更履歴を記録しない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const loaded = await repository.findByIdOrThrow(todo.id);

    const written = await changeLogsWrittenBy(repository, async () => {
      await repository.save(loaded);
      await repository.save(loaded.changeCompletion(false));
      await repository.delete("00000000-0000-4000-8000-000000000000");
    });

    expect(written).toStrictEqual([]);
  });

  test("同じ Todo を 2 回読み、両方で完了状態を変えて save すると、2 回目の save は変更履歴を残さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);
    const a = await repository.findByIdOrThrow(todo.id);
    const b = await repository.findByIdOrThrow(todo.id);
    await repository.save(a.changeCompletion(true));

    const written = await changeLogsWrittenBy(repository, () =>
      repository
        .save(b.rename("x").changeCompletion(true))
        .catch(() => undefined),
    );

    expect(written).toStrictEqual([]);
  });

  // InMemory だけ: Postgres の一意制約違反（新規の 2 回目の INSERT）はトランザクションで戻る。InMemory も記録を足さない。
  test("新規の Todo を 2 回 save すると、2 回目の save は変更履歴を残さない", async () => {
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    const written = await changeLogsWrittenBy(repository, () =>
      repository.save(todo).catch(() => undefined),
    );

    expect(written).toStrictEqual([]);
  });

  test("actorId を渡して組み立てると、変更履歴の actorId にその id が入る", async () => {
    const actorId = "11111111-1111-4111-8111-111111111111";
    const repository = new InMemoryTodoRepository(actorId);
    const todo = Todo.create("牛乳を買う");

    const written = await changeLogsWrittenBy(repository, async () => {
      await repository.save(todo);
      await repository.save(
        (await repository.findByIdOrThrow(todo.id)).rename("x"),
      );
      await repository.delete(todo.id);
    });

    // 新規の save の 2 件（todos と完了の履歴の insert）、名前の変更の 1 件、delete の 1 件。
    expect(written.map((entry) => entry.actorId)).toEqual([
      actorId,
      actorId,
      actorId,
      actorId,
    ]);
  });

  // InMemory だけ: 記録の id（Postgres は DB が作る）と occurredAt（Postgres は recordChange が now() で入れる）。
  test("changeLogs の記録は、記録ごとに別の id と、積んだときの now() の日時を持つ", async () => {
    const occurredAt = new Date("2026-09-30T09:00:00.000Z");
    const repository = new InMemoryTodoRepository();
    const todo = Todo.create("牛乳を買う");
    vi.mocked(now).mockReturnValueOnce(occurredAt);

    await repository.save(todo);

    const [first, second] = repository.changeLogs;
    expect({
      count: repository.changeLogs.length,
      firstId: first?.id,
      occurredAt: [first?.occurredAt, second?.occurredAt],
    }).toStrictEqual({
      count: 2,
      firstId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      occurredAt: [occurredAt, occurredAt],
    });
    expect(first?.id).not.toBe(second?.id);
  });

  test("changeLogs が返した配列を書き換えても、積んだ記録は変わらない", async () => {
    const repository = new InMemoryTodoRepository();
    await repository.save(Todo.create("牛乳を買う"));

    (repository.changeLogs as unknown[]).pop();

    expect(repository.changeLogs).toHaveLength(2);
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
