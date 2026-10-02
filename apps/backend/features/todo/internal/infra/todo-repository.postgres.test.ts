// @vitest-environment node
import { now } from "@repo/shared/now";
import { and, asc, eq, sql } from "drizzle-orm";
import pg from "pg";
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
import type { Transaction } from "../../../../shared/application/transaction";
import { DomainError } from "../../../../shared/domain/domain-error";
import type { ChangeEntry } from "../../../../shared/infra/change-log";
import { changeLogs } from "../../../../shared/infra/schema";
import { PostgresTransactionRunner } from "../../../../shared/infra/transaction.postgres";
import { PostgresWriter } from "../../../../shared/infra/writer";
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

// WHY restoreAllMocks: 文の数を数えるテストが Pool（database.pool）・pg の Client の query を vi.spyOn で包む。失敗したときも次の
//   テストに spy を残さない（vi.mock の now は restoreAllMocks の対象外で、上の mockReset が戻す）。
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
  // WHY console.log / console.warn を黙らせる: 書き込みのたびに Writer（shared/infra/writer.ts。Issue #205・#215）が
  //   書き込みの前後のログ（info は console.log、失敗は console.warn）を出し、テストの出力が埋まる。ログの行は下の
  //   writeLogsBy が読む（afterEach の restoreAllMocks が戻す）。
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function repository(): PostgresTodoRepository {
  return new PostgresTodoRepository(database.db);
}

// Repository の書き込みと command 用の読み込みを、1 つのトランザクションで行う（本番は command が runner の run で張る。Issue #215）。
// WHY 書き込みごとに別のトランザクションにする: 1 回の command の単位（読み込み → 書き込み）と同じにし、書き込みが COMMIT された
//   後の DB を確かめる。actorId は変更履歴の actor（runner が持つ）。
function inTransaction<T>(
  work: (tx: Transaction) => Promise<T>,
  actorId?: string | null,
): Promise<T> {
  return new PostgresTransactionRunner(database.db, actorId).run(work);
}

function insert(todo: Todo): Promise<void> {
  return inTransaction((tx) => repository().insert(todo, tx));
}

function update(todo: Todo): Promise<void> {
  return inTransaction((tx) => repository().update(todo, tx));
}

function remove(id: string): Promise<void> {
  return inTransaction((tx) => repository().delete(id, tx));
}

// command と同じく、トランザクションの中で行をロックして読む（トランザクションはすぐ終わるので、ロックもすぐ外れる）。
function load(id: string): Promise<Todo> {
  return inTransaction((tx) => repository().findByIdForUpdate(id, tx));
}

// 任意のタイミングで resolve できる Promise（同時に動く 2 つのトランザクションの順序を決める）。
function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// トランザクション（tx）の接続の Postgres のプロセスの id。
async function backendPid(tx: Transaction): Promise<number> {
  const [row] = await PostgresWriter.of(tx)
    .select({ pid: sql<number>`pg_backend_pid()` })
    .from(todos);
  return Number(row?.pid);
}

