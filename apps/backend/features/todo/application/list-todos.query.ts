import type { Todo } from "../domain/todo";
import type { TodoRepository } from "../domain/todo-repository";

// WHY 並べ替えをここで行う: 「一覧は作成日時の昇順」は API の仕様で、リポジトリの実装（Map の挿入順、DB の既定順）に
//   任せると実装を差し替えたときに順序が変わりうる。用途を知っている application 層で明示的に決める。
export class ListTodosQuery {
  constructor(private readonly repository: TodoRepository) {}

  async execute(): Promise<Todo[]> {
    const todos = await this.repository.findAll();
    // Array#sort は安定ソート（ES2019 以降）なので、作成日時が同じ Todo はリポジトリが返した順を保つ。
    // WHY コピーしてから並べ替える: Array#sort は配列をその場で書き換える。リポジトリの実装がキャッシュした配列を
    //   そのまま返すと、読むだけの query がリポジトリ側の状態を書き換えてしまうため、受け取った配列には触らない。
    return [...todos].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }
}
