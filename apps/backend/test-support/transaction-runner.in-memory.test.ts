// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "./transaction-runner.in-memory";

describe("InMemoryTransactionRunner", () => {
  test("work に inMemoryTransaction を渡して呼び、work の値を返す", async () => {
    // given
    const received: unknown[] = [];

    // when
    const result = await new InMemoryTransactionRunner().run(async (tx) => {
      received.push(tx);
      return "done";
    });

    // then
    expect({ result, received }).toStrictEqual({
      result: "done",
      received: [inMemoryTransaction],
    });
  });

  test("work が reject したら同じ例外で reject する（rollback は再現しない）", async () => {
    // given
    const failure = new Error("boom");

    // when
    const promise = new InMemoryTransactionRunner().run(async () => {
      throw failure;
    });

    // then
    await expect(promise).rejects.toBe(failure);
  });
});
