import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { DesignSystem } from "@/test-support/design-system";
import { activeTheme } from "../active-theme";
import { Alert } from "./alert";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("子の文字を role=alert で出し（読み上げさせる）、テーマが Alert に決めた見た目のクラスが付く", () => {
  // given: 前提なし（テーマは DesignSystem の既定 activeTheme）
  // when
  render(<Alert>保存できませんでした</Alert>, { wrapper: DesignSystem });

  // then
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe("保存できませんでした");
  expect(alert.classList).toContain(
    activeTheme.theme.components.Alert.classNames.root,
  );
});
