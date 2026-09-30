import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// Todo の一覧を返す（query: 読むだけで状態を変えない）。
// 並び順（作成日時の昇順、同じなら id の昇順）は Repository の findAll の契約（domain/todo-repository.ts）で、
//   ここでは並べ替えない。WHY: Postgres は ORDER BY で並べて返すので、application で並べ替え直すと同じ規則を
//   2 か所に持つことになる。
export class ListTodosQuery {
  constructor(private readonly repository: TodoRepository) {}

  execute(): Promise<Todo[]> {
    return this.repository.findAll();
  }
}
