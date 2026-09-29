import { use, useMemo } from "react";
import type { Locale } from "./locale";
import { LocaleContext } from "./locale-provider";
import { createTranslator, type Translate } from "./messages";

// 画面のロケール（LocaleProvider が配る値）。日付の表示（format.ts）や、実行時のキーの翻訳（formatMessage）に渡す。
export function useLocale(): Locale {
  return use(LocaleContext);
}

// 画面のロケールで翻訳する型付きの t（messages.ts の Translate）。画面の文言はすべてこれを通す（.claude/rules/frontend.md の「i18n」）。
// WHY useMemo: ロケールが変わらない限り同じ関数を返し、t を effect や useCallback の依存に入れても作り直しが起きないようにする。
export function useT(): Translate {
  const locale = useLocale();
  return useMemo(() => createTranslator(locale), [locale]);
}
