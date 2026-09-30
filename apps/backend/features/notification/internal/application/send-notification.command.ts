import type { NotificationSender } from "../domain/notification-sender";

export type SendNotificationInput = {
  message: string;
};

// 通知を 1 件送る（command: 外の世界に作用する）。
// WHY 失敗を握りつぶさない: 失敗をどう扱うか（ログに残して呼び出し元へは伝えない）は公開の入口 expose/notify.ts が決める。
export class SendNotificationCommand {
  constructor(private readonly sender: NotificationSender) {}

  async execute(input: SendNotificationInput): Promise<void> {
    await this.sender.send(input.message);
  }
}
