// @vitest-environment node
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DomainError } from "./domain-error";
import { KeyedIssue } from "./keyed-issue";
import { DomainValidation } from "./validate";

describe("DomainValidation.validated", () => {
  test("通れば parse した値（trim などの変換後）を返す", () => {
    // given
    const schema = z.string(KeyedIssue.of("todo.title.invalid")).trim();

    // when
    const value = DomainValidation.validated(schema, "  abc  ");

    // then
    expect(value).toBe("abc");
  });

  test("KeyedIssue.of で付けたキーを DomainError(validation_error) の key にする（params は無し）", () => {
    // given
    const schema = z.string(KeyedIssue.of("todo.title.invalid"));

    // when
    const action = () =>
      DomainValidation.validated(schema, 1 as unknown as string);

    // then
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const { code, key, params } = error as DomainError;
      expect({ code, key, params }).toEqual({
        code: "validation_error",
        key: "todo.title.invalid",
        params: undefined,
      });
      return;
    }
    throw new Error("DomainError が投げられなかった");
  });

  test("KeyedIssue.refine で付けたキーと params を DomainError の key と params にする", () => {
    // given
    const schema = z
      .string()
      .refine(() => false, KeyedIssue.refine("todo.title.tooLong", { max: 3 }));

    // when
    const action = () => DomainValidation.validated(schema, "abcd");

    // then
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const { code, key, params } = error as DomainError;
      expect({ code, key, params }).toEqual({
        code: "validation_error",
        key: "todo.title.tooLong",
        params: { max: 3 },
      });
      return;
    }
    throw new Error("DomainError が投げられなかった");
  });

  test("複数の issue があるときは最初の issue のキーにする", () => {
    // given
    const schema = z.object({
      a: z.string(KeyedIssue.of("todo.id.invalid")),
      b: z.string(KeyedIssue.of("todo.title.invalid")),
    });

    // when
    const action = () =>
      DomainValidation.validated(schema, { a: 1, b: 2 } as unknown as {
        a: string;
        b: string;
      });

    // then
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).key).toBe("todo.id.invalid");
      return;
    }
    throw new Error("DomainError が投げられなかった");
  });

  // KeyedIssue.of / KeyedIssue.refine を付け忘れた検査では、issue の message が zod の既定の英語の文言になる。それを ErrorKey として
  //   返すと、画面の辞書に無いキーとして API の契約を破る。利用者の入力の誤り（400）ではなく実装の誤りなので、
  //   DomainError ではない Error（presentation が 500 にしてログに出す）にし、開発中に気づけるようにする。
  test("キーを付け忘れた検査で失敗したら、DomainError ではない Error を zod の文言と ZodError を添えて投げる", () => {
    // given
    const schema = z.string().min(1);
    const zodMessage = schema.safeParse("").error?.issues[0]?.message;

    // when
    const action = () => DomainValidation.validated(schema, "");

    // then
    try {
      action();
    } catch (error) {
      expect(error).not.toBeInstanceOf(DomainError);
      expect(error).toEqual(
        new Error(
          `zod issue has no ErrorKey (pass KeyedIssue.of / KeyedIssue.refine to the schema): ${zodMessage}`,
        ),
      );
      expect((error as Error).cause).toBeInstanceOf(z.ZodError);
      return;
    }
    throw new Error("Error が投げられなかった");
  });
});
