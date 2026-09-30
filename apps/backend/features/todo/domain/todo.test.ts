// @vitest-environment node
import { now } from "@repo/shared/now";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DomainError } from "../../../shared/domain/domain-error";
import type { ErrorKey } from "../../../shared/domain/error-key";
import { TODO_TITLE_MAX_LENGTH, Todo } from "./todo";

// WHY 時計（now）を差し替える: Todo.create は作成日時を now() から自動で入れる（引数では受け取らない）。
//   テストで決まった時刻にするには、現在時刻の唯一の出口（apps/shared/now.ts）を差し替えるしかない。
//   自動モックの now は既定で undefined を返すので、beforeEach で決まった時刻を返させる（返させ忘れた Todo.create は
//   作成日時の不変条件で validation_error になり、気づける）。
vi.mock("@repo/shared/now");

const NOW = new Date("2026-09-28T00:00:00.000Z");

beforeEach(() => {
  vi.mocked(now).mockReturnValue(NOW);
});

afterEach(() => {
  vi.mocked(now).mockReset();
});

// key と params は API の Problem Details（problem.ts）の拡張メンバーとして画面に渡る（画面が翻訳するクライアントとの契約。Issue #116）ので、両方を検証する。
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
  test("未完了で作られ、id と、作成日時として現在時刻（now()）が付く", () => {
    const createdAt = new Date("2026-09-28T12:34:56.789Z");
    vi.mocked(now).mockReturnValueOnce(createdAt);

    const todo = Todo.create("牛乳を買う");

    expect(todo.title).toBe("牛乳を買う");
    expect(todo.completed).toBe(false);
    expect(todo.createdAt).toEqual(createdAt);
    expect(now).toHaveBeenCalledTimes(1);
    // randomUUID の形式（8-4-4-4-12 の 16 進）。
    expect(todo.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // WHY 型で止める: 作成日時は Entity の生成ルールとして now() から入れる。呼び出し側が渡せると、ルールが呼び出し側に漏れる。
  test("作成日時は引数で受け取らない（型エラーで、渡しても now() の値が入る）", () => {
    const createdAt = new Date("2000-01-01T00:00:00.000Z");
    // @ts-expect-error Todo.create はタイトルだけを受け取る。
    const todo = Todo.create("牛乳を買う", createdAt);

    expect(todo.createdAt).toEqual(NOW);
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

  // WHY 定数の値を固定する: presentation のリクエストのスキーマ（create-todo.api.ts・rename-todo.api.ts）がこの定数を参照して
  //   同じ上限を重ねる（Issue #144）。値を変えると画面の文言（params.max）と API の契約が変わるので、変えるときはここも直す。
  test("タイトルの上限の文字数 TODO_TITLE_MAX_LENGTH は 100 で、それを超えると validation_error になる", () => {
    expect(TODO_TITLE_MAX_LENGTH).toBe(100);
    expectValidationError(
      () => Todo.create("a".repeat(TODO_TITLE_MAX_LENGTH + 1)),
      TOO_LONG_TITLE,
    );
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
    vi.mocked(now).mockReturnValueOnce(new Date("not a date"));

    expectValidationError(() => Todo.create("牛乳を買う"), INVALID_CREATED_AT);
  });
});

describe("Todo#rename", () => {
  test("新しいタイトルの Todo を返し、元の Todo は変えない（作成日時は作ったときのまま）", () => {
    // WHY 作成時だけ別の時刻にする: rename が now() を読み直す書き換えでは、作成日時が既定の NOW に変わって落ちる。
    const createdAt = new Date("2026-09-27T00:00:00.000Z");
    vi.mocked(now).mockReturnValueOnce(createdAt);
    const original = Todo.create("牛乳を買う");

    const renamed = original.rename(" 卵を買う ");

    expect(renamed.title).toBe("卵を買う");
    expect(renamed.id).toBe(original.id);
    expect(renamed.createdAt).toEqual(createdAt);
    expect(original.title).toBe("牛乳を買う");
  });

  test("完了済みの Todo の名前を変えても、完了状態・id・作成日時は変わらない", () => {
    // rename はタイトルだけを差し替え、他の値は今の値（props()）から引き継ぐので、
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
  test("完了 / 未完了を切り替えた Todo を返し、元の Todo は変えない（作成日時は変わらない）", () => {
    // WHY 作成時だけ別の時刻にする: changeCompletion が now() を読み直す書き換えでは、作成日時が既定の NOW に変わって落ちる。
    const createdAt = new Date("2026-09-27T00:00:00.000Z");
    vi.mocked(now).mockReturnValueOnce(createdAt);
    const original = Todo.create("牛乳を買う");

    const completed = original.changeCompletion(true);
    const reopened = completed.changeCompletion(false);

    expect(completed.completed).toBe(true);
    expect(reopened.completed).toBe(false);
    expect(completed.id).toBe(original.id);
    expect(completed.title).toBe(original.title);
    expect(completed.createdAt).toEqual(createdAt);
    expect(reopened.createdAt).toEqual(createdAt);
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
  //   （zod の既定の英語の文言を domain の外に出さない。todo.ts の todoPropsSchema の title のコメント）。
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

// origin: 読み込んだとき（reconstruct）の値。Repository の save が「変わった列だけ」を書くために差分を取る（Issue #165）。
describe("Todo#origin", () => {
  const VALUES = {
    id: "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e",
    title: "牛乳を買う",
    completed: false,
    createdAt: new Date("2026-09-28T00:00:00.000Z"),
  };

  test("create した Todo の origin は undefined（新規で、読み込んだ値が無い）", () => {
    const todo = Todo.create("牛乳を買う");

    expect(todo.origin).toBeUndefined();
    expect(todo.rename("卵を買う").origin).toBeUndefined();
    expect(todo.changeCompletion(true).origin).toBeUndefined();
  });

  // WHY 検証後の値（trim 後）: 差分は今の値（常に検証後）と比べる。引数のまま持つと、前後に空白のある行を読んで
  //   何も変えずに save しただけで title が「変わった」ことになる。
  test("reconstruct した Todo の origin は検証後の値（title は前後の空白を取り除いた値）", () => {
    const todo = Todo.reconstruct({ ...VALUES, title: "  牛乳を買う \n" });

    expect(todo.origin).toStrictEqual(VALUES);
  });

  test("rename・changeCompletion した Todo は元の origin を引き継ぐ（今の値は変わっても origin は読み込んだときのまま）", () => {
    const loaded = Todo.reconstruct(VALUES);

    const renamed = loaded.rename("卵を買う");
    const completed = renamed.changeCompletion(true);

    expect(renamed.title).toBe("卵を買う");
    expect(completed.completed).toBe(true);
    expect(renamed.origin).toBe(loaded.origin);
    expect(completed.origin).toBe(loaded.origin);
    expect(completed.origin).toStrictEqual(VALUES);
  });

  // WHY: origin は永続化のための付帯情報で、Todo の値ではない。列挙されるプロパティに出すと、値の等価（テストの toEqual）
  //   が「読み込んだかどうか」で変わり、Todo を直列化したときにも混ざる。
  test("origin は Todo の値（列挙されるプロパティ）に含めない", () => {
    const todo = Todo.reconstruct(VALUES).rename("卵を買う");

    expect(Object.keys(todo)).toEqual([
      "id",
      "title",
      "completed",
      "createdAt",
    ]);
    expect(todo).toEqual(
      Todo.reconstruct({ ...VALUES, title: "卵を買う" }).rename("卵を買う"),
    );
  });
});
