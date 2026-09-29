import type { ReactNode } from "react";
import { LocaleProvider } from "./locale-provider";
import { createTranslator, type Translate } from "./messages";

// テスト専用（本番のコードからは使わない。ファイル名の .test-support が目印。apps/backend/shared/infra/database.test-support.ts と同じ）。
// 画面・components のテストは、本番の app/layout.tsx と同じく LocaleProvider で包んで描き、期待する文言は
// 辞書のキーの翻訳結果（tJa）と比べる。
// WHY 文言を直書きせずキーの翻訳結果と比べる: テストが見るのは「どのキーの文言を出すか」。言い回しを辞書で変えても
//   テストを直さずに済み、辞書の中身（言い回し）は shared/i18n/messages.test.ts で固定する。
// WHY ロケールを ja に明示する（Provider の既定値に頼らない）: 既定値が変わってもテストの前提が変わらないようにする。

// 期待値を組み立てる ja の t。
export const tJa: Translate = createTranslator("ja");

// render / renderHook の wrapper（render(ui, { wrapper: JaLocale })）。
// WHY render を包む関数（renderInJa など）を置かない: Provider の既定値も ja なので、包む処理を消しても結果が変わらず、
//   mutation testing で等価な変異になる。wrapper を各テストで明示する。
export function JaLocale({ children }: { children: ReactNode }) {
  return <LocaleProvider locale="ja">{children}</LocaleProvider>;
}
