// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { DomainError } from "../domain/domain-error";
import {
  InvalidRequestError,
  type Problem,
  type ProblemErrorInput,
  toProblemResponse,
  withProblemResponse,
} from "./problem";

describe("InvalidRequestError", () => {
  // name はログやスタックトレースの先頭に出る。Error のままだと想定外の例外と見分けられない。
  // message は開発者向け（キーと params の JSON）。画面は key と params を翻訳する（Issue #116）。
  test("key を持ち、message はキー、name は InvalidRequestError になる（params と errors は無い）", () => {
    const error = new InvalidRequestError("request.body.notJson");

    expect(error).toBeInstanceOf(Error);
    expect(error.key).toBe("request.body.notJson");
    expect(error.params).toBeUndefined();
    expect(error.message).toBe("request.body.notJson");
    expect(error.name).toBe("InvalidRequestError");
    expect(error.errors).toBeUndefined();
  });

  test("params と項目ごとの誤り（errors）を持て、message はキーと params の JSON になる", () => {
    const errors: ProblemErrorInput[] = [
      {
        pointer: "#/title",
        key: "request.field.notString",
        params: { path: "title" },
      },
    ];

    const error = new InvalidRequestError(
      "request.field.notString",
      { path: "title" },
      errors,
    );

    expect(error.key).toBe("request.field.notString");
    expect(error.params).toEqual({ path: "title" });
    expect(error.message).toBe('request.field.notString {"path":"title"}');
    expect(error.errors).toEqual(errors);
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

// RFC 9457（Problem Details for HTTP APIs。https://www.rfc-editor.org/rfc/rfc9457.html ）の本文。
// WHY 本文を toStrictEqual で丸ごと比べる: type / title / status / key / params / errors はクライアント（画面）との契約で、
//   detail も英語の文言を固定する（problem-detail.en.ts）。toStrictEqual は undefined のプロパティと無いプロパティを区別するので、
//   params・errors が無いときに本文にキーが出ないこと（JSON.stringify は undefined を出さない）も確かめられる。
// WHY Content-Type を確かめる: application/problem+json は RFC 9457 の 3 節が定めるメディア型で、汎用の HTTP ソフトウェアや
//   クライアントが「これは Problem Details だ」と見分ける手がかりになる（本文の形だけでは分からない）。
async function expectProblem(
  response: Response,
  expected: Problem,
): Promise<void> {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  await expect(response.json()).resolves.toStrictEqual(expected);
}

function request(path: string): Request {
  return new Request(`http://localhost${path}?q=1`, { method: "POST" });
}

describe("toProblemResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("DomainError の validation_error は 400 の /problems/validation-error になり、key・params と英語の detail を持つ", async () => {
    const response = toProblemResponse(
      new DomainError("validation_error", "todo.title.tooLong", { max: 100 }),
      request("/api/todos"),
    );

    await expectProblem(response, {
      type: "/problems/validation-error",
      title: "Validation error",
      status: 400,
      detail: "Title must be at most 100 characters.",
      instance: "/api/todos",
      key: "todo.title.tooLong",
      params: { max: 100 },
    });
  });

  test("DomainError の params が無ければ、本文に params のキーを出さない", async () => {
    const response = toProblemResponse(
      new DomainError("validation_error", "todo.title.empty"),
      request("/api/todos"),
    );

    await expectProblem(response, {
      type: "/problems/validation-error",
      title: "Validation error",
      status: 400,
      detail: "Title must not be empty.",
      instance: "/api/todos",
      key: "todo.title.empty",
    });
  });

  // instance はクエリを含まない URL のパス（new URL(request.url).pathname）。
  // WHY パスだけ: リクエストログと同じ方針でクエリの値は出さない（Issue #85）。パスの id は params と detail にも出る。
  test("DomainError の not_found は 404 の /problems/not-found になり、instance はリクエストのパス（クエリを除く）", async () => {
    const response = toProblemResponse(
      new DomainError("not_found", "todo.notFound", { id: "abc" }),
      request("/api/todos/abc"),
    );

    await expectProblem(response, {
      type: "/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "Todo abc was not found.",
      instance: "/api/todos/abc",
      key: "todo.notFound",
      params: { id: "abc" },
    });
  });

  test("リクエストの形の誤り（InvalidRequestError）は 400 の /problems/validation-error になる（errors が無ければキーを出さない）", async () => {
    const response = toProblemResponse(
      new InvalidRequestError("request.body.notJson"),
      request("/api/todos"),
    );

    await expectProblem(response, {
      type: "/problems/validation-error",
      title: "Validation error",
      status: 400,
      detail: "Request body must be valid JSON.",
      instance: "/api/todos",
      key: "request.body.notJson",
    });
  });

  test("InvalidRequestError の errors は、各要素に英語の detail を足して本文の errors に入れる", async () => {
    const response = toProblemResponse(
      new InvalidRequestError("request.field.notString", { path: "title" }, [
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
        { pointer: "#", key: "request.body.notObject" },
      ]),
      request("/api/todos"),
    );

    await expectProblem(response, {
      type: "/problems/validation-error",
      title: "Validation error",
      status: 400,
      detail: "title must be a string.",
      instance: "/api/todos",
      key: "request.field.notString",
      params: { path: "title" },
      errors: [
        {
          pointer: "#/title",
          key: "request.field.notString",
          params: { path: "title" },
          detail: "title must be a string.",
        },
        {
          pointer: "#",
          key: "request.body.unknownKeys",
          params: { keys: "extra" },
          detail: "Request body has unknown fields: extra.",
        },
        {
          pointer: "#",
          key: "request.body.notObject",
          detail: "Request body must be a JSON object.",
        },
      ],
    });
  });

  test("想定外の例外は 500 の /problems/internal-error と server.internalError になり、内部のメッセージをクライアントに返さない", async () => {
    // 500 のときはサーバのログに原因を残す実装なので、テスト出力を汚さないよう黙らせる。
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = toProblemResponse(
      new Error("DB のパスワードが違います"),
      request("/api/todos"),
    );

    await expectProblem(response, {
      type: "/problems/internal-error",
      title: "Internal error",
      status: 500,
      detail: "Internal server error.",
      instance: "/api/todos",
      key: "server.internalError",
    });
  });

  test("想定外の例外は logger.emit で、event.name（server_error）と例外の type・message を含む ERROR の 1 行の JSON としてサーバのログ（stderr）に残す", () => {
    // logger（apps/shared/logger.ts。Issue #90 で移した）は error を console.error に 1 行の文字列で渡す。
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const error = new Error("想定外");

    toProblemResponse(error, request("/api/todos"));

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR",
      time: expect.any(String),
      message: "unexpected error",
      event: { name: "server_error" },
      error: { type: "Error", message: "想定外" },
    });
  });

  test("DomainError と InvalidRequestError はクライアントの誤りなので、ログに残さない", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    toProblemResponse(
      new DomainError("not_found", "todo.notFound", { id: "a" }),
      request("/api/todos/a"),
    );
    toProblemResponse(
      new InvalidRequestError("request.body.notJson"),
      request("/api/todos"),
    );

    expect(consoleError).not.toHaveBeenCalled();
  });
});

