import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// WHY completed の値を受け取る（toggle にしない）: 同じリクエストを 2 回送っても結果が同じ（冪等）になるため
//   （todo.ts の changeCompletion のコメント）。
export type ChangeTodoCompletionInput = {
  id: string;
  completed: boolean;
};

// Todo を完了にする / 未完了に戻して保存する（command: 状態を変える）。
// WHY 名前の変更（rename-todo.command.ts）と分ける: rename-todo.command.ts の RenameTodoCommand のコメント。
export class ChangeTodoCompletionCommand {
  constructor(private readonly repository: TodoRepository) {}

  async execute(input: ChangeTodoCompletionInput): Promise<Todo> {
    // 無い id は findByIdOrThrow が not_found の DomainError を投げる（API で 404）。
    const current = await this.repository.findByIdOrThrow(input.id);
    const changed = current.changeCompletion(input.completed);
    await this.repository.save(changed);
    return changed;
  }
}
