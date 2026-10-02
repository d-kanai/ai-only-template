// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { Clock } from "@repo/shared/now";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { Todo } from "../../../features/todo/internal/domain/todo";
import { DomainError } from "../../../shared/domain/domain-error";
import type { ErrorKey } from "../../../shared/domain/error-key";

// domain 仕様（Issue #318）: todo.feature の `*` の step を、Todo（domain の Entity）を直接呼んで確かめる。
// WHY API を通さず Entity を直接呼ぶ: 履歴の不変条件（1 件以上・最後の状態の一致・古い順）は API からは作れない
//   （どの API も規則を満たす Todo しか作らない）。Entity を直接呼べば、どの規則も前提から確かめられる。
// WHY `*` を And で定義する: vitest-cucumber 8.0.0 は `*` の step を And として扱う（API 仕様の step と同じ）。
// step 1 つ = 1 テストで、前の step に依存しない（前提から検証までを step の中で完結させる。Stryker が変異を通る
//   テストだけに絞っても前提が飛ばされない）。
// 技術の仕組み（読み込んだときの値・値の凍結・型を偽った値・作成日時の型・id の形）は todo.test.ts に残す。

// WHY 時計（Clock.now）を差し替える: Todo.create は作成日時を、changeCompletion は履歴の時刻を Clock.now() から入れる
//   （引数では受け取らない）。時刻を決めるには現在時刻の唯一の出口（apps/shared/now.ts）を差し替えるしかない
//   （.claude/rules/quality/testing.md の「テストダブル」）。
vi.mock("@repo/shared/now");

const CREATED_AT = new Date("2026-09-28T00:00:00.000Z");
const COMPLETED_AT = new Date("2026-09-28T01:00:00.000Z");
const REOPENED_AT = new Date("2026-09-28T02:00:00.000Z");
const BEFORE_CREATED = new Date("2026-09-27T23:59:59.999Z");
// 保存してあった Todo を読み出す（reconstruct）ときの値。uuid の形の固定の値。
const STORED_ID = "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e";

beforeEach(() => {
  vi.mocked(Clock.now).mockReturnValue(CREATED_AT);
});

afterEach(() => {
  vi.mocked(Clock.now).mockReset();
});

