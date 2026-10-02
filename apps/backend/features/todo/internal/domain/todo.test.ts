// @vitest-environment node
import { Clock } from "@repo/shared/now";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DomainError } from "../../../../shared/error/domain-error";
import type { ErrorKey } from "../../../../shared/error/error-key";
import { TODO_TITLE_MAX_LENGTH, Todo } from "./todo";

// Todo の技術の仕組み（id の形・現在時刻の読み方・不変（元の Todo を変えない）・値の凍結・型を偽った値・Invalid Date・
//   読み込んだときの値 origin・どの口も全体を検証する完全コンストラクタ）の単体テスト。
// 業務ルール（タイトルの規則・完了と履歴の規則・履歴の不変条件）は domain 仕様 apps/backend/spec/domain/todo/todo.feature
//   （step の実装は todo.domain-spec.test.ts）に書き、ここでは重ねない（Issue #318）。

// WHY 時計（Clock.now）を差し替える: Todo.create は作成日時を Clock.now() から自動で入れる（引数では受け取らない）。
//   テストで決まった時刻にするには、現在時刻の唯一の出口（apps/shared/now.ts）を差し替えるしかない。
//   自動モックの Clock.now は既定で undefined を返すので、beforeEach で決まった時刻を返させる（返させ忘れた Todo.create は
//   作成日時の不変条件で validation_error になり、気づける）。
vi.mock("@repo/shared/now");

const NOW = new Date("2026-09-28T00:00:00.000Z");

beforeEach(() => {
  vi.mocked(Clock.now).mockReturnValue(NOW);
});

