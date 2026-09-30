// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { PostgresTransactionRunner } from "../../../../shared/infra/transaction.postgres";
import type { Problem } from "../../../../shared/presentation/problem";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "../../../../test-support/transaction-runner.in-memory";
import { CreateTodoCommand } from "../application/create-todo.command";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";
import {
  CreateTodoApi,
  type CreateTodoResponse,
  POST as productionPost,
} from "./create-todo.api";

// テストごとに空の InMemory のリポジトリで組み立てる（本番の POST は Postgres を使い、テストの順序で結果が変わるため）。
function setup() {
  const repository = new InMemoryTodoRepository();
  return {
    repository,
    POST: new CreateTodoApi(
      new CreateTodoCommand(repository, new InMemoryTransactionRunner()),
    ).handle,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// 400 の本文のうち、誤りごとに変わる部分（detail・key・params・errors）。type・title・status・instance は 400 のどれも同じなので、
//   テストの中で固定の値を足して本文全体と比べる。
type ProblemBody = Pick<Problem, "detail" | "key" | "params" | "errors">;

function postRequest(body: string): Request {
  return new Request("http://localhost/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/todos", () => {
  test("201 と作成した Todo（CreateTodoResponse）を返し、保存される", async () => {
    const { repository, POST } = setup();

    const response = await POST(
      postRequest(JSON.stringify({ title: " 牛乳を買う " })),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateTodoResponse;
    expect(body).toEqual({
      id: expect.any(String),
      title: "牛乳を買う",
      completed: false,
      createdAt: expect.any(String),
    });
    // createdAt は ISO 8601（Date#toISOString の形）で返す。
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
    await expect(repository.findById(body.id)).resolves.toMatchObject({
      title: "牛乳を買う",
    });
  });

  // WHY 本番の POST（モジュールの最下部で組み立てたもの）を確かめる: InMemory に切り替える分岐を持たない（Issue #59）
  //   ことを、Postgres の Repository に保存されることで固定する。runner の run と insert を差し替えるので DB には接続しない。
  test("本番の POST は Postgres の runner が張ったトランザクションで、Postgres の Repository に保存する", async () => {
    // WHY runner の run を差し替える: 本番の組み立ての PostgresTransactionRunner が DB に接続しないよう、work を呼ぶだけにする。
    //   run が 1 回呼ばれ、Repository がその tx を受け取ることで、本番の command がトランザクションを張ることも確かめる。
    const run = vi
      .spyOn(PostgresTransactionRunner.prototype, "run")
      .mockImplementation((work) => work(inMemoryTransaction));
    const insert = vi
      .spyOn(PostgresTodoRepository.prototype, "insert")
      .mockResolvedValue();

    const response = await productionPost(
      postRequest(JSON.stringify({ title: "牛乳を買う" })),
    );

    expect(response.status).toBe(201);
    expect(run).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]).toEqual([
      expect.objectContaining({ title: "牛乳を買う" }),
      inMemoryTransaction,
    ]);
  });

  // presentation は domain より厳しくしない（Issue #144）。domain が通す境界の値（1 文字・前後の空白付き）を presentation も通す。
  test("title の前後の空白を除いて 1 文字なら作れる", async () => {
    const { POST } = setup();

    const response = await POST(postRequest(JSON.stringify({ title: " a " })));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ title: "a" });
  });

  test("title の前後の空白を除いて 100 文字（絵文字は 1 文字と数える）なら作れる", async () => {
    const { POST } = setup();
    const title = "🍎".repeat(100);

    const response = await POST(
      postRequest(JSON.stringify({ title: ` ${title} ` })),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ title });
  });

  // 本文は RFC 9457 の Problem Details（problem.ts）。type・status・key・params・errors は画面との契約で、detail は英語の文言を
  //   固定する（problem-detail.en.ts）ので、本文全体を検証する。
  // errors: presentation の zod スキーマの誤り（形と、domain と同じキーで重ねた必須・長さ。Issue #144）に付く。
  //   JSON として読めない誤りには付かない（problem.ts の Problem のコメント）。
  // WHY toStrictEqual: toEqual は undefined のプロパティと無いプロパティを同じとみなす。params・errors の無い誤りで
  //   本文にそのキーが出ないこと（JSON は undefined を出さないので、出ていれば値がある）も確かめる。
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
      '["牛乳を買う"]',
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
      JSON.stringify({ title: 1 }),
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
      "定義されていない項目がある",
      JSON.stringify({ title: "牛乳を買う", completed: true }),
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
    // WHY 形の誤りを 2 つ同時に置く: presentation は誤りを項目ごとにまとめて返す（1 つ直すたびに次の誤りが出る往復を無くす。
    //   Issue #144）。
    [
      "title が文字列でなく、定義されていない項目もある",
      JSON.stringify({ title: 1, extra: true }),
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
      JSON.stringify({ title: "  " }),
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
    "%s なら 400 の /problems/validation-error を、理由の key（と params・errors）と英語の detail 付きで返し、何も保存しない",
    async (_label, body, expected) => {
      const { repository, POST } = setup();

      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      await expect(response.json()).resolves.toStrictEqual({
        type: "/problems/validation-error",
        title: "Validation error",
        status: 400,
        instance: "/api/todos",
        ...expected,
      });
      await expect(repository.findAll()).resolves.toEqual([]);
    },
  );
});
