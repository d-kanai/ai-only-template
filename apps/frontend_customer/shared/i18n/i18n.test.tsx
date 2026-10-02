import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, test } from "vitest";
import {
  createTranslator,
  defineMessages,
  formatMessage,
  isMessageKey,
  LocaleProvider,
  type MessageKey,
  type MessageParams,
  type Messages,
  type TranslateArgs,
  useLocale,
  useT,
} from "@/shared/i18n/i18n";
import type { Locale } from "@/shared/i18n/locale";

// globals 無効のため Testing Library の自動 cleanup が働かない。テストごとに DOM を片付ける。
afterEach(cleanup);

// テスト専用の辞書。画面の辞書（*.messages.ts）の言い回しを変えてもこのテストが揺れないよう、仕組みの仕様はここの辞書で固定する。
// 画面の辞書の中身は、各画面・部品のテスト（en で描くテスト）と api-error.test.ts（共通の辞書）で見る。
const testMessages = defineMessages({
  ja: {
    save: "保存",
    tooLong: "タイトルは {max} 文字以内で入力してください",
    toggle: "「{title}」を完了にする",
    unknownKeys: "リクエストに不明な項目があります: {keys}",
    pair: "{a} と {b}",
  },
  en: {
    save: "Save",
    tooLong: "The title must be {max} characters or fewer",
    toggle: "Mark “{title}” as completed",
    unknownKeys: "The request has unknown fields: {keys}",
    // placeholder の順番は言語で変わってよい（集合が同じなら型が通る）。
    pair: "{b} and {a}",
  },
});

// 「別の辞書のキー」を渡したときの型の検査に使う、キーが testMessages と重ならない辞書。
const otherMessages = defineMessages({
  ja: { back: "一覧へ戻る" },
  en: { back: "Back to list" },
});

// 型の検査で使う、文字列リテラルの型ではない（string 型の）値。
const stringValue: string = String("x");

