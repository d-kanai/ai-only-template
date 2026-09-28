import { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

export type CreateTodoInput = {
  title: string;
};

// Todo を作って保存する（command: 状態を変える）。
// WHY 作った Todo を返す: command は状態を変えるのが役割だが、API が作成結果（id・作成日時）を 201 で返す仕様のため、
//   保存し直した値を読み直す query を別に呼ばずに済むよう、作った Todo をそのまま返す。
export class CreateTodoCommand {
  constructor(private readonly repository: TodoRepository) {}

  async execute(input: CreateTodoInput): Promise<Todo> {
    // タイトルの検証（trim・長さ）は Todo.create が行う。ここで重ねて書かない（不変条件は domain に 1 か所）。
    const todo = Todo.create(input.title);
    await this.repository.save(todo);
    return todo;
  }
}
