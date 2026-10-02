import type { ReactNode } from "react";
import { DesignSystemProvider } from "@/shared/ui/design-system-provider";

// テスト専用（本番のコードからは使わない。i18n.tsx と同じく test-support/ に置く）。
// 画面・部品は Mantine の部品で描くので、本番の app/layout.tsx と同じく DesignSystemProvider（MantineProvider）で包まないと
// 「MantineProvider was not found」で描けない（Issue #292）。
// jsdom には window.matchMedia が無く、MantineProvider（配色の判定）が「window.matchMedia is not a function」で落ちる。
// Mantine の公式のテストの手順（https://mantine.dev/guides/vitest/）と同じく、常に一致しない MediaQueryList を返す代わりを入れる。
// WHY setupFiles ではなくここ: Mantine で描くテストは必ずこのファイル（DesignSystem・JaLocale）を通るので、使うテストだけに効く。
// WHY 有無を確かめずに入れる: jsdom（今の版）には無く、確かめる分岐は通らない（カバレッジ 100% のため）。
// addEventListener などは jsdom の EventTarget のものを使う（配色の変化はテストでは起きないので、登録されるだけで呼ばれない）。
// 古い addListener / removeListener は付けない（Mantine 9.6.3 は addEventListener を使う）。
window.matchMedia = (query: string) =>
  Object.assign(new EventTarget(), {
    matches: false,
    media: query,
    onchange: null,
  }) as unknown as MediaQueryList;

// render の wrapper（render(ui, { wrapper: DesignSystem })）。ja で描くときは i18n.tsx の JaLocale がこれも含む。
export function DesignSystem({ children }: { children: ReactNode }) {
  return <DesignSystemProvider>{children}</DesignSystemProvider>;
}