// withProblemResponse: handler を包み、handler が投げた例外（reject も同期の throw も）を toProblemResponse で Problem Details の
//   Response にする（Issue #141）。変換の規則は上の toProblemResponse のテストが固定しているので、ここでは「包んだ handler が
//   どの経路の例外でも toProblemResponse を通ること」と「引数・戻り値を素通しすること」を確かめる。
describe("withProblemResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("handler が返した Response を、そのまま（同じオブジェクトで）返す", async () => {
    const ok = Response.json({ ok: true }, { status: 201 });
    const handle = withProblemResponse(async (_request: Request) => ok);

    await expect(handle(request("/api/todos"))).resolves.toBe(ok);
  });

  test("handler に渡した引数（request と、動的セグメントの ctx）を、そのまま handler に渡す", async () => {
    const received: unknown[] = [];
    const handle = withProblemResponse(
      async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
        received.push(req, await ctx.params);
        return new Response(null, { status: 204 });
      },
    );
    const req = request("/api/todos/abc");

    const response = await handle(req, {
      params: Promise.resolve({ id: "abc" }),
    });

    expect(response.status).toBe(204);
    expect(received).toEqual([req, { id: "abc" }]);
    expect(received[0]).toBe(req);
  });

  test("handler が DomainError(not_found) で reject すると、404 の Problem を返す（instance は第 1 引数の request のパス）", async () => {
    const handle = withProblemResponse(
      async (_request: Request, _ctx: { params: Promise<{ id: string }> }) => {
        throw new DomainError("not_found", "todo.notFound", { id: "abc" });
      },
    );

    const response = await handle(request("/api/todos/abc"), {
      params: Promise.resolve({ id: "abc" }),
    });

    await expectProblem(response, {
      type: "/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "Todo abc was not found.",
      instance: "/api/todos/abc",
      key: "todo.notFound",
      params: { id: "abc" },
    });
  });

  test("handler が DomainError(validation_error) で reject すると、400 の Problem を返す", async () => {
    const handle = withProblemResponse(async (_request: Request) => {
      throw new DomainError("validation_error", "todo.title.empty");
    });

    await expectProblem(await handle(request("/api/todos")), {
      type: "/problems/validation-error",
      title: "Validation error",
      status: 400,
      detail: "Title must not be empty.",
      instance: "/api/todos",
      key: "todo.title.empty",
    });
  });

  test("handler が InvalidRequestError で reject すると、400 の Problem を返す", async () => {
    const handle = withProblemResponse(async (_request: Request) => {
      throw new InvalidRequestError("request.body.notJson");
    });

    await expectProblem(await handle(request("/api/todos")), {
      type: "/problems/validation-error",
      title: "Validation error",
      status: 400,
      detail: "Request body must be valid JSON.",
      instance: "/api/todos",
      key: "request.body.notJson",
    });
  });

  test("handler が想定外の例外で reject すると、500 の Problem を返し、logger.emit（server_error）でサーバのログに残す", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handle = withProblemResponse(async (_request: Request) => {
      throw new Error("DB のパスワードが違います");
    });

    await expectProblem(await handle(request("/api/todos")), {
      type: "/problems/internal-error",
      title: "Internal error",
      status: 500,
      detail: "Internal server error.",
      instance: "/api/todos",
      key: "server.internalError",
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR",
      time: expect.any(String),
      message: "unexpected error",
      event: { name: "server_error" },
      error: { type: "Error", message: "DB のパスワードが違います" },
    });
  });

  // WHY 同期の throw も確かめる: 型は Promise を返す関数だが、async でない関数（(request) => { throw ... }）も渡せる。
  //   handler(...args) の呼び出しを try の外に置く実装だと、同期の throw が変換されずに素の例外として漏れる。
  test("handler が（Promise を返さずに）同期で throw しても、reject せずに Problem を返す", async () => {
    const handle = withProblemResponse(
      (_request: Request): Promise<Response> => {
        throw new DomainError("not_found", "todo.notFound", { id: "x" });
      },
    );

    const response = await handle(request("/api/todos/x"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      key: "todo.notFound",
      instance: "/api/todos/x",
    });
  });
});
