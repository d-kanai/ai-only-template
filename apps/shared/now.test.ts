// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { now } from "./now";

// now（現在時刻の唯一の出口）の仕様。
// WHY 実時計と比べる（now を mock しない）: 呼び出し側のテストはこの関数を vi.mock で差し替えるので、本物が実時計を読むことは
//   ここでしか確かめられない。

afterEach(() => {
  vi.useRealTimers();
});

describe("now", () => {
  test("システムの時計の現在時刻を Date で返す", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T01:02:03.456Z"));

    const current = now();

    expect(current).toBeInstanceOf(Date);
    expect(current.toISOString()).toBe("2026-09-30T01:02:03.456Z");
  });

  test("呼ぶたびに新しい Date を返す（返した値を書き換えても次の呼び出しに影響しない）", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
    const first = now();
    first.setUTCFullYear(2000);

    vi.setSystemTime(new Date("2026-09-30T00:00:01.000Z"));

    expect(now().toISOString()).toBe("2026-09-30T00:00:01.000Z");
    expect(first).not.toBe(now());
  });
});
