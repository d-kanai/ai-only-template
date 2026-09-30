// @vitest-environment node
import { now } from "@repo/shared/now";
import { asc, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { DomainError } from "../../../shared/domain/domain-error";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../test-support/database";
import { Todo } from "../domain/todo";
import { todoStatusChanges, todos } from "./schema";
import { PostgresTodoRepository } from "./todo-repository.postgres";

// WHY 時計（now）を差し替えられるようにする: 作成日時（Todo.create が now() から入れる）をミリ秒まで決めた値で保存し、
//   同じ値で読み戻せることを確かめるため。spy: true で本物の now を残し、時刻を決めたいテストだけ次の 1 回の値を返させる。
vi.mock("@repo/shared/now", { spy: true });

afterEach(() => {
  vi.mocked(now).mockReset();
});

// 実 Postgres（compose.yaml。`pnpm db:up` で起動）に対して実行する。
// テスト用のスキーマにマイグレーション（drizzle/）を当て、各テストの前に todos と完了の履歴（todo_status_changes）を空にする
//   （テスト同士が干渉しない）。
// WHY 2 つの表を 1 文で truncate する: todo_status_changes は todos を外部キーで参照するので、todos だけの truncate は Postgres が
//   拒否する（参照する表も同じ文で指定するか CASCADE が要る）。
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate todo_status_changes, todos`);
});

function repository(): PostgresTodoRepository {
  return new PostgresTodoRepository(database.db);
}

// 完了の履歴の行（todo_status_changes）を、Todo ごと・足した順（position）に読む。行の id（uuid）は乱数なので除く。
function statusChangeRows() {
  return database.db
    .select({
      todoId: todoStatusChanges.todoId,
      position: todoStatusChanges.position,
      completed: todoStatusChanges.completed,
      changedAt: todoStatusChanges.changedAt,
    })
    .from(todoStatusChanges)
    .orderBy(asc(todoStatusChanges.todoId), asc(todoStatusChanges.position));
}

describe("PostgresTodoRepository", () => {
  test("空の状態では findAll が空配列を返す", async () => {
    await expect(repository().findAll()).resolves.toEqual([]);
  });

  test("save した Todo を findById / findAll で同じ値（id・title・completed・作成日時）として取り出せる", async () => {
    const createdAt = new Date("2026-09-28T01:02:03.456Z");
    vi.mocked(now).mockReturnValueOnce(createdAt);
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    expect(todo.createdAt).toEqual(createdAt);

    await repository().save(todo);

    await expect(repository().findById(todo.id)).resolves.toEqual(todo);
    await expect(repository().findAll()).resolves.toEqual([todo]);
  });

  // 並び順のテスト用に id を固定した行を入れる（Todo.create の id は乱数で、id の大小が決まらないため）。
  // WHY Repository の save を通さず行を直接入れる: id を決めた Todo は Todo.reconstruct でしか作れず、reconstruct した
  //   Todo は「読み込み済み」（origin を持つ）なので、save は変わった列だけの UPDATE になり行を作らない（Issue #165）。
  // 完了の履歴も「作成日時に未完了」の 1 行を入れる（履歴が無い行は不変条件を満たさない）。
  async function insertTodo(
    id: string,
    title: string,
    createdAt: string,
  ): Promise<void> {
    await database.db
      .insert(todos)
      .values({ id, title, completed: false, createdAt: new Date(createdAt) });
    await database.db.insert(todoStatusChanges).values({
      todoId: id,
      position: 0,
      completed: false,
      changedAt: new Date(createdAt),
    });
  }

  test("findAll は作成日時の昇順で返す（保存した順・id の順によらない）", async () => {
    // id の順（小さい順）は 新しい → 真ん中 → 古い で、作成日時の順と逆にする。id 順に並べる実装では通らない。
    // 入れる順は 新しい → 古い → 真ん中 で、入れた順とも違う順になることを確かめる。
    await insertTodo(
      "00000000-0000-4000-8000-000000000001",
      "新しい",
      "2026-09-28T10:00:00.000Z",
    );
    await insertTodo(
      "00000000-0000-4000-8000-000000000003",
      "古い",
      "2026-09-28T09:00:00.000Z",
    );
    await insertTodo(
      "00000000-0000-4000-8000-000000000002",
      "真ん中",
      "2026-09-28T09:30:00.000Z",
    );

    const todos = await repository().findAll();

    expect(todos.map((todo) => todo.title)).toEqual([
      "古い",
      "真ん中",
      "新しい",
    ]);
  });

  test("作成日時が同じ Todo は id の昇順で返す（保存した順によらず、毎回同じ順になる）", async () => {
    const createdAt = "2026-09-28T09:00:00.000Z";
    // id の大きい方から入れ、入れた順ではなく id の順に並ぶことを確かめる。
    await insertTodo(
      "ffffffff-0000-4000-8000-000000000000",
      "大きい id",
      createdAt,
    );
    await insertTodo(
      "00000000-0000-4000-8000-000000000000",
      "小さい id",
      createdAt,
    );

    const todos = await repository().findAll();

    expect(todos.map((todo) => todo.title)).toEqual(["小さい id", "大きい id"]);
  });

  // WHY 読み込んでから変える: create した Todo（新規）を変えて save し直すと新規の 2 回目（一意制約違反）になる。
  //   本番の rename / change-todo-completion の command と同じく、findByIdOrThrow で読み込んだ Todo（origin を持つ）を変えて save する。
  test("読み込んだ Todo を変えて save すると上書きされ、行は増えない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);

    const updated = (await repository().findByIdOrThrow(todo.id))
      .rename("卵を買う")
      .changeCompletion(true);
    await repository().save(updated);

    await expect(repository().findAll()).resolves.toEqual([updated]);
  });

  // ここから下の save のテストは todo-repository.in-memory.test.ts と同じ契約で、同じテスト名にそろえる（Issue #165）。
  //   DB を直接見る・spy するテストは Postgres だけにあり、そのことをテストの上に書く。
  // WHY 読み込み済みの Todo は変わった列だけを UPDATE する: 全列を書くと、同じ Todo を同時に別の列で更新したときに
  //   後から save した方が、先に save された別の列を読み込んだときの値に巻き戻す（lost update）。
  // 2 つの Repository（a・b）は同じ db（プール）を使う。同時に動く 2 つのリクエストを、読み込みと save の順を決めて再現する。
  test("同じ Todo を 2 回読み、片方で完了にして save、もう片方で名前を変えて save すると、両方の変更が残る（別の列の同時更新を巻き戻さない）", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const a = await repository().findByIdOrThrow(todo.id);
    const b = await repository().findByIdOrThrow(todo.id);

    await repository().save(a.changeCompletion(true));
    await repository().save(b.rename("x"));

    const [row] = await database.db.select().from(todos);
    expect(row).toEqual({
      id: todo.id,
      title: "x",
      completed: true,
      createdAt: todo.createdAt,
    });
  });

  test("同じ Todo を 2 回読み、両方で名前を変えて save すると、後から save した名前が残る（同じ列の同時更新は後勝ち）", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const a = await repository().findByIdOrThrow(todo.id);
    const b = await repository().findByIdOrThrow(todo.id);

    await repository().save(b.rename("y"));
    await repository().save(a.rename("z"));

    await expect(repository().findByIdOrThrow(todo.id)).resolves.toMatchObject({
      title: "z",
    });
  });

  // 後勝ちの例外: 読み込んだときと同じ値に戻す変更は差分が無いので書かれない（version 列は入れない。ユーザー判断）。
  test("同じ Todo を 2 回読み、片方が名前を変えて save した後、もう片方が読み込んだときの名前に戻して save しても書かれず、先の変更が残る", async () => {
    const todo = Todo.create("x");
    await repository().save(todo);
    const a = await repository().findByIdOrThrow(todo.id);
    const b = await repository().findByIdOrThrow(todo.id);

    await repository().save(b.rename("y"));
    await repository().save(a.rename("y").rename("x"));

    await expect(repository().findByIdOrThrow(todo.id)).resolves.toMatchObject({
      title: "y",
    });
  });

  test("読み込んだ Todo を変えずに save しても、その間に別の save が書いた値を巻き戻さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const a = await repository().findByIdOrThrow(todo.id);
    const b = await repository().findByIdOrThrow(todo.id);

    await repository().save(a.rename("卵を買う").changeCompletion(true));
    await repository().save(b);

    const saved = await repository().findByIdOrThrow(todo.id);
    expect({ title: saved.title, completed: saved.completed }).toEqual({
      title: "卵を買う",
      completed: true,
    });
  });

  // db の insert / update / transaction を spy するので Postgres だけ（InMemory には SQL が無い）。
  // WHY transaction も数える: save の書き込みはトランザクション（tx）の中で行うので、db の insert / update の spy だけでは
  //   tx 経由の INSERT・UPDATE を数えられない。トランザクションを始めないことで、その中の SQL も無いことを確かめる。
  // 同じ値への changeCompletion は Todo を変えない（todo.ts）ので、履歴も足さず SQL を発行しない。
  test("読み込んだ Todo を変えずに save すると、SQL（INSERT・UPDATE）を発行しない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);
    const update = vi.spyOn(database.db, "update");
    const insert = vi.spyOn(database.db, "insert");
    const transaction = vi.spyOn(database.db, "transaction");

    await repository().save(loaded);
    await repository().save(loaded.changeCompletion(false));
    const calls = {
      update: update.mock.calls.length,
      insert: insert.mock.calls.length,
      transaction: transaction.mock.calls.length,
    };
    // 次の検証（findByIdOrThrow）や失敗時に spy を残さないよう、数えたらすぐ戻す。
    update.mockRestore();
    insert.mockRestore();
    transaction.mockRestore();

    expect(calls).toEqual({ update: 0, insert: 0, transaction: 0 });
  });

  // WHY not_found にする: 以前の upsert は、読み込んだ後に消された Todo を INSERT で戻していた（PUT と DELETE の競合）。
  test("読み込んだ後に delete された Todo を変えて save すると、その id を params に持つ DomainError(not_found, todo.notFound) を投げ、Todo を戻さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);
    await repository().delete(todo.id);

    await expect(repository().save(loaded.rename("卵を買う"))).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: todo.id }),
    );
    await expect(repository().findAll()).resolves.toEqual([]);
  });

  // 変わった列が無ければ SQL を発行しないので、消されたことにも気づかない。
  test("読み込んだ後に delete された Todo を変えずに save すると、何もしない（エラーにせず、Todo を戻さない）", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);
    await repository().delete(todo.id);

    await repository().save(loaded);

    await expect(repository().findAll()).resolves.toEqual([]);
  });

  // WHY 2 回目をエラーにする（upsert で黙って通さない）: 新規（create した Todo）を 2 回 save する呼び出しは無く、
  //   あれば実装ミス。upsert は id が衝突した別の行も上書きする。素の INSERT なら Postgres の一意制約違反
  //   （SQLSTATE 23505）で気づける。
  test("新規の Todo（create したもの）を 2 回 save すると、2 回目はエラーになり行は 1 件のまま", async () => {
    const todo = Todo.create("牛乳を買う");

    await repository().save(todo);
    const second = repository().save(todo);

    await expect(second).rejects.toBeInstanceOf(Error);
    // drizzle は失敗したクエリを DrizzleQueryError に包み、pg のエラー（SQLSTATE は code）を cause に入れる。
    await expect(second).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(repository().findAll()).resolves.toEqual([todo]);
  });

  // WHY: 読み込んだ Todo が origin を持たないと、save が新規として全列を上書きし、上の同時更新のテストの意味が無くなる。
  test("findById・findByIdOrThrow・findAll が返す Todo は、読み込んだときの値を origin に持つ", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await repository().save(todo);
    const values = {
      id: todo.id,
      title: "牛乳を買う",
      completed: true,
      createdAt: todo.createdAt,
      statusChanges: todo.statusChanges,
    };

    expect((await repository().findById(todo.id))?.origin).toStrictEqual(
      values,
    );
    expect((await repository().findByIdOrThrow(todo.id)).origin).toStrictEqual(
      values,
    );
    expect((await repository().findAll())[0]?.origin).toStrictEqual(values);
  });

  // DB の行を直接書き換えて確かめるので Postgres だけ。
  // 変わった列だけを UPDATE し、変えていない列（作成日時）は書かない。作成日時を DB だけで変えておき、save で
  //   読み込んだときの値に戻らないことで確かめる（全列を書く実装では戻る）。
  test("読み込んだ Todo の save は変わった列だけを書き、他の列（作成日時を含む）は DB の値のまま残す", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    await database.db.update(todos).set({ createdAt, completed: true });

    await repository().save(loaded.rename("卵を買う"));

    const [row] = await database.db.select().from(todos);
    expect(row).toEqual({
      id: todo.id,
      title: "卵を買う",
      completed: true,
      createdAt,
    });
  });

  // ここから下の完了の履歴（Issue #188）のテストは todo-repository.in-memory.test.ts と同じ契約で、同じテスト名にそろえる。
  //   DB の行（todo_status_changes）を直接見る確認と、DB だけのテストは Postgres だけ。
  test("新規の Todo を save すると完了の履歴（作成日時に未完了の 1 件）も保存され、読み出した Todo が同じ履歴を持つ", async () => {
    const todo = Todo.create("牛乳を買う");

    await repository().save(todo);

    await expect(repository().findById(todo.id)).resolves.toMatchObject({
      statusChanges: [{ completed: false, changedAt: todo.createdAt }],
    });
    await expect(statusChangeRows()).resolves.toStrictEqual([
      {
        todoId: todo.id,
        position: 0,
        completed: false,
        changedAt: todo.createdAt,
      },
    ]);
  });

  test("新規の Todo を作ってすぐ完了にして save すると、履歴の 2 件がどちらも保存される", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);

    await repository().save(todo);

    await expect(repository().findById(todo.id)).resolves.toEqual(todo);
    await expect(statusChangeRows()).resolves.toStrictEqual(
      todo.statusChanges.map((change, position) => ({
        todoId: todo.id,
        position,
        ...change,
      })),
    );
  });

  // WHY 既存の行が変わらないことを行の id で確かめる: 増分だけを INSERT する（insert のみの子表。UPDATE / DELETE しない）。
  //   全件を消して入れ直す実装では、既存の行の id が変わる。
  test("読み込んだ Todo の完了状態を変えて save すると、増えた履歴だけが足され、既存の履歴は変わらない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const [first] = await database.db.select().from(todoStatusChanges);

    const completed = (
      await repository().findByIdOrThrow(todo.id)
    ).changeCompletion(true);
    await repository().save(completed);
    const reopened = (
      await repository().findByIdOrThrow(todo.id)
    ).changeCompletion(false);
    await repository().save(reopened);

    await expect(repository().findById(todo.id)).resolves.toEqual(reopened);
    expect(reopened.statusChanges.map((change) => change.completed)).toEqual([
      false,
      true,
      false,
    ]);
    const rows = await database.db
      .select()
      .from(todoStatusChanges)
      .orderBy(asc(todoStatusChanges.position));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toStrictEqual(first);
    expect(rows.map(({ id: _id, ...row }) => row)).toStrictEqual(
      reopened.statusChanges.map((change, position) => ({
        todoId: todo.id,
        position,
        ...change,
      })),
    );
  });

  // 完了状態は読み込んだときと同じでも、途中の遷移は履歴に残す（todos の UPDATE は無く、履歴の INSERT だけになる）。
  test("読み込んだ Todo を完了にしてから未完了に戻して save すると、履歴の 2 件が足され、完了状態は変わらない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const toggled = (await repository().findByIdOrThrow(todo.id))
      .changeCompletion(true)
      .changeCompletion(false);

    await repository().save(toggled);

    await expect(repository().findById(todo.id)).resolves.toEqual(toggled);
    await expect(statusChangeRows()).resolves.toStrictEqual(
      toggled.statusChanges.map((change, position) => ({
        todoId: todo.id,
        position,
        ...change,
      })),
    );
  });

  // WHY 足した順（position）で返す: 日時が同じ履歴（作成と完了が同じミリ秒）は、日時だけでは順が決まらない。行の物理的な順
  //   （入れた順）に頼らないことを確かめるため、Postgres では position の逆順に行を入れる。
  test("findAll・findById は完了の履歴を足した順で返す", async () => {
    const createdAt = new Date("2026-09-28T00:00:00.000Z");
    const id = "00000000-0000-4000-8000-000000000001";
    await database.db
      .insert(todos)
      .values({ id, title: "牛乳を買う", completed: false, createdAt });
    const history = [
      { position: 2, completed: false, changedAt: createdAt },
      { position: 1, completed: true, changedAt: createdAt },
      { position: 0, completed: false, changedAt: createdAt },
    ];
    for (const change of history) {
      await database.db
        .insert(todoStatusChanges)
        .values({ todoId: id, ...change });
    }
    await insertTodo(
      "00000000-0000-4000-8000-000000000002",
      "卵を買う",
      "2026-09-28T01:00:00.000Z",
    );
    const expected = [
      { completed: false, changedAt: createdAt },
      { completed: true, changedAt: createdAt },
      { completed: false, changedAt: createdAt },
    ];

    await expect(repository().findById(id)).resolves.toMatchObject({
      statusChanges: expected,
    });
    const all = await repository().findAll();
    expect(all.map((todo) => todo.statusChanges)).toStrictEqual([
      expected,
      [
        {
          completed: false,
          changedAt: new Date("2026-09-28T01:00:00.000Z"),
        },
      ],
    ]);
  });

  // WHY 2 回目をエラーにする: どちらも「読み込んだときの履歴の次」（同じ position）に足そうとする。両方を足すと、足した順と
  //   日時の順・今の completed がずれうる（履歴の最後の completed が今の completed と違う Todo は読めなくなる）。Postgres では
  //   (todo_id, position) の一意制約違反（SQLSTATE 23505）になり、同じ save の todos の UPDATE（title）も戻る（トランザクション）。
  test("同じ Todo を 2 回読み、両方で完了状態を変えて save すると、2 回目はエラーになり、1 回目の変更だけが残る", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const a = await repository().findByIdOrThrow(todo.id);
    const b = await repository().findByIdOrThrow(todo.id);
    const first = a.changeCompletion(true);
    await repository().save(first);

    const second = repository().save(b.rename("x").changeCompletion(true));

    await expect(second).rejects.toBeInstanceOf(Error);
    await expect(second).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(repository().findById(todo.id)).resolves.toEqual(first);
    await expect(statusChangeRows()).resolves.toStrictEqual(
      first.statusChanges.map((change, position) => ({
        todoId: todo.id,
        position,
        ...change,
      })),
    );
  });

  // DB の外部キー（on delete cascade）の確認なので Postgres だけ。
  test("delete すると、その Todo の完了の履歴も消え、他の Todo の履歴は残る", async () => {
    const removed = Todo.create("牛乳を買う").changeCompletion(true);
    const kept = Todo.create("卵を買う");
    await repository().save(removed);
    await repository().save(kept);

    await repository().delete(removed.id);

    await expect(statusChangeRows()).resolves.toStrictEqual([
      {
        todoId: kept.id,
        position: 0,
        completed: false,
        changedAt: kept.createdAt,
      },
    ]);
  });

  // 読み込んだ後に消された Todo は、完了状態の UPDATE が 0 行で not_found になり、同じトランザクションの履歴の INSERT もしない。
  test("読み込んだ後に delete された Todo の完了状態を変えて save すると、not_found を投げ、履歴を足さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);
    await repository().delete(todo.id);

    await expect(
      repository().save(loaded.changeCompletion(true)),
    ).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: todo.id }),
    );
    await expect(statusChangeRows()).resolves.toStrictEqual([]);
  });

  test("無い id の findById は undefined を返す", async () => {
    await expect(
      repository().findById("00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeUndefined();
  });

  test("findByIdOrThrow は id に一致する Todo を返す", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);

    await expect(repository().findByIdOrThrow(todo.id)).resolves.toEqual(todo);
  });

  test("無い id の findByIdOrThrow は、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const id = "00000000-0000-4000-8000-000000000000";

    await expect(repository().findByIdOrThrow(id)).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id }),
    );
  });

  // WHY uuid の形でない id を「無い」（undefined）にしない: 利用者の入力は presentation の parseUuidParam が先に 404 にする
  //   ので、ここに uuid の形でない id が来るのは呼び出し側の実装ミスだけ。「無い」で通すと誤りが隠れる。Postgres の
  //   uuid 型のエラー（SQLSTATE 22P02 invalid_text_representation）をそのまま投げ、API は 500 でログに残す。
  test.each([
    ["uuid でない文字列", "missing"],
    ["uuid の前に余分な文字", "x8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e"],
    ["uuid の後に余分な文字", "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4ex"],
  ])(
    "uuid の形でない id（%s）の findById は Postgres の invalid input syntax のエラーで reject する",
    async (_label, id) => {
      const result = repository().findById(id);

      // drizzle は失敗したクエリを DrizzleQueryError に包み、Postgres のエラー（pg の DatabaseError。SQLSTATE は code）を cause に入れる。
      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(result).rejects.toMatchObject({
        cause: {
          code: "22P02",
          message: `invalid input syntax for type uuid: "${id}"`,
        },
      });
    },
  );

  // Postgres の uuid 型は大文字の 16 進も同じ値として受け付けるので、形の検査でも大文字を弾かない（/i）。
  test("大文字で書いた uuid でも、同じ Todo を取り出せて削除できる", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);

    await expect(repository().findById(todo.id.toUpperCase())).resolves.toEqual(
      todo,
    );
    await repository().delete(todo.id.toUpperCase());
    await expect(repository().findById(todo.id)).resolves.toBeUndefined();
  });

  test("delete すると取り出せなくなり、他の Todo は残る", async () => {
    const removed = Todo.create("牛乳を買う");
    const kept = Todo.create("卵を買う");
    await repository().save(removed);
    await repository().save(kept);

    await repository().delete(removed.id);

    await expect(repository().findById(removed.id)).resolves.toBeUndefined();
    await expect(repository().findAll()).resolves.toEqual([kept]);
  });

  test("無い id の delete は何もしない（エラーにしない）", async () => {
    const kept = Todo.create("卵を買う");
    await repository().save(kept);

    await repository().delete("00000000-0000-4000-8000-000000000000");

    await expect(repository().findAll()).resolves.toEqual([kept]);
  });

  // WHY findById と同じ: 「無い」として黙って何もしないと、消したつもりで消えていない実装ミスが隠れる。
  test("uuid の形でない id の delete は Postgres の invalid input syntax のエラーで reject し、何も消さない", async () => {
    const kept = Todo.create("卵を買う");
    await repository().save(kept);

    const result = repository().delete("missing");

    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toMatchObject({
      cause: {
        code: "22P02",
        message: 'invalid input syntax for type uuid: "missing"',
      },
    });
    await expect(repository().findAll()).resolves.toEqual([kept]);
  });

  // DB の行が Todo の不変条件を満たさない（手で入れた行・規則を変えたのに移行していない行）ときの扱い（Issue #94）。
  // WHY DomainError ではなく Error を投げる（= API は 500）: DomainError(validation_error) は presentation で 400 になり、
  //   「リクエストを直せば通る」とクライアントに伝える。DB のデータの不整合はクライアントには直せないサーバ側の誤り。
  //   toEqual は Error の name・message・cause を比べるので、DomainError のまま投げる実装はこのテストで落ちる。
  // 行は Todo を通さずに insert する（Todo は不変条件を満たさない値を作れない）。
  // 3 番目は元の DomainError（cause）。Error の message はその message（キーと params）を含む。
  const INVALID_ROWS = [
    [
      "タイトルが空",
      { title: "" },
      new DomainError("validation_error", "todo.title.empty"),
    ],
    [
      "タイトルが 101 文字",
      { title: "a".repeat(101) },
      new DomainError("validation_error", "todo.title.tooLong", { max: 100 }),
    ],
    [
      "id の版の桁が 0（Postgres の uuid 型は受け付ける）",
      { id: "8d0f4f39-6f0b-0a39-9d53-0a3f8b1c2d4e" },
      new DomainError("validation_error", "todo.id.invalid"),
    ],
  ] as const;

  // 完了の履歴の行（作成日時に未完了の 1 行）。不変条件の違反を行ごとに 1 つにするため、履歴は正しい形で入れる。
  async function insertHistory(row: { id: string; createdAt: Date }) {
    await database.db.insert(todoStatusChanges).values({
      todoId: row.id,
      position: 0,
      completed: false,
      changedAt: row.createdAt,
    });
  }

  function invalidRow(override: { id?: string; title?: string }) {
    return {
      id: "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e",
      title: "牛乳を買う",
      completed: false,
      createdAt: new Date("2026-09-28T00:00:00.000Z"),
      ...override,
    };
  }

  // WHY message は英語: ログ（toProblemResponse の logger.error）に出る開発者向けの文字列で、apps/backend の非テストコードには
  //   自然言語の日本語を置かない（Issue #116）。cause の DomainError の message はキーと params（describeErrorKey）。
  function corruptedRowError(id: string, cause: DomainError): Error {
    return new Error(
      `stored Todo (id: ${id}) violates the invariants: ${cause.message}`,
      { cause },
    );
  }

  test.each(INVALID_ROWS)(
    "不変条件を満たさない行（%s）の findById は、DomainError ではない Error を投げる（API で 500 になるように）",
    async (_label, override, cause) => {
      const row = invalidRow(override);
      await database.db.insert(todos).values(row);
      await insertHistory(row);

      await expect(repository().findById(row.id)).rejects.toEqual(
        corruptedRowError(row.id, cause),
      );
    },
  );

  test.each(INVALID_ROWS)(
    "不変条件を満たさない行（%s）が 1 行でもあれば、findAll は DomainError ではない Error を投げる",
    async (_label, override, cause) => {
      const row = invalidRow(override);
      await repository().save(Todo.create("卵を買う"));
      await database.db.insert(todos).values(row);
      await insertHistory(row);

      await expect(repository().findAll()).rejects.toEqual(
        corruptedRowError(row.id, cause),
      );
    },
  );

  // 完了の履歴の不変条件（Issue #188）: 履歴の無い行（Issue #188 より前の行を移行していない・手で入れた行）と、最後の履歴の
  //   completed が todos.completed と違う行。
  test.each([
    ["完了の履歴が無い", []],
    [
      "最後の履歴の completed が todos.completed と違う",
      [{ position: 0, completed: true }],
    ],
  ] as const)(
    "完了の履歴が不変条件を満たさない行（%s）の findById・findAll は、DomainError ではない Error を投げる",
    async (_label, history) => {
      const row = invalidRow({});
      await database.db.insert(todos).values(row);
      for (const change of history) {
        await database.db
          .insert(todoStatusChanges)
          .values({ todoId: row.id, changedAt: row.createdAt, ...change });
      }
      const error = corruptedRowError(
        row.id,
        new DomainError("validation_error", "todo.statusChanges.invalid"),
      );

      await expect(repository().findById(row.id)).rejects.toEqual(error);
      await expect(repository().findAll()).rejects.toEqual(error);
    },
  );
});
