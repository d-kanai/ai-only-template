import { describe, expect, expectTypeOf, test } from "vitest";
import {
  createTranslator,
  type Dictionary,
  formatMessage,
  isMessageKey,
  type MessageKey,
  type MessageParams,
  type TranslateArgs,
} from "@/shared/i18n/messages";
import { en } from "@/shared/i18n/messages/en";
import { ja } from "@/shared/i18n/messages/ja";

// 辞書の文言から placeholder（{name}）の名前の集合を取り出す（テストで ja と en を比べるため）。
// 本番の置換（messages.ts の formatMessage）と同じく、{ } の中が英数字と _ の名前だけを placeholder とみなす。
function placeholderNames(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe("辞書（ja を正とし、en は同じキーと placeholder を持つ）", () => {
  // WHY 型（en.ts の satisfies Dictionary）に加えてテストでも見る: satisfies が外されたり、as で型を逃がしたりしても止める。
  test("en は ja と同じキーをすべて持ち、余分なキーを持たない", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  // WHY: placeholder の名前は ja の文言から型で導く（MessageParams）。en の文言の placeholder は型に表れないので、
  //   名前の書き間違い（{max} を {maximum} にする）や抜けは、ここで見つけないと en の画面で置換されずに {maximum} と出る。
  test.each(Object.keys(ja) as MessageKey[])(
    "%s: en の placeholder の集合は ja と同じ",
    (key) => {
      expect(placeholderNames(en[key])).toEqual(placeholderNames(ja[key]));
    },
  );

  test.each(Object.keys(ja) as MessageKey[])(
    "%s: ja・en とも空でない文言を持つ",
    (key) => {
      expect(ja[key].trim()).not.toBe("");
      expect(en[key].trim()).not.toBe("");
    },
  );
});

describe("formatMessage（キーと params から文言を組み立てる）", () => {
  test("ロケールの辞書の文言を返す", () => {
    expect(formatMessage("ja", "todo.form.submit")).toBe(
      ja["todo.form.submit"],
    );
    expect(formatMessage("en", "todo.form.submit")).toBe(
      en["todo.form.submit"],
    );
    expect(formatMessage("ja", "todo.form.submit")).not.toBe(
      formatMessage("en", "todo.form.submit"),
    );
  });

  test("placeholder を params の値で置き換える（数も文字列にする）", () => {
    expect(formatMessage("ja", "todo.title.tooLong", { max: 100 })).toBe(
      "タイトルは 100 文字以内で入力してください",
    );
    expect(formatMessage("en", "todo.item.deleteAria", { title: "Milk" })).toBe(
      "Delete “Milk”",
    );
  });

  test("文言の途中の placeholder を置き換え、前後の文言は残す", () => {
    expect(
      formatMessage("en", "request.body.unknownKeys", { keys: "a, b" }),
    ).toBe("The request has unknown fields: a, b");
  });

  // WHY 置き換えずに残す: サーバの params が欠けたとき、"undefined" や空文字に化けると気づけない。{name} のまま出せば分かる。
  test("params に無い placeholder は {name} のまま残す", () => {
    expect(formatMessage("ja", "todo.title.tooLong", {})).toBe(
      "タイトルは {max} 文字以内で入力してください",
    );
    expect(formatMessage("ja", "todo.title.tooLong")).toBe(
      "タイトルは {max} 文字以内で入力してください",
    );
  });

  test("文言に無い params は無視する", () => {
    expect(formatMessage("ja", "todo.title.empty", { extra: "x" })).toBe(
      ja["todo.title.empty"],
    );
  });

  // Object.prototype の名前（toString など）を params の値と取り違えない。
  test("params が持たない名前は、Object.prototype の名前でも置き換えない", () => {
    expect(formatMessage("ja", "todo.title.tooLong", { toString: 1 })).toBe(
      "タイトルは {max} 文字以内で入力してください",
    );
  });
});

describe("createTranslator（型付きの t）", () => {
  test("ロケールを固定した t を返す", () => {
    const tJa = createTranslator("ja");
    const tEn = createTranslator("en");

    expect(tJa("todo.item.toggle", { title: "牛乳" })).toBe(
      "「牛乳」を完了にする",
    );
    expect(tEn("todo.item.toggle", { title: "Milk" })).toBe(
      "Mark “Milk” as completed",
    );
    expect(tEn("todo.detail.save")).toBe("Save");
  });

  // 型の検査（pnpm typecheck で確かめる。@ts-expect-error の行がエラーにならなければ tsc が失敗する）。
  // 呼ぶと存在しないキーで実行時エラーになるので、関数に包んで呼ばない。
  test("キーと params の誤りはコンパイルエラーになる", () => {
    const t = createTranslator("ja");
    const typeErrors = [
      // @ts-expect-error 存在しないキー
      () => t("todo.nope"),
      // @ts-expect-error placeholder のある文言に params を渡さない
      () => t("todo.title.tooLong"),
      // @ts-expect-error placeholder の名前が違う
      () => t("todo.title.tooLong", { min: 1 }),
      // @ts-expect-error placeholder の無い文言に params を渡す
      () => t("todo.title.empty", { max: 1 }),
      // @ts-expect-error params の値は文字列か数だけ
      () => t("todo.title.tooLong", { max: true }),
    ];
    expect(typeErrors).toHaveLength(5);
  });

  test("params の型は ja の文言の placeholder から導く", () => {
    expectTypeOf<MessageParams<"todo.title.tooLong">>().toEqualTypeOf<{
      readonly max: string | number;
    }>();
    expectTypeOf<TranslateArgs<"todo.title.empty">>().toEqualTypeOf<[]>();
    expectTypeOf<TranslateArgs<"todo.item.toggle">>().toEqualTypeOf<
      [params: { readonly title: string | number }]
    >();
  });

  // en.ts は `satisfies Dictionary` で、ja のキーの過不足をコンパイルエラーにする。その型が過不足を止めることを確かめる。
  test("辞書の型（Dictionary）はキーの欠け・余分をコンパイルエラーにする", () => {
    // @ts-expect-error キーが欠けている
    const missing: Dictionary = { "todo.list.title": "Todo" };
    // @ts-expect-error 余分なキー（オブジェクトリテラルの過剰プロパティ）
    const extraLiteral: Dictionary = { ...en, "todo.extra": "x" };
    expect([missing, extraLiteral]).toHaveLength(2);
  });
});

describe("isMessageKey（サーバから届いたキーが辞書にあるか）", () => {
  test("辞書にあるキーなら true", () => {
    expect(isMessageKey("todo.notFound")).toBe(true);
    expect(isMessageKey("error.unknown")).toBe(true);
  });

  test.each(["todo.nope", "", "toString", "__proto__", "constructor"])(
    "辞書に無い値（%j。Object.prototype の名前を含む）なら false",
    (value) => {
      expect(isMessageKey(value)).toBe(false);
    },
  );
});
