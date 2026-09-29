// @vitest-environment node
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { DomainError } from "../../../shared/domain/domain-error";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../../shared/infra/database.test-support";
import { Todo } from "../domain/todo";
import { todos } from "./schema";
import { PostgresTodoRepository } from "./todo-repository.postgres";

// 実 Postgres（compose.yaml。`pnpm db:up` で起動）に対して実行する。
// テスト用のスキーマにマイグレーション（drizzle/）を当て、各テストの前に todos を空にする（テスト同士が干渉しない）。
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await database.migrate();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.db.execute(sql`truncate todos`);
});

function repository(): PostgresTodoRepository {
  return new PostgresTodoRepository(database.db);
}

describe("PostgresTodoRepository", () => {
  test("空の状態では findAll が空配列を返す", async () => {
    await expect(repository().findAll()).resolves.toEqual([]);
  });

  test("save した Todo を findById / findAll で同じ値（id・title・completed・作成日時）として取り出せる", async () => {
    const todo = Todo.create(
      "牛乳を買う",
      new Date("2026-09-28T01:02:03.456Z"),
    ).changeCompletion(true);

    await repository().save(todo);

    await expect(repository().findById(todo.id)).resolves.toEqual(todo);
    await expect(repository().findAll()).resolves.toEqual([todo]);
  });

  // 並び順のテスト用に id を固定した Todo を作る（Todo.create の id は乱数で、id の大小が決まらないため）。
  function todoWith(id: string, title: string, createdAt: string): Todo {
    return Todo.reconstruct({
      id,
      title,
      completed: false,
      createdAt: new Date(createdAt),
    });
  }

  test("findAll は作成日時の昇順で返す（保存した順・id の順によらない）", async () => {
    // id の順（小さい順）は 新しい → 真ん中 → 古い で、作成日時の順と逆にする。id 順に並べる実装では通らない。
    const newer = todoWith(
      "00000000-0000-4000-8000-000000000001",
      "新しい",
      "2026-09-28T10:00:00.000Z",
    );
    const middle = todoWith(
      "00000000-0000-4000-8000-000000000002",
      "真ん中",
      "2026-09-28T09:30:00.000Z",
    );
    const older = todoWith(
      "00000000-0000-4000-8000-000000000003",
      "古い",
      "2026-09-28T09:00:00.000Z",
    );
    await repository().save(newer);
    await repository().save(older);
    await repository().save(middle);

    const todos = await repository().findAll();

    expect(todos.map((todo) => todo.title)).toEqual([
      "古い",
      "真ん中",
      "新しい",
    ]);
  });

  test("作成日時が同じ Todo は id の昇順で返す（保存した順によらず、毎回同じ順になる）", async () => {
    const createdAt = "2026-09-28T09:00:00.000Z";
    const larger = todoWith(
      "ffffffff-0000-4000-8000-000000000000",
      "大きい id",
      createdAt,
    );
    const smaller = todoWith(
      "00000000-0000-4000-8000-000000000000",
      "小さい id",
      createdAt,
    );
    // id の大きい方から保存し、保存した順ではなく id の順に並ぶことを確かめる。
    await repository().save(larger);
    await repository().save(smaller);

    const todos = await repository().findAll();

    expect(todos.map((todo) => todo.title)).toEqual(["小さい id", "大きい id"]);
  });

  test("同じ id で save すると title と completed を上書きし（upsert）、行は増えない", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);

    const updated = todo.rename("卵を買う").changeCompletion(true);
    await repository().save(updated);

    await expect(repository().findAll()).resolves.toEqual([updated]);
  });

  test("無い id の findById は undefined を返す", async () => {
    await expect(
      repository().findById("00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeUndefined();
  });

  test("uuid の形でない id の findById は、DB のエラーにせず undefined を返す（API で 404 になるように）", async () => {
    await expect(repository().findById("missing")).resolves.toBeUndefined();
  });

  test("uuid の前後に余分な文字が付いた id も、DB のエラーにせず undefined を返す", async () => {
    const todo = Todo.create("牛乳を買う");
    await repository().save(todo);

    await expect(repository().findById(`x${todo.id}`)).resolves.toBeUndefined();
    await expect(repository().findById(`${todo.id}x`)).resolves.toBeUndefined();
  });

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

  test("無い id・uuid の形でない id の delete は何もしない（エラーにしない）", async () => {
    const kept = Todo.create("卵を買う");
    await repository().save(kept);

    await repository().delete("00000000-0000-4000-8000-000000000000");
    await repository().delete("missing");

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

  function invalidRow(override: { id?: string; title?: string }) {
    return {
      id: "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e",
      title: "牛乳を買う",
      completed: false,
      createdAt: new Date("2026-09-28T00:00:00.000Z"),
      ...override,
    };
  }

  // WHY message は英語: ログ（toErrorResponse の logger.error）に出る開発者向けの文字列で、apps/backend の非テストコードには
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

      await expect(repository().findAll()).rejects.toEqual(
        corruptedRowError(row.id, cause),
      );
    },
  );
});
