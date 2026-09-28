// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "@/backend/shared/domain/domain-error";

describe("DomainError", () => {
  // name はログやスタックトレースの先頭に出る。Error のままだと想定外の例外と見分けられない（domain-error.ts の WHY）。
  test("code と message を持ち、name は DomainError になる", () => {
    const error = new DomainError("not_found", "Todo が見つかりません");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Todo が見つかりません");
    expect(error.name).toBe("DomainError");
  });
});
