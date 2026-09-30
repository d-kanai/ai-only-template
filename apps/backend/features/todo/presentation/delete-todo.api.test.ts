// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Problem } from "../../../shared/presentation/problem";
import { DeleteTodoCommand } from "../application/delete-todo.command";
import { Todo } from "../domain/todo";
import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";
import { PostgresTodoRepository } from "../infra/todo-repository.postgres";
import { DeleteTodoApi, DELETE as productionDelete } from "./delete-todo.api";

// テストごとに空の InMemory のリポジトリで組み立てる（本番の DELETE は Postgres を使い、テストの順序で結果が変わるため）。
function setup() {
  const repository = new InMemoryTodoRepository();
  return {
    repository,
    DELETE: new DeleteTodoApi(new DeleteTodoCommand(repository)).handle,
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
    instance: `/api/todos/${id}`,
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

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function deleteRequest(id: string): Request {
  return new Request(`http://localhost/api/todos/${id}`, { method: "DELETE" });
}

// 問い合わせを記録するリポジトリ。uuid の形でない id で、presentation が query / command に渡す前に
//   404 にしていること（parseUuidParam）を、Repository が呼ばれないことで確かめる。
// WHY spy で確かめる（その id の Todo を置いて「あっても 404」を見ない）: Issue #94 から Todo は常に不変条件
//   （id は uuid の形）を満たすので、uuid の形でない id の Todo は作れない。空のリポジトリで 404 を見るだけだと、
//   id をそのまま渡しても「無い」の 404 になり、presentation の検査を外しても通ってしまう。
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

describe("DELETE /api/todos/:id", () => {
  test("204 と空の本文を返し、Todo が消える", async () => {
    const { repository, DELETE } = setup();
    const todo = Todo.create("牛乳を買う");
    await repository.save(todo);

    const response = await DELETE(deleteRequest(todo.id), context(todo.id));

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  // WHY 本番の DELETE（モジュールの最下部で組み立てたもの）を確かめる: InMemory に切り替える分岐を持たない（Issue #59）
  //   ことを、Postgres の Repository が呼ばれることで固定する。findById と delete を差し替えるので DB には接続しない。
  test("本番の DELETE は Postgres の Repository から削除する", async () => {
    const todo = Todo.create("牛乳を買う");
    vi.spyOn(PostgresTodoRepository.prototype, "findById").mockResolvedValue(
      todo,
    );
    const remove = vi
      .spyOn(PostgresTodoRepository.prototype, "delete")
      .mockResolvedValue();

    const response = await productionDelete(
      deleteRequest(todo.id),
      context(todo.id),
    );

    expect(response.status).toBe(204);
    expect(remove.mock.calls).toEqual([[todo.id]]);
  });

  test("uuid の形だが存在しない id なら 404 の /problems/not-found を、todo.notFound と id の params 付きで返す", async () => {
    const { DELETE } = setup();
    const id = randomUUID();

    const response = await DELETE(deleteRequest(id), context(id));

    await expectProblem(response, notFoundProblem(id));
  });

  test.each(NOT_UUID_IDS)(
    "id が %s なら、Repository に問い合わせずに 404 の /problems/not-found（todo.notFound と id の params）を返す",
    async (_label, id) => {
      const { repository, ...spies } = spiedRepository();
      const DELETE = new DeleteTodoApi(new DeleteTodoCommand(repository))
        .handle;

      const response = await DELETE(deleteRequest(id), context(id));

      await expectProblem(response, notFoundProblem(id));
      expect(spies.findById).not.toHaveBeenCalled();
      expect(spies.save).not.toHaveBeenCalled();
      expect(spies.delete).not.toHaveBeenCalled();
    },
  );
});
