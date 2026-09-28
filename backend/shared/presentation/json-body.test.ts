// @vitest-environment node
import { describe, expect, test } from "vitest";
import { InvalidRequestError } from "@/backend/shared/presentation/http-error";
import { readJsonObject } from "@/backend/shared/presentation/json-body";

function postRequest(body: string): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("readJsonObject", () => {
  test("JSON のオブジェクトならそのまま返す", async () => {
    await expect(
      readJsonObject(postRequest(JSON.stringify({ title: "牛乳を買う" }))),
    ).resolves.toEqual({ title: "牛乳を買う" });
  });

  test("JSON として読めなければ InvalidRequestError を投げる", async () => {
    await expect(readJsonObject(postRequest("{title:"))).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });

  test.each([
    ["配列", "[]"],
    ["null", "null"],
    ["文字列", '"title"'],
    ["数値", "1"],
  ])(
    "JSON でもオブジェクトでない（%s）なら InvalidRequestError を投げる",
    async (_label, body) => {
      await expect(readJsonObject(postRequest(body))).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
    },
  );
});