afterEach(() => {
  vi.mocked(Clock.now).mockReset();
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
const INVALID_STATUS_CHANGES = { key: "todo.statusChanges.invalid" } as const;

describe("Todo.create", () => {
  test("id は randomUUID の形で付き、現在時刻（Clock.now()）は 1 回だけ読む", () => {
    // given: beforeEach で now() が NOW を返すようにしてある
    // when
    const todo = Todo.create("牛乳を買う");

    // then
    expect(Clock.now).toHaveBeenCalledTimes(1);
    // randomUUID の形式（8-4-4-4-12 の 16 進）。
    expect(todo.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // WHY 型で止める: 作成日時は Entity の生成ルールとして Clock.now() から入れる。呼び出し側が渡せると、ルールが呼び出し側に漏れる。
  test("作成日時は引数で受け取らない（型エラーで、渡しても Clock.now() の値が入る）", () => {
    // given
    const createdAt = new Date("2000-01-01T00:00:00.000Z");

    // when
    // @ts-expect-error Todo.create はタイトルだけを受け取る。
    const todo = Todo.create("牛乳を買う", createdAt);

    // then
    expect(todo.createdAt).toEqual(NOW);
  });

  test("作るたびに別の id になる", () => {
    // given: beforeEach で now() が NOW を返すようにしてある
    // when
    const first = Todo.create("a");
    const second = Todo.create("a");

    // then
    expect(first.id).not.toBe(second.id);
  });

  // WHY 定数の値を固定する: presentation のリクエストのスキーマ（create-todo.api.ts・rename-todo.api.ts）がこの定数を参照して
  //   同じ上限を重ねる（Issue #144）。値を変えると画面の文言（params.max）と API の契約が変わるので、変えるときはここも直す。
  test("タイトルの上限の文字数 TODO_TITLE_MAX_LENGTH は 100 で、それを超えると validation_error になる", () => {
    // given: beforeEach で now() が NOW を返すようにしてある
    // when
    const action = () => Todo.create("a".repeat(TODO_TITLE_MAX_LENGTH + 1));

    // then
    expect(TODO_TITLE_MAX_LENGTH).toBe(100);
    expectValidationError(action, TOO_LONG_TITLE);
  });

  // 完全コンストラクタ: create はタイトルだけでなく Todo のすべての値（TodoProps）を検証してから作る。
  test("作成日時が日付として不正（Invalid Date）なら validation_error を投げる", () => {
    // given
    vi.mocked(Clock.now).mockReturnValueOnce(new Date("not a date"));

    // when
    const action = () => Todo.create("牛乳を買う");

    // then
    expectValidationError(action, INVALID_CREATED_AT);
  });
});

describe("Todo#rename", () => {
  test("新しいタイトルの Todo を返し、元の Todo は変えない（作成日時は作ったときのまま）", () => {
    // given
    // WHY 作成時だけ別の時刻にする: rename が Clock.now() を読み直す書き換えでは、作成日時が既定の NOW に変わって落ちる。
    const createdAt = new Date("2026-09-27T00:00:00.000Z");
    vi.mocked(Clock.now).mockReturnValueOnce(createdAt);
    const original = Todo.create("牛乳を買う");

    // when
    const renamed = original.rename("卵を買う");

    // then
    expect(renamed.title).toBe("卵を買う");
    expect(renamed.id).toBe(original.id);
    expect(renamed.createdAt).toEqual(createdAt);
    expect(original.title).toBe("牛乳を買う");
  });
});

describe("Todo#changeCompletion", () => {
  test("完了 / 未完了を切り替えた Todo を返し、元の Todo は変えない（作成日時は変わらない）", () => {
    // given
    // WHY 作成時だけ別の時刻にする: changeCompletion が Clock.now() を読み直す書き換えでは、作成日時が既定の NOW に変わって落ちる。
    const createdAt = new Date("2026-09-27T00:00:00.000Z");
    vi.mocked(Clock.now).mockReturnValueOnce(createdAt);
    const original = Todo.create("牛乳を買う");

    // when
    const completed = original.changeCompletion(true);
    const reopened = completed.changeCompletion(false);

    // then
    expect(completed.completed).toBe(true);
    expect(reopened.completed).toBe(false);
    expect(completed.id).toBe(original.id);
    expect(completed.title).toBe(original.title);
    expect(completed.createdAt).toEqual(createdAt);
    expect(reopened.createdAt).toEqual(createdAt);
    expect(original.completed).toBe(false);
  });

  // WHY 元の履歴を見る: 履歴は Todo の値で、Todo は不変。足した履歴が元の Todo に混ざると、保存前の値や origin との差分が変わる。
  test("完了状態を変えても、元の Todo の完了の履歴は変えない", () => {
    // given
    const original = Todo.create("牛乳を買う");

    // when
    const completed = original.changeCompletion(true);
    completed.changeCompletion(false);

    // then
    expect(original.statusChanges).toStrictEqual([
      { completed: false, changedAt: NOW },
    ]);
    expect(completed.statusChanges).toStrictEqual([
      { completed: false, changedAt: NOW },
      { completed: true, changedAt: NOW },
    ]);
  });

  // WHY 現在時刻を読まないことを見る: 同じ状態の指定は何も変えない（domain 仕様）。時刻を読むのは履歴を足すときだけで、読む誤りは
  //   結果の Todo（toBe）では分からない（reviewer の指摘、Issue #318）。
  test.each([false, true])(
    "今と同じ値（%s）を渡すと、現在時刻（Clock.now()）を読まない",
    (value) => {
      // given
      const todo =
        value === false
          ? Todo.create("牛乳を買う")
          : Todo.create("牛乳を買う").changeCompletion(true);
      vi.mocked(Clock.now).mockClear();

      // when
      todo.changeCompletion(value);

      // then
      expect(Clock.now).not.toHaveBeenCalled();
    },
  );

  // WHY 型に反する値を as で渡す: 型の上では boolean しか渡せないが、完全コンストラクタは口によらず全体を検証する
  //   （todo.ts のコメント）。completed の規則（boolean であること）も、changeCompletion を通って守られることを確かめる。
  test("completed が boolean でなければ validation_error を投げる（全体を検証する）", () => {
    // given
    const todo = Todo.create("牛乳を買う");

    // when
    const action = () => todo.changeCompletion("true" as unknown as boolean);

    // then
    expectValidationError(action, { key: "todo.completed.invalid" });
  });
});

describe("Todo.reconstruct", () => {
  const VALID_ID = "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e";
  const CREATED_AT = new Date("2026-09-28T00:00:00.000Z");

  // WHY 型に反する値を as で渡す: 型の上では string しか渡せないが、文字列でない値にもキーを付ける
  //   （zod の既定の英語の文言を domain の外に出さない。todo.ts の todoPropsSchema の title のコメント）。
  test("title が文字列でなければ validation_error を投げる", () => {
    // given: 前提なし
    // when
    const action = () =>
      Todo.reconstruct({
        id: VALID_ID,
        title: undefined as unknown as string,
        completed: false,
        createdAt: CREATED_AT,
        statusChanges: [{ completed: false, changedAt: CREATED_AT }],
      });

    // then
    expectValidationError(action, { key: "todo.title.invalid" });
  });

  test("保存済みの値（id・title・completed・作成日時・完了の履歴）をそのまま持つ Todo を作る", () => {
    // given
    const completedAt = new Date("2026-09-28T01:00:00.000Z");

    // when
    const todo = Todo.reconstruct({
      id: VALID_ID,
      title: "牛乳を買う",
      completed: true,
      createdAt: CREATED_AT,
      statusChanges: [
        { completed: false, changedAt: CREATED_AT },
        { completed: true, changedAt: completedAt },
      ],
    });

    // then
    expect(todo).toBeInstanceOf(Todo);
    expect(todo.id).toBe(VALID_ID);
    expect(todo.title).toBe("牛乳を買う");
    expect(todo.completed).toBe(true);
    expect(todo.createdAt).toEqual(CREATED_AT);
    expect(todo.statusChanges).toStrictEqual([
      { completed: false, changedAt: CREATED_AT },
      { completed: true, changedAt: completedAt },
    ]);
  });

  // WHY 凍結する: 履歴は Todo の値で、Todo は不変（todo.ts）。配列や要素を書き換えられると、update の前に保持中の値
  //   （InMemory）や origin との差分が変わる。
  test("完了の履歴の配列と要素は凍結されていて書き換えられない", () => {
    // given: 前提なし
    // when
    const todo = Todo.reconstruct({
      id: VALID_ID,
      title: "牛乳を買う",
      completed: false,
      createdAt: CREATED_AT,
      statusChanges: [{ completed: false, changedAt: CREATED_AT }],
    });

    // then
    expect(Object.isFrozen(todo.statusChanges)).toBe(true);
    expect(Object.isFrozen(todo.statusChanges[0])).toBe(true);
  });

  // create と同じスキーマを通るので、前後の空白は取り除かれる（規則を満たす形にそろう）。
  test("タイトルの前後の空白は取り除いて保持する", () => {
    // given: 前提なし
    // when
    const todo = Todo.reconstruct({
      id: VALID_ID,
      title: "  牛乳を買う \n",
      completed: false,
      createdAt: CREATED_AT,
      statusChanges: [{ completed: false, changedAt: CREATED_AT }],
    });

    // then
    expect(todo.title).toBe("牛乳を買う");
  });

  // Issue #94: 保存済みの値も今の不変条件で検査する（Todo 型 = 不変条件を満たす値）。タイトルの規則そのものは domain 仕様が
  //   見るので、ここで見るのは「読み出しの口も同じ規則を通る」こと（完全コンストラクタ。上の前後の空白の除去も同じ）。規則を厳しくしたときは、
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
    // 完了の履歴の不変条件（Issue #188）: 1 件以上、日時は昇順（同じ値は可）、最初の日時は作成日時以上、最後の completed は
    //   今の completed と等しい。
    // 型に反する値を as で渡す（DB からは来ないが、配列でない値にもキーを付ける。title が文字列でないときと同じ）。
    [
      "完了の履歴が配列でない",
      { statusChanges: undefined as unknown as [] },
      INVALID_STATUS_CHANGES,
    ],
    [
      "履歴の completed が boolean でない",
      {
        statusChanges: [
          { completed: "false" as unknown as boolean, changedAt: CREATED_AT },
        ],
      },
      INVALID_STATUS_CHANGES,
    ],
    [
      "履歴の日時が Invalid Date",
      {
        statusChanges: [
          { completed: false, changedAt: new Date("not a date") },
        ],
      },
      INVALID_STATUS_CHANGES,
    ],
  ])(
    "%sなら validation_error を、理由の key（と params）付きで投げる",
    (_label, override, expected) => {
      // given: 前提なし
      // when
      const action = () =>
        Todo.reconstruct({
          id: VALID_ID,
          title: "牛乳を買う",
          completed: false,
          createdAt: CREATED_AT,
          statusChanges: [{ completed: false, changedAt: CREATED_AT }],
          ...override,
        });

      // then
      expectValidationError(action, expected);
    },
  );
});

// origin: 読み込んだとき（reconstruct）の値。Repository の update が「変わった列だけ」を書くために差分を取る（Issue #165）。
describe("Todo#origin", () => {
  const VALUES = {
    id: "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e",
    title: "牛乳を買う",
    completed: false,
    createdAt: new Date("2026-09-28T00:00:00.000Z"),
    statusChanges: [
      { completed: false, changedAt: new Date("2026-09-28T00:00:00.000Z") },
    ],
  };

  test("create した Todo の origin は undefined（新規で、読み込んだ値が無い）", () => {
    // given: 前提なし
    // when
    const todo = Todo.create("牛乳を買う");
    const renamed = todo.rename("卵を買う");
    const completed = todo.changeCompletion(true);

    // then
    expect(todo.origin).toBeUndefined();
    expect(renamed.origin).toBeUndefined();
    expect(completed.origin).toBeUndefined();
  });

  // WHY 検証後の値（trim 後）: 差分は今の値（常に検証後）と比べる。引数のまま持つと、前後に空白のある行を読んで
  //   何も変えずに update しただけで title が「変わった」ことになる。
  test("reconstruct した Todo の origin は検証後の値（title は前後の空白を取り除いた値）", () => {
    // given: 前提なし
    // when
    const todo = Todo.reconstruct({ ...VALUES, title: "  牛乳を買う \n" });

    // then
    expect(todo.origin).toStrictEqual(VALUES);
  });

  test("rename・changeCompletion した Todo は元の origin を引き継ぐ（今の値は変わっても origin は読み込んだときのまま）", () => {
    // given
    const loaded = Todo.reconstruct(VALUES);

    // when
    const renamed = loaded.rename("卵を買う");
    const completed = renamed.changeCompletion(true);

    // then
    expect(renamed.title).toBe("卵を買う");
    expect(completed.completed).toBe(true);
    expect(renamed.origin).toBe(loaded.origin);
    expect(completed.origin).toBe(loaded.origin);
    expect(completed.origin).toStrictEqual(VALUES);
  });

  // WHY: origin は永続化のための付帯情報で、Todo の値ではない。列挙されるプロパティに出すと、値の等価（テストの toEqual）
  //   が「読み込んだかどうか」で変わり、Todo を直列化したときにも混ざる。
  test("origin は Todo の値（列挙されるプロパティ）に含めない", () => {
    // given: 前提なし
    // when
    const todo = Todo.reconstruct(VALUES).rename("卵を買う");

    // then
    expect(Object.keys(todo)).toEqual([
      "id",
      "title",
      "completed",
      "createdAt",
      "statusChanges",
    ]);
    expect(todo).toEqual(
      Todo.reconstruct({ ...VALUES, title: "卵を買う" }).rename("卵を買う"),
    );
  });
});
