import { Button, Group, Stack } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DesignSystem } from "@/test-support/design-system";
import { activeTheme } from "./active-theme";
import { DesignSystemProvider } from "./design-system-provider";
import { bentoTheme } from "./themes/bento/bento.theme";
import { popTheme } from "./themes/pop/pop.theme";
import type { SpacingStep, ThemeDefinition } from "./themes/theme-definition";

// デザインシステム（Mantine。Issue #292）の仕様: 画面の見た目はテーマから来て、テーマを差し替えるだけで変わる。
// 画面（features/）が見た目を直接書かないことは rule-tests/design-system.test.ts が見る。ここはテーマの側を見る。

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

const themes: [string, ThemeDefinition][] = [
  ["bento", bentoTheme],
  ["pop", popTheme],
];

test("画面全体で使うテーマは bento", () => {
  // given: 前提なし（activeTheme はモジュールの定数）
  // when
  const theme = activeTheme;

  // then
  expect(theme).toBe(bentoTheme);
});

test("テーマを渡さなければ、画面全体で使うテーマ（activeTheme）の見た目で描く", () => {
  // given: 前提なし（DesignSystem は既定の DesignSystemProvider で包む）
  // when
  render(<Button>追加</Button>, { wrapper: DesignSystem });

  // then
  expect(screen.getByRole("button").classList).toContain(
    activeTheme.theme.components.Button.classNames.root,
  );
});

// 余白の段階名（rule-tests/design-system.test.ts の SPACING_SCALE と同じ。画面に書けるのはこの名前だけ）。
const spacingScale: SpacingStep[] = ["xs", "sm", "md", "lg", "xl"];

describe.each(themes)("%s テーマ", (_name, theme) => {
  test("余白の段階 xs〜xl の値（rem）をテーマが決める", () => {
    // given: 前提なし（theme は describe.each の引数）
    // when
    const spacing = theme.theme.spacing;

    // then
    expect(Object.keys(spacing)).toEqual(spacingScale);
    for (const value of Object.values(spacing)) {
      expect(value).toMatch(/^\d+(?:\.\d+)?rem$/);
    }
  });

  test.each([
    ["Stack", "--stack-gap"],
    ["Group", "--group-gap"],
  ] as const)(
    "並べる部品（%s）の既定の間隔は、テーマが決めた段階名の余白になる",
    (component, variable) => {
      // given
      const gap = theme.theme.components[component].defaultProps.gap;
      const Layout = component === "Stack" ? Stack : Group;

      // when
      render(
        <DesignSystemProvider theme={theme}>
          <Layout data-testid="layout">x</Layout>
        </DesignSystemProvider>,
      );

      // then
      expect(spacingScale).toContain(gap);
      expect(
        screen.getByTestId("layout").style.getPropertyValue(variable),
      ).toBe(`var(--mantine-spacing-${gap})`);
    },
  );

  test("部品（Button）に、テーマが部品ごとに決めた見た目のクラスが付く", () => {
    // given: 前提なし（theme は describe.each の引数）
    // when
    render(
      <DesignSystemProvider theme={theme}>
        <Button>追加</Button>
      </DesignSystemProvider>,
    );

    // then
    const className = theme.theme.components.Button.classNames.root;
    expect(className).not.toBe("");
    expect(screen.getByRole("button").classList).toContain(className);
  });

  test("画面の背景色（--mantine-color-body）を、テーマの CSS 変数で上書きする", () => {
    // given
    const body = theme.cssVariablesResolver(
      // WHY 空のオブジェクトを渡す: どちらのテーマの resolver も引数（Mantine の完全なテーマ）を読まない。
      {} as Parameters<ThemeDefinition["cssVariablesResolver"]>[0],
    ).light["--mantine-color-body"];

    // when
    render(
      <DesignSystemProvider theme={theme}>
        <Button>追加</Button>
      </DesignSystemProvider>,
    );

    // then
    expect(body).toMatch(/^#[0-9a-f]{6}$/);
    // MantineProvider は CSS 変数を <style> 要素として描く（置き場所は Mantine が決めるので、文書の中のすべての <style> を見る）。
    const styles = Array.from(
      document.querySelectorAll("style"),
      (style) => style.textContent,
    ).join("\n");
    expect(styles).toContain(`--mantine-color-body: ${body}`);
  });
});

test("bento と pop では、同じ部品に付く見た目のクラスが違う（テーマの差し替えで見た目が変わる）", () => {
  // given
  const bento = bentoTheme.theme.components.Button.classNames.root;

  // when
  const pop = popTheme.theme.components.Button.classNames.root;

  // then
  expect(pop).not.toBe(bento);
});

test("bento と pop では、余白の段階ごとの値が違う（テーマの差し替えで余白も変わる）", () => {
  // given
  const bento = bentoTheme.theme.spacing;

  // when
  const pop = popTheme.theme.spacing;

  // then
  for (const step of spacingScale) {
    expect(pop[step]).not.toBe(bento[step]);
  }
});
