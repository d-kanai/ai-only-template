// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TransactionRunner } from "../../../../shared/application/transaction";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "../../../../test-support/transaction-runner.in-memory";
import { Todo } from "../domain/todo";
import { ChangeTodoCompletionCommand } from "./change-todo-completion.command";

// notifications: command が完了の通知に渡したメッセージ（呼ばれた順）。
// WHY 記録する関数を渡す（vi.fn にしない）: 通知の口はコンストラクタで受け取る関数で、型で縛られた偽物をここで書ける
//   （InMemory の Repository と同じく、差し替えはコンストラクタで行う）。
async function setup(
  transactions: TransactionRunner = new InMemoryTransactionRunner(),
) {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.insert(todo, inMemoryTransaction);
  const notifications: string[] = [];
  return {
    repository,
    todo,
    notifications,
    command: new ChangeTodoCompletionCommand(
      repository,
      transactions,
      (message) => {
        notifications.push(message);
      },
    ),
  };
}

// run の work が終わった（COMMIT した）ことを events に記録する runner（create-todo.command.test.ts と同じ）。
function committingRunner(events: string[]): TransactionRunner {
  return {
    async run(work) {
      const result = await work(inMemoryTransaction);
      events.push("commit");
      return result;
    },
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
    vi.spyOn(repository, "update").mockRejectedValue(new Error("save failed"));

    await expect(
      command.execute({ id: todo.id, completed: true }),
    ).rejects.toEqual(new Error("save failed"));

    expect(notifications).toEqual([]);
  });

  // WHY 通知はトランザクションの外（run が resolve した後）: 保存が確定（COMMIT）してから知らせる。update が成功しても COMMIT が
  //   失敗すれば完了は戻るので、run の中で通知すると、完了していない Todo の完了を知らせてしまう（Issue #215）。
  test("update の後に COMMIT が失敗したら、その例外で reject し、通知しない", async () => {
    const failingCommit: TransactionRunner = {
      async run(work) {
        await work(inMemoryTransaction);
        throw new Error("commit failed");
      },
    };
    const { todo, notifications, command } = await setup(failingCommit);

    await expect(
      command.execute({ id: todo.id, completed: true }),
    ).rejects.toEqual(new Error("commit failed"));

    expect(notifications).toEqual([]);
  });

  // WHY 読み込み（行ロック）と書き込みを同じ tx で行う（Issue #215）: 読んでから書くまでの間に、別の要求が同じ Todo を変えられない
  //   （通知の条件「未完了 → 完了」も、読んだ値のまま判定できる）。
  test("findByIdForUpdate と update を run が渡した同じ tx で run の中で行い、通知は COMMIT の後に行う", async () => {
    const events: string[] = [];
    const { repository, todo } = await setup();
    const loaded = (await repository.findById(todo.id)) as Todo;
    const find = vi
      .spyOn(repository, "findByIdForUpdate")
      .mockImplementation(async () => {
        events.push("findByIdForUpdate");
        return loaded;
      });
    const update = vi
      .spyOn(repository, "update")
      .mockImplementation(async () => {
        events.push("update");
      });
    const notifying = new ChangeTodoCompletionCommand(
      repository,
      committingRunner(events),
      () => {
        events.push("notify");
      },
    );

    const changed = await notifying.execute({ id: todo.id, completed: true });

    expect(find.mock.calls).toEqual([[todo.id, inMemoryTransaction]]);
    expect(update.mock.calls).toEqual([[changed, inMemoryTransaction]]);
    expect(events).toEqual(["findByIdForUpdate", "update", "commit", "notify"]);
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
