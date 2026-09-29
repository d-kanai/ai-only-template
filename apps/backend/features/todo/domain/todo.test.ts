// @vitest-environment node
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DomainError } from "../../../shared/domain/domain-error";
import type { ErrorKey } from "../../../shared/domain/error-key";
import { keyedIssue, keyedRefine, Todo, validate } from "./todo";

// key と params は API の ErrorResponse として画面に渡る（画面が翻訳するクライアントとの契約。Issue #116）ので、両方を検証する。
// WHY toEqual に params: undefined を含める: params の無いキーで params が {} などになっていないことも確かめる
//   （toEqual は undefined のプロパティと無いプロパティを同じに扱うが、{} とは区別する）。
function expectValidationError(
  action: () => unknown,
  expected: { key: ErrorKey; params?: Record<string, string | number> },
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const { code, key, params } = error as DomainError;
    expect({ code, key, params }).toEqual({
      code: "validation_error",
      params: undefined,
      ...expected,
    });
    return;
  }
  throw new Error("DomainError(validation_error) が投げられなかった");
}

const EMPTY_TITLE = { key: "todo.title.empty" } as const;
const TOO_LONG_TITLE = {
  key: "todo.title.tooLong",
  params: { max: 100 },
} as const;
const INVALID_ID = { key: "todo.id.invalid" } as const;
const INVALID_CREATED_AT = { key: "todo.createdAt.invalid" } as const;

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
    // String#length（UTF-16 のコード単位の数。zod の .max(100) もこれで数える）なら 200 文字になり弾かれる。
    expect(Todo.create("🍎".repeat(100)).title).toBe("🍎".repeat(100));
  });

  test("前後の空白は文字数に数えない（空白を除いて 100 文字なら受け付ける）", () => {
    expect(Todo.create(`  ${"a".repeat(100)}\t`).title).toBe("a".repeat(100));
  });

  test.each([
    ["空文字", "", EMPTY_TITLE],
    ["空白だけ", "   \t\n", EMPTY_TITLE],
    ["101 文字", "a".repeat(101), TOO_LONG_TITLE],
    ["空白を除いて 101 文字", ` ${"a".repeat(101)} `, TOO_LONG_TITLE],
    ["絵文字 101 個", "🍎".repeat(101), TOO_LONG_TITLE],
  ])(
    "タイトルが%sなら validation_error を、理由の key（と params）付きで投げる",
    (_label, title, expected) => {
      expectValidationError(() => Todo.create(title), expected);
    },
  );

  // 完全コンストラクタ: create はタイトルだけでなく Todo のすべての値（TodoProps）を検証してから作る。
  test("作成日時が日付として不正（Invalid Date）なら validation_error を投げる", () => {
    expectValidationError(
      () => Todo.create("牛乳を買う", new Date("not a date")),
      INVALID_CREATED_AT,
    );
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

  test("完了済みの Todo の名前を変えても、完了状態・id・作成日時は変わらない", () => {
    // rename はタイトルだけを差し替える。{ ...this } の展開で他の値を引き継ぐので、
    //   completed を未完了に戻す（false 固定にする）ような書き換えを検出するため、完了済みから始める。
    //   未完了から始めると、false 固定にしても結果が同じで見逃す。
    const completed = Todo.create("牛乳を買う").changeCompletion(true);

    const renamed = completed.rename("卵を買う");

    expect(renamed.completed).toBe(true);
    expect(renamed.id).toBe(completed.id);
    expect(renamed.createdAt).toEqual(completed.createdAt);
    expect(renamed.title).toBe("卵を買う");
  });

  test.each([
    ["空白だけ", " ", EMPTY_TITLE],
    ["101 文字", "a".repeat(101), TOO_LONG_TITLE],
  ])(
    "作成時と同じ不変条件を守る（%sなら validation_error）",
    (_label, title, expected) => {
      const todo = Todo.create("牛乳を買う");

      expectValidationError(() => todo.rename(title), expected);
    },
  );
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

  // WHY 型に反する値を as で渡す: 型の上では boolean しか渡せないが、完全コンストラクタは口によらず全体を検証する
  //   （todo.ts のコメント）。completed の規則（boolean であること）も、changeCompletion を通って守られることを確かめる。
  test("completed が boolean でなければ validation_error を投げる（全体を検証する）", () => {
    const todo = Todo.create("牛乳を買う");

    expectValidationError(
      () => todo.changeCompletion("true" as unknown as boolean),
      { key: "todo.completed.invalid" },
    );
  });
});

