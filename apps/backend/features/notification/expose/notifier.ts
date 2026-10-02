import { logger } from "@repo/shared/logger";
import { SendNotificationCommand } from "../internal/application/send-notification.command";
import { LogNotificationSender } from "../internal/infra/notification-sender.log";

// notification モジュールの公開の入口（Issue #208。モジュラーモノリスの expose）。
// 他のモジュールが使ってよいのは expose/ の下だけで、internal/ は import しない（rule-tests/architecture.test.ts の
//   module-internal）。使うのは他のモジュールの presentation（組み立ての場所）だけで、application にはコンストラクタで
//   このクラスのインスタンスを渡す（module-expose-only-from-presentation。todo の change-todo-completion.api.ts）。
// WHY クラスにする（関数を export しない）: backend の本番コードはクラスを基本にし、モジュールやファイルをまたぐ利用は
//   コンストラクタで受け取ったインスタンスを通す（ADR docs/adr/architecture/20261002-class-based-backend.md。Issue #262）。
export class Notifier {
  // WHY 組み立て（command と送り先）をコンストラクタの中に置き、引数で受け取らない: 呼び出し側（他のモジュールの
  //   presentation）は internal を import できないので、引数にしても本番で渡せるものは無い（既定値付きの引数にすると、
  //   公開の型に internal の command が現れる）。この入口が何で動くかを、presentation の api ファイルと同じく 1 ファイルで読める。
  //   テストで送信の失敗を起こすときは SendNotificationCommand の prototype を差し替える（notifier.test.ts）。
  // WHY インスタンスごとに作る（モジュールの読み込み時の 1 つにしない）: 状態を持たず作るのが軽い。本番は api ファイルが
  //   読み込み時に 1 つだけ作る（change-todo-completion.api.ts の PUT）。
  private readonly sendNotification = new SendNotificationCommand(
    new LogNotificationSender(),
  );

  // 通知を送る。送り終わるのを待たずに戻る（fire-and-forget）。
  // WHY 同期の void を返す（Promise を返さない）: 呼び出し側（Todo の完了）は通知の結果を待たずに応答を返す。Promise を返すと、
  //   呼び出し側が await も catch もしなかったときに reject が未処理になり、Node 24 は未処理の reject でプロセスを終了する
  //   （--unhandled-rejections の既定 throw）。Promise は expose の外に出さず、ここで受ける。
  // WHY 失敗はログに出して呼び出し側へ伝えない: 通知は完了に付随する処理で、失敗しても完了（保存済み）は取り消さない。
  //   失敗に気づけるよう ERROR の 1 行（notification の failed は logger が ERROR にする）で残す（Error は logger が { type, message } にする）。
  // WHY event.name を notification（phase: failed）にする（server_error にしない。Issue #209）: server_error は HTTP の境界の 500
  //   （ProblemResponse.from）の行で、通知の失敗は応答を 500 にしない（完了は成功している）。notification で引けば送信と失敗が
  //   並び、失敗だけは phase（と severity の ERROR）で絞れる（db_write の phase と同じ形）。
  notify(message: string): void {
    this.sendNotification.execute({ message }).catch((error: unknown) => {
      logger.emit({
        message: "notification failed",
        event: { name: "notification", phase: "failed" },
        error,
      });
    });
  }
}
