// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Problem } from "../../../../shared/presentation/problem";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import { RenameTodoCommand } from "../application/rename-todo.command";
import { Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";
import {
  PUT as productionPut,
  RenameTodoApi,
  type RenameTodoResponse,
} from "./rename-todo.api";

// テストごとに、Todo を 1 件だけ置いた InMemory のリポジトリで組み立てる（本番の PUT は Postgres を使い、
//   テストの順序で結果が変わるため）。
async function setup() {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.save(todo);
  return {
    repository,
    todo,
    PUT: new RenameTodoApi(new RenameTodoCommand(repository)).handle,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// 404 の Problem Details（RFC 9457。problem.ts）。無い id と uuid の形でない id で同じ本文になる（画面から見て「無い Todo」）。
// WHY 関数にして本文全体を返す: id ごとに detail・instance・params が変わるだけで、ほかは同じ契約。テストの中で丸ごと比べる。
function notFoundProblem(id: string): Problem {
  return {
    type: "/problems/not-found",
    title: "Not found",
    status: 404,
    detail: `Todo ${id} was not found.`,
    instance: `/api/todos/${id}/title`,
    key: "todo.notFound",
    params: { id },
  };
}

// WHY Content-Type も確かめる: application/problem+json（RFC 9457 の 3 節）で、汎用のクライアントが Problem Details と見分ける。
async function expectProblem(
  response: Response,
  expected: Problem,
): Promise<void> {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  await expect(response.json()).resolves.toStrictEqual(expected);
}

// 400 の本文のうち、誤りごとに変わる部分（detail・key・params・errors）。type・title・status・instance は固定の値を足して比べる。
type ProblemBody = Pick<Problem, "detail" | "key" | "params" | "errors">;

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function putRequest(id: string, body: string): Request {
  return new Request(`http://localhost/api/todos/${id}/title`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// 問い合わせを記録するリポジトリ。uuid の形でない id で、presentation が command に渡す前に
//   404 にしていること（parseUuidParam）を、Repository が呼ばれないことで確かめる。
// WHY spy で確かめる（その id の Todo を置いて「あっても 404」を見ない）: Todo は常に不変条件（id は uuid の形）を
//   満たすので、uuid の形でない id の Todo は作れない。空のリポジトリで 404 を見るだけだと、id をそのまま渡しても
//   「無い」の 404 になり、presentation の検査を外しても通ってしまう。
function spiedRepository() {
  const repository = new InMemoryTodoRepository();
  return {
    repository,
    findById: vi.spyOn(repository, "findById"),
    save: vi.spyOn(repository, "save"),
    delete: vi.spyOn(repository, "delete"),
  };
}

// id の形の検査は z.uuid()（RFC 9562 の形。版の桁は 1〜8、variant の桁は 8 / 9 / a / b）。
const NOT_UUID_IDS = [
  ["uuid の形でない", "missing"],
  // Postgres の uuid 型は受け付けるが、RFC 9562 の形ではない（版の桁が 0）。Todo の id は randomUUID（v4）で作る。
  ["版の桁が 0", "8d0f4f39-6f0b-0a39-9d53-0a3f8b1c2d4e"],
] as const;

describe("PUT /api/todos/:id/title", () => {
  test("title を変え、200 と変えた後の Todo（RenameTodoResponse）を返す。completed はそのまま", async () => {
    const { repository, todo, PUT } = await setup();

    const response = await PUT(
      putRequest(todo.id, JSON.stringify({ title: "卵を買う" })),
      context(todo.id),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as RenameTodoResponse;
    expect(body).toEqual({
      id: todo.id,
      title: "卵を買う",
      completed: false,
      createdAt: todo.createdAt.toISOString(),
    });
    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      title: "卵を買う",
      completed: false,
    });
  });

  // presentation は domain より厳しくしない（Issue #144）。domain が通す境界の値（前後の空白を除いて 1 文字・100 文字、
  //   絵文字は 1 文字と数える）を presentation も通し、domain と同じく trim した値で保存する。
  test.each([
    ["1 文字", " a ", "a"],
    ["100 文字", ` ${"a".repeat(100)}\t`, "a".repeat(100)],
    ["絵文字 100 個", ` ${"🍎".repeat(100)} `, "🍎".repeat(100)],
  ])(
    "title が前後の空白を除いて %s なら変えられる",
    async (_label, title, saved) => {
      const { repository, todo, PUT } = await setup();

      const response = await PUT(
        putRequest(todo.id, JSON.stringify({ title })),
        context(todo.id),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ title: saved });
      await expect(repository.findById(todo.id)).resolves.toMatchObject({
        title: saved,
      });
    },
  );

  // WHY 本番の PUT（モジュールの最下部で組み立てたもの）を確かめる: InMemory に切り替える分岐を持たない（Issue #59）
  //   ことを、Postgres の Repository が呼ばれることで固定する。findById と save を差し替えるので DB には接続しない。
  test("本番の PUT は Postgres の Repository に保存する", async () => {
    const todo = Todo.create("牛乳を買う");
    vi.spyOn(PostgresTodoRepository.prototype, "findById").mockResolvedValue(
      todo,
    );
    const save = vi
      .spyOn(PostgresTodoRepository.prototype, "save")
      .mockResolvedValue();

    const response = await productionPut(
      putRequest(todo.id, JSON.stringify({ title: "卵を買う" })),
      context(todo.id),
    );

    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      id: todo.id,
      title: "卵を買う",
    });
  });

  test("uuid の形だが存在しない id なら 404 の /problems/not-found を、todo.notFound と id の params 付きで返す", async () => {
    const { PUT } = await setup();
    const id = randomUUID();

    const response = await PUT(
      putRequest(id, JSON.stringify({ title: "卵を買う" })),
      context(id),
    );

    await expectProblem(response, notFoundProblem(id));
  });

  // WHY id を本文より先に確かめる: URL が指す Todo が存在しえないなら、本文の誤りを直しても成功しない。
  //   先に 404 を返し、直しても意味の無い 400 を返さない。
  test.each(
    NOT_UUID_IDS.flatMap(([idLabel, id]) =>
      [
        ["本文が正しい", JSON.stringify({ title: "卵を買う" })],
        ["本文が JSON でない", "{title:"],
        ["本文の形が違う", JSON.stringify({ title: 1 })],
      ].map(([bodyLabel, requestBody]) => [
        idLabel,
        bodyLabel,
        id,
        requestBody,
      ]),
    ),
  )(
    "id が %s なら、%sときも、Repository に問い合わせずに 404 の /problems/not-found（todo.notFound と id の params）を返す",
    async (_idLabel, _bodyLabel, id, requestBody) => {
      const { repository, ...spies } = spiedRepository();
      const PUT = new RenameTodoApi(new RenameTodoCommand(repository)).handle;

      const response = await PUT(putRequest(id, requestBody), context(id));

      await expectProblem(response, notFoundProblem(id));
      expect(spies.findById).not.toHaveBeenCalled();
      expect(spies.save).not.toHaveBeenCalled();
      expect(spies.delete).not.toHaveBeenCalled();
    },
  );

  // 本文は RFC 9457 の Problem Details で、本文全体を toStrictEqual で検証する（WHY は create-todo.api.test.ts と同じ）。
  //   errors は presentation の zod スキーマの誤り（形と、domain と同じキーで重ねた必須・長さ。Issue #144）に付く。
  test.each<[string, string, ProblemBody]>([
    [
      "JSON でない",
      "{title:",
      {
        detail: "Request body must be valid JSON.",
        key: "request.body.notJson",
      },
    ],
    [
      "オブジェクトでない",
      "null",
      {
        detail: "Request body must be a JSON object.",
        key: "request.body.notObject",
        errors: [
          {
            pointer: "#",
            key: "request.body.notObject",
            detail: "Request body must be a JSON object.",
          },
        ],
      },
    ],
    [
      // WHY 欠落を 400 にする: この API は名前の変更だけを受け持つので title は必須。任意にすると「何も変えない」200 になる。
      "title が無い",
      "{}",
      {
        detail: "title must be a string.",
        key: "request.field.notString",
        params: { path: "title" },
        errors: [
          {
            pointer: "#/title",
            key: "request.field.notString",
            params: { path: "title" },
            detail: "title must be a string.",
          },
        ],
      },
    ],
    [
      "title が文字列でない",
      JSON.stringify({ title: null }),
      {
        detail: "title must be a string.",
        key: "request.field.notString",
        params: { path: "title" },
        errors: [
          {
            pointer: "#/title",
            key: "request.field.notString",
            params: { path: "title" },
            detail: "title must be a string.",
          },
        ],
      },
    ],
    [
      // WHY 未知のキーを拒否する: completed をこの API に送る誤り（完了は /completion）を黙って捨てず、400 で知らせる。
      "定義されていない項目がある（completed はこの API では受け付けない）",
      JSON.stringify({ title: "卵を買う", completed: true }),
      {
        detail: "Request body has unknown fields: completed.",
        key: "request.body.unknownKeys",
        params: { keys: "completed" },
        errors: [
          {
            pointer: "#",
            key: "request.body.unknownKeys",
            params: { keys: "completed" },
            detail: "Request body has unknown fields: completed.",
          },
        ],
      },
    ],
    // WHY 誤りを同時に置く: presentation は誤りを項目ごとにまとめて返す（Issue #144）。
    [
      "title が長すぎ、定義されていない項目もある",
      JSON.stringify({ title: "a".repeat(101), extra: true }),
      {
        detail: "Title must be at most 100 characters.",
        key: "todo.title.tooLong",
        params: { max: 100 },
        errors: [
          {
            pointer: "#/title",
            key: "todo.title.tooLong",
            params: { max: 100 },
            detail: "Title must be at most 100 characters.",
          },
          {
            pointer: "#",
            key: "request.body.unknownKeys",
            params: { keys: "extra" },
            detail: "Request body has unknown fields: extra.",
          },
        ],
      },
    ],
    [
      "title が空",
      JSON.stringify({ title: "" }),
      {
        detail: "Title must not be empty.",
        key: "todo.title.empty",
        errors: [
          {
            pointer: "#/title",
            key: "todo.title.empty",
            detail: "Title must not be empty.",
          },
        ],
      },
    ],
    [
      "title が空白だけ",
      JSON.stringify({ title: " \t " }),
      {
        detail: "Title must not be empty.",
        key: "todo.title.empty",
        errors: [
          {
            pointer: "#/title",
            key: "todo.title.empty",
            detail: "Title must not be empty.",
          },
        ],
      },
    ],
    [
      "title が 101 文字",
      JSON.stringify({ title: "a".repeat(101) }),
      {
        detail: "Title must be at most 100 characters.",
        key: "todo.title.tooLong",
        params: { max: 100 },
        errors: [
          {
            pointer: "#/title",
            key: "todo.title.tooLong",
            params: { max: 100 },
            detail: "Title must be at most 100 characters.",
          },
        ],
      },
    ],
    [
      "title が絵文字 101 個",
      JSON.stringify({ title: "🍎".repeat(101) }),
      {
        detail: "Title must be at most 100 characters.",
        key: "todo.title.tooLong",
        params: { max: 100 },
        errors: [
          {
            pointer: "#/title",
            key: "todo.title.tooLong",
            params: { max: 100 },
            detail: "Title must be at most 100 characters.",
          },
        ],
      },
    ],
  ])(
    "%s なら 400 の /problems/validation-error を、理由の key（と params・errors）と英語の detail 付きで返し、Todo は変わらない",
    async (_label, body, expected) => {
      const { repository, todo, PUT } = await setup();

      const response = await PUT(putRequest(todo.id, body), context(todo.id));

      await expectProblem(response, {
        type: "/problems/validation-error",
        title: "Validation error",
        status: 400,
        instance: `/api/todos/${todo.id}/title`,
        ...expected,
      });
      await expect(repository.findById(todo.id)).resolves.toEqual(todo);
    },
  );
});
