import { OpenFeature, ProviderStatus } from "@openfeature/web-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FeatureFlagApi } from "@/features/feature-flag/api/feature-flag-api";

// fetch を差し替えて、画面側の provider（OFREP の web provider）が backend の OFREP の API（app/api/ofrep/v1/evaluate/flags）に
//   送るリクエストと、受け取った評価の扱いを確かめる（todo-api.test.ts と同じく、実際の Route Handler には繋がない）。
// WHY provider を OpenFeature に登録して client から読む（provider のメソッドを直接呼ばない）: 画面は OpenFeature の client を通して
//   フラグを読む（react-sdk の hook）。登録 → 初期化（一括の評価）→ client の評価、という本番と同じ経路で値が届くことを見る。
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // WHY localStorage を空にする: OFREP の web provider は評価の結果を localStorage に残し（既定の cacheMode）、次の初期化で
  //   先にそれを返す。前のテストの値が残ると、このテストの応答ではなく残った値を読んでしまう。
  localStorage.clear();
});

afterEach(async () => {
  // OpenFeature はモジュールの中の 1 つの状態（グローバル）なので、テストごとに provider を外す。
  await OpenFeature.clearProviders();
  vi.unstubAllGlobals();
});

function bulkResponse(flags: { key: string; value: boolean }[]): Response {
  return new Response(
    JSON.stringify({
      flags: flags.map((flag) => ({ ...flag, reason: "STATIC" })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("初期化で POST /api/ofrep/v1/evaluate/flags（同じオリジン）を呼び、on のフラグを true と読む", async () => {
  // given
  fetchMock.mockResolvedValue(
    bulkResponse([{ key: "todo-detail-screen", value: true }]),
  );

  // when
  await OpenFeature.setProviderAndWait(FeatureFlagApi.createProvider());

  // then
  const client = OpenFeature.getClient();
  expect(client.providerStatus).toBe(ProviderStatus.READY);
  expect(client.getBooleanValue("todo-detail-screen", false)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const request = fetchMock.mock.calls[0]?.[0] as Request;
  expect(request.method).toBe("POST");
  expect(new URL(request.url).pathname).toBe("/api/ofrep/v1/evaluate/flags");
  expect(new URL(request.url).origin).toBe(window.location.origin);
});

test("off のフラグは false と読む", async () => {
  // given
  fetchMock.mockResolvedValue(
    bulkResponse([{ key: "todo-detail-screen", value: false }]),
  );

  // when
  await OpenFeature.setProviderAndWait(FeatureFlagApi.createProvider());

  // then
  expect(
    OpenFeature.getClient().getBooleanValue("todo-detail-screen", true),
  ).toBe(false);
});
