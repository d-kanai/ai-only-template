// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { NotificationSender } from "../domain/notification-sender";
import { SendNotificationCommand } from "./send-notification.command";

// 送ったメッセージを記録する送信口。
// WHY vi.fn / spy にしない: NotificationSender は interface なので、テスト用の実装をここで書けば型で縛られる（形が変われば
//   コンパイルエラー）。InMemory の Repository と同じく、差し替えはコンストラクタで行う。
class RecordingSender implements NotificationSender {
  readonly sent: string[] = [];

  async send(message: string): Promise<void> {
    this.sent.push(message);
  }
}

// 送信に失敗する送信口。
class FailingSender implements NotificationSender {
  async send(): Promise<void> {
    throw new Error("send failed");
  }
}

describe("SendNotificationCommand", () => {
  test("受け取ったメッセージをそのまま、送信口に 1 回だけ渡す", async () => {
    const sender = new RecordingSender();
    const command = new SendNotificationCommand(sender);

    await command.execute({ message: "Todo completed: 1" });

    expect(sender.sent).toEqual(["Todo completed: 1"]);
  });

  // WHY 失敗を握りつぶさずに reject する: 失敗をどう扱うか（ログに出して呼び出し元へは伝えない）は expose（notify）が決める。
  //   command で握りつぶすと、expose が失敗を知れずログに残らない。
  test("送信口が失敗したら、その例外で reject する", async () => {
    const command = new SendNotificationCommand(new FailingSender());

    await expect(command.execute({ message: "x" })).rejects.toEqual(
      new Error("send failed"),
    );
  });
});
