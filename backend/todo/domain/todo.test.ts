// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "@/backend/shared/domain/domain-error";
import { Todo } from "@/backend/todo/domain/todo";

function expectValidationError(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("validation_error");
    return;
  }
  throw new Error("DomainError(validation_error) が投げられなかった");
}

describe("Todo.create", () => {
  test("未完了で作られ、id と作成日時が付く", () => {
    const createdAt = new Date("2026-09-28T00:00:00.000Z");

    const todo = Todo.create("牛乳を買う", createdAt);

    expect(todo.title).toBe("牛乳を買う");
    expect(todo.completed).toBe(false);
    expect(todo.createdAt).toEqual(createdAt);
    // randomUUID の形式（8-4-4-4-12 の 16 進）。
    expect(todo.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("作るたびに別の id になる", () => {
    expect(Todo.create("a").id).not.toBe(Todo.create("a").id);
  });

  test("タイトルの前後の空白は取り除いて保持する", () => {
    expect(Todo.create("  牛乳を買う \n").title).toBe("牛乳を買う");
  });

  test("タイトルは 1 文字と 100 文字を受け付ける", () => {
    expect(Todo.create("a").title).toBe("a");
    expect(Todo.create("a".repeat(100)).title).toBe("a".repeat(100));
  });

  test("絵文字などのサロゲートペアも 1 文字と数える（100 個まで受け付ける）", () => {
    // "🍎".length は 2 だが、利用者から見れば 1 文字。
    expect(Todo.create("🍎".repeat(100)).title).toBe("🍎".repeat(100));
  });

  test.each([
    ["空文字", ""],
    ["空白だけ", "   \t\n"],
    ["101 文字", "a".repeat(101)],
    ["空白を除いて 101 文字", ` ${"a".repeat(101)} `],
  ])("タイトルが%sなら validation_error", (_label, title) => {
    expectValidationError(() => Todo.create(title));
  });
});

describe("Todo#rename", () => {
  test("新しいタイトルの Todo を返し、元の Todo は変えない", () => {
    const original = Todo.create("牛乳を買う");

    const renamed = original.rename(" 卵を買う ");

    expect(renamed.title).toBe("卵を買う");
    expect(renamed.id).toBe(original.id);
    expect(renamed.createdAt).toEqual(original.createdAt);
    expect(original.title).toBe("牛乳を買う");
  });

  test("作成時と同じ不変条件を守る（空なら validation_error）", () => {
    const todo = Todo.create("牛乳を買う");

    expectValidationError(() => todo.rename(" "));
  });
});

describe("Todo#changeCompletion", () => {
  test("完了 / 未完了を切り替えた Todo を返し、元の Todo は変えない", () => {
    const original = Todo.create("牛乳を買う");

    const completed = original.changeCompletion(true);
    const reopened = completed.changeCompletion(false);

    expect(completed.completed).toBe(true);
    expect(reopened.completed).toBe(false);
    expect(completed.id).toBe(original.id);
    expect(completed.title).toBe(original.title);
    expect(original.completed).toBe(false);
  });
});
