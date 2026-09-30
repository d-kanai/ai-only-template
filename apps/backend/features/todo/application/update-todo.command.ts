import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// 部分更新: 指定された項目だけを変える（undefined の項目はそのまま）。
export type UpdateTodoInput = {
  id: string;
  title?: string;
  completed?: boolean;
};

export class UpdateTodoCommand {
  constructor(private readonly repository: TodoRepository) {}

  async execute(input: UpdateTodoInput): Promise<Todo> {
    // 無い id は findByIdOrThrow が not_found の DomainError を投げる（API で 404）。
    const current = await this.repository.findByIdOrThrow(input.id);
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
