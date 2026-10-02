import type {
  ErrorKey,
  ErrorKeyParams,
} from "@repo/backend/shared/presentation/problem";
import { describe, expect, expectTypeOf, test } from "vitest";
import { ApiError, ApiErrorMessage } from "@/features/todo/api/api-error";
import { commonMessages } from "@/shared/i18n/common.messages";
import type { MessageKey, MessageParams } from "@/shared/i18n/i18n";
import { tJa } from "@/test-support/i18n";

type CommonMessages = typeof commonMessages;

describe("ApiError", () => {
  // status と type は、画面が文言以外で失敗を見分けるための値（Problem Details の type。RFC 9457）。
  test("サーバのエラーの HTTP ステータス・type・キー・params を持つ Error", () => {
    // given: 前提なし
    // when
    const error = new ApiError({
      status: 400,
      type: "/problems/validation-error",
      key: "todo.title.tooLong",
      params: { max: 100 },
    });

    // then
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.status).toBe(400);
    expect(error.type).toBe("/problems/validation-error");
    expect(error.key).toBe("todo.title.tooLong");
    expect(error.params).toEqual({ max: 100 });
    // message は画面に出さない（出すのは key の翻訳）。ログや開発者ツールで何のエラーかが分かるよう key を入れる。
    expect(error.message).toBe("todo.title.tooLong");
  });

  // 本文が Problem Details でない失敗（error.unknown）は type が分からない。
  test("type と params を省くと、type は undefined、params は空のオブジェクトになる", () => {
    // given: 前提なし
    // when
    const error = new ApiError({ status: 502, key: "error.unknown" });

    // then
    expect(error.type).toBeUndefined();
    expect(error.params).toEqual({});
  });

  // errors は Problem Details の拡張メンバー（項目ごとの誤り。apps/backend/shared/presentation/problem.ts の ProblemError）。
  test("errors を省くと、項目ごとの誤りは空の配列になる", () => {
    // given: 前提なし
    // when
    const error = new ApiError({ status: 404, key: "todo.notFound" });

    // then
    expect(error.errors).toStrictEqual([]);
  });

  // WHY detail を持たない: 画面に出さない開発者向けの英語（ApiError 全体の方針と同じ）。
  //   todo-api.ts は本文の errors をそのまま渡すので、detail を落とすのはここ（コンストラクタ）で行う。
  test("errors の各要素は pointer・key・params だけを持ち（detail は落とす）、params を省くと空のオブジェクトになる", () => {
    // given
    const serverErrors = [
      {
        pointer: "#/title",
        key: "todo.title.tooLong" as const,
        params: { max: 100 },
        detail: "Title must be 100 characters or fewer.",
      },
      {
        pointer: "#",
        key: "request.body.notObject" as const,
        detail: "Request body must be a JSON object.",
      },
    ];

    // when
    const error = new ApiError({
      status: 400,
      type: "/problems/validation-error",
      key: "todo.title.tooLong",
      params: { max: 100 },
      errors: serverErrors,
    });

    // then
    expect(error.errors).toStrictEqual([
      { pointer: "#/title", key: "todo.title.tooLong", params: { max: 100 } },
      { pointer: "#", key: "request.body.notObject", params: {} },
    ]);
  });
});

describe("ApiErrorMessage.toMessage（失敗の理由を画面の文言にする）", () => {
  test("ApiError はキーと params を、ロケールの辞書で翻訳する", () => {
    // given
    const error = new ApiError({
      status: 404,
      type: "/problems/not-found",
      key: "todo.notFound",
      params: { id: "todo-1" },
    });

    // when
    const ja = ApiErrorMessage.toMessage(error, "ja");
    const en = ApiErrorMessage.toMessage(error, "en");

    // then
    expect(ja).toBe("Todo（id: todo-1）が見つかりません");
    expect(en).toBe("Todo (id: todo-1) was not found");
  });

  test("HTTP ステータスだけが分かる失敗（error.unknown）は、ステータスを入れて翻訳する", () => {
    // given
    const error = new ApiError({
      status: 502,
      key: "error.unknown",
      params: { status: 502 },
    });

    // when
    const message = ApiErrorMessage.toMessage(error, "ja");

    // then
    expect(message).toBe("通信に失敗しました（HTTP 502）");
  });

  // fetch そのものの失敗（ネットワークの切断で TypeError）など、API の応答ではない失敗。
  // WHY Error の message を出さない: ブラウザが作る英語の message（"Failed to fetch"）はロケールに合わず、利用者に意味が伝わらない。
  test.each([
    ["ApiError でない Error", new TypeError("Failed to fetch")],
    ["Error でない値", "network down"],
    ["undefined", undefined],
  ])("%s は、固定の文言（error.unexpected）にする", (_label, reason) => {
    // given: 前提なし（reason は test.each の引数）
    // when
    const ja = ApiErrorMessage.toMessage(reason, "ja");
    const en = ApiErrorMessage.toMessage(reason, "en");

    // then
    expect(ja).toBe("予期しないエラーが発生しました");
    expect(en).toBe("An unexpected error occurred");
  });
});

