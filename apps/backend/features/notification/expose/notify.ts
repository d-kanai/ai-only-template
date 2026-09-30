import { logger } from "@repo/shared/logger";
import { SendNotificationCommand } from "../internal/application/send-notification.command";
import { LogNotificationSender } from "../internal/infra/notification-sender.log";

// notification モジュールの公開の入口（Issue #208。モジュラーモノリスの expose）。
// 他のモジュールが使ってよいのは expose/ の下だけで、internal/ は import しない（rule-tests/architecture.test.ts の
//   module-internal）。使うのは他のモジュールの presentation（組み立ての場所）だけで、application にはコンストラクタで関数として
//   渡す（module-expose-only-from-presentation。todo の change-todo-completion.api.ts）。
// WHY 組み立てをここに置く: presentation の api ファイルと同じく、この入口が何で動くかを 1 ファイルで読めるようにする。
//   状態を持たないので、モジュールの読み込み時に 1 つだけ作る。
const sendNotification = new SendNotificationCommand(
  new LogNotificationSender(),
);

// 通知を送る。送り終わるのを待たずに戻る（fire-and-forget）。
// WHY 同期の void を返す（Promise を返さない）: 呼び出し側（Todo の完了）は通知の結果を待たずに応答を返す。Promise を返すと、
//   呼び出し側が await も catch もしなかったときに reject が未処理になり、Node 24 は未処理の reject でプロセスを終了する
//   （--unhandled-rejections の既定 throw）。Promise は expose の外に出さず、ここで受ける。
// WHY 失敗はログに出して呼び出し側へ伝えない: 通知は完了に付随する処理で、失敗しても完了（保存済み）は取り消さない。
//   失敗に気づけるよう error の 1 行で残す（Error は logger が { name, message } にする）。
export function notify(message: string): void {
  sendNotification.execute({ message }).catch((error: unknown) => {
    logger.error({ message: "notification failed", error });
  });
}
