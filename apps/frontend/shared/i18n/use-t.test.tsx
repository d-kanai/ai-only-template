import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Locale } from "@/shared/i18n/locale";
import { LocaleProvider } from "@/shared/i18n/locale-provider";
import { useLocale, useT } from "@/shared/i18n/use-t";

// globals 無効のため Testing Library の自動 cleanup が働かない。テストごとに DOM を片付ける。
afterEach(cleanup);

// ロケールを変えて描き直せるよう、hook を呼ぶ部品を LocaleProvider で包んで描く。
// WHY renderHook を使わない: renderHook の wrapper には initialProps が渡らず（Testing Library 16.3.3）、rerender でロケールを変えられない。
function renderWithLocale<T>(hook: () => T, locale: Locale) {
  const result: { current: T | undefined } = { current: undefined };
  function Probe() {
    result.current = hook();
    return null;
  }
  const view = render(
    <LocaleProvider locale={locale}>
      <Probe />
    </LocaleProvider>,
  );
  const rerender = (next: Locale) =>
    view.rerender(
      <LocaleProvider locale={next}>
        <Probe />
      </LocaleProvider>,
    );
  return { result: result as { current: T }, rerender };
}

describe("useLocale", () => {
  test("LocaleProvider のロケールを返す", () => {
    const { result } = renderWithLocale(() => useLocale(), "en");

    expect(result.current).toBe("en");
  });

  // WHY 既定に落とす（エラーにしない）: app/layout.tsx が必ず LocaleProvider で包む。包まれないのはテストなどで、
  //   Proxy を通らないリクエストと同じく既定の ja で表示すればよい。
  test("LocaleProvider の外では既定の ja を返す", () => {
    const { result } = renderHook(() => useLocale());

    expect(result.current).toBe("ja");
  });
});

describe("useT", () => {
  test("LocaleProvider のロケールで翻訳する t を返す", () => {
    const { result } = renderWithLocale(() => useT(), "en");

    expect(result.current("todo.item.toggle", { title: "Milk" })).toBe(
      "Mark “Milk” as completed",
    );
  });

  test("ロケールが変わると、新しいロケールで翻訳する t に変わる", () => {
    const { result, rerender } = renderWithLocale(() => useT(), "ja");
    expect(result.current("todo.detail.save")).toBe("保存");

    rerender("en");

    expect(result.current("todo.detail.save")).toBe("Save");
  });

  // WHY 同じ関数を返す: t を useEffect / useCallback の依存に入れても、描画のたびに作り直されないようにする。
  test("ロケールが変わらなければ、再描画しても同じ t を返す", () => {
    const { result, rerender } = renderWithLocale(() => useT(), "ja");
    const first = result.current;

    rerender("ja");

    expect(result.current).toBe(first);
  });
});

describe("LocaleProvider", () => {
  test("子要素をそのまま描く", () => {
    render(
      <LocaleProvider locale="ja">
        <p>child</p>
      </LocaleProvider>,
    );

    expect(screen.getByText("child")).toBeDefined();
  });
});
