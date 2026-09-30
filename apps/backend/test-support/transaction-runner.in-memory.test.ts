// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  InMemoryTransactionRunner,
  inMemoryTransaction,
} from "./transaction-runner.in-memory";

describe("InMemoryTransactionRunner", () => {
  test("work に inMemoryTransaction を渡して呼び、work の値を返す", async () => {
    const received: unknown[] = [];

    const result = await new InMemoryTransactionRunner().run(async (tx) => {
      received.push(tx);
      return "done";
    });

    expect({ result, received }).toStrictEqual({
      result: "done",
      received: [inMemoryTransaction],
    });
  });

  test("work が reject したら同じ例外で reject する（rollback は再現しない）", async () => {
    const failure = new Error("boom");

    await expect(
      new InMemoryTransactionRunner().run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
