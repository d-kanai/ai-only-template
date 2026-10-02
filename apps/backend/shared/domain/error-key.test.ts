// @vitest-environment node
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  ERROR_KEYS,
  type ErrorKey,
  ErrorKeys,
  type ParamlessErrorKey,
} from "./error-key";

// ErrorKeys.describe は Error#message（ログ・スタックトレースに出る開発者向けの文字列）を作る。
//   画面に出す文言ではない（画面はキーと params を辞書で翻訳する。Issue #116）。
describe("ErrorKeys.describe", () => {
  test("params が無ければ、キーだけを返す", () => {
    // given: 前提なし
    // when
    const message = ErrorKeys.describe("todo.title.empty");

    // then
    expect(message).toBe("todo.title.empty");
  });

  test("params があれば、キーの後ろに空白 1 つと params の JSON を付ける", () => {
    // given: 前提なし
    // when
    const message = ErrorKeys.describe("todo.title.tooLong", { max: 100 });

    // then
    expect(message).toBe('todo.title.tooLong {"max":100}');
  });
});

// ERROR_KEYS は ErrorKey（ErrorKeyParams のキー）の実行時の一覧。ErrorKeys.includes がこれで判定する。
// WHY 型で比べる（toEqualTypeOf）: 一覧の過不足（キーを ErrorKeyParams に足して ERROR_KEYS に足し忘れる、その逆）を
//   pnpm typecheck で止める。実行時の値を並べて比べると、キーを足すたびにテストも直す必要があり、足し忘れを見逃す。
describe("ERROR_KEYS", () => {
  test("ErrorKey のすべてを過不足なく持つ（型で検査する）", () => {
    // given: 前提なし
    // when
    const keys = expectTypeOf<(typeof ERROR_KEYS)[number]>();

    // then
    keys.toEqualTypeOf<ErrorKey>();
  });
});

// ParamlessErrorKey は params を持たないキー（Record<string, never>）だけ。zod の型の検査（z.string など）の issue は
//   params を運ばないので、そこに付けられるのはこのキーだけにする（shared/domain/keyed-issue.ts の KeyedIssue.of）。
describe("ParamlessErrorKey", () => {
  test("params の無いキーだけを含む（型で検査する）", () => {
    // given: 前提なし
    // when
    const keys = expectTypeOf<ParamlessErrorKey>();

    // then
    keys.toEqualTypeOf<
      | "todo.title.empty"
      | "todo.title.invalid"
      | "todo.id.invalid"
      | "todo.completed.invalid"
      | "todo.createdAt.invalid"
      | "todo.statusChanges.invalid"
      | "request.body.notJson"
      | "request.body.notObject"
      | "server.internalError"
    >();
  });
});

// ErrorKeys.includes は zod の issue の message が ErrorKey かを確かめる（validate.ts の DomainValidation.validated。キーを付け忘れた項目では zod の
//   英語の文言が入る）。
describe("ErrorKeys.includes", () => {
  test.each(ERROR_KEYS)("%s は ErrorKey", (key) => {
    // given: 前提なし
    // when
    const included = ErrorKeys.includes(key);

    // then
    expect(included).toBe(true);
  });

  test.each([
    ["zod の既定の文言", "Invalid input: expected string, received number"],
    ["空文字", ""],
    ["キーの前方だけ", "todo.title"],
    ["キーの後ろに文字が続く", "todo.title.empty "],
    ["大文字が違う", "Todo.title.empty"],
    // WHY 配列の要素で判定する（オブジェクトのプロパティで引かない）: "constructor" などの Object.prototype の名前を
    //   キーと取り違えない。
    ["Object.prototype の名前", "constructor"],
  ])("%s は ErrorKey ではない", (_label, value) => {
    // given: 前提なし
    // when
    const included = ErrorKeys.includes(value);

    // then
    expect(included).toBe(false);
  });
});
