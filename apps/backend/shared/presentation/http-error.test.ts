// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { DomainError } from "../domain/domain-error";
import {
  type ErrorResponse,
  InvalidRequestError,
  toErrorResponse,
} from "./http-error";

describe("InvalidRequestError", () => {
  // name はログやスタックトレースの先頭に出る。Error のままだと想定外の例外と見分けられない。
  test("message を持ち、name は InvalidRequestError になる", () => {
    const error = new InvalidRequestError("title は文字列で指定してください");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("title は文字列で指定してください");
    expect(error.name).toBe("InvalidRequestError");
  });
});

describe("toErrorResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("DomainError の validation_error は 400 と ErrorResponse になる", async () => {
    const response = toErrorResponse(
      new DomainError("validation_error", "タイトルが不正です"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: { code: "validation_error", message: "タイトルが不正です" },
    });
  });

  test("DomainError の not_found は 404 と ErrorResponse になる", async () => {
    const response = toErrorResponse(
      new DomainError("not_found", "Todo が見つかりません"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: { code: "not_found", message: "Todo が見つかりません" },
    });
  });

  test("リクエストの形の誤り（InvalidRequestError）は 400 の validation_error になる", async () => {
    const response = toErrorResponse(
      new InvalidRequestError("title は文字列で指定してください"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: {
        code: "validation_error",
        message: "title は文字列で指定してください",
      },
    });
  });

  test("想定外の例外は 500 になり、内部のメッセージをクライアントに返さない", async () => {
    // 500 のときはサーバのログに原因を残す実装なので、テスト出力を汚さないよう黙らせる。
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = toErrorResponse(new Error("DB のパスワードが違います"));

    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorResponse;
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("パスワード");
  });

  test("想定外の例外は logger.error で、例外の name と message を含む 1 行の JSON としてサーバのログ（stderr）に残す", () => {
    // logger（apps/backend/shared/infra/logger.ts）は error を console.error に 1 行の文字列で渡す。
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const error = new Error("想定外");

    toErrorResponse(error);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toEqual({
      level: "error",
      timestamp: expect.any(String),
      message: "想定外の例外",
      error: { name: "Error", message: "想定外" },
    });
  });

  test("DomainError と InvalidRequestError はクライアントの誤りなので、ログに残さない", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    toErrorResponse(new DomainError("not_found", "見つかりません"));
    toErrorResponse(new InvalidRequestError("JSON ではありません"));

    expect(consoleError).not.toHaveBeenCalled();
  });
});
