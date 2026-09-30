import { logger } from "@repo/shared/logger";
import type { NotificationSender } from "../domain/notification-sender";

// NotificationSender の実装: 通知をログ（stdout の JSON 1 行）に出すだけ。
// WHY 今はログだけ（Issue #208。ユーザー判断）: モジュール間の呼び出しの形（expose / internal の境界）を先に作り、実際の送り先
//   （メール・チャット）は必要になったときに、この interface の別の実装として足す。
// WHY message を固定の "notification" にし、本文は notification に入れる: message はログの一覧に出る文で、
//   ほかのログ（"db write start" など）と同じく固定の文言にする。種類は event.name（notification。Issue #209。
//   apps/shared/log-event.ts）で引く。
// WHY 名前を <interface>.<実装>.ts にする: todo の todo-repository.postgres.ts（PostgresTodoRepository）と同じ命名。
export class LogNotificationSender implements NotificationSender {
  async send(message: string): Promise<void> {
    logger.info({
      message: "notification",
      event: { name: "notification" },
      notification: message,
    });
  }
}
