// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
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
import {
  createTestDatabase,
  type TestDatabase,
} from "../../test-support/database";
import {
  backfillDirectory,
  backfillFiles,
  main,
  runBackfills,
} from "./backfill";

// データの移行（backfill。Issue #194）の仕様。決まりは .claude/rules/backend.md の「永続化」、決定は
//   ADR docs/adr/workflow/20261001-backfill-after-traffic-switch.md。
// 実 Postgres（compose.yaml）に対して実行する。テスト用のスキーマにマイグレーションを当て、本物の backfill の SQL
//   （shared/drizzle/backfill/）と、架空の SQL（一時ディレクトリの fixture）を流す。

let database: TestDatabase;
let fixtureRoot: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
  fixtureRoot = mkdtempSync(join(tmpdir(), "backfill-"));
});

afterAll(async () => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  await database.close();
});

beforeEach(async () => {
  await database.pool.query("truncate todos cascade");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const OPEN = "11111111-1111-4111-8111-111111111111";
const DONE = "22222222-2222-4222-8222-222222222222";
const HAS_HISTORY = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = new Date("2026-09-30T01:02:03.456Z");
const LATER = new Date("2026-09-30T05:00:00.000Z");

async function insertTodo(id: string, completed: boolean): Promise<void> {
  await database.pool.query(
    "insert into todos (id, title, completed, created_at) values ($1, $2, $3, $4)",
    [id, `todo ${id.slice(0, 1)}`, completed, CREATED_AT],
  );
}

async function insertHistory(
  todoId: string,
  position: number,
  completed: boolean,
  changedAt: Date,
): Promise<void> {
  await database.pool.query(
    "insert into todo_status_changes (todo_id, position, completed, changed_at) values ($1, $2, $3, $4)",
    [todoId, position, completed, changedAt],
  );
}

type History = {
  todoId: string;
  position: number;
  completed: boolean;
  changedAt: Date;
};

async function histories(): Promise<History[]> {
  const { rows } = await database.pool.query<History>(
    `select todo_id as "todoId", position, completed, changed_at as "changedAt"
       from todo_status_changes order by todo_id, position`,
  );
  return rows;
}

// Todo の完了の履歴の不変条件（features/todo の todo.ts の isConsistentHistory と同じ規則）を満たさない Todo の id（昇順）。
//   履歴が 0 件、日時が作成日時から昇順でない、最後の completed が todos.completed と違う。
async function violations(): Promise<string[]> {
  const { rows } = await database.pool.query<{
    id: string;
    completed: boolean;
    createdAt: Date;
  }>(`select id, completed, created_at as "createdAt" from todos order by id`);
  const all = await histories();
  return rows
    .filter(({ id, completed, createdAt }) => {
      const history = all.filter((row) => row.todoId === id);
      const ascending = history.every(
        (row, index) =>
          row.changedAt >= (history[index - 1]?.changedAt ?? createdAt),
      );
      return !ascending || history.at(-1)?.completed !== completed;
    })
    .map(({ id }) => id);
}

// 一時ディレクトリに SQL ファイルを置き、そのディレクトリを返す。
function fixtureDirectory(files: Record<string, string>): string {
  const directory = mkdtempSync(join(fixtureRoot, "dir-"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(directory, name), text);
  }
  return directory;
}

// 出力された 1 行ずつのログ（JSON）。event.name が db_backfill の行だけ。
function backfillLogs(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls
    .map(([line]) => JSON.parse(String(line)) as { event: { name: string } })
    .filter((line) => line.event.name === "db_backfill");
}

function spyLogs() {
  return {
    info: vi.spyOn(console, "log").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

// pid の接続（のトランザクション）が持つロックを待っている接続が 1 つになるまで待つ。
// WHY pg_blocking_pids で見る（todo-repository.postgres.test.ts と同じ）: 別の接続の文が「ロックを待っている」ことを、時間（sleep）
//   ではなく Postgres の状態で確かめる。同じ DB を使う他のテストファイルの接続は、この pid のロックを待たないので数えない。
async function waitUntilBlockedBy(pid: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await database.pool.query<{ blocked: number }>(
        "select count(*)::int as blocked from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
        [pid],
      );
      expect(rows[0]?.blocked).toBe(1);
    },
    { timeout: 3000, interval: 20 },
  );
}

describe("backfill の SQL（shared/drizzle/backfill/）: Todo の完了の履歴", () => {
  // WHY 完了の日時を作成日時にする: 記録が無く分からないので、不変条件の下限（作成日時）にする（0002 のマイグレーションと同じ規則）。
  test("履歴の無い Todo に作成日時の未完了の 1 件目を足し、完了済みならさらに作成日時の完了の 2 件目を足す", async () => {
    await insertTodo(OPEN, false);
    await insertTodo(DONE, true);

    await runBackfills(database.pool, backfillDirectory());

    expect(await histories()).toEqual([
      { todoId: OPEN, position: 0, completed: false, changedAt: CREATED_AT },
      { todoId: DONE, position: 0, completed: false, changedAt: CREATED_AT },
      { todoId: DONE, position: 1, completed: true, changedAt: CREATED_AT },
    ]);
  });

  test("履歴のある Todo は変えない（最後の completed が今の completed と同じ行も、2 件以上ある行も）", async () => {
    await insertTodo(OPEN, false);
    await insertHistory(OPEN, 0, false, CREATED_AT);
    await insertTodo(HAS_HISTORY, false);
    await insertHistory(HAS_HISTORY, 0, false, CREATED_AT);
    await insertHistory(HAS_HISTORY, 1, true, LATER);
    await insertHistory(HAS_HISTORY, 2, false, LATER);
    await insertTodo(DONE, true);
    await insertHistory(DONE, 0, false, CREATED_AT);
    await insertHistory(DONE, 1, true, LATER);
    const before = await histories();

    await runBackfills(database.pool, backfillDirectory());

    expect(await histories()).toEqual(before);
  });

  // WHY 1 件目だけある完了済みの Todo に 2 件目を足す: 1 文目（1 件目）を流した後、2 文目の前に止まった実行（同じトランザクション
  //   なので本来は起きないが、ファイルを分けた場合など）でも、流し直せば不変条件を満たす形にそろう。
  test("未完了の 1 件目だけがある完了済みの Todo には、完了の 2 件目だけを足す", async () => {
    await insertTodo(DONE, true);
    await insertHistory(DONE, 0, false, CREATED_AT);

    await runBackfills(database.pool, backfillDirectory());

    expect(await histories()).toEqual([
      { todoId: DONE, position: 0, completed: false, changedAt: CREATED_AT },
      { todoId: DONE, position: 1, completed: true, changedAt: CREATED_AT },
    ]);
  });

  // WHY 冪等にする: 適用の記録表を持たず、デプロイのたびに全ファイルを流す（.claude/rules/backend.md の「永続化」）。
  // WHY 2 文目だけを流す: READ COMMITTED では文ごとにスナップショットを取るので、1 文目と 2 文目の間に旧アプリが作って完了にした
  //   Todo（履歴 0 件・完了済み）は 2 文目にだけ見える。そのとき (id, 1, true) だけを入れると、履歴が [完了] の 1 件になり、
  //   不変条件は満たすので repair on read でも backfill の流し直しでも直らず、未完了に戻す update が 23505 で 500 になり続ける。
  //   文の区切りは SQL のファイルの「--> statement-breakpoint」の行（drizzle のマイグレーションと同じ書き方）。
  test("履歴 0 件の完了済み Todo に、2 文目（完了の 2 件目を足す文）だけを流しても足さない", async () => {
    await insertTodo(DONE, true);
    const statements = readFileSync(
      join(backfillDirectory(), "0001_todo_status_changes.sql"),
      "utf8",
    ).split("--> statement-breakpoint");
    expect(statements).toHaveLength(3);

    await database.pool.query(String(statements[1]));

    expect(await histories()).toEqual([]);
  });

  // 最後の履歴が todos.completed と食い違う Todo（Issue #237）: 履歴を知らない旧リビジョンが、backfill で履歴が付いた後に
  //   todos.completed だけを変えた Todo。3 文目が末尾に「最後の履歴の日時に、今の completed」を 1 件足す。
  // WHY 日時を最後の履歴の日時にする: 変えた日時の記録が無いので、不変条件（日時は昇順）の下限にする（Repository の repairHistory と同じ）。
  // WHY 2 件以上の履歴の例にする: 2 文目（1 件目だけの完了済み）では足されず、3 文目だけが足すことを確かめる。
  test("最後の履歴が今の完了かどうかと食い違う Todo に、最後の履歴の日時で今の completed の 1 件を足し、2 回流しても増えない", async () => {
    await insertTodo(OPEN, false);
    await insertHistory(OPEN, 0, false, CREATED_AT);
    await insertHistory(OPEN, 1, true, LATER);
    await insertTodo(DONE, true);
    await insertHistory(DONE, 0, false, CREATED_AT);
    await insertHistory(DONE, 1, true, CREATED_AT);
    await insertHistory(DONE, 2, false, LATER);
    const expected = [
      { todoId: OPEN, position: 0, completed: false, changedAt: CREATED_AT },
      { todoId: OPEN, position: 1, completed: true, changedAt: LATER },
      { todoId: OPEN, position: 2, completed: false, changedAt: LATER },
      { todoId: DONE, position: 0, completed: false, changedAt: CREATED_AT },
      { todoId: DONE, position: 1, completed: true, changedAt: CREATED_AT },
      { todoId: DONE, position: 2, completed: false, changedAt: LATER },
      { todoId: DONE, position: 3, completed: true, changedAt: LATER },
    ];

    await runBackfills(database.pool, backfillDirectory());
    expect(await histories()).toEqual(expected);

    await runBackfills(database.pool, backfillDirectory());
    expect(await histories()).toEqual(expected);
  });

  // WHY 3 種類を混ぜて 1 回だけ流す: 1 文目〜3 文目が互いの結果を前提にしても（1 文目で足した 1 件目を 2 文目が見る、など）、
  //   1 回で Todo の不変条件（履歴が 1 件以上・日時は作成日時から昇順・最後の completed が今の completed）を満たす形にそろうこと。
  //   不変条件は domain（features/todo の todo.ts）が持つが、shared の infra から feature の domain は import しない
  //   （rule-tests/architecture.test.ts）ので、同じ規則を violations で数える。
  test("履歴 0 件・1 件目だけ・食い違う Todo を混ぜて 1 回流すと、不変条件を満たさない Todo が残らない", async () => {
    await insertTodo(OPEN, true);
    await insertTodo(DONE, true);
    await insertHistory(DONE, 0, false, CREATED_AT);
    await insertTodo(HAS_HISTORY, false);
    await insertHistory(HAS_HISTORY, 0, false, CREATED_AT);
    await insertHistory(HAS_HISTORY, 1, true, LATER);
    expect(await violations()).toEqual([OPEN, DONE, HAS_HISTORY].sort());

    await runBackfills(database.pool, backfillDirectory());

    expect(await violations()).toEqual([]);
  });

  test("2 回流しても行は増えない（冪等）", async () => {
    await insertTodo(OPEN, false);
    await insertTodo(DONE, true);
    await runBackfills(database.pool, backfillDirectory());
    const once = await histories();

    await runBackfills(database.pool, backfillDirectory());

    expect(await histories()).toEqual(once);
    expect(once).toHaveLength(3);
  });

  // 新しいアプリ（repair on write）との同時実行（Issue #194）。アプリは findByIdForUpdate で todos の行をロックし、履歴の無い
  //   Todo の履歴を補って INSERT する。backfill の SQL は FOR UPDATE OF で todos の行をロックしてアプリと直列化し、ロック待ちの
  //   間にアプリが COMMIT した履歴（文の開始時のスナップショットの NOT EXISTS では見えない）は ON CONFLICT DO NOTHING で捨てる。
  // WHY 2 つの接続を同時に開く: ロックを待つことを、backfill がアプリの接続を待っている（pg_blocking_pids）状態になってから
  //   アプリを COMMIT することで確かめる。FOR UPDATE が無ければ backfill は待たず、この状態にならない。ON CONFLICT が無ければ、
  //   COMMIT の後に backfill が同じ (todo_id, position) を INSERT して一意制約の違反（23505）で失敗する。
  test("アプリのトランザクションが Todo の行をロックしている間は待ち、アプリが履歴を補って COMMIT した後に流れて、履歴を 2 重にしない", async () => {
    await insertTodo(OPEN, false);
    const app = await database.pool.connect();
    let backfill: Promise<void> | undefined;
    try {
      await app.query("begin");
      await app.query("select id from todos where id = $1 for update", [OPEN]);
      const { rows } = await app.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      backfill = runBackfills(database.pool, backfillDirectory());
      await waitUntilBlockedBy(Number(rows[0]?.pid));
      await app.query(
        "insert into todo_status_changes (todo_id, position, completed, changed_at) values ($1, 0, false, $2)",
        [OPEN, LATER],
      );
      await app.query("commit");
      await backfill;
    } finally {
      // WHY finally で終わらせる: 待ちの確認に失敗しても、開いたトランザクションと走っている backfill を終わらせてからテストを
      //   失敗させる（開いたままだと次のテストの truncate がロックを待ち続ける。todo-repository.postgres.test.ts と同じ理由）。
      //   COMMIT の後の rollback は何もしない（警告だけ）。
      await app.query("rollback");
      app.release();
      await Promise.allSettled([backfill]);
    }

    expect(await histories()).toEqual([
      { todoId: OPEN, position: 0, completed: false, changedAt: LATER },
    ]);
  });

  // 3 文目（食い違いの補い。Issue #237）も 1 文目と同じく、アプリ（repair on write）との同時実行で履歴を 2 重にしない。
  // WHY アプリは todos を変えずに履歴だけを書く: todos の行が変わらないので、backfill はロックが取れた後に行を読み直さず
  //   （READ COMMITTED の再評価が起きない）、文の開始時のスナップショットのまま (todo_id, 最後の position + 1) を INSERT する。
  //   ON CONFLICT DO NOTHING が無ければ、アプリが COMMIT した同じ position と一意制約の違反（23505）になる。
  test("食い違う Todo の行をアプリがロックして履歴を補い COMMIT するまで待ち、その後に流れて、履歴を 2 重にしない", async () => {
    await insertTodo(OPEN, false);
    await insertHistory(OPEN, 0, false, CREATED_AT);
    await insertHistory(OPEN, 1, true, CREATED_AT);
    const app = await database.pool.connect();
    let backfill: Promise<void> | undefined;
    try {
      await app.query("begin");
      await app.query("select id from todos where id = $1 for update", [OPEN]);
      const { rows } = await app.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      backfill = runBackfills(database.pool, backfillDirectory());
      await waitUntilBlockedBy(Number(rows[0]?.pid));
      await app.query(
        "insert into todo_status_changes (todo_id, position, completed, changed_at) values ($1, 2, false, $2)",
        [OPEN, LATER],
      );
      await app.query("commit");
      await backfill;
    } finally {
      // WHY finally で終わらせる: 上の 1 文目のテストと同じ。
      await app.query("rollback");
      app.release();
      await Promise.allSettled([backfill]);
    }

    expect(await histories()).toEqual([
      { todoId: OPEN, position: 0, completed: false, changedAt: CREATED_AT },
      { todoId: OPEN, position: 1, completed: true, changedAt: CREATED_AT },
      { todoId: OPEN, position: 2, completed: false, changedAt: LATER },
    ]);
  });

  // WHY 履歴のある Todo をロックしない: FOR UPDATE OF は SELECT が返す行（WHERE NOT EXISTS で絞った、補う対象の行）だけをロックする。
  //   絞らないとすべての Todo の行をロックし、流している間、履歴のある Todo を変えるアプリの要求まで待たせる。
  // WHY 待たないことを時間で見る: 待つ状態（pg_blocking_pids）は「起きない」ことを確かめられない。2 秒で終わらなければ待ったとみなす。
  test("アプリが履歴のある Todo（未完了・完了済み）の行をロックしていても、backfill は待たずに終わる", async () => {
    await insertTodo(HAS_HISTORY, false);
    await insertHistory(HAS_HISTORY, 0, false, CREATED_AT);
    await insertTodo(DONE, true);
    await insertHistory(DONE, 0, false, CREATED_AT);
    await insertHistory(DONE, 1, true, LATER);
    const app = await database.pool.connect();
    let backfill: Promise<void> | undefined;
    try {
      await app.query("begin");
      await app.query("select id from todos for update");
      backfill = runBackfills(database.pool, backfillDirectory());
      const outcome = await Promise.race([
        backfill.then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("waited"), 2000)),
      ]);
      expect(outcome).toBe("done");
    } finally {
      await app.query("rollback");
      app.release();
      await Promise.allSettled([backfill]);
    }
  });
});

