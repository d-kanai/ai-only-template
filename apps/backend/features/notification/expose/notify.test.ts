// @vitest-environment node
import { now } from "@repo/shared/now";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SendNotificationCommand } from "../internal/application/send-notification.command";
import { notify } from "./notify";

// WHY 時計（now）を差し替える: ログの行の time を決めた値にして、行を丸ごと比べるため。
vi.mock("@repo/shared/now");

afterEach(() => {
  vi.mocked(now).mockReset();
  vi.restoreAllMocks();
});

const TIMESTAMP = new Date("2026-09-30T09:00:00.000Z");

describe("notify（notification モジュールの公開の入口）", () => {
  // WHY 戻り値が undefined であることを見る: notify は同期の void で、呼び出し側（todo の command）は await しない。
  //   Promise を返すと、呼び出し側が受け取らなかった reject が未処理になり、Node 24 ではプロセスが終了する。
  test("同期で undefined を返し、その後に通知の行が info で 1 行出る", async () => {
    vi.mocked(now).mockReturnValue(TIMESTAMP);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(notify("Todo completed: 1")).toBeUndefined();

    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
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

  // WHY 送信の失敗を呼び出し側へ伝えない: 通知は Todo の完了に付随する処理で、失敗しても完了（保存済み）は取り消さない。
  //   失敗は error の 1 行で残す（Error は logger が { type, message } にする）。event.name は送信と同じ notification で、
  //   phase が failed（notification で引けば送信と失敗が並ぶ。server_error は HTTP の 500 の行で、通知の失敗は 500 にならない）。
  // WHY command の execute を差し替える: 本物の送信口（ログに出すだけ）は失敗しないので、失敗の経路を起こせない。
  test("送信が失敗しても例外を投げず、失敗を error の 1 行（event.name: notification、phase: failed）でログに出す", async () => {
    vi.mocked(now).mockReturnValue(TIMESTAMP);
    vi.spyOn(SendNotificationCommand.prototype, "execute").mockRejectedValue(
      new Error("send failed"),
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(notify("Todo completed: 1")).toBeUndefined();

    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls).toEqual([
      [
        JSON.stringify({
          severity: "ERROR",
          time: TIMESTAMP.toISOString(),
          message: "notification failed",
          event: { name: "notification", phase: "failed" },
          error: { type: "Error", message: "send failed" },
        }),
      ],
    ]);
    expect(log).not.toHaveBeenCalled();
  });
});
