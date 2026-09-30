import type { ReactNode } from "react";
import {
  createTranslator,
  LocaleProvider,
  type MessageKey,
  type Messages,
  type TranslateArgs,
} from "@/shared/i18n/i18n";

// テスト専用（本番のコードからは使わない。test-support/ に置くのが目印で、本番のコードからの import は rule-tests/test-support.test.ts が止め、
// Docker のイメージには入らない（.dockerignore の **/test-support）。apps/backend/test-support/database.ts と同じ）。
// 画面・components のテストは、本番の app/layout.tsx と同じく LocaleProvider で包んで描き、期待する文言は
// その画面・部品の辞書のキーの翻訳結果（tJa）と比べる。
// WHY 文言を直書きせずキーの翻訳結果と比べる: テストが見るのは「どのキーの文言を出すか」。言い回しを辞書で変えても
//   テストを直さずに済む。辞書の中身は、各画面・部品のテストの「en で描く」テストと api-error.test.ts で見る。
// WHY ロケールを ja に明示する（Provider の既定値に頼らない）: 既定値が変わってもテストの前提が変わらないようにする。

// 期待値を組み立てる ja の翻訳。辞書を最初の引数で受け取り、キーと params の型は本番の t と同じ（createTranslator）。
// WHY 辞書を引数にする: 画面ごとの辞書（*.messages.ts）のどれを引くかをテストに書かせ、別の辞書のキーをコンパイルエラーにする。
export function tJa<M extends Messages, K extends MessageKey<M>>(
  messages: M,
  key: K,
  ...args: TranslateArgs<M, K>
): string {
  return createTranslator(messages, "ja")(key, ...args);
}

// render / renderHook の wrapper（render(ui, { wrapper: JaLocale })）。
// WHY render を包む関数（renderInJa など）を置かない: Provider の既定値も ja なので、包む処理を消しても結果が変わらず、
//   mutation testing で等価な変異になる。wrapper を各テストで明示する。
export function JaLocale({ children }: { children: ReactNode }) {
  return <LocaleProvider locale="ja">{children}</LocaleProvider>;
}
