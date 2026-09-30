// @vitest-environment node
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { keyedIssue, keyedRefine } from "./keyed-issue";

// keyedIssue / keyedRefine は zod のスキーマ・refine に ErrorKey（と params）を付ける口。domain の validate（todo.ts）と
//   presentation の toProblemError（json-body.ts）が、issue の message（= キー）と params を取り出して誤りにする。
describe("keyedIssue / keyedRefine", () => {
  test("keyedIssue は params の無いキーを zod の error にする", () => {
    expect(keyedIssue("todo.title.empty")).toEqual({
      error: "todo.title.empty",
    });
  });

  test("keyedRefine はキーを zod の error に、params を zod の params にする", () => {
    expect(keyedRefine("todo.title.tooLong", { max: 100 })).toEqual({
      error: "todo.title.tooLong",
      params: { max: 100 },
    });
  });

  // WHY 実際の zod の issue で確かめる: 取り出す側（validate・toProblemError）は issue の message と params を読む。
  //   zod が error を message に、refine の params を issue の params にそのまま載せることを固定する（zod 4.6.5 の挙動）。
  test("zod は keyedIssue のキーを issue の message に、keyedRefine の params を issue の params に載せる", () => {
    const schema = z
      .string()
      .refine(() => false, keyedIssue("todo.title.empty"))
      .refine(() => false, keyedRefine("todo.title.tooLong", { max: 3 }));

    const issues = schema.safeParse("abcd").error?.issues;

    // WHY as: zod の issue の型は種類の和で、params は custom の issue だけが持つ。取り出す側（validate・toProblemError）と同じく
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
  test("params の要るキーは keyedIssue に渡せない（型の検査に付けると params が落ちる）", () => {
    // @ts-expect-error todo.title.tooLong は params を持つので keyedIssue では付けられない（refine に keyedRefine で付ける）
    z.string(keyedIssue("todo.title.tooLong", { max: 100 }));
  });

  test("keyedRefine は params の要るキーだけを受け付ける（params の無いキーは keyedIssue で付ける）", () => {
    // @ts-expect-error todo.title.empty は params を持たない
    keyedRefine("todo.title.empty", {});
  });
});
