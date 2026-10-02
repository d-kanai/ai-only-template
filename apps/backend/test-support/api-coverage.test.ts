// @vitest-environment node
import { describe, expect, test } from "vitest";
import { ApiCoverage } from "./api-coverage";

// 記録の対象にする Api の形だけを持つクラス（handle が Request を受けて Response を返す）。
// WHY 本物の Api（CreateTodoApi など）を使わない: 記録の仕組みは Api の中身に依存せず、クラスの名前と handle だけを見る。
class EchoApi {
  readonly handle = async (
    request: Request,
    label: string,
  ): Promise<Response> => Response.json({ url: request.url, label });
}

class OtherApi {
  readonly handle = async (): Promise<Response> => new Response(null);
}

describe("ApiCoverage.track", () => {
  test("handler を呼ぶと、今のテストの meta.apiCalls に Api のクラス名を記録し、handle の応答をそのまま返す", async ({
    task,
  }) => {
    // given
    const echo = ApiCoverage.track(new EchoApi());

    // when
    const response = await echo(new Request("http://localhost/x"), "a");

    // then
    await expect(response.json()).resolves.toStrictEqual({
      url: "http://localhost/x",
      label: "a",
    });
    expect(task.meta.apiCalls).toStrictEqual(["EchoApi"]);
  });

  test("同じ Api を何度呼んでも 1 つだけ記録し、別の Api は呼んだ順に足す", async ({
    task,
  }) => {
    // given
    const echo = ApiCoverage.track(new EchoApi());
    const other = ApiCoverage.track(new OtherApi());

    // when
    await echo(new Request("http://localhost/"), "a");
    await other();
    await echo(new Request("http://localhost/"), "b");

    // then
    expect(task.meta.apiCalls).toStrictEqual(["EchoApi", "OtherApi"]);
  });

  test("handler を呼ばなければ記録しない（track するだけでは網羅にならない）", ({
    task,
  }) => {
    // given
    const _echo = ApiCoverage.track(new EchoApi());

    // when
    const calls = task.meta.apiCalls;

    // then
    expect(calls).toBeUndefined();
  });

  test("今のテストが無い（beforeAll などテストの外）ときは、記録できないので失敗にする", async () => {
    // given
    const outsideTest = ApiCoverage.track(new OtherApi(), () => undefined);

    // when
    const calling = outsideTest();

    // then
    await expect(calling).rejects.toEqual(
      new Error(
        "OtherApi was called outside a test. API coverage records each call on the running test, so call the handler inside a step (test).",
      ),
    );
  });
});
