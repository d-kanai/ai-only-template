// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DomainError } from "../domain/domain-error";
import { parseUuidParam } from "./resource-id";

describe("parseUuidParam", () => {
  test("uuid の形なら、同じ値をそのまま返す", () => {
    const id = randomUUID();

    expect(parseUuidParam(id, "見つかりません")).toBe(id);
  });

  // toEqual は Error の name / message を比べるが、独自のプロパティ（code）まで比べるとは限らない（未確認）ので、
  //   code は別に確かめる。同期の関数なので rejects ではなく toThrow で例外の値を比べる。
  test.each([
    ["uuid の形でない文字列", "missing"],
    ["空文字", ""],
    // Postgres の uuid 型は受け付けるが、RFC 9562 の形ではない（版の桁が 0）。
    ["版の桁が 0", "8d0f4f39-6f0b-0a39-9d53-0a3f8b1c2d4e"],
  ])("%sなら、渡した文言の DomainError(not_found) を投げる", (_label, id) => {
    const message = `Todo（id: ${id}）が見つかりません`;

    expect(() => parseUuidParam(id, message)).toThrow(
      new DomainError("not_found", message),
    );
    try {
      parseUuidParam(id, message);
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("not_found");
    }
  });
});
