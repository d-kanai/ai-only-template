// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { DomainError } from "../domain/domain-error";
import {
  type ErrorIssue,
  type ErrorResponse,
  InvalidRequestError,
  toErrorResponse,
} from "./http-error";

describe("InvalidRequestError", () => {
  // name はログやスタックトレースの先頭に出る。Error のままだと想定外の例外と見分けられない。
  // message は開発者向け（キーと params の JSON）。画面は key と params を翻訳する（Issue #116）。
  test("key を持ち、message はキー、name は InvalidRequestError になる（params と issues は無い）", () => {
    const error = new InvalidRequestError("request.body.notJson");

    expect(error).toBeInstanceOf(Error);
    expect(error.key).toBe("request.body.notJson");
    expect(error.params).toBeUndefined();
    expect(error.message).toBe("request.body.notJson");
    expect(error.name).toBe("InvalidRequestError");
    expect(error.issues).toBeUndefined();
  });

  test("params と項目ごとの誤り（issues）を持て、message はキーと params の JSON になる", () => {
    const issues: ErrorIssue[] = [
      {
        path: "title",
        key: "request.field.notString",
        params: { path: "title" },
      },
    ];

    const error = new InvalidRequestError(
      "request.field.notString",
      { path: "title" },
      issues,
    );

    expect(error.key).toBe("request.field.notString");
    expect(error.params).toEqual({ path: "title" });
    expect(error.message).toBe('request.field.notString {"path":"title"}');
    expect(error.issues).toEqual(issues);
  });

  // 型の検査（pnpm typecheck の tsc -p apps/backend が見る。domain-error.test.ts と同じ）。
  test("params の要るキーに渡し忘れる・params の無いキーに渡すと、コンパイルエラーになる", () => {
    const typeOnly = () => [
      // @ts-expect-error request.field.notString は { path: string } が必須
      new InvalidRequestError("request.field.notString"),
      // @ts-expect-error request.body.notJson は params を持たない
      new InvalidRequestError("request.body.notJson", { path: "title" }),
    ];

    expect(typeof typeOnly).toBe("function");
  });
});

describe("toErrorResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("DomainError の validation_error は 400 と、key（と params）の ErrorResponse になる", async () => {
    const response = toErrorResponse(
      new DomainError("validation_error", "todo.title.tooLong", { max: 100 }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: {
        code: "validation_error",
        key: "todo.title.tooLong",
        params: { max: 100 },
      },
    });
  });

  // params の無いキーは本文に params のキーを出さない（toEqual は undefined のプロパティを無いものと同じに扱うので、
  //   キーの有無は Object.keys で確かめる）。
  test("DomainError の params が無ければ、ErrorResponse に params のキーを出さない", async () => {
    const response = toErrorResponse(
      new DomainError("validation_error", "todo.title.empty"),
    );

    const body = (await response.json()) as ErrorResponse;
    expect(Object.keys(body.error)).toEqual(["code", "key"]);
    expect(body).toEqual({
      error: { code: "validation_error", key: "todo.title.empty" },
    });
  });

  test("DomainError の not_found は 404 と ErrorResponse になる", async () => {
    const response = toErrorResponse(
      new DomainError("not_found", "todo.notFound", { id: "abc" }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: { code: "not_found", key: "todo.notFound", params: { id: "abc" } },
    });
  });

  test("リクエストの形の誤り（InvalidRequestError）は 400 の validation_error になる（issues が無ければキーを出さない）", async () => {
    const response = toErrorResponse(
      new InvalidRequestError("request.body.notJson"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponse;
    expect(Object.keys(body.error)).toEqual(["code", "key"]);
    expect(body).toEqual({
      error: { code: "validation_error", key: "request.body.notJson" },
    });
  });

  test("InvalidRequestError の params と issues は、ErrorResponse の error.params・error.issues にそのまま入れる", async () => {
    const issues: ErrorIssue[] = [
      {
        path: "title",
        key: "request.field.notString",
        params: { path: "title" },
      },
      {
        path: "",
        key: "request.body.unknownKeys",
        params: { keys: "extra" },
      },
    ];

    const response = toErrorResponse(
      new InvalidRequestError(
        "request.field.notString",
        { path: "title" },
        issues,
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: {
        code: "validation_error",
        key: "request.field.notString",
        params: { path: "title" },
        issues,
      },
    });
  });

  test("想定外の例外は 500 の internal_error と server.internalError になり、内部のメッセージをクライアントに返さない", async () => {
    // 500 のときはサーバのログに原因を残す実装なので、テスト出力を汚さないよう黙らせる。
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = toErrorResponse(new Error("DB のパスワードが違います"));

    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toEqual({
      error: { code: "internal_error", key: "server.internalError" },
    });
  });

  test("想定外の例外は logger.error で、例外の name と message を含む 1 行の JSON としてサーバのログ（stderr）に残す", () => {
    // logger（apps/shared/logger.ts。Issue #90 で移した）は error を console.error に 1 行の文字列で渡す。
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
      message: "unexpected error",
      error: { name: "Error", message: "想定外" },
    });
  });

  test("DomainError と InvalidRequestError はクライアントの誤りなので、ログに残さない", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    toErrorResponse(new DomainError("not_found", "todo.notFound", { id: "a" }));
    toErrorResponse(new InvalidRequestError("request.body.notJson"));

    expect(consoleError).not.toHaveBeenCalled();
  });
});
