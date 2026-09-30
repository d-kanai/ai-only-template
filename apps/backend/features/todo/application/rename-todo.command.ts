import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

export type RenameTodoInput = {
  id: string;
  title: string;
};

// Todo の名前（title）を変えて保存する（command: 状態を変える）。
// WHY 完了（change-todo-completion.command.ts）と分ける: 名前の変更と完了は業務プロセスが別で、後から片方だけに
//   処理（完了で通知を送るなど）が付いたとき、1 つの command に if が増えないようにする（1 ユースケース = 1 API = 1 command。
//   ADR docs/adr/architecture/20260930-one-api-per-use-case.md）。
export class RenameTodoCommand {
  constructor(private readonly repository: TodoRepository) {}

  async execute(input: RenameTodoInput): Promise<Todo> {
    // 無い id は findByIdOrThrow が not_found の DomainError を投げる（API で 404）。
    const current = await this.repository.findByIdOrThrow(input.id);
    // title が不変条件を満たさなければ rename が validation_error を投げる。Todo は不変なので、save する前に
    //   投げれば保存済みの値は変わらない。
    const renamed = current.rename(input.title);
    await this.repository.save(renamed);
    return renamed;
  }
}
