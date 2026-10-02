// @vitest-environment node
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { KeyedIssue } from "./keyed-issue";

// KeyedIssue.of / KeyedIssue.refine は zod のスキーマ・refine に ErrorKey（と params）を付ける口。domain の DomainValidation.validated（validate.ts）と
//   presentation の toProblemError（json-body.ts）が、issue の message（= キー）と params を取り出して誤りにする（Issue #144）。
describe("KeyedIssue.of / KeyedIssue.refine", () => {
  test("KeyedIssue.of は params の無いキーを zod の error にする", () => {
    // given: 前提なし
    // when
    const issue = KeyedIssue.of("todo.title.empty");

    // then
    expect(issue).toEqual({
      error: "todo.title.empty",
    });
  });

  test("KeyedIssue.refine はキーを zod の error に、params を zod の params にする", () => {
    // given: 前提なし
    // when
    const issue = KeyedIssue.refine("todo.title.tooLong", { max: 100 });

    // then
    expect(issue).toEqual({
      error: "todo.title.tooLong",
      params: { max: 100 },
    });
  });

  // WHY 実際の zod の issue で確かめる: 取り出す側（DomainValidation.validated・toProblemError）は issue の message と params を読む。
  //   zod が error を message に、refine の params を issue の params にそのまま載せることを固定する（zod 4.6.5 の実測）。
  test("zod は KeyedIssue.of のキーを issue の message に、KeyedIssue.refine の params を issue の params に載せる", () => {
    // given
    const schema = z
      .string()
      .refine(() => false, KeyedIssue.of("todo.title.empty"))
      .refine(() => false, KeyedIssue.refine("todo.title.tooLong", { max: 3 }));

    // when
    const issues = schema.safeParse("abcd").error?.issues;

    // then
    // WHY as: zod の issue の型は種類の和で、params は custom の issue だけが持つ。取り出す側（DomainValidation.validated・toProblemError）と同じく
    //   params を読む。
    expect(
      issues?.map((issue) => ({
        message: issue.message,
        params: (issue as { params?: unknown }).params,
      })),
    ).toEqual([
      { message: "todo.title.empty", params: undefined },
      { message: "todo.title.tooLong", params: { max: 3 } },
    ]);
  });

  // WHY 型で止める: 型の検査（z.string など）の issue は params を運ばない（zod 4.6.5。refine の custom の issue だけが
  //   params を載せる）。params の要るキーを型の検査に付けると、型は通っても実行時に params が落ち、画面の文言の
  //   埋め込み（{max}）が欠ける。
  test("params の要るキーは KeyedIssue.of に渡せない（型の検査に付けると params が落ちる）", () => {
    // given: 前提なし
    // when
    // @ts-expect-error todo.title.tooLong は params を持つので KeyedIssue.of では付けられない（refine に KeyedIssue.refine で付ける）
    const schema = z.string(KeyedIssue.of("todo.title.tooLong", { max: 100 }));

    // then
    expect(schema).toBeDefined();
  });

  test("KeyedIssue.refine は params の要るキーだけを受け付ける（params の無いキーは KeyedIssue.of で付ける）", () => {
    // given: 前提なし
    // when
    // @ts-expect-error todo.title.empty は params を持たない
    const issue = KeyedIssue.refine("todo.title.empty", {});

    // then
    expect(issue).toBeDefined();
  });
});
