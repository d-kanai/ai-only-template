// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { ErrorKey } from "../error/error-key";
import { EnglishProblemDetail } from "./problem-detail.en";

// Problem Details の detail（開発者向けの英語。RFC 9457 の「この発生に固有の説明」）。画面には出さない（画面は key と params を
//   辞書で翻訳する）が、curl やログで API を読む開発者が何が起きたかを分かるよう、params を埋め込んだ文を固定する。
// WHY 全キーを並べる: 文言の打ち間違い・params の埋め込み忘れ（`${max}` を書き忘れる）を見逃さない。キーの網羅は
//   problem-detail.en.ts の型（ErrorKey ごとの関数の Record）が pnpm typecheck で止める。
describe("EnglishProblemDetail.of", () => {
  test.each<[ErrorKey, Record<string, string | number> | undefined, string]>([
    ["todo.title.empty", undefined, "Title must not be empty."],
    [
      "todo.title.tooLong",
      { max: 100 },
      "Title must be at most 100 characters.",
    ],
    ["todo.title.invalid", undefined, "Title must be a string."],
    ["todo.id.invalid", undefined, "Id must be a UUID."],
    ["todo.completed.invalid", undefined, "Completed must be a boolean."],
    ["todo.createdAt.invalid", undefined, "CreatedAt must be a valid date."],
    [
      "todo.statusChanges.invalid",
      undefined,
      "Completion history is inconsistent with the Todo.",
    ],
    [
      "todo.notFound",
      { id: "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e" },
      "Todo 8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e was not found.",
    ],
    ["request.body.notJson", undefined, "Request body must be valid JSON."],
    [
      "request.body.notObject",
      undefined,
      "Request body must be a JSON object.",
    ],
    [
      "request.body.unknownKeys",
      { keys: "extra, other" },
      "Request body has unknown fields: extra, other.",
    ],
    ["request.field.notString", { path: "tags.1" }, "tags.1 must be a string."],
    [
      "request.field.notBoolean",
      { path: "completed" },
      "completed must be a boolean.",
    ],
    ["server.internalError", undefined, "Internal server error."],
  ])("%s は params を埋め込んだ英語の文にする", (key, params, expected) => {
    // given: 前提なし
    // when
    const detail = EnglishProblemDetail.of(key, params);

    // then
    expect(detail).toBe(expected);
  });
});
