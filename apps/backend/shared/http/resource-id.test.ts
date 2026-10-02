// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DomainError } from "../error/domain-error";
import { ResourceId } from "./resource-id";

describe("ResourceId.parseUuid", () => {
  test("uuid の形なら、同じ値をそのまま返す", () => {
    // given
    const id = randomUUID();

    // when
    const parsed = ResourceId.parseUuid(id, "todo.notFound", { id });

    // then
    expect(parsed).toBe(id);
  });

  // toEqual は Error の name / message を比べるが、独自のプロパティ（code・key・params）まで比べるとは限らない（未確認）ので、
  //   別に確かめる。同期の関数なので rejects ではなく toThrow で例外の値を比べる。
  test.each([
    ["uuid の形でない文字列", "missing"],
    ["空文字", ""],
    // Postgres の uuid 型は受け付けるが、RFC 9562 の形ではない（版の桁が 0）。
    ["版の桁が 0", "8d0f4f39-6f0b-0a39-9d53-0a3f8b1c2d4e"],
  ])(
    "%sなら、渡したキーと params の DomainError(not_found) を投げる",
    (_label, id) => {
      // given: 前提なし
      // when
      const action = () => ResourceId.parseUuid(id, "todo.notFound", { id });

      // then
      expect(action).toThrow(
        new DomainError("not_found", "todo.notFound", { id }),
      );
      try {
        action();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        const { code, key, params } = error as DomainError;
        expect({ code, key, params }).toEqual({
          code: "not_found",
          key: "todo.notFound",
          params: { id },
        });
      }
    },
  );

  // 型の検査（pnpm typecheck の tsc -p apps/backend が見る。domain-error.test.ts と同じ）。
  test("params の要るキーに渡し忘れると、コンパイルエラーになる", () => {
    // given: 前提なし
    // when
    const typeOnly = () =>
      // @ts-expect-error todo.notFound は { id: string } が必須
      ResourceId.parseUuid("missing", "todo.notFound");

    // then
    expect(typeof typeOnly).toBe("function");
  });
});