// 拒否の理由（key と params）を確かめる。key と params は画面が翻訳する契約（Issue #116）なので、両方を比べる。
// WHY params: undefined を含めて比べる: params の無い理由で params が {} などになっていないことも確かめる。
function expectRejected(
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

const EMPTY = { key: "todo.title.empty" } as const;
const TOO_LONG = { key: "todo.title.tooLong", params: { max: 100 } } as const;
const BROKEN_HISTORY = { key: "todo.statusChanges.invalid" } as const;

// 保存してあった未完了の Todo の値。override で一部を壊す。
function storedValues(
  override: Partial<Parameters<typeof Todo.reconstruct>[0]> = {},
): Parameters<typeof Todo.reconstruct>[0] {
  return {
    id: STORED_ID,
    title: "牛乳を買う",
    completed: false,
    createdAt: CREATED_AT,
    statusChanges: [{ completed: false, changedAt: CREATED_AT }],
    ...override,
  };
}

const feature = await loadFeature("./todo.feature");

describeFeature(feature, ({ Rule }) => {
  Rule("作った Todo は未完了で始まる", ({ RuleScenario }) => {
    RuleScenario("作る", ({ And }) => {
      And("作った Todo は未完了で、作成日時は作った時刻になる", () => {
        // given: beforeEach で現在時刻を CREATED_AT にしてある
        // when
        const todo = Todo.create("牛乳を買う");

        // then
        expect(todo.title).toBe("牛乳を買う");
        expect(todo.completed).toBe(false);
        expect(todo.createdAt).toEqual(CREATED_AT);
      });
      And(
        "作った Todo の完了の履歴は、作成日時に未完了になった 1 件から始まる",
        () => {
          // given: beforeEach で現在時刻を CREATED_AT にしてある
          // when
          const todo = Todo.create("牛乳を買う");

          // then
          expect(todo.statusChanges).toStrictEqual([
            { completed: false, changedAt: CREATED_AT },
          ]);
        },
      );
    });
  });

  Rule("タイトルは前後の空白を除いて 1〜100 文字", ({ RuleScenario }) => {
    RuleScenario("作るときに受け付けるタイトル", ({ And }) => {
      And("1 文字と 100 文字のタイトルで作れる", () => {
        // given: 前提なし
        // when
        const shortest = Todo.create("a");
        const longest = Todo.create("a".repeat(100));

        // then
        expect(shortest.title).toBe("a");
        expect(longest.title).toBe("a".repeat(100));
      });
      And("絵文字だけの 100 文字のタイトルで作れる", () => {
        // given
        // "🍎".length は 2 だが、利用者から見れば 1 文字。String#length で数えると 200 文字になり弾かれる。
        const title = "🍎".repeat(100);

        // when
        const todo = Todo.create(title);

        // then
        expect(todo.title).toBe(title);
      });
      And("タイトルの前後の空白は除いて保存される", () => {
        // given: 前提なし
        // when
        const todo = Todo.create("  牛乳を買う \n");

        // then
        expect(todo.title).toBe("牛乳を買う");
      });
      And("前後の空白を除いて 100 文字なら作れる", () => {
        // given: 前提なし
        // when
        const todo = Todo.create(`  ${"a".repeat(100)}\t`);

        // then
        expect(todo.title).toBe("a".repeat(100));
      });
    });

    RuleScenario("作るときに拒否するタイトル", ({ And }) => {
      And("空のタイトルは、空という理由で拒否される", () => {
        // given: 前提なし
        // when
        const action = () => Todo.create("");

        // then
        expectRejected(action, EMPTY);
      });
      And("空白だけのタイトルは、空という理由で拒否される", () => {
        // given: 前提なし
        // when
        const action = () => Todo.create("   \t\n");

        // then
        expectRejected(action, EMPTY);
      });
      And(
        "101 文字のタイトルは、上限の 100 文字とともに、長すぎるという理由で拒否される",
        () => {
          // given: 前提なし
          // when
          const action = () => Todo.create("a".repeat(101));

          // then
          expectRejected(action, TOO_LONG);
        },
      );
      And(
        "前後の空白を除いて 101 文字のタイトルは、長すぎるという理由で拒否される",
        () => {
          // given: 前提なし
          // when
          const action = () => Todo.create(` ${"a".repeat(101)} `);

          // then
          expectRejected(action, TOO_LONG);
        },
      );
      And(
        "絵文字だけの 101 文字のタイトルは、長すぎるという理由で拒否される",
        () => {
          // given: 前提なし
          // when
          const action = () => Todo.create("🍎".repeat(101));

          // then
          expectRejected(action, TOO_LONG);
        },
      );
    });

    RuleScenario("名前を変えるときのタイトル", ({ And }) => {
      And("新しいタイトルは、前後の空白を除いて保存される", () => {
        // given
        const todo = Todo.create("牛乳を買う");

        // when
        const renamed = todo.rename(" 卵を買う ");

        // then
        expect(renamed.title).toBe("卵を買う");
      });
      And("空白だけのタイトルには変えられず、空という理由で拒否される", () => {
        // given
        const todo = Todo.create("牛乳を買う");

        // when
        const action = () => todo.rename(" ");

        // then
        expectRejected(action, EMPTY);
      });
      And(
        "101 文字のタイトルには変えられず、長すぎるという理由で拒否される",
        () => {
          // given
          const todo = Todo.create("牛乳を買う");

          // when
          const action = () => todo.rename("a".repeat(101));

          // then
          expectRejected(action, TOO_LONG);
        },
      );
    });
  });

  Rule(
    "名前を変えても、完了かどうか・作成日時・完了の履歴は変わらない",
    ({ RuleScenario }) => {
      RuleScenario("名前を変える", ({ And }) => {
        And("完了の Todo の名前を変えても、完了のまま", () => {
          // given
          // WHY 完了から始める: 未完了から始めると、名前を変えるときに未完了に戻す誤りでも結果が同じで見逃す。
          const completed = Todo.create("牛乳を買う").changeCompletion(true);

          // when
          const renamed = completed.rename("卵を買う");

          // then
          expect(renamed.completed).toBe(true);
          expect(renamed.title).toBe("卵を買う");
        });
        And("名前を変えても、作成日時は変わらない", () => {
          // given
          // WHY 名前を変える時刻を作成日時と変える: 名前を変えるときに現在時刻を読み直す誤りでは作成日時が変わって落ちる。
          const todo = Todo.create("牛乳を買う");
          vi.mocked(Clock.now).mockReturnValue(COMPLETED_AT);

          // when
          const renamed = todo.rename("卵を買う");

          // then
          expect(renamed.createdAt).toEqual(CREATED_AT);
        });
        And("名前を変えても、完了の履歴は変わらない", () => {
          // given
          vi.mocked(Clock.now)
            .mockReturnValueOnce(CREATED_AT)
            .mockReturnValue(COMPLETED_AT);
          const todo = Todo.create("牛乳を買う").changeCompletion(true);

          // when
          const renamed = todo.rename("卵を買う");

          // then
          expect(renamed.statusChanges).toStrictEqual([
            { completed: false, changedAt: CREATED_AT },
            { completed: true, changedAt: COMPLETED_AT },
          ]);
        });
      });
    },
  );

  Rule(
    "完了かどうかが変わるたびに、完了の履歴に 1 件足す",
    ({ RuleScenario }) => {
      RuleScenario("完了にする・未完了に戻す", ({ And }) => {
        And(
          "未完了の Todo を完了にすると完了になり、完了にした時刻の「完了」が履歴の最後に足される",
          () => {
            // given
            const todo = Todo.create("牛乳を買う");
            vi.mocked(Clock.now).mockReturnValue(COMPLETED_AT);

            // when
            const completed = todo.changeCompletion(true);

            // then
            expect(completed.completed).toBe(true);
            expect(completed.createdAt).toEqual(CREATED_AT);
            expect(completed.statusChanges).toStrictEqual([
              { completed: false, changedAt: CREATED_AT },
              { completed: true, changedAt: COMPLETED_AT },
            ]);
          },
        );
        And(
          "完了の Todo を未完了に戻すと未完了になり、戻した時刻の「未完了」が履歴の最後に足される",
          () => {
            // given
            vi.mocked(Clock.now)
              .mockReturnValueOnce(CREATED_AT)
              .mockReturnValueOnce(COMPLETED_AT)
              .mockReturnValue(REOPENED_AT);
            const completed = Todo.create("牛乳を買う").changeCompletion(true);

            // when
            const reopened = completed.changeCompletion(false);

            // then
            expect(reopened.completed).toBe(false);
            expect(reopened.statusChanges).toStrictEqual([
              { completed: false, changedAt: CREATED_AT },
              { completed: true, changedAt: COMPLETED_AT },
              { completed: false, changedAt: REOPENED_AT },
            ]);
          },
        );
        And("作った時刻と同じ時刻に完了にしても受け付ける", () => {
          // given: beforeEach で現在時刻を CREATED_AT のままにしてある（作成と完了が同じ時刻）
          // when
          const todo = Todo.create("牛乳を買う").changeCompletion(true);

          // then
          expect(todo.statusChanges).toStrictEqual([
            { completed: false, changedAt: CREATED_AT },
            { completed: true, changedAt: CREATED_AT },
          ]);
        });
      });

      RuleScenario("今と同じ状態を指定する", ({ And }) => {
        // WHY 同じ Todo（toBe）が返ることまで見る: 何も変わらないので、保存しても差分が無い（Repository の update が
        //   何も書かない）。現在時刻も読まない（読む誤りは、時刻を足した新しい Todo になって toBe で落ちる）。
        And("未完了の Todo を未完了にしても、何も変わらない", () => {
          // given
          const todo = Todo.create("牛乳を買う");

          // when
          const changed = todo.changeCompletion(false);

          // then
          expect(changed).toBe(todo);
        });
        And("完了の Todo を完了にしても、何も変わらない", () => {
          // given
          const todo = Todo.create("牛乳を買う").changeCompletion(true);

          // when
          const changed = todo.changeCompletion(true);

          // then
          expect(changed).toBe(todo);
          expect(changed.statusChanges).toHaveLength(2);
        });
      });
    },
  );

  Rule("完了の履歴は、今の状態と食い違わない", ({ RuleScenario }) => {
    RuleScenario("読み出せる履歴", ({ And }) => {
      And("同じ時刻の履歴が並んでいても、読み出せる", () => {
        // given
        const statusChanges = [
          { completed: false, changedAt: CREATED_AT },
          { completed: true, changedAt: COMPLETED_AT },
          { completed: false, changedAt: COMPLETED_AT },
        ];

        // when
        const todo = Todo.reconstruct(storedValues({ statusChanges }));

        // then
        expect(todo.statusChanges).toStrictEqual(statusChanges);
      });
      And("最初の履歴が作成日時より後でも、読み出せる", () => {
        // given
        const statusChanges = [{ completed: true, changedAt: COMPLETED_AT }];

        // when
        const todo = Todo.reconstruct(
          storedValues({ completed: true, statusChanges }),
        );

        // then
        expect(todo.statusChanges).toStrictEqual(statusChanges);
      });
    });

    RuleScenario("壊れた履歴", ({ And }) => {
      And("履歴が 1 件も無い Todo は、壊れた Todo として拒否される", () => {
        // given
        const values = storedValues({ statusChanges: [] });

        // when
        const action = () => Todo.reconstruct(values);

        // then
        expectRejected(action, BROKEN_HISTORY);
      });
      And(
        "履歴の最後の状態が今の状態と違う Todo は、壊れた Todo として拒否される",
        () => {
          // given
          const values = storedValues({
            completed: false,
            statusChanges: [
              { completed: false, changedAt: CREATED_AT },
              { completed: true, changedAt: COMPLETED_AT },
            ],
          });

          // when
          const action = () => Todo.reconstruct(values);

          // then
          expectRejected(action, BROKEN_HISTORY);
        },
      );
      And(
        "履歴の時刻が古い順に並んでいない Todo は、壊れた Todo として拒否される",
        () => {
          // given
          const values = storedValues({
            statusChanges: [
              { completed: false, changedAt: CREATED_AT },
              { completed: true, changedAt: REOPENED_AT },
              { completed: false, changedAt: COMPLETED_AT },
            ],
          });

          // when
          const action = () => Todo.reconstruct(values);

          // then
          expectRejected(action, BROKEN_HISTORY);
        },
      );
      And(
        "履歴の最初の時刻が作成日時より前の Todo は、壊れた Todo として拒否される",
        () => {
          // given
          const values = storedValues({
            statusChanges: [{ completed: false, changedAt: BEFORE_CREATED }],
          });

          // when
          const action = () => Todo.reconstruct(values);

          // then
          expectRejected(action, BROKEN_HISTORY);
        },
      );
    });
  });
});