// 400 の errors（項目ごとの誤り）を、入力の下に出す文言（fields）とフォーム全体の文言（form）に分ける。
// fields に渡すのは、その画面が入力を描く項目の名前（リクエストの本文の最上位のキー）。
describe("ApiErrorMessage.toMessages（失敗の理由を、フォーム全体の文言と項目ごとの文言にする）", () => {
  const validation = { status: 400, type: "/problems/validation-error" };

  test("errors が無い ApiError（404 など）は、フォーム全体の文言だけ（ApiErrorMessage.toMessage と同じ）", () => {
    // given
    const error = new ApiError({
      status: 404,
      type: "/problems/not-found",
      key: "todo.notFound",
      params: { id: "todo-1" },
    });

    // when
    const messages = ApiErrorMessage.toMessages(error, "ja", ["title"]);

    // then
    expect(messages).toStrictEqual({
      form: tJa(commonMessages, "todo.notFound", { id: "todo-1" }),
      fields: {},
    });
  });

  test("ApiError でない失敗は、フォーム全体の固定の文言（error.unexpected）だけ", () => {
    // given
    const error = new TypeError("Failed to fetch");

    // when
    const messages = ApiErrorMessage.toMessages(error, "ja", ["title"]);

    // then
    expect(messages).toStrictEqual({
      form: tJa(commonMessages, "error.unexpected"),
      fields: {},
    });
  });

  // WHY フォーム全体の文言を出さない: 本文の key は errors の最初の 1 件と同じ（problem.ts の Problem の key）。
  //   両方を出すと、同じ文言が入力の下とフォームの上に 2 回出る。
  test("pointer が描いている項目（#/title）を指す誤りは、その項目の文言になり、フォーム全体の文言は出さない", () => {
    // given
    const error = new ApiError({
      ...validation,
      key: "todo.title.empty",
      errors: [{ pointer: "#/title", key: "todo.title.empty" }],
    });

    // when
    const messages = ApiErrorMessage.toMessages(error, "ja", ["title"]);

    // then
    expect(messages).toStrictEqual({
      form: null,
      fields: { title: tJa(commonMessages, "todo.title.empty") },
    });
  });

  test("項目の誤りの params を文言に埋め込み、ロケールの辞書で翻訳する", () => {
    // given
    const error = new ApiError({
      ...validation,
      key: "todo.title.tooLong",
      params: { max: 100 },
      errors: [
        { pointer: "#/title", key: "todo.title.tooLong", params: { max: 100 } },
      ],
    });

    // when
    const ja = ApiErrorMessage.toMessages(error, "ja", ["title"]);
    const en = ApiErrorMessage.toMessages(error, "en", ["title"]);

    // then
    expect(ja.fields).toStrictEqual({
      title: "タイトルは 100 文字以内で入力してください",
    });
    expect(en.fields).toStrictEqual({
      title: "The title must be 100 characters or fewer",
    });
  });

  // 本文全体（#）の誤りは項目に結び付かないので、フォーム全体に出す。
  test("項目の誤り（#/title）と本文全体の誤り（#）の 2 件は、項目の文言とフォーム全体の文言に分ける", () => {
    // given
    const error = new ApiError({
      ...validation,
      key: "request.field.notString",
      params: { path: "title" },
      errors: [
        {
          pointer: "#/title",
          key: "request.field.notString",
          params: { path: "title" },
        },
        {
          pointer: "#",
          key: "request.body.unknownKeys",
          params: { keys: "extra" },
        },
      ],
    });

    // when
    const messages = ApiErrorMessage.toMessages(error, "ja", ["title"]);

    // then
    expect(messages).toStrictEqual({
      form: tJa(commonMessages, "request.body.unknownKeys", { keys: "extra" }),
      fields: {
        title: tJa(commonMessages, "request.field.notString", {
          path: "title",
        }),
      },
    });
  });

  // 画面に入力の無い項目の誤りを捨てると、利用者は何も表示されないまま送信に失敗する。フォーム全体に出して伝える。
  test.each([
    ["描いていない項目（#/completed）", "#/completed"],
    ["入れ子の位置（#/title/0）", "#/title/0"],
    ["# の無い項目名（title）", "title"],
    ["前方が一致するだけの項目（#/titles）", "#/titles"],
  ])("pointer が %s の誤りは、フォーム全体の文言になる", (_label, pointer) => {
    // given
    const error = new ApiError({
      ...validation,
      key: "request.field.notBoolean",
      params: { path: "completed" },
      errors: [
        {
          pointer,
          key: "request.field.notBoolean",
          params: { path: "completed" },
        },
      ],
    });

    // when
    const messages = ApiErrorMessage.toMessages(error, "ja", ["title"]);

    // then
    expect(messages).toStrictEqual({
      form: tJa(commonMessages, "request.field.notBoolean", {
        path: "completed",
      }),
      fields: {},
    });
  });

  test("描く項目を複数渡すと、それぞれの pointer の誤りをその項目の文言にする", () => {
    // given
    const error = new ApiError({
      ...validation,
      key: "request.field.notString",
      params: { path: "title" },
      errors: [
        {
          pointer: "#/title",
          key: "request.field.notString",
          params: { path: "title" },
        },
        {
          pointer: "#/completed",
          key: "request.field.notBoolean",
          params: { path: "completed" },
        },
      ],
    });

    // when
    const messages = ApiErrorMessage.toMessages(error, "ja", [
      "title",
      "completed",
    ]);

    // then
    expect(messages).toStrictEqual({
      form: null,
      fields: {
        title: tJa(commonMessages, "request.field.notString", {
          path: "title",
        }),
        completed: tJa(commonMessages, "request.field.notBoolean", {
          path: "completed",
        }),
      },
    });
  });

  // WHY 最初の 1 件: 入力の下とフォームの上には文言を 1 つずつ出す（hook の error・fieldErrors は文字列 1 つ）。
  //   backend の errors の順は zod の issue の順で、本文の key は最初の 1 件と同じ（json-body.ts）。
  //   今の画面が送る本文（項目 1 つ）では、同じ項目の誤りと本文全体（#）の誤りはそれぞれ 1 件までしか返らない。
  test("同じ項目の誤りが複数あれば、その項目の文言は最初の 1 件。項目に結び付かない誤りが複数あれば、フォーム全体の文言も最初の 1 件", () => {
    // given
    const error = new ApiError({
      ...validation,
      key: "todo.title.empty",
      errors: [
        { pointer: "#/title", key: "todo.title.empty" },
        { pointer: "#/title", key: "todo.title.invalid" },
        {
          pointer: "#",
          key: "request.body.unknownKeys",
          params: { keys: "a" },
        },
        { pointer: "#", key: "request.body.notObject" },
      ],
    });

    // when
    const messages = ApiErrorMessage.toMessages(error, "ja", ["title"]);

    // then
    expect(messages).toStrictEqual({
      form: tJa(commonMessages, "request.body.unknownKeys", { keys: "a" }),
      fields: { title: tJa(commonMessages, "todo.title.empty") },
    });
  });
});

