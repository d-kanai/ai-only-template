import type {
  ErrorKey,
  ErrorKeyParams,
} from "@repo/backend/shared/presentation/http-error";
import { describe, expect, expectTypeOf, test } from "vitest";
import { ApiError, toErrorMessage } from "@/features/todo/api/api-error";
import type { MessageKey, MessageParams } from "@/shared/i18n/messages";

describe("ApiError", () => {
  test("サーバのエラーのキーと params を持つ Error", () => {
    const error = new ApiError("todo.title.tooLong", { max: 100 });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.key).toBe("todo.title.tooLong");
    expect(error.params).toEqual({ max: 100 });
    // message は画面に出さない（出すのは key の翻訳）。ログや開発者ツールで何のエラーかが分かるよう key を入れる。
    expect(error.message).toBe("todo.title.tooLong");
  });

  test("params を省くと空のオブジェクトになる", () => {
    expect(new ApiError("todo.title.empty").params).toEqual({});
  });
});

describe("toErrorMessage（失敗の理由を画面の文言にする）", () => {
  test("ApiError はキーと params を、ロケールの辞書で翻訳する", () => {
    const error = new ApiError("todo.notFound", { id: "todo-1" });

    expect(toErrorMessage(error, "ja")).toBe(
      "Todo（id: todo-1）が見つかりません",
    );
    expect(toErrorMessage(error, "en")).toBe("Todo (id: todo-1) was not found");
  });

  test("HTTP ステータスだけが分かる失敗（error.unknown）は、ステータスを入れて翻訳する", () => {
    expect(
      toErrorMessage(new ApiError("error.unknown", { status: 502 }), "ja"),
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

// 型の検査（pnpm typecheck で確かめる）。backend の ErrorKey と画面の辞書の対応。
describe("backend の ErrorKey と辞書の対応（型）", () => {
  // ErrorKey がすべて辞書のキーであることは、api-error.ts の ApiErrorKey の制約（TranslatedKey<K extends MessageKey>）で止める。
  test("ErrorKey はすべて辞書のキー", () => {
    expectTypeOf<ErrorKey>().toExtend<MessageKey>();
  });

  // backend の params の名前（ErrorKeyParams）と、ja の文言の placeholder の名前が一致しないキーの一覧。空（never）であること。
  // WHY: backend が { max } を送るのに文言が {limit} だと、置換されずに {limit} と表示される。
  test("各 ErrorKey の params の名前は、ja の文言の placeholder と同じ", () => {
    // Record<string, never>（params の無いキー）は keyof が string になるので、名前なし（never）として扱う。
    type ParamNames<P> = string extends keyof P ? never : keyof P;
    type Mismatched = {
      [K in ErrorKey]: [ParamNames<ErrorKeyParams[K]>] extends [
        keyof MessageParams<K>,
      ]
        ? [keyof MessageParams<K>] extends [ParamNames<ErrorKeyParams[K]>]
          ? never
          : K
        : K;
    }[ErrorKey];
    expectTypeOf<Mismatched>().toEqualTypeOf<never>();
  });
});
