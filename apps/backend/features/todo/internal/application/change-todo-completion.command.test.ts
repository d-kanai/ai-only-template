// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import { Todo } from "../domain/todo";
import { ChangeTodoCompletionCommand } from "./change-todo-completion.command";

// notifications: command が完了の通知に渡したメッセージ（呼ばれた順）。
// WHY 記録する関数を渡す（vi.fn にしない）: 通知の口はコンストラクタで受け取る関数で、型で縛られた偽物をここで書ける
//   （InMemory の Repository と同じく、差し替えはコンストラクタで行う）。
async function setup() {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.save(todo);
  const notifications: string[] = [];
  return {
    repository,
    todo,
    notifications,
    command: new ChangeTodoCompletionCommand(repository, (message) => {
      notifications.push(message);
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChangeTodoCompletionCommand", () => {
  test("completed を true にして保存し、変えた Todo を返す（title はそのまま）", async () => {
    const { repository, todo, command } = await setup();

    const changed = await command.execute({ id: todo.id, completed: true });

    expect(changed).toMatchObject({
      id: todo.id,
      title: "牛乳を買う",
      completed: true,
    });
    await expect(repository.findById(todo.id)).resolves.toEqual(changed);
  });

  // WHY false に戻す場合も見る: 引数を無視して常に true にする実装を通さないため。
  test("完了済みの Todo の completed を false に戻して保存する", async () => {
    const { repository, todo, command } = await setup();
    await command.execute({ id: todo.id, completed: true });

    const changed = await command.execute({ id: todo.id, completed: false });

    expect(changed).toMatchObject({ id: todo.id, completed: false });
    await expect(repository.findById(todo.id)).resolves.toEqual(changed);
  });

  // 完了の履歴（Issue #188）: 完了状態を変えるたびに 1 件ずつ増え、保存される。
  test("完了状態を変えると、完了の履歴が 1 件増えて保存される", async () => {
    const { repository, todo, command } = await setup();

    const changed = await command.execute({ id: todo.id, completed: true });

    expect(changed.statusChanges.map((change) => change.completed)).toEqual([
      false,
      true,
    ]);
    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      statusChanges: changed.statusChanges,
    });
  });

  test("今と同じ完了状態を指定すると、完了の履歴は増えない", async () => {
    const { repository, todo, command } = await setup();

    const changed = await command.execute({ id: todo.id, completed: false });

    expect(changed.statusChanges).toStrictEqual(todo.statusChanges);
    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      statusChanges: todo.statusChanges,
    });
  });

  // 完了の通知（Issue #208）: 未完了 → 完了に変わったときだけ、notification モジュールの expose（notify）を呼ぶ。
  // WHY メッセージは id だけの英語: title などの利用者の値をログに出さない（ログは運用者向けの英語。backend.md の「ログ」）。
  test("未完了の Todo を完了にすると、Todo completed: <id> で 1 回だけ通知する", async () => {
    const { todo, notifications, command } = await setup();

    await command.execute({ id: todo.id, completed: true });

    expect(notifications).toEqual([`Todo completed: ${todo.id}`]);
  });

  // WHY 同じ要求の 2 回目は通知しない: PUT は冪等（同じ要求を 2 回送っても結果が同じ）なので、完了の通知も 1 回にする。
  test("既に完了の Todo をもう一度完了にしても、通知しない", async () => {
    const { todo, notifications, command } = await setup();
    await command.execute({ id: todo.id, completed: true });

    await command.execute({ id: todo.id, completed: true });

    expect(notifications).toEqual([`Todo completed: ${todo.id}`]);
  });

  test("完了の Todo を未完了に戻しても、通知しない", async () => {
    const { todo, notifications, command } = await setup();
    await command.execute({ id: todo.id, completed: true });

    await command.execute({ id: todo.id, completed: false });

    expect(notifications).toEqual([`Todo completed: ${todo.id}`]);
  });

  test("未完了の Todo を未完了にしても、通知しない", async () => {
    const { todo, notifications, command } = await setup();

    await command.execute({ id: todo.id, completed: false });

    expect(notifications).toEqual([]);
  });

  // WHY 保存の後に通知する: 保存に失敗した（完了になっていない）Todo の完了を知らせない。
  test("保存に失敗したら、その例外で reject し、通知しない", async () => {
    const { repository, todo, notifications, command } = await setup();
    vi.spyOn(repository, "save").mockRejectedValue(new Error("save failed"));

    await expect(
      command.execute({ id: todo.id, completed: true }),
    ).rejects.toEqual(new Error("save failed"));

    expect(notifications).toEqual([]);
  });

  test("無い id なら、その id を params に持つ DomainError(not_found, todo.notFound) を投げる", async () => {
    const { command } = await setup();

    await expect(
      command.execute({ id: "missing", completed: true }),
    ).rejects.toMatchObject({
      code: "not_found",
      key: "todo.notFound",
      params: { id: "missing" },
    });
  });
});
