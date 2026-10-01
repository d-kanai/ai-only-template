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
//   失敗に気づけるよう ERROR の 1 行（notification の failed は logger が ERROR にする）で残す（Error は logger が { type, message } にする）。
// WHY event.name を notification（phase: failed）にする（server_error にしない。Issue #209）: server_error は HTTP の境界の 500
//   （toProblemResponse）の行で、通知の失敗は応答を 500 にしない（完了は成功している）。notification で引けば送信と失敗が
//   並び、失敗だけは phase（と severity の ERROR）で絞れる（db_write の phase と同じ形）。
export function notify(message: string): void {
  sendNotification.execute({ message }).catch((error: unknown) => {
    logger.emit({
      message: "notification failed",
      event: { name: "notification", phase: "failed" },
      error,
    });
  });
}
