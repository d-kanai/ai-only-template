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
import {
  createTestDatabase,
  type TestDatabase,
} from "@/backend/shared/infra/database.test-support";
import { Todo } from "@/backend/todo/domain/todo";
import { PostgresTodoRepository } from "@/backend/todo/infra/todo-repository.postgres";

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
    return Todo.restore({
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

  test("トランザクションの executor を渡すと、その中で読み書きする", async () => {
    const todo = Todo.create("牛乳を買う");

    await expect(
      database.db.transaction(async (tx) => {
        await new PostgresTodoRepository(tx).save(todo);
        throw new Error("rollback させる");
      }),
    ).rejects.toEqual(new Error("rollback させる"));

    await expect(repository().findAll()).resolves.toEqual([]);
  });
});
