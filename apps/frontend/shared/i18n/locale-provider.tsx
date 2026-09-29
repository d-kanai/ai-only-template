"use client";

import { createContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, type Locale } from "./locale";

// 画面のロケールを配る context（Issue #116）。app/layout.tsx（Server Component）が x-locale ヘッダから決めたロケールを渡し、
// 画面・hook・components は use-t.ts の useT() / useLocale() で読む。
// "use client": context は Client Component でしか使えない。layout はこの Provider に文字列（ロケール）だけを渡す。
// WHY 既定値を DEFAULT_LOCALE にする（Provider が無ければエラーにしない）: layout が必ず包むので、包まれないのはテストなど。
//   Proxy を通らないリクエストと同じ扱い（既定の ja）にそろえる。
export const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}