describe("defineMessages（ja を正とする辞書を定義する）", () => {
  test("渡した辞書をそのまま返す（実行時の処理は無く、型の検査だけを行う）", () => {
    // given
    const messages = { ja: { a: "あ" }, en: { a: "A" } } as const;

    // when
    const defined = defineMessages(messages);

    // then
    expect(defined).toBe(messages);
  });

  test("ja の文言は文字列リテラルの型になる（as const を書かなくてよい）", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const save = expectTypeOf(testMessages.ja.save);
    const tooLong = expectTypeOf(testMessages.ja.tooLong);

    // then
    save.toEqualTypeOf<"保存">();
    tooLong.toEqualTypeOf<"タイトルは {max} 文字以内で入力してください">();
  });

  // 型の検査（pnpm typecheck で確かめる。@ts-expect-error の行がエラーにならなければ tsc が失敗する）。
  // 実行しても意味が無いので関数に包んで呼ばない。
  test("en のキーの過不足・placeholder の不一致・空の文言はコンパイルエラーになる", () => {
    // given: 前提なし
    // when
    const typeErrors = [
      () =>
        defineMessages({
          ja: { a: "あ", b: "い" },
          // @ts-expect-error en にキーが欠けている
          en: { a: "A" },
        }),
      () =>
        defineMessages({
          ja: { a: "あ" },
          // @ts-expect-error en に ja に無いキーがある
          en: { a: "A", extra: "X" },
        }),
      () =>
        defineMessages({
          ja: { a: "{max} 文字以内" },
          // @ts-expect-error placeholder の名前が違う（{max} と {maximum}）
          en: { a: "{maximum} characters or fewer" },
        }),
      () =>
        defineMessages({
          ja: { a: "{max} 文字以内" },
          // @ts-expect-error en に placeholder が無い
          en: { a: "characters or fewer" },
        }),
      () =>
        defineMessages({
          ja: { a: "削除" },
          // @ts-expect-error en に ja に無い placeholder がある
          en: { a: "Delete {title}" },
        }),
      () =>
        defineMessages({
          // @ts-expect-error ja の文言が空
          ja: { a: "" },
          en: { a: "A" },
        }),
      () =>
        defineMessages({
          ja: { a: "あ" },
          // @ts-expect-error en の文言が空白だけ
          en: { a: " \n" },
        }),
      // 全角の空白と \r も空白として扱う（Issue #125 の reviewer 指摘。日本語の入力で全角の空白だけの文言を書きうる）。
      () =>
        defineMessages({
          // @ts-expect-error ja の文言が全角の空白だけ
          ja: { a: "\u3000 " },
          en: { a: "A" },
        }),
      () =>
        defineMessages({
          ja: { a: "あ" },
          // @ts-expect-error en の文言が \r と \n だけ
          en: { a: "\r\n" },
        }),
      // 文字列リテラルの型でない値（string 型の変数）は、空かどうかも placeholder も型で分からないので受け付けない。
      () =>
        defineMessages({
          // @ts-expect-error ja の文言が string 型（文字列リテラルの型ではない）
          ja: { a: stringValue },
          en: { a: "A" },
        }),
      () =>
        defineMessages({
          ja: { a: "あ" },
          // @ts-expect-error en の文言が string 型（文字列リテラルの型ではない）
          en: { a: stringValue },
        }),
      // placeholder の名前は英数字と _ だけ（formatMessage の置換 /\{(\w+)\}/ と同じ）。それ以外の {...} は、型では
      //   placeholder に見えても実行時に置き換わらないので、文言に書けない。
      () =>
        defineMessages({
          // @ts-expect-error placeholder の名前に - がある
          ja: { a: "{a-b} 件" },
          // @ts-expect-error en も同じ（ja と placeholder の集合が同じでも、名前が \w+ でない {...} は書けない）
          en: { a: "{a-b} items" },
        }),
      () =>
        defineMessages({
          // @ts-expect-error placeholder の名前が空
          ja: { a: "値は {}" },
          // @ts-expect-error en も同じ（ja と placeholder の集合が同じでも、名前が \w+ でない {...} は書けない）
          en: { a: "value is {}" },
        }),
      () =>
        defineMessages({
          // @ts-expect-error placeholder の名前に空白がある
          ja: { a: "{ max } 文字以内" },
          // @ts-expect-error en も同じ（ja と placeholder の集合が同じでも、名前が \w+ でない {...} は書けない）
          en: { a: "{ max } characters or fewer" },
        }),
    ];

    // then
    expect(typeErrors).toHaveLength(14);
  });

  // WHY } の後に { を書く: { の後に } があると、その間は placeholder の名前として検査される（上の「名前に空白がある」）。
  test("placeholder の名前は英数字と _ で、対にならない { や } は文言に書ける（型と実行時で同じ名前を置き換える）", () => {
    // given
    const messages = defineMessages({
      ja: { a: "{max_1} と {Id2}（} だけ、{ だけ）" },
      en: { a: "{Id2} and {max_1} (} only, { only)" },
    });

    // when
    const formatted = formatMessage(messages, "en", "a", {
      max_1: 3,
      Id2: "x",
    });

    // then
    expectTypeOf<MessageParams<typeof messages, "a">>().toEqualTypeOf<{
      readonly max_1: string | number;
      readonly Id2: string | number;
    }>();
    expect(formatted).toBe("x and 3 (} only, { only)");
  });
});

describe("formatMessage（辞書・ロケール・キーと params から文言を組み立てる）", () => {
  test("ロケールの辞書の文言を返す", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const ja = formatMessage(testMessages, "ja", "save");
    const en = formatMessage(testMessages, "en", "save");

    // then
    expect(ja).toBe("保存");
    expect(en).toBe("Save");
  });

  test("placeholder を params の値で置き換える（数も文字列にする）", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const number = formatMessage(testMessages, "ja", "tooLong", { max: 100 });
    const text = formatMessage(testMessages, "en", "toggle", { title: "Milk" });

    // then
    expect(number).toBe("タイトルは 100 文字以内で入力してください");
    expect(text).toBe("Mark “Milk” as completed");
  });

  test("文言の途中の placeholder を置き換え、前後の文言は残す", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const formatted = formatMessage(testMessages, "en", "unknownKeys", {
      keys: "a, b",
    });

    // then
    expect(formatted).toBe("The request has unknown fields: a, b");
  });

  test("複数の placeholder をそれぞれの値で置き換える", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const formatted = formatMessage(testMessages, "en", "pair", {
      a: "A",
      b: "B",
    });

    // then
    expect(formatted).toBe("B and A");
  });

  // WHY 置き換えずに残す: サーバの params が欠けたとき、"undefined" や空文字に化けると気づけない。{name} のまま出せば分かる。
  test("params に無い placeholder は {name} のまま残す", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const emptyParams = formatMessage(testMessages, "ja", "tooLong", {});
    const noParams = formatMessage(testMessages, "ja", "tooLong");

    // then
    expect(emptyParams).toBe("タイトルは {max} 文字以内で入力してください");
    expect(noParams).toBe("タイトルは {max} 文字以内で入力してください");
  });

  test("文言に無い params は無視する", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const formatted = formatMessage(testMessages, "ja", "save", { extra: "x" });

    // then
    expect(formatted).toBe("保存");
  });

  // Object.prototype の名前（toString など）を params の値と取り違えない。
  test("params が持たない名前は、Object.prototype の名前でも置き換えない", () => {
    // given
    const messages = defineMessages({
      ja: { a: "値は {toString}" },
      en: { a: "value is {toString}" },
    });

    // when
    const formatted = formatMessage(messages, "ja", "a", {});

    // then
    expect(formatted).toBe("値は {toString}");
  });
});