describe("runBackfills", () => {
  // WHY 名前順: 後のファイルが前のファイルの結果（足した行・表）を前提にできるようにする（NNNN_ の番号で順を決める）。
  test("ディレクトリの .sql を名前順にすべて実行し、.sql でないファイルは読まない", async () => {
    const directory = fixtureDirectory({
      "0002_insert.sql": "insert into backfill_order values ('second');",
      "0001_create.sql":
        "create table backfill_order (name text); insert into backfill_order values ('first');",
      "README.md": "this is not sql;",
    });

    await runBackfills(database.pool, directory);

    const { rows } = await database.pool.query(
      "select name from backfill_order",
    );
    expect(rows).toEqual([{ name: "first" }, { name: "second" }]);
    await database.pool.query("drop table backfill_order");
  });

  test("ファイルごとに start と done（足した・変えた行の数の合計と所要時間）のログを出す（行の数の無い文は 0 として数える）", async () => {
    const spies = spyLogs();
    await insertTodo(OPEN, false);
    await insertTodo(DONE, true);
    const directory = fixtureDirectory({
      "0001_a.sql": `create temporary table backfill_log (n int) on commit drop;
        insert into backfill_log values (1), (2);
        update todos set title = 'x';`,
    });

    await runBackfills(database.pool, directory);

    expect(backfillLogs(spies.info)).toEqual([
      expect.objectContaining({
        severity: "INFO",
        message: "backfill start",
        event: { name: "db_backfill", phase: "start" },
        file: { name: "0001_a.sql" },
      }),
      expect.objectContaining({
        severity: "INFO",
        message: "backfill done",
        event: {
          name: "db_backfill",
          phase: "done",
          duration_ms: expect.any(Number),
        },
        file: { name: "0001_a.sql" },
        affected_rows: 4,
      }),
    ]);
    expect(spies.error).not.toHaveBeenCalled();
  });

  // WHY ファイルを 1 つのトランザクションにする: 途中の文で失敗したとき、前の文の結果だけが残る半端な状態にしない。直して流し直せば
  //   最初から当たる。
  test("文が失敗したファイルは ROLLBACK して、failed のログ（SQLSTATE と例外）を出し、後のファイルを実行せずに例外を投げる", async () => {
    const spies = spyLogs();
    await insertTodo(OPEN, false);
    const directory = fixtureDirectory({
      "0001_fails.sql": `update todos set title = 'changed';
        select 1 / 0;`,
      "0002_not_run.sql": "update todos set title = 'not run';",
    });

    const error = await runBackfills(database.pool, directory).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({
      message: "division by zero",
      code: "22012",
    });
    const { rows } = await database.pool.query("select title from todos");
    expect(rows).toEqual([{ title: "todo 1" }]);
    expect(backfillLogs(spies.info)).toEqual([
      expect.objectContaining({
        event: { name: "db_backfill", phase: "start" },
        file: { name: "0001_fails.sql" },
      }),
    ]);
    expect(backfillLogs(spies.error)).toEqual([
      {
        severity: "ERROR",
        time: expect.any(String),
        message: "backfill failed",
        event: {
          name: "db_backfill",
          phase: "failed",
          duration_ms: expect.any(Number),
        },
        file: { name: "0001_fails.sql" },
        db: { response: { status_code: "22012" } },
        error: { type: "error", message: "division by zero" },
      },
    ]);
  });

  test("接続できなければ、failed のログ（SQLSTATE なし）を出して例外を投げる", async () => {
    const spies = spyLogs();
    // WHY ポート 1: 待ち受けが無く、すぐに接続を拒否される。
    const unreachable = new Pool({
      connectionString: "postgres://app:app@127.0.0.1:1/app",
    });
    const directory = fixtureDirectory({ "0001_a.sql": "select 1;" });

    try {
      await expect(runBackfills(unreachable, directory)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    } finally {
      await unreachable.end();
    }

    expect(backfillLogs(spies.error)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ phase: "failed" }),
        file: { name: "0001_a.sql" },
        error: expect.objectContaining({ type: "Error" }),
      }),
    ]);
    expect(backfillLogs(spies.error)[0]).not.toHaveProperty("db");
  });
});

