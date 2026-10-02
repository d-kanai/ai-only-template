import { describe, expect, test } from "vitest";
import { DateTimeFormatter } from "@/shared/i18n/format";

// 2026-09-28T00:00:00Z は日本時間（UTC+9）で 2026-09-28 09:00。
const createdAt = "2026-09-28T00:00:00.000Z";

describe("DateTimeFormatter.format（日時をロケールとタイムゾーンで表示する）", () => {
  test("ロケールの書式で、日付（medium）と時刻（short）を出す", () => {
    // given: 前提なし（createdAt はモジュールの定数）
    // when
    const ja = DateTimeFormatter.format(createdAt, "ja", "UTC");
    const en = DateTimeFormatter.format(createdAt, "en", "UTC");

    // then
    expect(ja).toBe("2026/09/28 0:00");
    expect(en).toBe("Sep 28, 2026, 12:00 AM");
  });

  test("渡したタイムゾーンの時刻で出す（実行環境のタイムゾーンに依存しない）", () => {
    // given: 前提なし（createdAt はモジュールの定数）
    // when
    const ja = DateTimeFormatter.format(createdAt, "ja", "Asia/Tokyo");
    const en = DateTimeFormatter.format(createdAt, "en", "Asia/Tokyo");

    // then
    expect(ja).toBe("2026/09/28 9:00");
    expect(en).toBe("Sep 28, 2026, 9:00 AM");
  });

  // 日付が変わる境界: UTC では 9/28 15:30、日本時間では 9/29 0:30。
  test("タイムゾーンで日付が変わるときは、そのタイムゾーンの日付で出す", () => {
    // given
    const utcLate = "2026-09-28T15:30:00.000Z";

    // when
    const formatted = DateTimeFormatter.format(utcLate, "ja", "Asia/Tokyo");

    // then
    expect(formatted).toBe("2026/09/29 0:30");
  });
});