// 型の検査（pnpm typecheck で確かめる）。backend の ErrorKey と共通の辞書（shared/i18n/common.messages.ts）の対応。
describe("backend の ErrorKey と共通の辞書の対応（型）", () => {
  // ErrorKey がすべて共通の辞書のキーであることは、api-error.ts の ApiErrorKey の制約（TranslatedKey<K extends MessageKey<...>>）で止める。
  test("ErrorKey はすべて共通の辞書のキー", () => {
    // given: 前提なし
    // when
    const errorKey = expectTypeOf<ErrorKey>();

    // then
    errorKey.toExtend<MessageKey<CommonMessages>>();
  });

  // WHY 過不足なく一致させる: 共通の辞書に置くのは、どの画面でも出る API のエラー（ErrorKey）と画面側だけのエラー（error.*）だけ。
  //   画面・部品に固有の文言（「削除」など）は、その隣の *.messages.ts に置く（Issue #125）。ここに混ざると、どの画面の文言かが
  //   ファイルの場所から分からなくなる。backend から消えた ErrorKey が残ることも止める。
  test("共通の辞書のキーは、ErrorKey と error.unknown・error.unexpected だけ（画面固有の文言を置かない）", () => {
    // given: 前提なし
    // when
    const commonKey = expectTypeOf<MessageKey<CommonMessages>>();

    // then
    commonKey.toEqualTypeOf<ErrorKey | "error.unknown" | "error.unexpected">();
  });

  // backend の params の名前（ErrorKeyParams）と、ja の文言の placeholder の名前が一致しないキーの一覧。空（never）であること。
  // WHY: backend が { max } を送るのに文言が {limit} だと、置換されずに {limit} と表示される。
  test("各 ErrorKey の params の名前は、ja の文言の placeholder と同じ", () => {
    // given
    // Record<string, never>（params の無いキー）は keyof が string になるので、名前なし（never）として扱う。
    type ParamNames<P> = string extends keyof P ? never : keyof P;
    type Mismatched = {
      [K in ErrorKey]: [ParamNames<ErrorKeyParams[K]>] extends [
        keyof MessageParams<CommonMessages, K>,
      ]
        ? [keyof MessageParams<CommonMessages, K>] extends [
            ParamNames<ErrorKeyParams[K]>,
          ]
          ? never
          : K
        : K;
    }[ErrorKey];

    // when
    const mismatched = expectTypeOf<Mismatched>();

    // then
    mismatched.toEqualTypeOf<never>();
  });
});
