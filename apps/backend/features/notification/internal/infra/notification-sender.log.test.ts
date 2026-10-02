// @vitest-environment node
import { Clock } from "@repo/shared/now";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LogNotificationSender } from "./notification-sender.log";

// WHY 時計（Clock.now）を差し替える: ログの行の time を決めた値にして、行を丸ごと比べるため。
vi.mock("@repo/shared/now");

afterEach(() => {
  vi.mocked(Clock.now).mockReset();
  vi.restoreAllMocks();
});

const TIMESTAMP = new Date("2026-09-30T09:00:00.000Z");

describe("LogNotificationSender", () => {
  // WHY 行を丸ごと比べる: message・event.name（出来事の種類）と notification（送った本文）のキー名・severity も、ログを読む側の契約。
  test("メッセージを INFO の 1 行（message: notification、event.name: notification、notification: 本文）でログに出す", async () => {
    vi.mocked(Clock.now).mockReturnValue(TIMESTAMP);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await new LogNotificationSender().send("Todo completed: 1");

    expect(log.mock.calls).toEqual([
      [
        JSON.stringify({
          severity: "INFO",
          time: TIMESTAMP.toISOString(),
          message: "notification",
          event: { name: "notification" },
          notification: "Todo completed: 1",
        }),
      ],
    ]);
  });
});