describe("createTranslator（辞書とロケールを固定した型付きの t）", () => {
  test("辞書とロケールを固定した t を返す", () => {
    // given
    const tJa = createTranslator(testMessages, "ja");
    const tEn = createTranslator(testMessages, "en");

    // when
    const ja = tJa("toggle", { title: "牛乳" });
    const en = tEn("toggle", { title: "Milk" });
    const noParams = tEn("save");

    // then
    expect(ja).toBe("「牛乳」を完了にする");
    expect(en).toBe("Mark “Milk” as completed");
    expect(noParams).toBe("Save");
  });

  // 型の検査（pnpm typecheck で確かめる）。呼ぶと存在しないキーで実行時エラーになるので、関数に包んで呼ばない。
  test("キーと params の誤りはコンパイルエラーになる", () => {
    // given
    const t = createTranslator(testMessages, "ja");

    // when
    const typeErrors = [
      // @ts-expect-error 存在しないキー
      () => t("nope"),
      // @ts-expect-error 別の辞書（otherMessages）のキー
      () => t("back"),
      // @ts-expect-error placeholder のある文言に params を渡さない
      () => t("tooLong"),
      // @ts-expect-error placeholder の名前が違う
      () => t("tooLong", { min: 1 }),
      // @ts-expect-error placeholder の無い文言に params を渡す
      () => t("save", { max: 1 }),
      // @ts-expect-error placeholder が 2 つの文言に 1 つだけ渡す
      () => t("pair", { a: "A" }),
      // @ts-expect-error params の値は文字列か数だけ
      () => t("tooLong", { max: true }),
    ];
    // 別の辞書の t には、その辞書のキーを渡せる（上の「別の辞書のキー」がキーの集合の違いで止まっていることの対照）。
    const otherLabel = createTranslator(otherMessages, "en")("back");

    // then
    expect(typeErrors).toHaveLength(7);
    expect(otherLabel).toBe("Back to list");
  });

  test("キーと params の型は、渡した辞書の ja の文言から導く", () => {
    // given
    type TestMessages = typeof testMessages;

    // when
    const keys = expectTypeOf<MessageKey<TestMessages>>();
    const tooLongParams =
      expectTypeOf<MessageParams<TestMessages, "tooLong">>();
    const pairParams = expectTypeOf<MessageParams<TestMessages, "pair">>();
    const saveArgs = expectTypeOf<TranslateArgs<TestMessages, "save">>();
    const toggleArgs = expectTypeOf<TranslateArgs<TestMessages, "toggle">>();
    const dictionary = expectTypeOf<TestMessages>();

    // then
    keys.toEqualTypeOf<
      "save" | "tooLong" | "toggle" | "unknownKeys" | "pair"
    >();
    tooLongParams.toEqualTypeOf<{
      readonly max: string | number;
    }>();
    pairParams.toEqualTypeOf<{
      readonly a: string | number;
      readonly b: string | number;
    }>();
    saveArgs.toEqualTypeOf<[]>();
    toggleArgs.toEqualTypeOf<[params: { readonly title: string | number }]>();
    // defineMessages が返す辞書は Messages（ja と en を持つ辞書の一般の形）に当てはまる。
    dictionary.toExtend<Messages>();
  });
});

