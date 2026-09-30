import type { TodoRepository } from "../domain/todo-repository";

// Todo を削除する（command: 状態を変える）。
export class DeleteTodoCommand {
  constructor(private readonly repository: TodoRepository) {}

  async execute(id: string): Promise<void> {
    // WHY 先に存在を確かめる: リポジトリの delete は無い id でも何もしない（TodoRepository の約束）。
    //   API は「無い id の削除は 404」を仕様にしているので、無ければ findByIdOrThrow が not_found を投げる。
    await this.repository.findByIdOrThrow(id);
    await this.repository.delete(id);
  }
}
