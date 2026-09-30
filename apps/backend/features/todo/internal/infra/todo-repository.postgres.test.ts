// @vitest-environment node
import { now } from "@repo/shared/now";
import { and, asc, eq, sql } from "drizzle-orm";
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
import { DomainError } from "../../../../shared/domain/domain-error";
import type { ChangeEntry } from "../../../../shared/infra/change-log";
import { changeLogs } from "../../../../shared/infra/schema";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../../test-support/database";
import { Todo } from "../domain/todo";
import { todoStatusChanges, todos } from "./schema";
import { PostgresTodoRepository } from "./todo-repository.postgres";

// WHY 時計（now）を差し替えられるようにする: 作成日時（Todo.create が now() から入れる）をミリ秒まで決めた値で保存し、
//   同じ値で読み戻せることを確かめるため。spy: true で本物の now を残し、時刻を決めたいテストだけ次の 1 回の値を返させる。
vi.mock("@repo/shared/now", { spy: true });

// WHY restoreAllMocks: 文の数を数えるテストが Pool（database.pool）の query を vi.spyOn で包む。失敗したときも次のテストに
//   spy を残さない（vi.mock の now は restoreAllMocks の対象外で、上の mockReset が戻す）。
afterEach(() => {
  vi.mocked(now).mockReset();
  vi.restoreAllMocks();
});

// 実 Postgres（compose.yaml。`pnpm db:up` で起動）に対して実行する。
// テスト用のスキーマにマイグレーション（drizzle/）を当て、各テストの前に todos と完了の履歴（todo_status_changes）と
//   変更履歴（change_logs。Issue #189）を空にする（テスト同士が干渉しない）。
// WHY todos と todo_status_changes を 1 文で truncate する: todo_status_changes は todos を外部キーで参照するので、todos だけの
//   truncate は Postgres が拒否する（参照する表も同じ文で指定するか CASCADE が要る）。change_logs は外部キーを持たない。
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(
    sql`truncate change_logs, todo_status_changes, todos`,
  );
  // WHY console.log / console.warn を黙らせる: save / delete のたびに writeInTransaction（shared/infra/write.ts。Issue #205）が
  //   書き込みの前後のログ（info は console.log、失敗は console.warn）を出し、テストの出力が埋まる。ログの行は下の
  //   writeLogsBy が読む（afterEach の restoreAllMocks が戻す）。
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function repository(actorId?: string | null): PostgresTodoRepository {
  return new PostgresTodoRepository(database.db, actorId);
}

// action の間に書かれた変更履歴（change_logs の行）を、id と occurred_at を除いた記録（ChangeEntry）にして返す。
// WHY id と occurred_at を除く: id は DB が乱数で作り、occurred_at は now() の時刻（shared/infra/change-log.test.ts が固定する）。
// WHY 表の名前と changes で並べる: 同じ save の記録は同じ occurred_at で、DB が返す順は決まらない。
async function changeLogsWrittenBy(
  action: () => Promise<unknown>,
): Promise<ChangeEntry[]> {
  const before = new Set(
    (await database.db.select({ id: changeLogs.id }).from(changeLogs)).map(
      (row) => row.id,
    ),
  );
  await action();
  const rows = await database.db.select().from(changeLogs);
  return rows
    .filter((row) => !before.has(row.id))
    .map(({ id: _id, occurredAt: _occurredAt, ...entry }) => entry)
    .sort(byTableAndChanges);
}

function byTableAndChanges(a: ChangeEntry, b: ChangeEntry): number {
  return (
    a.tableName.localeCompare(b.tableName) ||
    JSON.stringify(a.changes).localeCompare(JSON.stringify(b.changes))
  );
}

// action の間に出た書き込みのログ（writeInTransaction の "repository write ..." の行）を、info（console.log）と
//   warn（console.warn）ごとに JSON にして返す。WHY action の前に消す: 準備の save のログを数えない。
async function writeLogsBy(
  action: () => Promise<unknown>,
): Promise<{ info: unknown[]; warn: unknown[] }> {
  const info = vi.mocked(console.log);
  const warn = vi.mocked(console.warn);
  info.mockClear();
  warn.mockClear();
  await action();
  const lines = (spy: typeof info) =>
    spy.mock.calls.map(([line]) => JSON.parse(String(line)));
  return { info: lines(info), warn: lines(warn) };
}

