import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Page from "./page";

test("トップページをレンダリングすると level 1 の見出しに ai-only-template が表示される", () => {
  render(<Page />);

  // getByRole は見つからなければ例外を投げるため、存在確認は expect で明示してテストの意図を読みやすくする。
  expect(
    screen.getByRole("heading", { level: 1, name: "ai-only-template" }),
  ).toBeDefined();
});
