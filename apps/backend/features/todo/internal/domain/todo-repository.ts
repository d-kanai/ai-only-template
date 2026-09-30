import { DomainError } from "../../../../shared/domain/domain-error";
import type { Transaction } from "../../../../shared/domain/transaction";
import type { Todo } from "./todo";

// Todo の永続化の窓口（interface）。
// WHY domain に interface だけを置く: application 層は「保存できる何か」にだけ依存し、
//   実装（Postgres / テスト用の InMemory）は infra 層が持つ（依存性の逆転）。query / command はコンストラクタで
//   この interface を受け取り、本番は api ファイルが Postgres の実装を、テストは InMemory の実装を渡す（Issue #123）。
// WHY すべて Promise を返す: InMemory の実装は同期で済むが、DB の実装は非同期になる。同じ形にそろえ、
//   実装を差し替えても呼び出し側（application 層）を直さずに済むようにする。
// WHY 書き込みと command の読み込みは Transaction を受け取る（Issue #215。ADR docs/adr/architecture/20260930-transaction-from-application.md）:
//   トランザクションの範囲は command が決める（TransactionRunner の run）。command は同じ tx で findByIdOrThrow（行ロック）と
//   insert / update / delete を呼び、読み込みから書き込みまでを 1 つのトランザクションにする。Repository はトランザクションを張らない。
//   query（findAll / findById）はトランザクションを張らない（1 文で読む。下の findById）。
// WHY save（新規か読み込み済みかを origin で分けて 1 つにまとめていた。Issue #165）を insert / update に分ける（Issue #215）: 呼び出し側
//   （create は新規、rename / change-todo-completion は読み込み済み）は、どちらを書くかを知っている。Repository が origin で分岐する
//   必要が無くなり、update は読み込んだ後に消された場合（以前の updateOrLock）を考えずに済む（同じ tx で行をロックして読むため）。
export interface TodoRepository {
  // 作成日時の昇順で返す。作成日時が同じなら id の昇順（毎回同じ順になる）。
  // WHY 並び順を Repository の契約にする: 一覧の順序は永続化が最も安く決められ（Postgres は ORDER BY）、application で
  //   並べ替え直すと 2 か所で同じ規則を持つことになる。実装（Postgres / InMemory）が同じ順を返すことは、両方の
  //   テストが同じ名前で固定する。
  findAll(): Promise<Todo[]>;
  // 見つからないときは undefined。「無いこと」をどう扱うか（404 にするか等）は呼び出し側が決める。
  // query（get-todo）とテストが使う。トランザクションも行ロックも無い 1 文の読み取り。
  findById(id: string): Promise<Todo | undefined>;
  // command 用の読み込み。見つからないときは DomainError("not_found", "todo.notFound", { id }) を投げる（API では 404）。
  //   Postgres は根の行（todos）を tx の終わりまでロックする（FOR UPDATE。集約を読む前の別の文で取る。
  //   todo-repository.postgres.ts の findByIdOrThrow）。同じ Todo を変える別の command の
  //   findByIdOrThrow と delete は、この tx が終わるまで待つ（同じ Todo の同時更新は直列化される）。
  // WHY ロックする: 読んでから書くまでの間に別の要求が同じ Todo を消す・変えると、読んだ値を前提にした書き込み（完了の履歴の
  //   位置・通知の条件）がずれる。ロックすれば、書き込むときも読んだときの値のまま。
  // WHY interface に持たせる（ユースケースで throw を書かない）: 例外の code・key・params をここで 1 つに決め、
  //   ユースケースごとの書き漏れ・書き違いを無くす（Issue #123 の後のユーザー指示、2026-09-29）。実装は requireTodo を使う。
  findByIdOrThrow(id: string, tx: Transaction): Promise<Todo>;
  // 新規の Todo（Todo.create から作った。origin が undefined）を書く（根と完了の履歴の全件）。同じ id があれば失敗する
  //   （Postgres は一意制約違反。新規を 2 回書くのは実装ミス）。origin がある Todo を渡すと Error（読み込み済みは update）。
  insert(todo: Todo, tx: Transaction): Promise<void>;
  // 読み込み済みの Todo（findByIdOrThrow で読んだ。origin がある）の、読み込んだときから変わった項目（title・completed）だけを
  //   書き、完了の履歴は読み込んだときより後ろに増えた分だけを足す（既存の履歴は書き換えない・消さない）。変わった項目も増えた
  //   履歴も無ければ何もしない（SQL も発行しない）。origin が undefined の Todo を渡すと Error（新規は insert）。
  //   同じ tx の findByIdOrThrow で行をロックしていれば、行は消えていない。ロックせずに読んだ Todo（findById）で、その後に消された
  //   ときは失敗する（not_found にはしない。呼び出し側の誤り）。
  update(todo: Todo, tx: Transaction): Promise<void>;
  // 存在しない id でも何もしない（存在確認は呼び出し側が findByIdOrThrow で行う）。
  delete(id: string, tx: Transaction): Promise<void>;
}

// findByIdOrThrow の共通部分: 読んだ結果が undefined なら not_found の DomainError を投げ、あればそのまま返す。
// WHY 関数にして domain に置く（実装ごとに throw を書かない）: Postgres と InMemory の 2 つの実装が同じ例外を投げる
//   ことを 1 か所で保証する。片方だけ key や params を変えると、テスト（InMemory）と本番（Postgres）で API の応答が
//   ずれ、テストが本番の振る舞いを表さなくなる。
// WHY 基底クラス（abstract class TodoRepositoryBase）にしない: 実装に継承を強い、interface を満たすだけのテスト用の
//   スタブ（オブジェクトリテラル）とも形がそろわなくなる。関数なら各実装が `requireTodo(<読んだ Todo>, id)`
//   の 1 行で使え（Postgres は行をロックして読んだ結果、InMemory は findById の結果）、依存も「infra → 自 feature の domain」（.claude/rules/backend.md の層の許可）の範囲に収まる。
// WHY domain に置く（infra の共通ファイルにしない）: 「無い Todo を求めたら not_found」は TodoRepository の約束
//   （上の interface）そのもので、DomainError も domain の型。domain は自 feature と shared の domain だけを参照する。
export function requireTodo(todo: Todo | undefined, id: string): Todo {
  if (todo === undefined) {
    throw new DomainError("not_found", "todo.notFound", { id });
  }
  return todo;
}