// 書き込みの前後のログの行（timestamp と所要時間は実行ごとに変わるので形だけを見る。値は shared/infra/write.test.ts が固定する）。
function writeStartLine(table: string, rowId: string, operation: string) {
  return {
    level: "info",
    timestamp: expect.any(String),
    message: "repository write start",
    table,
    rowId,
    operation,
  };
}

function writeDoneLine(
  table: string,
  rowId: string,
  operation: string,
  changes: {
    tableName: string;
    rowId: string | undefined;
    operation: string;
  }[],
) {
  return {
    ...writeStartLine(table, rowId, operation),
    message: "repository write done",
    durationMs: expect.any(Number),
    changes,
  };
}

// 完了の履歴の行（todo_status_changes）の id。変更履歴の row_id と照らし合わせる。
async function statusChangeId(todoId: string, position: number) {
  const [row] = await database.db
    .select({ id: todoStatusChanges.id })
    .from(todoStatusChanges)
    .where(
      and(
        eq(todoStatusChanges.todoId, todoId),
        eq(todoStatusChanges.position, position),
      ),
    );
  return row?.id;
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

  // ここから下の save のテストは test-support/todo/todo-repository.in-memory.test.ts と同じ契約で、同じテスト名にそろえる（Issue #165）。
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

  // ここから下の完了の履歴（Issue #188）のテストは test-support/todo/todo-repository.in-memory.test.ts と同じ契約で、同じテスト名にそろえる。
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

  // 完了状態を変えて戻すと todos の列は変わらない（changed が空）が、履歴は 2 件増える。UPDATE が無くても todos の行が
  //   あることを確かめ、無ければ not_found にする（履歴の INSERT の外部キー違反 23503 → 500 にしない）。
  test("読み込んだ後に delete された Todo を、完了にして未完了に戻して save すると、not_found を投げ、履歴を足さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);
    await repository().delete(todo.id);

    await expect(
      repository().save(loaded.changeCompletion(true).changeCompletion(false)),
    ).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: todo.id }),
    );
    await expect(statusChangeRows()).resolves.toStrictEqual([]);
  });

  // WHY 文の数を 1 に固定する（read skew を防ぐ）: todos と完了の履歴を別の文で読むと、READ COMMITTED では文ごとに
  //   スナップショットが変わる。2 文の間に別の要求が DELETE（cascade で履歴も消える）や完了の変更をコミットすると、片方だけに
  //   見え、不変条件の違反（500）になる。同時実行のタイミングはテストで再現しにくいので、文の数で固定する。
  // WHY Pool（database.pool）の query を数える: drizzle-orm 0.45.3 の node-postgres は、トランザクションの外の文を 1 文ごとに
  //   Pool の query で送る（node-postgres/session.js の execute が client.query を呼び、client はコンストラクタで渡した Pool）。
  //   Pool.query は内部で接続を借りて Client の query を呼ぶので、Pool の query の回数が文の数になる（pg 8.23.0）。drizzle が
  //   Pool を通さずに送る形に変わると 0 回になり、このテストは落ちる（数え方の前提が崩れたことに気づける）。
  test("一覧 / 詳細の読み出しは SQL 1 文で行う（読み出しの途中で別の要求の変更が片方だけに見えない）", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await repository().save(todo);
    await repository().save(Todo.create("卵を買う"));
    const query = vi.spyOn(database.pool, "query");

    const all = await repository().findAll();
    const findAll = query.mock.calls.length;
    query.mockClear();
    const found = await repository().findById(todo.id);
    const findById = query.mock.calls.length;

    expect({ findAll, findById }).toEqual({ findAll: 1, findById: 1 });
    // 1 文で読んでも、履歴を Todo ごとに組み立てられていることも確かめる。
    expect(all).toHaveLength(2);
    expect(found).toEqual(todo);
  });

  // WHY 一時的な CHECK 制約で履歴の INSERT を失敗させる: domain は不変条件を満たす Todo しか作れないので、履歴の INSERT を
  //   domain 経由では失敗させられない。position < 0 だけを許す制約を張ると、新規の save の 2 文目（履歴の INSERT）が
  //   check_violation（SQLSTATE 23514）で失敗する。トランザクションが無ければ 1 文目の todos の INSERT が残る。
  // 制約は後始末（finally）で外す（beforeEach の truncate は制約を外さないので、残すと後のテストの save がすべて失敗する）。
  test("新規の Todo の save は、完了の履歴の INSERT が失敗すると todos の INSERT も戻す（1 つのトランザクション）", async () => {
    await database.db.execute(
      sql`alter table todo_status_changes add constraint tmp_reject_all_history check (position < 0)`,
    );
    try {
      const result = repository().save(Todo.create("牛乳を買う"));

      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(result).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.db.select().from(todos)).resolves.toEqual([]);
    } finally {
      await database.db.execute(
        sql`alter table todo_status_changes drop constraint tmp_reject_all_history`,
      );
    }
  });

  // ここから下の変更履歴（change_logs。Issue #189）のテストは test-support/todo/todo-repository.in-memory.test.ts と同じ契約で、同じテスト名に
  //   そろえる。記録は Postgres では change_logs の行、InMemory では changeLogs。表の名前と changes のキーは DB の名前。
  //   完了の履歴の行の id は DB が作るので、ここでは DB から読んで照らし合わせる。
  test("新規の Todo を save すると、変更履歴に todos の insert（全列）と完了の履歴の insert（全列）の 2 件を記録する", async () => {
    const todo = Todo.create("牛乳を買う");

    const written = await changeLogsWrittenBy(() => repository().save(todo));

    const statusId = await statusChangeId(todo.id, 0);
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
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);

    const written = await changeLogsWrittenBy(() =>
      repository().save(loaded.rename("卵を買う")),
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
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const completed = (
      await repository().findByIdOrThrow(todo.id)
    ).changeCompletion(true);

    const written = await changeLogsWrittenBy(() =>
      repository().save(completed),
    );

    const statusId = await statusChangeId(todo.id, 1);
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

  // 完了にして未完了に戻すと todos の列は変わらない（update の記録は無い）が、完了の履歴は 2 件増える。
  test("読み込んだ Todo を完了にしてから未完了に戻して save すると、変更履歴に完了の履歴の insert の 2 件だけを記録する", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const toggled = (await repository().findByIdOrThrow(todo.id))
      .changeCompletion(true)
      .changeCompletion(false);

    const written = await changeLogsWrittenBy(() => repository().save(toggled));

    // WHY position で並べる: 2 件は同じ表で、changes の JSON の先頭（id。乱数）では順が決まらない。
    expect(
      written
        .map(({ tableName, rowId, operation, changes }) => ({
          tableName,
          rowId,
          operation,
          position: changes.position,
          completed: changes.completed,
        }))
        .sort((a, b) => Number(a.position?.after) - Number(b.position?.after)),
    ).toStrictEqual([
      {
        tableName: "todo_status_changes",
        rowId: await statusChangeId(todo.id, 1),
        operation: "insert",
        position: { after: 1 },
        completed: { after: true },
      },
      {
        tableName: "todo_status_changes",
        rowId: await statusChangeId(todo.id, 2),
        operation: "insert",
        position: { after: 2 },
        completed: { after: false },
      },
    ]);
  });

  // WHY 完了の履歴の行（外部キーの on delete cascade で消える）を 1 件ずつ記録しない: 親の todos の delete の記録 1 件で、
  //   その Todo の履歴が消えたことが分かる（cascade の行は Repository の SQL に現れず、読むと文が増える）。
  test("delete すると、変更履歴に todos の delete（消す前の全列）の 1 件だけを記録する", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await repository().save(todo);

    const written = await changeLogsWrittenBy(() =>
      repository().delete(todo.id),
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
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);

    const written = await changeLogsWrittenBy(async () => {
      await repository().save(loaded);
      await repository().save(loaded.changeCompletion(false));
      await repository().delete("00000000-0000-4000-8000-000000000000");
    });

    expect(written).toStrictEqual([]);
  });

  test("同じ Todo を 2 回読み、両方で完了状態を変えて save すると、2 回目の save は変更履歴を残さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const a = await repository().findByIdOrThrow(todo.id);
    const b = await repository().findByIdOrThrow(todo.id);
    await repository().save(a.changeCompletion(true));

    const written = await changeLogsWrittenBy(() =>
      repository()
        .save(b.rename("x").changeCompletion(true))
        .catch(() => undefined),
    );

    expect(written).toStrictEqual([]);
  });

  test("actorId を渡して組み立てると、変更履歴の actorId にその id が入る", async () => {
    const actorId = "11111111-1111-4111-8111-111111111111";
    const todo = Todo.create("牛乳を買う");

    const written = await changeLogsWrittenBy(async () => {
      await repository(actorId).save(todo);
      await repository(actorId).save(
        (await repository(actorId).findByIdOrThrow(todo.id)).rename("x"),
      );
      await repository(actorId).delete(todo.id);
    });

    // 新規の save の 2 件（todos と完了の履歴の insert）、名前の変更の 1 件、delete の 1 件。
    expect(written.map((entry) => entry.actorId)).toEqual([
      actorId,
      actorId,
      actorId,
      actorId,
    ]);
  });

  // WHY 一時的な CHECK 制約で change_logs の INSERT を失敗させる（新規の save の原子性のテストと同じ手法）: 記録を本体と
  //   別のトランザクション（またはトランザクションの外）で書くと、記録の失敗で本体だけが残り、変更が記録から漏れる。
  //   本体の書き込みが失敗したとき（上の 2 回目の save）は、記録は本体の後に書くので書かれない。
  // WHY not valid: 準備の save が書いた記録（既存の行）は制約を満たさないので、既存の行を検査せずに張る（新しい行だけに効く）。
  // 制約は後始末（finally）で外す（残すと後のテストの save がすべて失敗する）。
  test("変更履歴の INSERT が失敗すると、同じ save・delete の todos と完了の履歴の書き込みも戻る（1 つのトランザクション）", async () => {
    const kept = Todo.create("卵を買う");
    await repository().save(kept);
    const loaded = await repository().findByIdOrThrow(kept.id);
    await database.db.execute(
      sql`alter table change_logs add constraint tmp_reject_all_logs check (table_name = '') not valid`,
    );
    try {
      // WHY 1 つずつ呼んで待つ: まとめて呼ぶと、待つ前に reject した Promise が未処理の reject として Vitest の実行を失敗させる。
      const writes = [
        () => repository().save(Todo.create("牛乳を買う")),
        () => repository().save(loaded.rename("x").changeCompletion(true)),
        () => repository().delete(kept.id),
      ];

      for (const write of writes) {
        await expect(write()).rejects.toMatchObject({
          cause: { code: "23514" },
        });
      }
      await expect(repository().findAll()).resolves.toEqual([loaded]);
      await expect(statusChangeRows()).resolves.toStrictEqual([
        {
          todoId: kept.id,
          position: 0,
          completed: false,
          changedAt: kept.createdAt,
        },
      ]);
    } finally {
      await database.db.execute(
        sql`alter table change_logs drop constraint tmp_reject_all_logs`,
      );
    }
  });

  // WHY COMMIT の時点で失敗させる（遅延制約）: 記録を tx ではない接続（this.db）で書いても、上の CHECK 制約のテストは通る
  //   （記録の失敗がコールバックの例外になり、本体が戻るため）。記録を同じトランザクションで書いていることは、本体と記録を
  //   書き終えた後の COMMIT が失敗したときに、記録も残らないことで確かめる。遅延（deferrable initially deferred）の一意制約・
  //   外部キーは COMMIT のときに検査される（CHECK は遅延できない）。
  // 制約と表は後始末（finally）で外す（残すと後のテストの save・delete が失敗する）。
  test("COMMIT で失敗した save・delete は、変更履歴も残さない（記録は本体と同じトランザクションで書く）", async () => {
    const milk = Todo.create("牛乳を買う");
    const egg = Todo.create("卵を買う");
    await repository().save(milk);
    await repository().save(egg);
    const loadedEgg = await repository().findByIdOrThrow(egg.id);
    const logsBefore = await database.db.select().from(changeLogs);
    await database.db.execute(
      sql`alter table todos add constraint tmp_unique_title unique (title) deferrable initially deferred`,
    );
    await database.db.execute(
      sql`create table tmp_refs (todo_id uuid references todos (id) deferrable initially deferred)`,
    );
    await database.db.execute(sql`insert into tmp_refs values (${milk.id})`);
    try {
      // WHY 1 つずつ待つ: 同時に動かすと、遅延制約の検査が他方のトランザクションの終わりを待ち、順序で結果が変わりうる。
      await expect(
        repository().save(Todo.create("牛乳を買う")),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(
        repository().save(loadedEgg.rename("牛乳を買う")),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(repository().delete(milk.id)).rejects.toMatchObject({
        cause: { code: "23503" },
      });

      // 準備の 2 回の save の記録（4 件）だけが残り、失敗した 3 つの記録は無い。
      const logsAfter = await database.db.select().from(changeLogs);
      expect(logsAfter.map((row) => row.id).sort()).toEqual(
        logsBefore.map((row) => row.id).sort(),
      );
      expect(logsBefore).toHaveLength(4);
      await expect(repository().findAll()).resolves.toHaveLength(2);
      await expect(repository().findById(milk.id)).resolves.toEqual(milk);
      await expect(repository().findById(egg.id)).resolves.toEqual(egg);
    } finally {
      await database.db.execute(sql`drop table tmp_refs`);
      await database.db.execute(
        sql`alter table todos drop constraint tmp_unique_title`,
      );
    }
  });

  // 書き込みのログ（Issue #205）は Postgres だけ（InMemory はログを出さない）。ログを出すのは shared/infra/write.ts の
  //   writeInTransaction で、Repository は表・id・操作を渡すだけ。changes は書いた行ごとの記録（値は出さない）。
  test("新規の Todo を save すると、書き込みの前後に todos・Todo の id・insert のログを出し、後のログに書いた行（todos と完了の履歴）を並べる", async () => {
    const todo = Todo.create("牛乳を買う");

    const logs = await writeLogsBy(() => repository().save(todo));

    expect(logs).toStrictEqual({
      info: [
        writeStartLine("todos", todo.id, "insert"),
        writeDoneLine("todos", todo.id, "insert", [
          { tableName: "todos", rowId: todo.id, operation: "insert" },
          {
            tableName: "todo_status_changes",
            rowId: await statusChangeId(todo.id, 0),
            operation: "insert",
          },
        ]),
      ],
      warn: [],
    });
  });

  test("読み込んだ Todo を変えて save すると、書き込みの前後に todos・Todo の id・update のログを出し、後のログに書いた行（todos の update と完了の履歴の insert）を並べる", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const changed = (await repository().findByIdOrThrow(todo.id))
      .rename("卵を買う")
      .changeCompletion(true);

    const logs = await writeLogsBy(() => repository().save(changed));

    expect(logs).toStrictEqual({
      info: [
        writeStartLine("todos", todo.id, "update"),
        writeDoneLine("todos", todo.id, "update", [
          { tableName: "todos", rowId: todo.id, operation: "update" },
          {
            tableName: "todo_status_changes",
            rowId: await statusChangeId(todo.id, 1),
            operation: "insert",
          },
        ]),
      ],
      warn: [],
    });
  });

  test("delete すると、書き込みの前後に todos・id・delete のログを出す（無い id は後のログの changes が空）", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const missing = "00000000-0000-4000-8000-000000000000";

    const logs = await writeLogsBy(async () => {
      await repository().delete(todo.id);
      await repository().delete(missing);
    });

    expect(logs).toStrictEqual({
      info: [
        writeStartLine("todos", todo.id, "delete"),
        writeDoneLine("todos", todo.id, "delete", [
          { tableName: "todos", rowId: todo.id, operation: "delete" },
        ]),
        writeStartLine("todos", missing, "delete"),
        writeDoneLine("todos", missing, "delete", []),
      ],
      warn: [],
    });
  });

  // 読み込んだ後に消された Todo の save は not_found（API で 404）。失敗は warn（500 の例外は toProblemResponse が error で残す）。
  test("読み込んだ後に delete された Todo を変えて save すると、前のログの後に失敗のログ（warn。not_found の例外）を出す", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);
    await repository().delete(todo.id);
    const error = new DomainError("not_found", "todo.notFound", {
      id: todo.id,
    });

    const logs = await writeLogsBy(() =>
      expect(repository().save(loaded.rename("卵を買う"))).rejects.toEqual(
        error,
      ),
    );

    expect(logs).toStrictEqual({
      info: [writeStartLine("todos", todo.id, "update")],
      warn: [
        {
          level: "warn",
          timestamp: expect.any(String),
          message: "repository write failed",
          table: "todos",
          rowId: todo.id,
          operation: "update",
          durationMs: expect.any(Number),
          error: { name: "DomainError", message: error.message },
        },
      ],
    });
  });

  // 変わった列も増えた履歴も無い save は SQL を発行しない（上の「SQL を発行しない」）ので、書き込みのログも出さない。
  test("読み込んだ Todo を変えずに save すると、書き込みのログを出さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);
    const loaded = await repository().findByIdOrThrow(todo.id);

    const logs = await writeLogsBy(() => repository().save(loaded));

    expect(logs).toStrictEqual({ info: [], warn: [] });
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
