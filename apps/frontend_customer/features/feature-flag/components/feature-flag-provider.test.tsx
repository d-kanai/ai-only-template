import {
  InMemoryProvider,
  OpenFeature,
  ProviderStatus,
} from "@openfeature/web-sdk";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FeatureFlagApi } from "@/features/feature-flag/api/feature-flag-api";
import { FeatureFlagProvider } from "@/features/feature-flag/components/feature-flag-provider";
import { useFeatureFlag } from "@/features/feature-flag/hooks/use-feature-flag.hook";

// FeatureFlagProvider が api/ の provider を OpenFeature に登録し、包んだ画面の hook（useFeatureFlag）にフラグの値が届くことを確かめる。
// WHY api/ を vi.mock で差し替え、provider を web-sdk 同梱の InMemoryProvider にする: 画面側のテストは境界の api/ で切る
//   （.claude/rules/quality/testing.md の「テストダブル」）。OFREP の API との会話は feature-flag-api.test.ts と E2E で見る。
vi.mock("@/features/feature-flag/api/feature-flag-api");

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

afterEach(async () => {
  // OpenFeature はモジュールの中の 1 つの状態（グローバル）なので、テストごとに provider を外す。
  await OpenFeature.clearProviders();
  vi.mocked(FeatureFlagApi.createProvider).mockReset();
});

// 初期化（initialize）を非同期に終える InMemoryProvider。
// WHY 素の InMemoryProvider を使わない: initialize を持たない provider では、@openfeature/core 1.12.0 の setProvider が Ready の
//   イベントを、既定の provider を差し替える前に出す（dist/esm/index.js の setAwaitableProvider。2026-10-02 に確認）。そのため
//   画面の描画の後に登録すると、react-sdk が Ready で評価し直しても前の provider（NOOP）の既定値のままになる。本番の OFREP の
//   web provider は initialize（一括の評価）を持つので、それと同じく initialize のある provider で確かめる。
class InitializingInMemoryProvider extends InMemoryProvider {
  initialize(): Promise<void> {
    return Promise.resolve();
  }
}

function todoDetailScreen(value: boolean) {
  return new InitializingInMemoryProvider({
    "todo-detail-screen": {
      variants: { on: true, off: false },
      defaultVariant: value ? "on" : "off",
      disabled: false,
    },
  });
}

// フラグの値を文字で出すだけの部品（テスト専用）。
function TodoDetailScreenFlag() {
  return <p>{useFeatureFlag("todo-detail-screen") ? "on" : "off"}</p>;
}

test("api/ の provider を登録し、on のフラグが包んだ部品に届く", async () => {
  // given
  vi.mocked(FeatureFlagApi.createProvider).mockReturnValue(
    todoDetailScreen(true),
  );

  // when
  render(
    <FeatureFlagProvider>
      <TodoDetailScreenFlag />
    </FeatureFlagProvider>,
  );

  // then
  expect(await screen.findByText("on")).toBeDefined();
  expect(FeatureFlagApi.createProvider).toHaveBeenCalledTimes(1);
});

test("off のフラグは、provider の準備ができた後も off のまま描く", async () => {
  // given
  vi.mocked(FeatureFlagApi.createProvider).mockReturnValue(
    todoDetailScreen(false),
  );

  // when
  render(
    <FeatureFlagProvider>
      <TodoDetailScreenFlag />
    </FeatureFlagProvider>,
  );

  // then
  await waitFor(() =>
    expect(OpenFeature.getClient().providerStatus).toBe(ProviderStatus.READY),
  );
  expect(screen.getByText("off")).toBeDefined();
});
