import type { NotificationSender } from "../domain/notification-sender";

export type SendNotificationInput = {
  message: string;
};

// 通知を 1 件送る（command: 外の世界に作用する）。
// WHY 失敗を握りつぶさない: 失敗をどう扱うか（ログに残して呼び出し元へは伝えない）は公開の入口 expose/notify.ts が決める。
export class SendNotificationCommand {
  constructor(private readonly sender: NotificationSender) {}

  // WHY トランザクション無し: 通知は送信の口（NotificationSender。今はログに出すだけ）を呼ぶだけで、DB に読み書きしない（Repository を
  //   持たない）。トランザクションを張ると接続を 1 本占有するだけになる（rule-tests/use-case.test.ts の command-runs-in-transaction）。
  async execute(input: SendNotificationInput): Promise<void> {
    await this.sender.send(input.message);
  }
}
