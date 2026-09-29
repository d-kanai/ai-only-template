import type {
  ErrorKey,
  ErrorKeyParams,
} from "@repo/backend/shared/presentation/problem";
import { describe, expect, expectTypeOf, test } from "vitest";
import { ApiError, toErrorMessage } from "@/features/todo/api/api-error";
import type { commonMessages } from "@/shared/i18n/common.messages";
import type { MessageKey, MessageParams } from "@/shared/i18n/i18n";

type CommonMessages = typeof commonMessages;

describe("ApiError", () => {
  // status と type は、画面が文言以外で失敗を見分けるための値（Problem Details の type。RFC 9457）。
  test("サーバのエラーの HTTP ステータス・type・キー・params を持つ Error", () => {
    const error = new ApiError({
      status: 400,
      type: "/problems/validation-error",
      key: "todo.title.tooLong",
      params: { max: 100 },
    });

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
    const error = new ApiError({ status: 502, key: "error.unknown" });

    expect(error.type).toBeUndefined();
    expect(error.params).toEqual({});
  });
});

describe("toErrorMessage（失敗の理由を画面の文言にする）", () => {
  test("ApiError はキーと params を、ロケールの辞書で翻訳する", () => {
    const error = new ApiError({
      status: 404,
      type: "/problems/not-found",
      key: "todo.notFound",
      params: { id: "todo-1" },
    });

    expect(toErrorMessage(error, "ja")).toBe(
      "Todo（id: todo-1）が見つかりません",
    );
    expect(toErrorMessage(error, "en")).toBe("Todo (id: todo-1) was not found");
  });

  test("HTTP ステータスだけが分かる失敗（error.unknown）は、ステータスを入れて翻訳する", () => {
    expect(
      toErrorMessage(
        new ApiError({
          status: 502,
          key: "error.unknown",
          params: { status: 502 },
        }),
        "ja",
      ),
    ).toBe("通信に失敗しました（HTTP 502）");
  });

  // fetch そのものの失敗（ネットワークの切断で TypeError）など、API の応答ではない失敗。
  // WHY Error の message を出さない: ブラウザが作る英語の message（"Failed to fetch"）はロケールに合わず、利用者に意味が伝わらない。
  test.each([
    ["ApiError でない Error", new TypeError("Failed to fetch")],
    ["Error でない値", "network down"],
    ["undefined", undefined],
  ])("%s は、固定の文言（error.unexpected）にする", (_label, reason) => {
    expect(toErrorMessage(reason, "ja")).toBe("予期しないエラーが発生しました");
    expect(toErrorMessage(reason, "en")).toBe("An unexpected error occurred");
  });
});

// 型の検査（pnpm typecheck で確かめる）。backend の ErrorKey と共通の辞書（shared/i18n/common.messages.ts）の対応。
describe("backend の ErrorKey と共通の辞書の対応（型）", () => {
  // ErrorKey がすべて共通の辞書のキーであることは、api-error.ts の ApiErrorKey の制約（TranslatedKey<K extends MessageKey<...>>）で止める。
  test("ErrorKey はすべて共通の辞書のキー", () => {
    expectTypeOf<ErrorKey>().toExtend<MessageKey<CommonMessages>>();
  });

  // WHY 過不足なく一致させる: 共通の辞書に置くのは、どの画面でも出る API のエラー（ErrorKey）と画面側だけのエラー（error.*）だけ。
  //   画面・部品に固有の文言（「削除」など）は、その隣の *.messages.ts に置く（Issue #125）。ここに混ざると、どの画面の文言かが
  //   ファイルの場所から分からなくなる。backend から消えた ErrorKey が残ることも止める。
  test("共通の辞書のキーは、ErrorKey と error.unknown・error.unexpected だけ（画面固有の文言を置かない）", () => {
    expectTypeOf<MessageKey<CommonMessages>>().toEqualTypeOf<
      ErrorKey | "error.unknown" | "error.unexpected"
    >();
  });

  // backend の params の名前（ErrorKeyParams）と、ja の文言の placeholder の名前が一致しないキーの一覧。空（never）であること。
  // WHY: backend が { max } を送るのに文言が {limit} だと、置換されずに {limit} と表示される。
  test("各 ErrorKey の params の名前は、ja の文言の placeholder と同じ", () => {
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
    expectTypeOf<Mismatched>().toEqualTypeOf<never>();
  });
});
