"use client";

import { OpenFeatureProvider } from "@openfeature/react-sdk";
import { OpenFeature } from "@openfeature/web-sdk";
import { type ReactNode, useEffect } from "react";
import { FeatureFlagApi } from "@/features/feature-flag/api/feature-flag-api";

// フィーチャーフラグ（OpenFeature）の Provider。app/layout.tsx が全画面を包み、中の画面は useFeatureFlag でフラグを読む（Issue #156）。
// "use client": OpenFeature の react-sdk は React の context と effect を使う（Server Component では使えない）。
// WHY provider の登録を useEffect の中で行う（描画の中・モジュールの読み込み時にしない）: provider（OFREP の web provider）は
//   fetch・localStorage を使うブラウザ側のもので、サーバでの描画（SSR）では作らない。サーバの描画とブラウザの最初の描画は
//   どちらも provider の準備ができる前の既定値（off）で描くので、hydration の不一致にならない。準備ができたら react-sdk が
//   描き直す（useFeatureFlag は suspend しない。画面を待たせない）。
// WHY OpenFeature の既定の provider（domain なし）に登録する: フラグの置き場所は backend の 1 つだけ（ADR
//   docs/adr/architecture/20261002-feature-flag-ofrep-hardcoded.md）で、domain で分ける相手が無い。
// 開発時の StrictMode では effect が 2 回走り provider を 2 つ作るが、OpenFeature は差し替えた前の provider を閉じる。
export function FeatureFlagProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    // WHY 準備を待たない（setProviderAndWait にしない）: 画面を待たせない。準備ができたことは react-sdk が Ready のイベントで受け取る。
    void OpenFeature.setProvider(FeatureFlagApi.createProvider());
  }, []);
  return <OpenFeatureProvider>{children}</OpenFeatureProvider>;
}
