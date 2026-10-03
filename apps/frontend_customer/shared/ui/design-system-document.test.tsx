import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  DesignSystemHead,
  designSystemHtmlProps,
} from "./design-system-document";

// Vitest は globals を無効にしているため、Testing Library の自動 cleanup が働かない。前のテストの DOM を明示的に消す。
afterEach(cleanup);

test("<html> には、配色 light と hydration の差の警告の抑止を付ける", () => {
  // given: 前提なし（designSystemHtmlProps はモジュールの定数）
  // when
  const props = designSystemHtmlProps;

  // then
  expect(props).toEqual({
    suppressHydrationWarning: true,
    "data-mantine-color-scheme": "light",
  });
});

test("<head> に置くスクリプトは、配色を light に固定する", () => {
  // given: 前提なし
  // when
  const { container } = render(<DesignSystemHead />);

  // then
  const script = container.querySelector("script");
  expect(script?.textContent).toBe(
    "document.documentElement.setAttribute(\"data-mantine-color-scheme\", 'light');",
  );
});

// Issue #106: 画面の CSP（script-src の nonce）でインラインのスクリプトが止まらないよう、proxy.ts が作った nonce を付ける。
test("<head> に置くスクリプトには、渡した nonce を付ける", () => {
  // given
  const nonce = "bm9uY2U=";

  // when
  const { container } = render(<DesignSystemHead nonce={nonce} />);

  // then
  const script = container.querySelector("script");
  expect(script?.nonce).toBe(nonce);
});
