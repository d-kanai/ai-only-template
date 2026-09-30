import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// WHY completed の値を受け取る（toggle にしない）: 同じリクエストを 2 回送っても結果が同じ（冪等）になるため
//   （todo.ts の changeCompletion のコメント）。
export type ChangeTodoCompletionInput = {
  id: string;
  completed: boolean;
};

// Todo が完了になったことを知らせる口。本番は notification モジュールの expose の notify を、api ファイル
//   （change-todo-completion.api.ts）が組み立てで渡す。
// WHY 関数をコンストラクタで受け取る（application から notification の expose を import しない）: application は他のモジュールを
//   知らず、他のモジュールの expose を import してよいのは組み立ての場所（presentation）だけ（rule-tests/architecture.test.ts の
//   module-expose-only-from-presentation。Issue #208）。テストは記録する関数を渡せる（Repository と同じくコンストラクタで差し替える）。
// WHY 同期の void: 通知を待たずに応答を返す（fire-and-forget）。失敗の扱い（ログ）は notification 側が持つ（expose/notify.ts）。
export type NotifyTodoCompleted = (message: string) => void;

// Todo を完了にする / 未完了に戻して保存する（command: 状態を変える）。未完了から完了に変わったときは通知する。
// WHY 名前の変更（rename-todo.command.ts）と分ける: rename-todo.command.ts の RenameTodoCommand のコメント。
export class ChangeTodoCompletionCommand {
  constructor(
    private readonly repository: TodoRepository,
    private readonly notifyCompleted: NotifyTodoCompleted,
  ) {}

  async execute(input: ChangeTodoCompletionInput): Promise<Todo> {
    // 無い id は findByIdOrThrow が not_found の DomainError を投げる（API で 404）。
    const current = await this.repository.findByIdOrThrow(input.id);
    const changed = current.changeCompletion(input.completed);
    await this.repository.save(changed);
    // WHY 保存の後: 保存に失敗した（完了になっていない）Todo の完了を知らせない。
    // WHY 未完了 → 完了に変わったときだけ: PUT は冪等で、同じ要求を 2 回送っても通知は 1 回にする。未完了に戻すときは知らせない。
    // WHY 本文は id だけの英語: title などの利用者の値をログに出さない（通知は今はログに出るだけ）。
    if (!current.completed && changed.completed) {
      this.notifyCompleted(`Todo completed: ${changed.id}`);
    }
    return changed;
  }
}
