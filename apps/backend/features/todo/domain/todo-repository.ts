import type { Todo } from "./todo";

// Todo の永続化の窓口（interface）。
// WHY domain に interface だけを置く: application 層は「保存できる何か」にだけ依存し、
//   実装（Postgres / テスト用の InMemory）は infra 層が持つ（依存性の逆転）。query / command はコンストラクタで
//   この interface を受け取り、本番は api ファイルが Postgres の実装を、テストは InMemory の実装を渡す（Issue #123）。
// WHY すべて Promise を返す: InMemory の実装は同期で済むが、DB の実装は非同期になる。同じ形にそろえ、
//   実装を差し替えても呼び出し側（application 層）を直さずに済むようにする。
export interface TodoRepository {
  // 並び順は保証しない（並べ替えは用途を知っている application 層が行う）。
  findAll(): Promise<Todo[]>;
  // 見つからないときは undefined。「無いこと」をどう扱うか（404 にするか等）は呼び出し側が決める。
  findById(id: string): Promise<Todo | undefined>;
  // 同じ id があれば上書きする（作成と更新を 1 つにまとめる）。
  save(todo: Todo): Promise<void>;
  // 存在しない id でも何もしない（存在確認は呼び出し側が findById で行う）。
  delete(id: string): Promise<void>;
}