// pid の接続（のトランザクション）が持つロックを待っている接続が 1 つになるまで待つ。
// WHY pg_blocking_pids で見る: 別の接続の文が「ロックを待っている」ことを、時間（sleep）ではなく Postgres の状態で確かめる。
//   同じ DB を使う他のテストファイルの接続は、この pid のロックを待たないので数えない。
async function waitUntilBlockedBy(pid: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await database.db.execute<{ blocked: number }>(
        sql`select count(*)::int as blocked from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
      );
      expect(rows[0]?.blocked).toBe(1);
    },
    { timeout: 3000, interval: 20 },
  );
}

// action の間に書かれた変更履歴（change_logs の行）を、id と occurred_at を除いた記録（ChangeEntry）にして返す。
// WHY id と occurred_at を除く: id は DB が乱数で作り、occurred_at は now() の時刻（shared/infra/change-log.test.ts が固定する）。
// WHY 表の名前と changes で並べる: 同じ command の記録の順は文の順だが、DB が返す順は決まらない。
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

// WHY 引数を表名と changes だけにする: 期待値（rowId が undefined になりうる組み立て途中の値）も同じ順に並べるため。
function byTableAndChanges(
  a: Pick<ChangeEntry, "tableName" | "changes">,
  b: Pick<ChangeEntry, "tableName" | "changes">,
): number {
  return (
    a.tableName.localeCompare(b.tableName) ||
    JSON.stringify(a.changes).localeCompare(JSON.stringify(b.changes))
  );
}

// action の間に出た書き込みのログ（Writer の event.name が db_write の行）を、info（console.log）と
//   warn（console.warn）ごとに JSON にして返す。WHY action の前に消す: 準備の insert のログを数えない。
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

// 書き込みのログの db（表名と操作）。
function dbFields(table: string, operation: string) {
  return { collection: { name: table }, operation: { name: operation } };
}

// 書き込みの前後のログの行（time と所要時間は実行ごとに変わるので形だけを見る。値は shared/infra/writer.test.ts が固定する）。
// Writer は文ごとにログを出す（Issue #215）。1 行の文は row_id、複数行の INSERT は row_ids。
function writeStartLine(table: string, rowIds: string[], operation: string) {
  return {
    severity: "INFO",
    time: expect.any(String),
    message: "db write start",
    event: { name: "db_write", phase: "start" },
    db: dbFields(table, operation),
    ...(rowIds.length === 1 ? { row_id: rowIds[0] } : { row_ids: rowIds }),
  };
}

// changes は書いた行ごとの記録で、before / after は schema.ts の列の分類表（todosColumns など。Issue #216）でマスクした値。
//   sides は rowIds と同じ順の行ごとの { before, after }（DB の列名 → 値。insert の before・delete の after は null）。
function writeDoneLine(
  table: string,
  rowIds: string[],
  operation: string,
  sides: { before: object | null; after: object | null }[],
) {
  return {
    ...writeStartLine(table, rowIds, operation),
    message: "db write done",
    event: {
      name: "db_write",
      phase: "done",
      duration_ms: expect.any(Number),
    },
    changes: rowIds.map((rowId, index) => ({
      table,
      row_id: rowId,
      operation,
      ...sides[index],
    })),
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

  test("insert した Todo を findById / findAll で同じ値（id・title・completed・作成日時）として取り出せる", async () => {
    const createdAt = new Date("2026-09-28T01:02:03.456Z");
    vi.mocked(now).mockReturnValueOnce(createdAt);
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    expect(todo.createdAt).toEqual(createdAt);

    await insert(todo);

    await expect(repository().findById(todo.id)).resolves.toEqual(todo);
    await expect(repository().findAll()).resolves.toEqual([todo]);
  });

  // 並び順のテスト用に id を固定した行を入れる（Todo.create の id は乱数で、id の大小が決まらないため）。
  // WHY Repository の insert を通さず行を直接入れる: id を決めた Todo は Todo.reconstruct でしか作れず、reconstruct した
  //   Todo は「読み込み済み」（origin を持つ）なので insert が受け付けない（新規は Todo.create だけ）。
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

  // 本番の rename / change-todo-completion の command と同じく、findByIdForUpdate で読み込んだ Todo（origin を持つ）を変えて update する。
  test("読み込んだ Todo を変えて update すると上書きされ、行は増えない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);

    const updated = (await load(todo.id))
      .rename("卵を買う")
      .changeCompletion(true);
    await update(updated);

    await expect(repository().findAll()).resolves.toEqual([updated]);
  });

  // ここから下の insert / update の契約のテストは test-support/todo/todo-repository.in-memory.test.ts と同じ契約で、同じテスト名に
  //   そろえる（Issue #165・#215）。DB を直接見る・spy するテストは Postgres だけにあり、そのことをテストの上に書く。
  // WHY origin で取り違えを止める: insert は新規（Todo.create）、update は読み込み済み（findByIdForUpdate）を受け取る。逆に渡すと、
  //   insert は読み込み済みの Todo を新規として全列を書き、update は差分の基準（origin）が無い。呼び出し側の誤りとして Error にする。
  test("読み込み済みの Todo（origin がある）を insert すると Error を投げ、何も書かない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = await load(todo.id);

    await expect(
      inTransaction((tx) => repository().insert(loaded.rename("卵を買う"), tx)),
    ).rejects.toEqual(
      new Error(
        `insert takes a new Todo (Todo.create), but got a loaded one: ${todo.id}`,
      ),
    );
    await expect(repository().findAll()).resolves.toEqual([loaded]);
  });

  test("新規の Todo（origin が undefined）を update すると Error を投げ、何も書かない", async () => {
    const todo = Todo.create("牛乳を買う");

    await expect(
      inTransaction((tx) => repository().update(todo, tx)),
    ).rejects.toEqual(
      new Error(
        `update takes a loaded Todo (findByIdForUpdate), but got a new one: ${todo.id}`,
      ),
    );
    await expect(repository().findAll()).resolves.toEqual([]);
  });

  // WHY 読み込み済みの Todo は変わった列だけを UPDATE する: 全列を書くと、同じ Todo をロックせずに 2 か所で読み（query で読んだ
  //   値など）、別の列を変えて書いたときに、後から書いた方が先の変更を読み込んだときの値に巻き戻す（lost update）。
  //   command は findByIdForUpdate で行をロックするので同時には読まない（下の「同時に動かすと」のテスト）が、update の契約として
  //   変わった列だけを書くことを、ロックせずに読んだ 2 つの Todo（findById）で固定する。
  test("ロックせずに同じ Todo を 2 回読み、片方で完了にして update、もう片方で名前を変えて update すると、両方の変更が残る（別の列の変更を巻き戻さない）", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const a = (await repository().findById(todo.id)) as Todo;
    const b = (await repository().findById(todo.id)) as Todo;

    await update(a.changeCompletion(true));
    await update(b.rename("x"));

    const [row] = await database.db.select().from(todos);
    expect(row).toEqual({
      id: todo.id,
      title: "x",
      completed: true,
      createdAt: todo.createdAt,
    });
  });

  test("ロックせずに同じ Todo を 2 回読み、両方で名前を変えて update すると、後から update した名前が残る（同じ列は後勝ち）", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const a = (await repository().findById(todo.id)) as Todo;
    const b = (await repository().findById(todo.id)) as Todo;

    await update(b.rename("y"));
    await update(a.rename("z"));

    await expect(repository().findById(todo.id)).resolves.toMatchObject({
      title: "z",
    });
  });

  // 後勝ちの例外: 読み込んだときと同じ値に戻す変更は差分が無いので書かれない（version 列は入れない。ユーザー判断）。
  test("ロックせずに同じ Todo を 2 回読み、片方が名前を変えて update した後、もう片方が読み込んだときの名前に戻して update しても書かれず、先の変更が残る", async () => {
    const todo = Todo.create("x");
    await insert(todo);
    const a = (await repository().findById(todo.id)) as Todo;
    const b = (await repository().findById(todo.id)) as Todo;

    await update(b.rename("y"));
    await update(a.rename("y").rename("x"));

    await expect(repository().findById(todo.id)).resolves.toMatchObject({
      title: "y",
    });
  });

  test("読み込んだ Todo を変えずに update しても、その間に別の update が書いた値を巻き戻さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const a = (await repository().findById(todo.id)) as Todo;
    const b = (await repository().findById(todo.id)) as Todo;

    await update(a.rename("卵を買う").changeCompletion(true));
    await update(b);

    const saved = await load(todo.id);
    expect({ title: saved.title, completed: saved.completed }).toEqual({
      title: "卵を買う",
      completed: true,
    });
  });

  // 同じ Todo を変える 2 つの command（Issue #165 の同時更新。Issue #215 で行ロックに変えた）: 先の command が findByIdForUpdate で
  //   根の行をロックしている間、後の command の findByIdForUpdate は待ち、先の COMMIT の後の値を読む（直列化）。そのため、
  //   別の列の変更は両方残り、同じ列は後勝ちになる（後の command は先の変更を読んだうえで変える）。
  // WHY 2 つのトランザクションを同時に開く: 以前は 2 回読んでから順に save して同時更新を再現したが、今の command は読み込みと
  //   書き込みが同じトランザクションで、読み込みで行をロックする。ロックを待つことを、後の command が先の接続を待っている
  //   （pg_blocking_pids）状態になってから先を進めることで確かめる。ロックが無ければ後の command は待たず、この状態にならない。
  test("同じ Todo の 2 つの command（findByIdForUpdate → update）を同時に動かすと、後の command は先の COMMIT まで待ってから読み、両方の変更が残る", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const firstLocked = deferred<number>();
    const releaseFirst = deferred();

    const first = inTransaction(async (tx) => {
      const a = await repository().findByIdForUpdate(todo.id, tx);
      firstLocked.resolve(await backendPid(tx));
      await releaseFirst.promise;
      await repository().update(a.changeCompletion(true), tx);
    });
    const firstPid = await firstLocked.promise;
    const second = inTransaction(async (tx) => {
      const b = await repository().findByIdForUpdate(todo.id, tx);
      await repository().update(b.rename("x"), tx);
      return b;
    });
    // WHY finally で先を進め、両方の終わりを待つ: 待ちの確認に失敗しても（ロックが無いなど）2 つのトランザクションを終わらせてから
    //   テストを失敗させる。開いたまま・走ったままだと、次のテストの beforeEach の truncate がその接続のロックと競合し（待ち続ける・
    //   deadlock detected）、無関係な次のテストまで失敗して原因が分かりにくくなる（Issue #215 で、ロックを外したときに実測）。
    try {
      await waitUntilBlockedBy(firstPid);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }
    await first;
    const readBySecond = await second;

    expect(readBySecond.completed).toBe(true);
    const [row] = await database.db.select().from(todos);
    expect(row).toEqual({
      id: todo.id,
      title: "x",
      completed: true,
      createdAt: todo.createdAt,
    });
  });

  // WHY 根の行をロックする: 読み込んだ後に別の要求が同じ Todo を消すと、その後の update（完了の履歴の INSERT）が外部キー違反などで
  //   失敗する。ロックすれば DELETE はこのトランザクションの終わりまで待つ。lock_timeout を短くして、待つ（= ロックがある）ことを
  //   55P03（lock_not_available）で確かめる（時間の長さで「待った」を判定しない）。
  test("findByIdForUpdate で読んだ Todo の行は、そのトランザクションの終わりまで別の接続から DELETE できない（待つ）", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);

    await inTransaction(async (tx) => {
      await repository().findByIdForUpdate(todo.id, tx);
      await expect(
        database.db.transaction(async (other) => {
          await other.execute(sql`set local lock_timeout = '50ms'`);
          await other.delete(todos).where(eq(todos.id, todo.id));
        }),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });

    await expect(repository().findById(todo.id)).resolves.toEqual(todo);
  });

  // WHY ロックを待った後の読み込みで not_found にする: 先の command が消して COMMIT した Todo を、待っていた後の command が読むと、
  //   ロックの文は消えた行を返さず（READ COMMITTED は待った後に行の最新の版を見る）、集約を読む 2 文目も空になる。そのまま
  //   update / delete に進まず、無い Todo として 404 にする（findByIdForUpdate の契約）。
  test("findByIdForUpdate がロックを待っている間に、先の command が同じ Todo を delete して COMMIT すると、not_found の DomainError を投げる", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const firstLocked = deferred<number>();
    const releaseFirst = deferred();

    const first = inTransaction(async (tx) => {
      await repository().findByIdForUpdate(todo.id, tx);
      firstLocked.resolve(await backendPid(tx));
      await releaseFirst.promise;
      await repository().delete(todo.id, tx);
    });
    const firstPid = await firstLocked.promise;
    const second = inTransaction((tx) =>
      repository().findByIdForUpdate(todo.id, tx),
    );
    // WHY finally で先を進め、両方の終わりを待つ: 上の「同時に動かすと」のテストと同じ（失敗しても次のテストに持ち越さない）。
    try {
      await waitUntilBlockedBy(firstPid);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
    }

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id: todo.id }),
    );
  });

  // WHY query（findAll / findById）は行をロックしない（待たない）: 一覧・詳細はトランザクションを張らない 1 文の読み取りで、command が
  //   ロックしている間も読める（ロックを取ると、command の間は一覧も詳細も待たされる）。
  test("findAll・findById は、command が行をロックしている間も待たずに読める", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);

    const read = await inTransaction(async (tx) => {
      await repository().findByIdForUpdate(todo.id, tx);
      return {
        all: await repository().findAll(),
        one: await repository().findById(todo.id),
      };
    });

    expect(read).toEqual({ all: [todo], one: todo });
  });

  // pg の Client の query（プールの接続が文を送る口）を数えるので Postgres だけ（InMemory には SQL が無い）。
  // WHY Client の query を数える: update は runner が張ったトランザクションの接続で書くので、db の spy では数えられない。
  //   トランザクションの接続は Pool の connect で借りた pg の Client で、BEGIN / COMMIT も文も Client の query で送る（drizzle-orm 0.45.3
  //   の node-postgres/session.js）。BEGIN と COMMIT だけなら、update が SQL を発行していない。
  // 同じ値への changeCompletion は Todo を変えない（todo.ts）ので、履歴も足さず SQL を発行しない。
  test("読み込んだ Todo を変えずに update すると、SQL を発行しない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = await load(todo.id);
    const query = vi.spyOn(pg.Client.prototype, "query");

    await update(loaded);
    await update(loaded.changeCompletion(false));
    const statements = query.mock.calls.map(([text]) =>
      String(typeof text === "string" ? text : (text as { text: string }).text),
    );
    query.mockRestore();

    expect(statements).toEqual(["begin", "commit", "begin", "commit"]);
  });

  // WHY Error（not_found にしない）: command は findByIdForUpdate で行をロックしてから update するので、読んだ後に消されることは無い。
  //   ロックせずに読んだ Todo（findById）で消された後に update するのは呼び出し側の誤りで、Writer が Error（500）にする。
  //   以前の upsert は、読み込んだ後に消された Todo を INSERT で戻していた（PUT と DELETE の競合）。
  test("ロックせずに読んだ後に delete された Todo を変えて update すると、Error を投げ、Todo を戻さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = (await repository().findById(todo.id)) as Todo;
    await remove(todo.id);

    await expect(update(loaded.rename("卵を買う"))).rejects.toEqual(
      new Error(`todos has no row to update: ${todo.id}`),
    );
    await expect(repository().findAll()).resolves.toEqual([]);
  });

  // 変わった列が無ければ SQL を発行しないので、消されたことにも気づかない。
  test("読み込んだ後に delete された Todo を変えずに update すると、何もしない（エラーにせず、Todo を戻さない）", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = (await repository().findById(todo.id)) as Todo;
    await remove(todo.id);

    await update(loaded);

    await expect(repository().findAll()).resolves.toEqual([]);
  });

  // WHY 2 回目をエラーにする（upsert で黙って通さない）: 新規（create した Todo）を 2 回 insert する呼び出しは無く、
  //   あれば実装ミス。upsert は id が衝突した別の行も上書きする。素の INSERT なら Postgres の一意制約違反
  //   （SQLSTATE 23505）で気づける。
  test("新規の Todo（create したもの）を 2 回 insert すると、2 回目はエラーになり行は 1 件のまま", async () => {
    const todo = Todo.create("牛乳を買う");

    await insert(todo);
    const second = insert(todo);

    await expect(second).rejects.toBeInstanceOf(Error);
    // drizzle は失敗したクエリを DrizzleQueryError に包み、pg のエラー（SQLSTATE は code）を cause に入れる。
    await expect(second).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(repository().findAll()).resolves.toEqual([todo]);
  });

  // WHY: 読み込んだ Todo が origin を持たないと、update が差分を取れない（insert に渡すと新規として全列を書く）。
  test("findById・findByIdForUpdate・findAll が返す Todo は、読み込んだときの値を origin に持つ", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await insert(todo);
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
    expect((await load(todo.id)).origin).toStrictEqual(values);
    expect((await repository().findAll())[0]?.origin).toStrictEqual(values);
  });

  // DB の行を直接書き換えて確かめるので Postgres だけ。
  // 変わった列だけを UPDATE し、変えていない列（作成日時）は書かない。作成日時を DB だけで変えておき、update で
  //   読み込んだときの値に戻らないことで確かめる（全列を書く実装では戻る）。
  test("読み込んだ Todo の update は変わった列だけを書き、他の列（作成日時を含む）は DB の値のまま残す", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = await load(todo.id);
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    await database.db.update(todos).set({ createdAt, completed: true });

    await update(loaded.rename("卵を買う"));

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
  test("新規の Todo を insert すると完了の履歴（作成日時に未完了の 1 件）も保存され、読み出した Todo が同じ履歴を持つ", async () => {
    const todo = Todo.create("牛乳を買う");

    await insert(todo);

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

  test("新規の Todo を作ってすぐ完了にして insert すると、履歴の 2 件がどちらも保存される", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);

    await insert(todo);

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
  test("読み込んだ Todo の完了状態を変えて update すると、増えた履歴だけが足され、既存の履歴は変わらない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const [first] = await database.db.select().from(todoStatusChanges);

    const completed = (await load(todo.id)).changeCompletion(true);
    await update(completed);
    const reopened = (await load(todo.id)).changeCompletion(false);
    await update(reopened);

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
  test("読み込んだ Todo を完了にしてから未完了に戻して update すると、履歴の 2 件が足され、完了状態は変わらない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const toggled = (await load(todo.id))
      .changeCompletion(true)
      .changeCompletion(false);

    await update(toggled);

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
  // findByIdForUpdate（行ロックの読み込み）も同じ SELECT（並び順）で読む。
  test("findAll・findById・findByIdForUpdate は完了の履歴を足した順で返す", async () => {
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
    await expect(load(id)).resolves.toMatchObject({ statusChanges: expected });
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

  // WHY 2 つの Todo の両方に複数の履歴を持たせ、履歴の行を Todo をまたいで交互・position の逆順に入れる: LEFT JOIN の行を Todo ごとに
  //   まとめる処理（toTodos）の誤り（境目で履歴が隣の Todo に混ざる・最後の Todo の履歴が落ちる・最初の Todo だけ正しい）は、
  //   どちらかの Todo の履歴が 1 件だと起きない（.claude/rules/testing.md の「複数件を扱う処理」）。日時を Todo ごと・履歴ごとに
  //   変え、取り違えたら値で分かるようにする。
  test("findAll は、2 つの Todo がそれぞれ複数の履歴を持つときも、履歴を Todo ごとに足した順で組み立てる", async () => {
    const first = "00000000-0000-4000-8000-000000000002";
    const second = "00000000-0000-4000-8000-000000000001";
    const at = (hour: number) =>
      new Date(`2026-09-28T${String(hour).padStart(2, "0")}:00:00.000Z`);
    await database.db.insert(todos).values([
      { id: second, title: "卵を買う", completed: true, createdAt: at(5) },
      { id: first, title: "牛乳を買う", completed: false, createdAt: at(0) },
    ]);
    const rows = [
      { todoId: second, position: 3, completed: true, changedAt: at(8) },
      { todoId: first, position: 2, completed: false, changedAt: at(2) },
      { todoId: second, position: 0, completed: false, changedAt: at(5) },
      { todoId: first, position: 0, completed: false, changedAt: at(0) },
      { todoId: second, position: 2, completed: false, changedAt: at(7) },
      { todoId: first, position: 1, completed: true, changedAt: at(1) },
      { todoId: second, position: 1, completed: true, changedAt: at(6) },
    ];
    for (const row of rows) {
      await database.db.insert(todoStatusChanges).values(row);
    }

    const all = await repository().findAll();

    expect(
      all.map(({ id, completed, statusChanges }) => ({
        id,
        completed,
        statusChanges,
      })),
    ).toStrictEqual([
      {
        id: first,
        completed: false,
        statusChanges: [
          { completed: false, changedAt: at(0) },
          { completed: true, changedAt: at(1) },
          { completed: false, changedAt: at(2) },
        ],
      },
      {
        id: second,
        completed: true,
        statusChanges: [
          { completed: false, changedAt: at(5) },
          { completed: true, changedAt: at(6) },
          { completed: false, changedAt: at(7) },
          { completed: true, changedAt: at(8) },
        ],
      },
    ]);
  });

  // WHY 2 回目をエラーにする: どちらも「読み込んだときの履歴の次」（同じ position）に足そうとする。両方を足すと、足した順と
  //   日時の順・今の completed がずれうる（履歴の最後の completed が今の completed と違う Todo は読めなくなる）。Postgres では
  //   (todo_id, position) の一意制約違反（SQLSTATE 23505）になり、同じ update の todos の UPDATE（title）も戻る（トランザクション）。
  //   command は行をロックして読むので起きないが、ロックせずに読んだ Todo（findById）を update したときの契約として固定する。
  test("ロックせずに同じ Todo を 2 回読み、両方で完了状態を変えて update すると、2 回目はエラーになり、1 回目の変更だけが残る", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const a = (await repository().findById(todo.id)) as Todo;
    const b = (await repository().findById(todo.id)) as Todo;
    const first = a.changeCompletion(true);
    await update(first);

    const second = update(b.rename("x").changeCompletion(true));

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
    await insert(removed);
    await insert(kept);

    await remove(removed.id);

    await expect(statusChangeRows()).resolves.toStrictEqual([
      {
        todoId: kept.id,
        position: 0,
        completed: false,
        changedAt: kept.createdAt,
      },
    ]);
  });

  // 完了状態を変えて戻すと todos の列は変わらない（UPDATE は無い）が、履歴は 2 件増える。行が無ければ履歴の INSERT が外部キー
  //   違反（SQLSTATE 23503）で失敗し、履歴を足さない（command は行をロックして読むので起きない。呼び出し側の誤りとして 500）。
  test("ロックせずに読んだ後に delete された Todo を、完了にして未完了に戻して update すると、エラー（Postgres では外部キー違反）を投げ、履歴を足さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = (await repository().findById(todo.id)) as Todo;
    await remove(todo.id);

    await expect(
      update(loaded.changeCompletion(true).changeCompletion(false)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(statusChangeRows()).resolves.toStrictEqual([]);
  });

  // WHY 文の数を 1 に固定する（read skew を防ぐ）: todos と完了の履歴を別の文で読むと、READ COMMITTED では文ごとに
  //   スナップショットが変わる。2 文の間に別の要求が DELETE（cascade で履歴も消える）や完了の変更をコミットすると、片方だけに
  //   見え、不変条件の違反（500）になる。同時実行のタイミングはテストで再現しにくいので、文の数で固定する。
  // WHY Pool（database.pool）の query を数える: drizzle-orm 0.45.3 の node-postgres は、トランザクションの外の文を 1 文ごとに
  //   Pool の query で送る（node-postgres/session.js の execute が client.query を呼び、client はコンストラクタで渡した Pool）。
  //   Pool.query は内部で接続を借りて Client の query を呼ぶので、Pool の query の回数が文の数になる（pg 8.23.0）。drizzle が
  //   Pool を通さずに送る形に変わると 0 回になり、このテストは落ちる（数え方の前提が崩れたことに気づける）。
  // findByIdForUpdate も同じ SELECT（1 文）で読む（トランザクションの接続で送るので、ここでは数えない）。
  test("一覧 / 詳細の読み出しは SQL 1 文で行う（読み出しの途中で別の要求の変更が片方だけに見えない）", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);
    await insert(todo);
    await insert(Todo.create("卵を買う"));
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
  //   domain 経由では失敗させられない。position < 0 だけを許す制約を張ると、新規の insert の 2 文目（履歴の INSERT）が
  //   check_violation（SQLSTATE 23514）で失敗する。トランザクション（runner）が無ければ 1 文目の todos の INSERT が残る。
  // 制約は後始末（finally）で外す（beforeEach の truncate は制約を外さないので、残すと後のテストの insert がすべて失敗する）。
  test("新規の Todo の insert は、完了の履歴の INSERT が失敗すると todos の INSERT も戻す（1 つのトランザクション）", async () => {
    await database.db.execute(
      sql`alter table todo_status_changes add constraint tmp_reject_all_history check (position < 0)`,
    );
    try {
      const result = insert(Todo.create("牛乳を買う"));

      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(result).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.db.select().from(todos)).resolves.toEqual([]);
    } finally {
      await database.db.execute(
        sql`alter table todo_status_changes drop constraint tmp_reject_all_history`,
      );
    }
  });

  // ここから下の変更履歴（change_logs。Issue #189）のテストは Postgres だけ（Issue #215 で変更履歴は Writer が文ごとに書くようになり、
  //   InMemory は積まない）。表の名前と changes のキーは DB の名前。完了の履歴の行の id は Writer が作るので、DB から読んで照らし合わせる。
  test("新規の Todo を insert すると、変更履歴に todos の insert（全列）と完了の履歴の insert（全列）の 2 件を記録する", async () => {
    const todo = Todo.create("牛乳を買う");

    const written = await changeLogsWrittenBy(() => insert(todo));

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

  test("読み込んだ Todo の名前を変えて update すると、変更履歴に todos の update（title の前後だけ）の 1 件を記録する", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = await load(todo.id);

    const written = await changeLogsWrittenBy(() =>
      update(loaded.rename("卵を買う")),
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

  // WHY before は DB が UPDATE の直前に持っていた値（Issue #215）: Writer が同じトランザクションで行を読んで before にする。以前
  //   （Repository が組み立てていたとき）は読み込んだときの値（origin）だった。ロックせずに読んだ Todo で、読んだ後に別の update が
  //   同じ列を変えていたら、その値が before になる。
  test("ロックせずに読んだ後に別の update が名前を変えていたら、変更履歴の before はその名前（DB が UPDATE の直前に持っていた値）になる", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const a = (await repository().findById(todo.id)) as Todo;
    await update((await load(todo.id)).rename("卵を買う"));

    const written = await changeLogsWrittenBy(() =>
      update(a.rename("パンを買う")),
    );

    expect(written).toMatchObject([
      { changes: { title: { before: "卵を買う", after: "パンを買う" } } },
    ]);
  });

  test("読み込んだ Todo を完了にして update すると、変更履歴に todos の update（completed の前後）と完了の履歴の insert の 2 件を記録する", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const completed = (await load(todo.id)).changeCompletion(true);

    const written = await changeLogsWrittenBy(() => update(completed));

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
  test("読み込んだ Todo を完了にしてから未完了に戻して update すると、変更履歴に完了の履歴の insert の 2 件だけを記録する", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const toggled = (await load(todo.id))
      .changeCompletion(true)
      .changeCompletion(false);

    const written = await changeLogsWrittenBy(() => update(toggled));

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
    await insert(todo);

    const written = await changeLogsWrittenBy(() => remove(todo.id));

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

  test("読み込んだ Todo を変えずに update しても、無い id を delete しても、変更履歴を記録しない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = await load(todo.id);

    const written = await changeLogsWrittenBy(async () => {
      await update(loaded);
      await update(loaded.changeCompletion(false));
      await remove("00000000-0000-4000-8000-000000000000");
    });

    expect(written).toStrictEqual([]);
  });

  test("ロックせずに同じ Todo を 2 回読み、両方で完了状態を変えて update すると、2 回目の update は変更履歴を残さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const a = (await repository().findById(todo.id)) as Todo;
    const b = (await repository().findById(todo.id)) as Todo;
    await update(a.changeCompletion(true));

    const written = await changeLogsWrittenBy(() =>
      update(b.rename("x").changeCompletion(true)).catch(() => undefined),
    );

    expect(written).toStrictEqual([]);
  });

  // WHY actorId は runner が持つ（Issue #215）: 変更履歴の actor は要求の文脈で、要求ごとに組み立てる runner が Writer に渡す。
  test("actorId を渡して組み立てた runner のトランザクションで書くと、変更履歴の actorId にその id が入る", async () => {
    const actorId = "11111111-1111-4111-8111-111111111111";
    const todo = Todo.create("牛乳を買う");

    const written = await changeLogsWrittenBy(async () => {
      await inTransaction((tx) => repository().insert(todo, tx), actorId);
      await inTransaction(async (tx) => {
        const loaded = await repository().findByIdForUpdate(todo.id, tx);
        await repository().update(loaded.rename("x"), tx);
      }, actorId);
      await inTransaction((tx) => repository().delete(todo.id, tx), actorId);
    });

    // 新規の insert の 2 件（todos と完了の履歴の insert）、名前の変更の 1 件、delete の 1 件。
    expect(written.map((entry) => entry.actorId)).toEqual([
      actorId,
      actorId,
      actorId,
      actorId,
    ]);
  });

  // WHY 一時的な CHECK 制約で change_logs の INSERT を失敗させる（新規の insert の原子性のテストと同じ手法）: 記録を本体と
  //   別のトランザクション（またはトランザクションの外）で書くと、記録の失敗で本体だけが残り、変更が記録から漏れる。
  //   本体の書き込みが失敗したとき（上の 2 回目の update）は、記録は本体の後に書くので書かれない。
  // WHY not valid: 準備の insert が書いた記録（既存の行）は制約を満たさないので、既存の行を検査せずに張る（新しい行だけに効く）。
  // 制約は後始末（finally）で外す（残すと後のテストの書き込みがすべて失敗する）。
  test("変更履歴の INSERT が失敗すると、同じ insert・update・delete の todos と完了の履歴の書き込みも戻る（1 つのトランザクション）", async () => {
    const kept = Todo.create("卵を買う");
    await insert(kept);
    const loaded = await load(kept.id);
    await database.db.execute(
      sql`alter table change_logs add constraint tmp_reject_all_logs check (table_name = '') not valid`,
    );
    try {
      // WHY 1 つずつ呼んで待つ: まとめて呼ぶと、待つ前に reject した Promise が未処理の reject として Vitest の実行を失敗させる。
      const writes = [
        () => insert(Todo.create("牛乳を買う")),
        () => update(loaded.rename("x").changeCompletion(true)),
        () => remove(kept.id),
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

  // WHY COMMIT の時点で失敗させる（遅延制約）: 記録を tx ではない接続で書いても、上の CHECK 制約のテストは通る（記録の失敗が
  //   例外になり、本体が戻るため）。記録を同じトランザクションで書いていることは、本体と記録を書き終えた後の COMMIT が失敗した
  //   ときに、記録も残らないことで確かめる。遅延（deferrable initially deferred）の一意制約・外部キーは COMMIT のときに検査される
  //   （CHECK は遅延できない）。
  // 制約と表は後始末（finally）で外す（残すと後のテストの書き込みが失敗する）。
  test("COMMIT で失敗した insert・update・delete は、変更履歴も残さない（記録は本体と同じトランザクションで書く）", async () => {
    const milk = Todo.create("牛乳を買う");
    const egg = Todo.create("卵を買う");
    await insert(milk);
    await insert(egg);
    const loadedEgg = await load(egg.id);
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
      await expect(insert(Todo.create("牛乳を買う"))).rejects.toMatchObject({
        cause: { code: "23505" },
      });
      await expect(
        update(loadedEgg.rename("牛乳を買う")),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(remove(milk.id)).rejects.toMatchObject({
        cause: { code: "23503" },
      });

      // 準備の 2 回の insert の記録（4 件）だけが残り、失敗した 3 つの記録は無い。
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

  // 書き込みのログ（Issue #205・#215）は Postgres だけ（InMemory はログを出さない）。ログを出すのは shared/infra/writer.ts の
  //   Writer で、文ごとに前後の 2 行を出す。changes は書いた行ごとの記録で、before / after の値は schema.ts の列の分類表で
  //   マスクする（Issue #216）。todos.title（利用者が書く自由文）は sensitive で ***、ほかの列（id・完了状態・日時・位置）は値のまま。
  test("新規の Todo を insert すると、todos の INSERT と完了の履歴の INSERT のそれぞれに、前後のログ（表・行の id・insert）を出し、changes の after は title だけを *** にする", async () => {
    const todo = Todo.create("牛乳を買う").changeCompletion(true);

    const logs = await writeLogsBy(() => insert(todo));

    const history = [
      (await statusChangeId(todo.id, 0)) as string,
      (await statusChangeId(todo.id, 1)) as string,
    ];
    const historyRow = (position: number) => ({
      before: null,
      after: {
        id: history[position],
        todo_id: todo.id,
        position,
        completed: todo.statusChanges[position]?.completed,
        changed_at: todo.statusChanges[position]?.changedAt.toISOString(),
      },
    });
    expect(logs).toStrictEqual({
      info: [
        writeStartLine("todos", [todo.id], "insert"),
        writeDoneLine("todos", [todo.id], "insert", [
          {
            before: null,
            after: {
              id: todo.id,
              title: "***",
              completed: true,
              created_at: todo.createdAt.toISOString(),
            },
          },
        ]),
        writeStartLine("todo_status_changes", history, "insert"),
        writeDoneLine("todo_status_changes", history, "insert", [
          historyRow(0),
          historyRow(1),
        ]),
      ],
      warn: [],
    });
    expect(JSON.stringify(logs)).not.toContain("牛乳");
  });

  test("読み込んだ Todo を変えて update すると、todos の UPDATE と完了の履歴の INSERT のそれぞれに、前後のログを出す", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const changed = (await load(todo.id))
      .rename("卵を買う")
      .changeCompletion(true);

    const logs = await writeLogsBy(() => update(changed));

    const history = [(await statusChangeId(todo.id, 1)) as string];
    expect(logs).toStrictEqual({
      info: [
        writeStartLine("todos", [todo.id], "update"),
        // update は変わった列だけ。title は前後とも ***、completed は値のまま。
        writeDoneLine("todos", [todo.id], "update", [
          {
            before: { title: "***", completed: false },
            after: { title: "***", completed: true },
          },
        ]),
        writeStartLine("todo_status_changes", history, "insert"),
        writeDoneLine("todo_status_changes", history, "insert", [
          {
            before: null,
            after: {
              id: history[0],
              todo_id: todo.id,
              position: 1,
              completed: true,
              changed_at: changed.statusChanges[1]?.changedAt.toISOString(),
            },
          },
        ]),
      ],
      warn: [],
    });
    expect(JSON.stringify(logs)).not.toContain("牛乳");
    expect(JSON.stringify(logs)).not.toContain("卵");
  });

  test("delete すると、書き込みの前後に todos・id・delete のログを出す（無い id は後のログの changes が空）", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const missing = "00000000-0000-4000-8000-000000000000";

    const logs = await writeLogsBy(async () => {
      await remove(todo.id);
      await remove(missing);
    });

    expect(logs).toStrictEqual({
      info: [
        writeStartLine("todos", [todo.id], "delete"),
        // delete は消した行の全列の before（title は ***）。cascade で消えた履歴の行は記録しない。
        writeDoneLine("todos", [todo.id], "delete", [
          {
            before: {
              id: todo.id,
              title: "***",
              completed: false,
              created_at: todo.createdAt.toISOString(),
            },
            after: null,
          },
        ]),
        writeStartLine("todos", [missing], "delete"),
        { ...writeDoneLine("todos", [missing], "delete", []), changes: [] },
      ],
      warn: [],
    });
  });

  // 失敗は warn（500 の例外は ProblemResponse.from が error で残す）。
  test("ロックせずに読んだ後に delete された Todo を変えて update すると、前のログの後に失敗のログ（warn。Error）を出す", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = (await repository().findById(todo.id)) as Todo;
    await remove(todo.id);
    const error = new Error(`todos has no row to update: ${todo.id}`);

    const logs = await writeLogsBy(() =>
      expect(update(loaded.rename("卵を買う"))).rejects.toEqual(error),
    );

    expect(logs).toStrictEqual({
      info: [writeStartLine("todos", [todo.id], "update")],
      warn: [
        {
          severity: "WARNING",
          time: expect.any(String),
          message: "db write failed",
          event: {
            name: "db_write",
            phase: "failed",
            duration_ms: expect.any(Number),
          },
          db: dbFields("todos", "update"),
          row_id: todo.id,
          error: { type: "Error", message: error.message },
        },
      ],
    });
  });

  // 変わった列も増えた履歴も無い update は SQL を発行しない（上の「SQL を発行しない」）ので、書き込みのログも出さない。
  test("読み込んだ Todo を変えずに update すると、書き込みのログを出さない", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);
    const loaded = await load(todo.id);

    const logs = await writeLogsBy(() => update(loaded));

    expect(logs).toStrictEqual({ info: [], warn: [] });
  });

  test("無い id の findById は undefined を返す", async () => {
    await expect(
      repository().findById("00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeUndefined();
  });

  test("findByIdForUpdate は id に一致する Todo を返す", async () => {
    const todo = Todo.create("牛乳を買う");
    await insert(todo);

    await expect(load(todo.id)).resolves.toEqual(todo);
  });

  test("無い id の findByIdForUpdate は、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const id = "00000000-0000-4000-8000-000000000000";

    await expect(load(id)).rejects.toEqual(
      new DomainError("not_found", "todo.notFound", { id }),
    );
  });

  // WHY uuid の形でない id を「無い」（undefined）にしない: 利用者の入力は presentation の ResourceId.parseUuid が先に 404 にする
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
    await insert(todo);

    await expect(repository().findById(todo.id.toUpperCase())).resolves.toEqual(
      todo,
    );
    await expect(load(todo.id.toUpperCase())).resolves.toEqual(todo);
    await remove(todo.id.toUpperCase());
    await expect(repository().findById(todo.id)).resolves.toBeUndefined();
  });

  test("delete すると取り出せなくなり、他の Todo は残る", async () => {
    const removed = Todo.create("牛乳を買う");
    const kept = Todo.create("卵を買う");
    await insert(removed);
    await insert(kept);

    await remove(removed.id);

    await expect(repository().findById(removed.id)).resolves.toBeUndefined();
    await expect(repository().findAll()).resolves.toEqual([kept]);
  });

  test("無い id の delete は何もしない（エラーにしない）", async () => {
    const kept = Todo.create("卵を買う");
    await insert(kept);

    await remove("00000000-0000-4000-8000-000000000000");

    await expect(repository().findAll()).resolves.toEqual([kept]);
  });

  // WHY findById と同じ: 「無い」として黙って何もしないと、消したつもりで消えていない実装ミスが隠れる。
  test("uuid の形でない id の delete は Postgres の invalid input syntax のエラーで reject し、何も消さない", async () => {
    const kept = Todo.create("卵を買う");
    await insert(kept);

    const result = remove("missing");

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

  // WHY message は英語: ログ（ProblemResponse.from の logger.emit の server_error）に出る開発者向けの文字列で、apps/backend の非テストコードには
  //   自然言語の日本語を置かない（Issue #116）。cause の DomainError の message はキーと params（ErrorKeys.describe）。
  function corruptedRowError(id: string, cause: DomainError): Error {
    return new Error(
      `stored Todo (id: ${id}) violates the invariants: ${cause.message}`,
      { cause },
    );
  }

  test.each(INVALID_ROWS)(
    "不変条件を満たさない行（%s）の findById・findByIdForUpdate は、DomainError ではない Error を投げる（API で 500 になるように）",
    async (_label, override, cause) => {
      const row = invalidRow(override);
      await database.db.insert(todos).values(row);
      await insertHistory(row);

      await expect(repository().findById(row.id)).rejects.toEqual(
        corruptedRowError(row.id, cause),
      );
      await expect(load(row.id)).rejects.toEqual(
        corruptedRowError(row.id, cause),
      );
    },
  );

  test.each(INVALID_ROWS)(
    "不変条件を満たさない行（%s）が 1 行でもあれば、findAll は DomainError ではない Error を投げる",
    async (_label, override, cause) => {
      const row = invalidRow(override);
      await insert(Todo.create("卵を買う"));
      await database.db.insert(todos).values(row);
      await insertHistory(row);

      await expect(repository().findAll()).rejects.toEqual(
        corruptedRowError(row.id, cause),
      );
    },
  );

  // 完了の履歴が不変条件を満たさない行（履歴が無い・最後の completed が todos.completed と違う・日時の並びが壊れている）。
  //   Repository は補わず、不変条件の違反（500）のまま気づけるようにする。
  // WHY 履歴が無い・食い違う行も補わない（Issue #260。#194・#237 では repairHistory が補っていた）: 補っていたのは、デプロイの
  //   切替から backfill までの間に旧リビジョン（履歴を知らない版）が書いた行を読むための下位互換で、本番環境が無い今は要らない。
  //   今のアプリは Todo（不変条件を満たす値）を通してしか書かないので、こうした行は手で入れた行などのデータの誤り。
  test.each([
    ["履歴が無い（未完了）", false, []],
    ["履歴が無い（完了済み）", true, []],
    [
      "最後の completed が todos.completed と違う",
      true,
      [{ completed: false, changedAt: new Date("2026-09-28T00:00:00.000Z") }],
    ],
    [
      "日時が作成日時より前",
      true,
      [
        { completed: false, changedAt: new Date("2026-09-27T00:00:00.000Z") },
        { completed: true, changedAt: new Date("2026-09-28T00:00:00.000Z") },
      ],
    ],
    [
      "日時が逆順で、最後の completed も違う",
      false,
      [
        { completed: false, changedAt: new Date("2026-09-28T05:00:00.000Z") },
        { completed: true, changedAt: new Date("2026-09-28T01:00:00.000Z") },
      ],
    ],
  ] as const)(
    "完了の履歴が不変条件を満たさない行（%s）の findById・findByIdForUpdate・findAll は、DomainError ではない Error を投げる",
    async (_label, completed, history) => {
      const row = invalidRow({});
      await database.db.insert(todos).values({ ...row, completed });
      // WHY 1 行ずつ insert する: 履歴が無い例（空配列）は values([]) が投げるので、まとめて入れられない。
      for (const [position, change] of history.entries()) {
        await database.db
          .insert(todoStatusChanges)
          .values({ todoId: row.id, position, ...change });
      }
      const error = corruptedRowError(
        row.id,
        new DomainError("validation_error", "todo.statusChanges.invalid"),
      );

      await expect(repository().findById(row.id)).rejects.toEqual(error);
      await expect(load(row.id)).rejects.toEqual(error);
      await expect(repository().findAll()).rejects.toEqual(error);
    },
  );
});
