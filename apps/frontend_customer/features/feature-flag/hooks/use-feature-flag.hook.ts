"use client";

// "use client"（hook のファイルだが付ける）: app/layout.tsx（Server Component）が feature の index から FeatureFlagProvider を
//   import すると、同じ index が export するこのファイルも Server Component の側で読み込まれる。@openfeature/react-sdk 1.4.1 は
//   読み込み時に React.createContext を呼ぶので、Server Component の側では「createContext is not a function」で next build が
//   止まった（2026-10-02 に実測）。このファイルをクライアントの境界にすると、Server Component の側では中身を評価しない。
//   hook を呼ぶのはクライアントの画面（todo-screen.hook.ts など）だけ。
import { useBooleanFlagValue } from "@openfeature/react-sdk";
import type { FeatureFlagKey } from "@/features/feature-flag/api/feature-flag-api";

// フラグの評価の設定。
// WHY suspend: false（provider の準備ができるまで Suspense で待たない）: 画面を待たせない（Issue #156 のユーザー判断）。準備が
//   できるまでは既定値（下の DEFAULT_VALUE）で描き、準備ができたら react-sdk が描き直す（Ready のイベント）。
//   react-sdk 1.4.1 の既定も suspend しない（DEFAULT_OPTIONS の suspendUntilReady: false）が、既定が変わっても挙動を変えないよう明示する。
// WHY モジュールの定数にする（呼ぶたびにオブジェクトを作らない）: react-sdk は options を useEffect の依存に入れているので、描画の
//   たびに新しいオブジェクトを渡すと、そのたびに評価をやり直す。
const EVALUATION_OPTIONS = { suspend: false } as const;

// 準備ができる前・フラグの評価に失敗したとき（API に届かない・一覧に無い）の値。
// WHY false（off）: 出す前の機能を隠す側に倒す。評価できないときに未公開の機能が見えるほうが困る。
const DEFAULT_VALUE = false;

// フィーチャーフラグ（on / off）を読む。key は backend の一覧の key だけを受け付ける（FeatureFlagKey。打ち間違いはコンパイルエラー）。
// FeatureFlagProvider（app/layout.tsx が包む）の中で使う。
export function useFeatureFlag(key: FeatureFlagKey): boolean {
  return useBooleanFlagValue(key, DEFAULT_VALUE, EVALUATION_OPTIONS);
}