describe("Todo.reconstruct", () => {
  const VALID_ID = "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e";
  const CREATED_AT = new Date("2026-09-28T00:00:00.000Z");

  // WHY 型に反する値を as で渡す: 型の上では string しか渡せないが、文字列でない値にもキーを付ける
  //   （zod の既定の英語の文言を domain の外に出さない。todo.ts の todoTitleSchema のコメント）。
  test("title が文字列でなければ validation_error を投げる", () => {
    expectValidationError(
      () =>
        Todo.reconstruct({
          id: VALID_ID,
          title: undefined as unknown as string,
          completed: false,
          createdAt: CREATED_AT,
        }),
      { key: "todo.title.invalid" },
    );
  });

  test("保存済みの値（id・title・completed・作成日時）をそのまま持つ Todo を作る", () => {
    const todo = Todo.reconstruct({
      id: VALID_ID,
      title: "牛乳を買う",
      completed: true,
      createdAt: CREATED_AT,
    });

    expect(todo).toBeInstanceOf(Todo);
    expect(todo.id).toBe(VALID_ID);
    expect(todo.title).toBe("牛乳を買う");
    expect(todo.completed).toBe(true);
    expect(todo.createdAt).toEqual(CREATED_AT);
  });

  // create と同じスキーマを通るので、前後の空白は取り除かれる（規則を満たす形にそろう）。
  test("タイトルの前後の空白は取り除いて保持する", () => {
    const todo = Todo.reconstruct({
      id: VALID_ID,
      title: "  牛乳を買う \n",
      completed: false,
      createdAt: CREATED_AT,
    });

    expect(todo.title).toBe("牛乳を買う");
  });

  // Issue #94: 保存済みの値も今の不変条件で検査する（Todo 型 = 不変条件を満たす値）。規則を厳しくしたときは、
  //   既存のデータを移行（スキル db-migration）してから規則を変える。
  test.each([
    ["タイトルが空文字", { title: "" }, EMPTY_TITLE],
    ["タイトルが空白だけ", { title: "   \t\n" }, EMPTY_TITLE],
    ["タイトルが 101 文字", { title: "a".repeat(101) }, TOO_LONG_TITLE],
    ["id が uuid の形でない", { id: "missing" }, INVALID_ID],
    // Postgres の uuid 型は受け付けるが、RFC 9562 の形ではない（版の桁が 0）。
    [
      "id の版の桁が 0",
      { id: "8d0f4f39-6f0b-0a39-9d53-0a3f8b1c2d4e" },
      INVALID_ID,
    ],
    [
      "作成日時が Invalid Date",
      { createdAt: new Date("not a date") },
      INVALID_CREATED_AT,
    ],
  ])(
    "%sなら validation_error を、理由の key（と params）付きで投げる",
    (_label, override, expected) => {
      expectValidationError(
        () =>
          Todo.reconstruct({
            id: VALID_ID,
            title: "牛乳を買う",
            completed: false,
            createdAt: CREATED_AT,
            ...override,
          }),
        expected,
      );
    },
  );
});

// keyedIssue / keyedRefine はスキーマに ErrorKey（と params）を付ける口。validate が issue から DomainError に戻す。
describe("keyedIssue / keyedRefine", () => {
  test("keyedIssue は params の無いキーを zod の error にする", () => {
    expect(keyedIssue("todo.title.empty")).toEqual({
      error: "todo.title.empty",
    });
  });

  test("keyedRefine はキーを zod の error に、params を zod の params にする", () => {
    expect(keyedRefine("todo.title.tooLong", { max: 100 })).toEqual({
      error: "todo.title.tooLong",
      params: { max: 100 },
    });
  });

  // WHY 型で止める: 型の検査（z.string など）の issue は params を運ばない（zod 4.6.5。refine の custom の issue だけが
  //   params を載せる）。params の要るキーを型の検査に付けると、型は通っても実行時に params が落ち、画面の文言の
  //   埋め込み（{max}）が欠ける。
  test("params の要るキーは keyedIssue に渡せない（型の検査に付けると params が落ちる）", () => {
    // @ts-expect-error todo.title.tooLong は params を持つので keyedIssue では付けられない（refine に keyedRefine で付ける）
    z.string(keyedIssue("todo.title.tooLong", { max: 100 }));
  });

  test("keyedRefine は params の要るキーだけを受け付ける（params の無いキーは keyedIssue で付ける）", () => {
    // @ts-expect-error todo.title.empty は params を持たない
    keyedRefine("todo.title.empty", {});
  });
});

describe("validate", () => {
  test("keyedRefine で付けたキーと params を DomainError の key と params にする", () => {
    const schema = z
      .string()
      .refine(() => false, keyedRefine("todo.title.tooLong", { max: 3 }));

    expectValidationError(() => validate(schema, "abcd"), {
      key: "todo.title.tooLong",
      params: { max: 3 },
    });
  });

  // keyedIssue / keyedRefine を付け忘れた検査では、issue の message が zod の既定の英語の文言になる。それを ErrorKey として
  //   返すと、画面の辞書に無いキーとして API の契約を破る。利用者の入力の誤り（400）ではなく実装の誤りなので、
  //   DomainError ではない Error（presentation が 500 にしてログに出す）にし、開発中に気づけるようにする。
  test("キーを付け忘れた検査で失敗したら、DomainError ではない Error を zod の文言と ZodError を添えて投げる", () => {
    const schema = z.string().min(1);
    const zodMessage = schema.safeParse("").error?.issues[0]?.message;

    try {
      validate(schema, "");
    } catch (error) {
      expect(error).not.toBeInstanceOf(DomainError);
      expect(error).toEqual(
        new Error(
          `zod issue has no ErrorKey (pass keyedIssue / keyedRefine to the schema): ${zodMessage}`,
        ),
      );
      expect((error as Error).cause).toBeInstanceOf(z.ZodError);
      return;
    }
    throw new Error("Error が投げられなかった");
  });
});
