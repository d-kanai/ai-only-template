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

  // message は API の ErrorResponse の message として画面に出る（クライアントとの契約）ので、文言まで検証する。
  // toEqual は例外のクラスと message を比べる（別のクラスや別の文言なら失敗する）。
  test("JSON として読めなければ、JSON でないことを伝える InvalidRequestError を投げる", async () => {
    await expect(readJsonObject(postRequest("{title:"))).rejects.toEqual(
      new InvalidRequestError("リクエスト本文が JSON ではありません"),
    );
  });

  test.each([
    ["配列", "[]"],
    ["null", "null"],
    ["文字列", '"title"'],
    ["数値", "1"],
  ])(
    "JSON でもオブジェクトでない（%s）なら、オブジェクトで指定するよう伝える InvalidRequestError を投げる",
    async (_label, body) => {
      await expect(readJsonObject(postRequest(body))).rejects.toEqual(
        new InvalidRequestError(
          "リクエスト本文は JSON のオブジェクトで指定してください",
        ),
      );
    },
  );
});
