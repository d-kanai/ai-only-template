import type { TransactionRunner } from "../../../../shared/application/transaction";
import type { TodoRepository } from "../domain/todo-repository";

// Todo を削除する（command: 状態を変える）。
// WHY transactions を受け取り run で包む: create-todo.command.ts の CreateTodoCommand のコメント。確かめる読み込み（行ロック）と
//   削除を同じトランザクションで行う。
export class DeleteTodoCommand {
  constructor(
    private readonly repository: TodoRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(id: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      // WHY 先に存在を確かめる: リポジトリの delete は無い id でも何もしない（TodoRepository の約束）。
      //   API は「無い id の削除は 404」を仕様にしているので、無ければ findByIdForUpdate が not_found を投げる。
      await this.repository.findByIdForUpdate(id, tx);
      await this.repository.delete(id, tx);
    });
  }
}
