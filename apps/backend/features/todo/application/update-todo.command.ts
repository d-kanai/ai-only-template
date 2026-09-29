import { DomainError } from "../../../shared/domain/domain-error";
import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// 部分更新: 指定された項目だけを変える（undefined の項目はそのまま）。
export type UpdateTodoInput = {
  id: string;
  title?: string;
  completed?: boolean;
};

// Todo の title / completed を更新して保存する（command: 状態を変える）。
export class UpdateTodoCommand {
  constructor(private readonly repository: TodoRepository) {}

  async execute(input: UpdateTodoInput): Promise<Todo> {
    const current = await this.repository.findById(input.id);
    if (current === undefined) {
      throw new DomainError(
        "not_found",
        `Todo（id: ${input.id}）が見つかりません`,
      );
    }
    // WHY 変更をすべて適用してから 1 回だけ save する: title が不変条件違反で例外になったとき、
    //   completed だけが保存される中途半端な状態を作らないため（Todo は不変なので、save するまで保存済みの値は変わらない）。
    let updated = current;
    if (input.title !== undefined) {
      updated = updated.rename(input.title);
    }
    if (input.completed !== undefined) {
      updated = updated.changeCompletion(input.completed);
    }
    await this.repository.save(updated);
    return updated;
  }
}