describe("backfillDirectory / backfillFiles", () => {
  test("backfill の SQL の置き場所は apps/backend/shared/drizzle/backfill/ で、今回の Todo の履歴のファイルを含む", () => {
    expect(realpathSync(backfillDirectory())).toBe(
      realpathSync(join(import.meta.dirname, "..", "drizzle", "backfill")),
    );
    expect(backfillFiles(backfillDirectory())).toContain(
      "0001_todo_status_changes.sql",
    );
  });

  test("ディレクトリが無ければ例外を投げる（0 件として黙って成功しない）", () => {
    expect(() => backfillFiles(join(fixtureRoot, "missing"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});

describe("main（pnpm db:backfill の本体）", () => {
  // WHY .env の DB（getDatabase）に流す SQL を、何も変えない select にする: main は環境変数の接続先を使い、テスト用のスキーマに
  //   向けられない。接続・実行・終了コード・プールを閉じることだけを確かめる（中身は runBackfills のテスト）。
  test("すべてのファイルが成功したら 0 を返し、プールを閉じる", async () => {
    spyLogs();
    const directory = fixtureDirectory({ "0001_a.sql": "select 1;" });

    expect(await main(directory)).toBe(0);
    expect(await main(directory)).toBe(0);
  });

  test("ファイルが失敗したら 1 を返す（ログは runBackfills が出す）", async () => {
    const spies = spyLogs();
    const directory = fixtureDirectory({ "0001_a.sql": "select 1 / 0;" });

    expect(await main(directory)).toBe(1);
    expect(backfillLogs(spies.error)).toHaveLength(1);
  });

  test("backfill のディレクトリが無ければ 1 を返す", async () => {
    expect(await main(join(fixtureRoot, "missing"))).toBe(1);
  });
});

describe("pnpm db:backfill の script（apps/backend/package.json）", () => {
  // WHY script をそのまま子プロセスで実行する: node が backend の TypeScript を直接動かせること（型の消去と ts-resolve.ts の
  //   resolve フック）と、終了コードを確かめる。Vitest の中の import では、Node の解決（拡張子の無い import）は通らない。
  // WHY 接続先を DATABASE_URL の options でテスト用のスキーマに向ける: 環境変数は .env より優先される（apps/shared/env.ts）。
  async function runScript(schema: string): Promise<{ status: number }> {
    const { scripts } = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    const url = new URL(database.url);
    url.searchParams.set("options", `-c search_path=${schema}`);
    try {
      execFileSync(
        "sh",
        ["-c", `DATABASE_URL='${url.toString()}' ${scripts["db:backfill"]}`],
        {
          cwd: join(import.meta.dirname, "..", ".."),
          stdio: "pipe",
          timeout: 30_000,
        },
      );
      return { status: 0 };
    } catch (error) {
      return { status: (error as { status: number }).status };
    }
  }

  test("テスト用のスキーマに backfill を流して 0 で終わる", async () => {
    await insertTodo(DONE, true);
    const { rows } = await database.pool.query<{ schema: string }>(
      "select current_schema() as schema",
    );

    expect(await runScript(String(rows[0]?.schema))).toEqual({ status: 0 });
    expect(await histories()).toHaveLength(2);
  });

  test("SQL が失敗したら（表の無いスキーマ）非 0 で終わる", async () => {
    expect(await runScript("backfill_missing_schema")).toEqual({ status: 1 });
  });
});
