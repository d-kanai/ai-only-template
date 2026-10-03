import { OpenFeatureProvider } from "@openfeature/react-sdk";
import { InMemoryProvider, OpenFeature } from "@openfeature/web-sdk";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test } from "vitest";
import { useFeatureFlag } from "@/features/feature-flag/hooks/use-feature-flag.hook";

// フラグの値は web-sdk 同梱の InMemoryProvider で決める（Issue #156。OFREP の API との会話は feature-flag-api.test.ts と E2E で見る）。
// WHY OpenFeatureProvider で包む: 本番は FeatureFlagProvider（app/layout.tsx）が包み、hook はその client からフラグを読む。

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの描画を明示的に外す。
afterEach(cleanup);

afterEach(async () => {
  // OpenFeature はモジュールの中の 1 つの状態（グローバル）なので、テストごとに provider を外す。
  await OpenFeature.clearProviders();
});

// todo-detail-screen を value にする InMemoryProvider の設定。
function todoDetailScreen(value: boolean) {
  return {
    "todo-detail-screen": {
      variants: { on: true, off: false },
      defaultVariant: value ? "on" : "off",
      disabled: false,
    },
  };
}

// 準備（initialize）が、テストが resolve するまで終わらない InMemoryProvider。
// WHY: InMemoryProvider は登録してすぐに準備ができる（最初の描画の時点で値が届いている）ので、「準備ができる前は既定値で描く」を
//   確かめられない。OFREP の web provider は初期化で API の応答を待つので、それを任意のタイミングで終わる初期化で再現する。
class NotYetReadyProvider extends InMemoryProvider {
  private finish: () => void = () => undefined;
  private readonly initialized = new Promise<void>((resolve) => {
    this.finish = resolve;
  });

  initialize(): Promise<void> {
    return this.initialized;
  }

  becomeReady(): void {
    this.finish();
  }
}

function Wrapper({ children }: { children: ReactNode }) {
  return <OpenFeatureProvider>{children}</OpenFeatureProvider>;
}

test("on のフラグは、provider の準備ができるまで既定値の false を返し（待たせない）、準備ができたら true を返す", async () => {
  // given
  const provider = new NotYetReadyProvider(todoDetailScreen(true));
  void OpenFeature.setProvider(provider);

  // when
  const { result } = renderHook(() => useFeatureFlag("todo-detail-screen"), {
    wrapper: Wrapper,
  });

  // then
  // WHY false（null でない）を見る: suspend すると描画は結果を返さない（result.current が null のまま）。
  expect(result.current).toBe(false);

  // when
  provider.becomeReady();

  // then
  await waitFor(() => expect(result.current).toBe(true));
});

test("off のフラグは、provider の準備ができた後も false を返す", async () => {
  // given
  await OpenFeature.setProviderAndWait(
    new InMemoryProvider(todoDetailScreen(false)),
  );

  // when
  const { result } = renderHook(() => useFeatureFlag("todo-detail-screen"), {
    wrapper: Wrapper,
  });

  // then
  expect(result.current).toBe(false);
});

test("provider が値を持たないフラグは既定値の false を返す", async () => {
  // given
  await OpenFeature.setProviderAndWait(new InMemoryProvider({}));

  // when
  const { result } = renderHook(() => useFeatureFlag("todo-detail-screen"), {
    wrapper: Wrapper,
  });

  // then
  expect(result.current).toBe(false);
});

test("backend の一覧に無い key はコンパイルエラーになる（打ち間違いを型で止める）", () => {
  // given: key の型は backend の FEATURE_FLAGS の key の集合（FeatureFlagKey）

  // when
  const typo = () =>
    // @ts-expect-error 一覧に無い key（"todo-detail-screen" の打ち間違い）
    useFeatureFlag("todo-detail-scren");

  // then
  // WHY 関数を作るだけで呼ばない: 確かめたいのは型（pnpm typecheck が @ts-expect-error の行にエラーが無いと失敗する）。
  expect(typeof typo).toBe("function");
});