describe("isMessageKey（サーバから届いた文字列が辞書のキーか）", () => {
  test("辞書にあるキーなら true", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const save = isMessageKey(testMessages, "save");
    const tooLong = isMessageKey(testMessages, "tooLong");

    // then
    expect(save).toBe(true);
    expect(tooLong).toBe(true);
  });

  test.each(["nope", "", "back", "toString", "__proto__", "constructor"])(
    "辞書に無い値（%j。別の辞書のキー、Object.prototype の名前を含む）なら false",
    (value) => {
      // given: 前提なし（value は test.each の引数）
      // when
      const result = isMessageKey(testMessages, value);

      // then
      expect(result).toBe(false);
    },
  );
});

// ロケールや辞書を変えて描き直せるよう、hook を呼ぶ部品を LocaleProvider で包んで描く。
// WHY renderHook を使わない: renderHook の wrapper には initialProps が渡らず（Testing Library 16.3.3）、rerender でロケールを変えられない。
function renderWithLocale<P, T>(
  hook: (props: P) => T,
  locale: Locale,
  props: P,
) {
  const result: { current: T | undefined } = { current: undefined };
  function Probe(probeProps: { value: P }) {
    result.current = hook(probeProps.value);
    return null;
  }
  const view = render(
    <LocaleProvider locale={locale}>
      <Probe value={props} />
    </LocaleProvider>,
  );
  const rerender = (next: Locale, nextProps: P) =>
    view.rerender(
      <LocaleProvider locale={next}>
        <Probe value={nextProps} />
      </LocaleProvider>,
    );
  return { result: result as { current: T }, rerender };
}

describe("useLocale", () => {
  test("LocaleProvider のロケールを返す", () => {
    // given: 前提なし
    // when
    const { result } = renderWithLocale(() => useLocale(), "en", undefined);

    // then
    expect(result.current).toBe("en");
  });

  // WHY 既定に落とす（エラーにしない）: app/layout.tsx が必ず LocaleProvider で包む。包まれないのはテストなどで、
  //   Proxy を通らないリクエストと同じく既定の ja で表示すればよい。
  test("LocaleProvider の外では既定の ja を返す", () => {
    // given: 前提なし
    // when
    const { result } = renderHook(() => useLocale());

    // then
    expect(result.current).toBe("ja");
  });
});

describe("useT（画面のロケールで、渡した辞書を翻訳する t）", () => {
  test("LocaleProvider のロケールで、渡した辞書を翻訳する t を返す", () => {
    // given: 前提なし（testMessages はモジュールの定数）
    // when
    const { result } = renderWithLocale(
      (messages: typeof testMessages) => useT(messages),
      "en",
      testMessages,
    );

    // then
    expect(result.current("toggle", { title: "Milk" })).toBe(
      "Mark “Milk” as completed",
    );
  });

  test("ロケールが変わると、新しいロケールで翻訳する t に変わる", () => {
    // given
    const { result, rerender } = renderWithLocale(
      (messages: typeof testMessages) => useT(messages),
      "ja",
      testMessages,
    );
    const before = result.current("save");

    // when
    rerender("en", testMessages);

    // then
    expect(before).toBe("保存");
    expect(result.current("save")).toBe("Save");
  });

  // WHY 辞書も依存に入れる: 同じ部品で辞書を切り替えたときに、前の辞書の t が残らないようにする。
  test("辞書が変わると、新しい辞書で翻訳する t に変わる", () => {
    // given
    const { result, rerender } = renderWithLocale(
      (messages: Messages) => useT(messages) as (key: string) => string,
      "en",
      testMessages as Messages,
    );
    const before = result.current("save");

    // when
    rerender("en", otherMessages as Messages);

    // then
    expect(before).toBe("Save");
    expect(result.current("back")).toBe("Back to list");
  });

  // WHY 同じ関数を返す: t を useEffect / useCallback の依存に入れても、描画のたびに作り直されないようにする。
  test("ロケールと辞書が変わらなければ、再描画しても同じ t を返す", () => {
    // given
    const { result, rerender } = renderWithLocale(
      (messages: typeof testMessages) => useT(messages),
      "ja",
      testMessages,
    );
    const first = result.current;

    // when
    rerender("ja", testMessages);

    // then
    expect(result.current).toBe(first);
  });
});

describe("LocaleProvider", () => {
  test("子要素をそのまま描く", () => {
    // given: 前提なし
    // when
    render(
      <LocaleProvider locale="ja">
        <p>child</p>
      </LocaleProvider>,
    );

    // then
    expect(screen.getByText("child")).toBeDefined();
  });
});
