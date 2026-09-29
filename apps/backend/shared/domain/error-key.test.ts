// @vitest-environment node
import { describe, expect, test } from "vitest";
import { describeErrorKey } from "./error-key";

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
