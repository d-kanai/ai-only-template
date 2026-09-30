import { describe, expect, test } from "vitest";
import { formatDateTime } from "@/shared/i18n/format";

// UTC の 9/28 0:00 は日本時間（UTC+9）で 9/28 9:00。
const createdAt = "2026-09-28T00:00:00.000Z";

describe("formatDateTime（日時をロケールとタイムゾーンで表示する）", () => {
  test("ロケールの書式で、日付（medium）と時刻（short）を出す", () => {
    expect(formatDateTime(createdAt, "ja", "UTC")).toBe("2026/09/28 0:00");
    expect(formatDateTime(createdAt, "en", "UTC")).toBe(
      "Sep 28, 2026, 12:00 AM",
    );
  });

  test("渡したタイムゾーンの時刻で出す（実行環境のタイムゾーンに依存しない）", () => {
    expect(formatDateTime(createdAt, "ja", "Asia/Tokyo")).toBe(
      "2026/09/28 9:00",
    );
    expect(formatDateTime(createdAt, "en", "Asia/Tokyo")).toBe(
      "Sep 28, 2026, 9:00 AM",
    );
  });

  // 日付が変わる境界: UTC では 9/28 15:30、日本時間では 9/29 0:30。
  test("タイムゾーンで日付が変わるときは、そのタイムゾーンの日付で出す", () => {
    expect(formatDateTime("2026-09-28T15:30:00.000Z", "ja", "Asia/Tokyo")).toBe(
      "2026/09/29 0:30",
    );
  });
});
