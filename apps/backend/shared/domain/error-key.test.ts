// @vitest-environment node
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  describeErrorKey,
  ERROR_KEYS,
  type ErrorKey,
  isErrorKey,
  type ParamlessErrorKey,
} from "./error-key";

// describeErrorKey は Error#message（ログ・スタックトレースに出る開発者向けの文字列）を作る。
//   画面に出す文言ではない（画面はキーと params を辞書で翻訳する。Issue #116）。
describe("describeErrorKey", () => {
  test("params が無ければ、キーだけを返す", () => {
    expect(describeErrorKey("todo.title.empty")).toBe("todo.title.empty");
  });

  test("params があれば、キーの後ろに空白 1 つと params の JSON を付ける", () => {
    expect(describeErrorKey("todo.title.tooLong", { max: 100 })).toBe(
      'todo.title.tooLong {"max":100}',
    );
  });
});

// ERROR_KEYS は ErrorKey（ErrorKeyParams のキー）の実行時の一覧。isErrorKey がこれで判定する。
// WHY 型で比べる（toEqualTypeOf）: 一覧の過不足（キーを ErrorKeyParams に足して ERROR_KEYS に足し忘れる、その逆）を
//   pnpm typecheck で止める。実行時の値を並べて比べると、キーを足すたびにテストも直す必要があり、足し忘れを見逃す。
describe("ERROR_KEYS", () => {
  test("ErrorKey のすべてを過不足なく持つ（型で検査する）", () => {
    expectTypeOf<(typeof ERROR_KEYS)[number]>().toEqualTypeOf<ErrorKey>();
  });
});

// ParamlessErrorKey は params を持たないキー（Record<string, never>）だけ。zod の型の検査（z.string など）の issue は
//   params を運ばないので、そこに付けられるのはこのキーだけにする（todo.ts の keyedIssue）。
describe("ParamlessErrorKey", () => {
  test("params の無いキーだけを含む（型で検査する）", () => {
    expectTypeOf<ParamlessErrorKey>().toEqualTypeOf<
      | "todo.title.empty"
      | "todo.title.invalid"
      | "todo.id.invalid"
      | "todo.completed.invalid"
      | "todo.createdAt.invalid"
      | "request.body.notJson"
      | "request.body.notObject"
      | "server.internalError"
    >();
  });
});

// isErrorKey は zod の issue の message が ErrorKey かを確かめる（todo.ts の validate。キーを付け忘れた項目では zod の
//   英語の文言が入る）。
describe("isErrorKey", () => {
  test.each(ERROR_KEYS)("%s は ErrorKey", (key) => {
    expect(isErrorKey(key)).toBe(true);
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
    expect(isErrorKey(value)).toBe(false);
  });
});
