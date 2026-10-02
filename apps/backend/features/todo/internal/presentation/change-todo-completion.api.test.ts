// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PostgresTransactionRunner } from "../../../../shared/infra/transaction.postgres";
import type { Problem } from "../../../../shared/presentation/problem";
import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "../../../../test-support/transaction-runner.in-memory";
import { ChangeTodoCompletionCommand } from "../application/change-todo-completion.command";
import { Todo } from "../domain/todo";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";
import {
  ChangeTodoCompletionApi,
  type ChangeTodoCompletionResponse,
  PUT as productionPut,
} from "./change-todo-completion.api";

// テストごとに、Todo を 1 件だけ置いた InMemory のリポジトリで組み立てる（本番の PUT は Postgres を使い、
//   テストの順序で結果が変わるため）。
async function setup() {
  const repository = new InMemoryTodoRepository();
  const todo = Todo.create("牛乳を買う");
  await repository.insert(todo, inMemoryTransaction);
  return {
    repository,
    todo,
    PUT: new ChangeTodoCompletionApi(
      new ChangeTodoCompletionCommand(
        repository,
        new InMemoryTransactionRunner(),
        ignoreNotification,
      ),
    ).handle,
  };
}

// 完了の通知の口（TodoCompletedNotifier）の偽物（何もしない）。通知の条件と本文は command のテスト（change-todo-completion.command.test.ts）が固定し、
//   ここでは HTTP の契約だけを見る。本番の組み立てが notification の expose を渡すことは下の「本番の PUT」のテストで見る。
const ignoreNotification = { notify: (): void => undefined };

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
    instance: `/api/todos/${id}/completion`,
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
  return new Request(`http://localhost/api/todos/${id}/completion`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// 問い合わせを記録するリポジトリ。uuid の形でない id で、presentation が command に渡す前に
//   404 にしていること（ResourceId.parseUuid）を、Repository が呼ばれないことで確かめる。
// WHY spy で確かめる（その id の Todo を置いて「あっても 404」を見ない）: Todo は常に不変条件（id は uuid の形）を
//   満たすので、uuid の形でない id の Todo は作れない。空のリポジトリで 404 を見るだけだと、id をそのまま渡しても
//   「無い」の 404 になり、presentation の検査を外しても通ってしまう。
function spiedRepository() {
  const repository = new InMemoryTodoRepository();
  return {
    repository,
    findById: vi.spyOn(repository, "findById"),
    findByIdForUpdate: vi.spyOn(repository, "findByIdForUpdate"),
    insert: vi.spyOn(repository, "insert"),
    update: vi.spyOn(repository, "update"),
    delete: vi.spyOn(repository, "delete"),
  };
}

// id の形の検査は z.uuid()（RFC 9562 の形。版の桁は 1〜8、variant の桁は 8 / 9 / a / b）。
const NOT_UUID_IDS = [
  ["uuid の形でない", "missing"],
  // Postgres の uuid 型は受け付けるが、RFC 9562 の形ではない（版の桁が 0）。Todo の id は randomUUID（v4）で作る。
  ["版の桁が 0", "8d0f4f39-6f0b-0a39-9d53-0a3f8b1c2d4e"],
] as const;

describe("PUT /api/todos/:id/completion", () => {
  test("completed を true にし、200 と変えた後の Todo（ChangeTodoCompletionResponse）を返す。title はそのまま", async () => {
    // given
    const { repository, todo, PUT } = await setup();

    // when
    const response = await PUT(
      putRequest(todo.id, JSON.stringify({ completed: true })),
      context(todo.id),
    );

    // then
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChangeTodoCompletionResponse;
    expect(body).toEqual({
      id: todo.id,
      title: "牛乳を買う",
      completed: true,
      createdAt: todo.createdAt.toISOString(),
    });
    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      title: "牛乳を買う",
      completed: true,
    });
  });

  // WHY false に戻す場合も見る: 本文の値を無視して常に true にする実装を通さないため。
  test("completed を false にすると、完了済みの Todo を未完了に戻す", async () => {
    // given
    const { repository, todo, PUT } = await setup();
    await PUT(
      putRequest(todo.id, JSON.stringify({ completed: true })),
      context(todo.id),
    );

    // when
    const response = await PUT(
      putRequest(todo.id, JSON.stringify({ completed: false })),
      context(todo.id),
    );

    // then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ completed: false });
    await expect(repository.findById(todo.id)).resolves.toMatchObject({
      completed: false,
    });
  });

  // WHY 本番の PUT（モジュールの最下部で組み立てたもの）を確かめる: InMemory に切り替える分岐を持たない（Issue #59）
  //   ことを、Postgres の Repository が呼ばれることで固定する。runner の run と findByIdForUpdate と update を差し替えるので DB には接続しない。
  test("本番の PUT は Postgres の runner が張ったトランザクションで、Postgres の Repository に保存する", async () => {
    // given
    const todo = Todo.create("牛乳を買う");
    // WHY runner の run を差し替える: 本番の組み立ての PostgresTransactionRunner が DB に接続しないよう、work を呼ぶだけにする。
    //   run が 1 回呼ばれ、Repository がその tx を受け取ることで、本番の command がトランザクションを張ることも確かめる。
    const run = vi
      .spyOn(PostgresTransactionRunner.prototype, "run")
      .mockImplementation((work) => work(inMemoryTransaction));
    vi.spyOn(
      PostgresTodoRepository.prototype,
      "findByIdForUpdate",
    ).mockResolvedValue(todo);
    const update = vi
      .spyOn(PostgresTodoRepository.prototype, "update")
      .mockResolvedValue();
    // 完了にすると通知のログが 1 行出る（下のテストで確かめる）。ここではテストの出力に出さないためだけに差し替える。
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // when
    const response = await productionPut(
      putRequest(todo.id, JSON.stringify({ completed: true })),
      context(todo.id),
    );

    // then
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]).toEqual([
      expect.objectContaining({ id: todo.id, completed: true }),
      inMemoryTransaction,
    ]);
  });

  // WHY 本番の PUT の通知をログの行で確かめる: 組み立てで渡すオブジェクト（notification の expose の Notifier）は api ファイルの中の
  //   値で、外から差し替えも参照もできない。Notifier は通知をログ（console.log の JSON 1 行）に出すので、本番の PUT で完了にした
  //   後にその行が出れば、notification の expose につながっていることが分かる。runner の run と findByIdForUpdate と update を
  //   差し替えるので DB には接続しない。
  test("本番の PUT は、未完了の Todo を完了にすると notification の expose で Todo completed: <id> を通知する（ログの 1 行）", async () => {
    // given
    const todo = Todo.create("牛乳を買う");
    vi.spyOn(PostgresTransactionRunner.prototype, "run").mockImplementation(
      (work) => work(inMemoryTransaction),
    );
    vi.spyOn(
      PostgresTodoRepository.prototype,
      "findByIdForUpdate",
    ).mockResolvedValue(todo);
    vi.spyOn(PostgresTodoRepository.prototype, "update").mockResolvedValue();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // when
    const response = await productionPut(
      putRequest(todo.id, JSON.stringify({ completed: true })),
      context(todo.id),
    );

    // then
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      severity: "INFO",
      message: "notification",
      event: { name: "notification" },
      notification: `Todo completed: ${todo.id}`,
    });
  });

  test("uuid の形だが存在しない id なら 404 の /problems/not-found を、todo.notFound と id の params 付きで返す", async () => {
    // given
    const { PUT } = await setup();
    const id = randomUUID();

    // when
    const response = await PUT(
      putRequest(id, JSON.stringify({ completed: true })),
      context(id),
    );

    // then
    await expectProblem(response, notFoundProblem(id));
  });

  // WHY id を本文より先に確かめる: URL が指す Todo が存在しえないなら、本文の誤りを直しても成功しない。
  //   先に 404 を返し、直しても意味の無い 400 を返さない。
  test.each(
    NOT_UUID_IDS.flatMap(([idLabel, id]) =>
      [
        ["本文が正しい", JSON.stringify({ completed: true })],
        ["本文が JSON でない", "{completed:"],
        ["本文の形が違う", JSON.stringify({ completed: "true" })],
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
      // given
      const { repository, ...spies } = spiedRepository();
      const PUT = new ChangeTodoCompletionApi(
        new ChangeTodoCompletionCommand(
          repository,
          new InMemoryTransactionRunner(),
          ignoreNotification,
        ),
      ).handle;

      // when
      const response = await PUT(putRequest(id, requestBody), context(id));

      // then
      await expectProblem(response, notFoundProblem(id));
      expect(spies.findById).not.toHaveBeenCalled();
      expect(spies.findByIdForUpdate).not.toHaveBeenCalled();
      expect(spies.insert).not.toHaveBeenCalled();
      expect(spies.update).not.toHaveBeenCalled();
      expect(spies.delete).not.toHaveBeenCalled();
    },
  );

  // 本文は RFC 9457 の Problem Details で、本文全体を toStrictEqual で検証する（WHY は create-todo.api.test.ts と同じ）。
  test.each<[string, string, ProblemBody]>([
    [
      "JSON でない",
      "{completed:",
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
      // WHY 欠落を 400 にする: この API は完了の変更だけを受け持つので completed は必須。任意にすると「何も変えない」200 になる。
      "completed が無い",
      "{}",
      {
        detail: "completed must be a boolean.",
        key: "request.field.notBoolean",
        params: { path: "completed" },
        errors: [
          {
            pointer: "#/completed",
            key: "request.field.notBoolean",
            params: { path: "completed" },
            detail: "completed must be a boolean.",
          },
        ],
      },
    ],
    [
      "completed が boolean でない",
      JSON.stringify({ completed: "true" }),
      {
        detail: "completed must be a boolean.",
        key: "request.field.notBoolean",
        params: { path: "completed" },
        errors: [
          {
            pointer: "#/completed",
            key: "request.field.notBoolean",
            params: { path: "completed" },
            detail: "completed must be a boolean.",
          },
        ],
      },
    ],
    [
      // WHY 未知のキーを拒否する: title をこの API に送る誤り（名前の変更は /title）を黙って捨てず、400 で知らせる。
      "定義されていない項目がある（title はこの API では受け付けない）",
      JSON.stringify({ title: "卵を買う", completed: true }),
      {
        detail: "Request body has unknown fields: title.",
        key: "request.body.unknownKeys",
        params: { keys: "title" },
        errors: [
          {
            pointer: "#",
            key: "request.body.unknownKeys",
            params: { keys: "title" },
            detail: "Request body has unknown fields: title.",
          },
        ],
      },
    ],
    // WHY 誤りを同時に置く: presentation は誤りを項目ごとにまとめて返す（Issue #144）。
    [
      "completed が boolean でなく、定義されていない項目もある",
      JSON.stringify({ completed: 1, extra: true }),
      {
        detail: "completed must be a boolean.",
        key: "request.field.notBoolean",
        params: { path: "completed" },
        errors: [
          {
            pointer: "#/completed",
            key: "request.field.notBoolean",
            params: { path: "completed" },
            detail: "completed must be a boolean.",
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
  ])(
    "%s なら 400 の /problems/validation-error を、理由の key（と params・errors）と英語の detail 付きで返し、Todo は変わらない",
    async (_label, body, expected) => {
      // given
      const { repository, todo, PUT } = await setup();

      // when
      const response = await PUT(putRequest(todo.id, body), context(todo.id));

      // then
      await expectProblem(response, {
        type: "/problems/validation-error",
        title: "Validation error",
        status: 400,
        instance: `/api/todos/${todo.id}/completion`,
        ...expected,
      });
      await expect(repository.findById(todo.id)).resolves.toEqual(todo);
    },
  );
});
