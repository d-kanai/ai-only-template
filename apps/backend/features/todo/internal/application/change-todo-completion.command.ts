import type { TransactionRunner } from "../../../../shared/application/transaction";
import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// WHY completed の値を受け取る（toggle にしない）: 同じリクエストを 2 回送っても結果が同じ（冪等）になるため
//   （todo.ts の changeCompletion のコメント）。
export type ChangeTodoCompletionInput = {
  id: string;
  completed: boolean;
};

// Todo が完了になったことを知らせる口。本番は notification モジュールの expose の Notifier を、api ファイル
//   （change-todo-completion.api.ts）が組み立てで渡す。
// WHY interface をコンストラクタで受け取る（application から notification の expose を import しない）: application は他のモジュールを
//   知らず、他のモジュールの expose を import してよいのは組み立ての場所（presentation）だけ（rule-tests/architecture.test.ts の
//   module-expose-only-from-presentation。Issue #208）。テストは記録するオブジェクトを渡せる（Repository と同じくコンストラクタで差し替える）。
// WHY 関数の型ではなく notify を持つ interface: backend はクラスを基本にし、モジュールをまたぐ利用はコンストラクタで受け取った
//   インスタンスを通す（ADR docs/adr/architecture/20261002-class-based-backend.md。Issue #262）。Notifier はこの形を満たす。
// WHY 同期の void: 通知を待たずに応答を返す（fire-and-forget）。失敗の扱い（ログ）は notification 側が持つ（expose/notifier.ts）。
export interface TodoCompletedNotifier {
  notify(message: string): void;
}

// Todo を完了にする / 未完了に戻して保存する（command: 状態を変える）。未完了から完了に変わったときは通知する。
// WHY 名前の変更（rename-todo.command.ts）と分ける: rename-todo.command.ts の RenameTodoCommand のコメント。
// WHY transactions を受け取り run で包む: rename-todo.command.ts の RenameTodoCommand のコメント。transactions は Repository の次
//   （組み立ての順を Repository → トランザクション → 他のモジュールの口にそろえる）。
export class ChangeTodoCompletionCommand {
  constructor(
    private readonly repository: TodoRepository,
    private readonly transactions: TransactionRunner,
    private readonly notifier: TodoCompletedNotifier,
  ) {}

  async execute(input: ChangeTodoCompletionInput): Promise<Todo> {
    const { current, changed } = await this.transactions.run(async (tx) => {
      // 無い id は findByIdForUpdate が not_found の DomainError を投げる（API で 404）。
      const current = await this.repository.findByIdForUpdate(input.id, tx);
      const changed = current.changeCompletion(input.completed);
      await this.repository.update(changed, tx);
      return { current, changed };
    });
    // WHY 保存の後（run が resolve した = COMMIT した後。トランザクションの外）: 保存に失敗した・COMMIT が失敗して戻った
    //   （完了になっていない）Todo の完了を知らせない（Issue #215）。通知は同期の fire-and-forget で、トランザクションの接続を
    //   通知の間は占有しない。
    // WHY 未完了 → 完了に変わったときだけ: PUT は冪等で、同じ要求を 2 回送っても通知は 1 回にする。未完了に戻すときは知らせない。
    // WHY 本文は id だけの英語: title などの利用者の値をログに出さない（通知は今はログに出るだけ）。
    if (!current.completed && changed.completed) {
      this.notifier.notify(`Todo completed: ${changed.id}`);
    }
    return changed;
  }
}
