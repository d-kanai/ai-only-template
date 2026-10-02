// @vitest-environment node
import { asc, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  todoStatusChanges,
  todos,
} from "../../features/todo/internal/infra/schema";
import { changeLogs } from "../../shared/infra/schema";
import { createTestDatabase, type TestDatabase } from "../database";
import { aTodo } from "./todo-builder";

// テストデータビルダー aTodo（todo-builder.ts）の仕様。実 Postgres（テスト用のスキーマ）に入った行と、build() の返り値を比べる。
// WHY 実 Postgres で確かめる: ビルダーは API 仕様（spec/api/）の前提を表に直接入れる道具で、入った行（列・履歴の位置・日時）が
//   ずれると、仕様の期待値が DB と食い違ったまま気づけない。

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
});

function todoRows() {
  return database.db
    .select()
    .from(todos)
    .orderBy(asc(todos.createdAt), asc(todos.id));
}

// 完了の履歴の行のうち、比べる列（行の id は DB の既定値の乱数なので除く）を Todo の id・位置の順に並べる。
function statusRows() {
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

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("aTodo（Todo のテストデータビルダー）", () => {
  it("何も指定しなければ、乱数の id・固定のタイトル・未完了・今の日時の Todo と、作成時の未完了の履歴が 1 件入る", async () => {
    const before = Date.now();

    const todo = await aTodo(database.db).build();

    const after = Date.now();
    expect(todo).toStrictEqual({
      id: expect.stringMatching(UUID_V4),
      title: "Buy milk",
      completed: false,
      createdAt: todo.createdAt,
      statusChanges: [{ completed: false, changedAt: todo.createdAt }],
    });
    expect(todo.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(todo.createdAt.getTime()).toBeLessThanOrEqual(after);
    await expect(todoRows()).resolves.toStrictEqual([
      {
        id: todo.id,
        title: "Buy milk",
        completed: false,
        createdAt: todo.createdAt,
      },
    ]);
    await expect(statusRows()).resolves.toStrictEqual([
      {
        todoId: todo.id,
        position: 0,
        completed: false,
        changedAt: todo.createdAt,
      },
    ]);
  });

  it("id・タイトル・作成日時を指定すると、その値で入る", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");

    const todo = await aTodo(database.db)
      .id("00000000-0000-4000-8000-000000000001")
      .title("牛乳を買う")
      .createdAt(createdAt)
      .build();

    expect(todo).toStrictEqual({
      id: "00000000-0000-4000-8000-000000000001",
      title: "牛乳を買う",
      completed: false,
      createdAt,
      statusChanges: [{ completed: false, changedAt: createdAt }],
    });
    await expect(todoRows()).resolves.toStrictEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        title: "牛乳を買う",
        completed: false,
        createdAt,
      },
    ]);
  });

  // 完了の Todo の履歴は、作成時の未完了と、作成日時の完了の 2 件（不変条件を満たす最小の履歴）。
  it("完了を指定すると、完了の Todo と、作成日時の未完了・完了の履歴 2 件が入る", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");

    const todo = await aTodo(database.db)
      .completed(true)
      .createdAt(createdAt)
      .build();

    expect(todo).toStrictEqual({
      id: todo.id,
      title: "Buy milk",
      completed: true,
      createdAt,
      statusChanges: [
        { completed: false, changedAt: createdAt },
        { completed: true, changedAt: createdAt },
      ],
    });
    await expect(todoRows()).resolves.toStrictEqual([
      { id: todo.id, title: "Buy milk", completed: true, createdAt },
    ]);
    await expect(statusRows()).resolves.toStrictEqual([
      { todoId: todo.id, position: 0, completed: false, changedAt: createdAt },
      { todoId: todo.id, position: 1, completed: true, changedAt: createdAt },
    ]);
  });

  // 壊れた Todo（日時が作成日時より前・逆順。Repository が読むと不変条件の違反で 500）も作れる。
  it("完了の履歴を指定すると、completed から導かずに指定した順のまま入る", async () => {
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    const statusChanges = [
      { completed: false, changedAt: new Date("2026-08-31T00:00:00.000Z") },
      { completed: true, changedAt: new Date("2026-08-30T00:00:00.000Z") },
    ];

    const todo = await aTodo(database.db)
      .completed(true)
      .createdAt(createdAt)
      .statusChanges(statusChanges)
      .build();

    expect(todo.statusChanges).toStrictEqual(statusChanges);
    await expect(statusRows()).resolves.toStrictEqual([
      {
        todoId: todo.id,
        position: 0,
        completed: false,
        changedAt: new Date("2026-08-31T00:00:00.000Z"),
      },
      {
        todoId: todo.id,
        position: 1,
        completed: true,
        changedAt: new Date("2026-08-30T00:00:00.000Z"),
      },
    ]);
  });

  // 履歴の無い Todo（壊れた Todo。Repository の読み出しで 500 になることを確かめる前提に使う）も作れる。
  it("空の履歴を指定すると、Todo だけが入り、完了の履歴は入らない", async () => {
    const todo = await aTodo(database.db).statusChanges([]).build();

    expect(todo.statusChanges).toStrictEqual([]);
    await expect(todoRows()).resolves.toStrictEqual([
      {
        id: todo.id,
        title: "Buy milk",
        completed: false,
        createdAt: todo.createdAt,
      },
    ]);
    await expect(statusRows()).resolves.toStrictEqual([]);
  });

  // WHY: 前提の用意は Writer を通らない（記録は対象の操作のものだけにする。spec/api/todo/support.ts の冒頭）。
  it("変更の記録（change_logs）は書かない", async () => {
    await aTodo(database.db).completed(true).build();

    await expect(database.db.select().from(changeLogs)).resolves.toStrictEqual(
      [],
    );
  });

  // WHY 同じビルダーから 2 回 build する: setter が元のビルダーを書き換えない（ほかの前提に値が漏れない）ことと、id を build の
  //   たびに作ることを確かめる。
  it("同じビルダーから 2 件入れると別の id になり、後から足した指定は元のビルダーに残らない", async () => {
    const base = aTodo(database.db).title("牛乳を買う");

    const milk = await base.build();
    const done = await base.completed(true).build();
    const again = await base.build();

    expect(new Set([milk.id, done.id, again.id]).size).toBe(3);
    expect([milk.completed, done.completed, again.completed]).toStrictEqual([
      false,
      true,
      false,
    ]);
    expect([milk.title, done.title, again.title]).toStrictEqual([
      "牛乳を買う",
      "牛乳を買う",
      "牛乳を買う",
    ]);
    await expect(todoRows()).resolves.toHaveLength(3);
  });
});
