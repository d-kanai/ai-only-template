import { DomainError } from "../../../../shared/domain/domain-error";
import type { Todo } from "./todo";

// Todo の永続化の窓口（interface）。
// WHY domain に interface だけを置く: application 層は「保存できる何か」にだけ依存し、
//   実装（Postgres / テスト用の InMemory）は infra 層が持つ（依存性の逆転）。query / command はコンストラクタで
//   この interface を受け取り、本番は api ファイルが Postgres の実装を、テストは InMemory の実装を渡す（Issue #123）。
// WHY すべて Promise を返す: InMemory の実装は同期で済むが、DB の実装は非同期になる。同じ形にそろえ、
//   実装を差し替えても呼び出し側（application 層）を直さずに済むようにする。
export interface TodoRepository {
  // 作成日時の昇順で返す。作成日時が同じなら id の昇順（毎回同じ順になる）。
  // WHY 並び順を Repository の契約にする: 一覧の順序は永続化が最も安く決められ（Postgres は ORDER BY）、application で
  //   並べ替え直すと 2 か所で同じ規則を持つことになる。実装（Postgres / InMemory）が同じ順を返すことは、両方の
  //   テストが同じ名前で固定する。
  findAll(): Promise<Todo[]>;
  // 見つからないときは undefined。「無いこと」をどう扱うか（404 にするか等）は呼び出し側が決める。
  // WHY findByIdOrThrow があっても残す: 「無いこと」を失敗ではなく結果として扱いたい呼び出し（存在確認だけしたい用途）
  //   のため。テストで保存・削除の結果（削除後は undefined）を確かめるのにも使う。
  findById(id: string): Promise<Todo | undefined>;
  // 見つからないときは DomainError("not_found", "todo.notFound", { id }) を投げる（API では 404）。
  // WHY interface に持たせる: get / rename / changeCompletion / delete のユースケースが同じ「無ければ not_found」を書いていた
  //   （Issue #123 の後のユーザー指示、2026-09-29）。例外の code・key・params をここで 1 つに決め、
  //   ユースケースごとの書き漏れ・書き違い（別の key や params を渡す）を無くす。実装は requireTodo を使う。
  findByIdOrThrow(id: string): Promise<Todo>;
  // 作成と更新を 1 つにまとめる。新規（Todo.create から作った Todo。origin が undefined）は同じ id があれば上書きする。
  //   読み込み済み（origin がある）は、読み込んだときから変わった項目だけを書く（別の項目の同時更新を巻き戻さない。
  //   同じ項目の同時更新は後勝ち。ただし読み込んだときと同じ値に戻す変更は差分が無いので書かれず、他方の更新が残る）。
  //   変わった項目が無ければ何もしない。読み込んだ後に消されていれば
  //   DomainError("not_found", "todo.notFound", { id }) を投げる（Issue #165）。
  //   完了の履歴（statusChanges）は、読み込んだときより後ろに増えた分だけを足す（既存の履歴は書き換えない・消さない）。
  //   読み込んだ後に別の save が履歴を足していたら、増えた分を足さずにエラーにする（同じ save の他の変更も書かない。Issue #188）。
  save(todo: Todo): Promise<void>;
  // 存在しない id でも何もしない（存在確認は呼び出し側が findById / findByIdOrThrow で行う）。
  delete(id: string): Promise<void>;
}

// findByIdOrThrow の共通部分: findById の結果が undefined なら not_found の DomainError を投げ、あればそのまま返す。
// WHY 関数にして domain に置く（実装ごとに throw を書かない）: Postgres と InMemory の 2 つの実装が同じ例外を投げる
//   ことを 1 か所で保証する。片方だけ key や params を変えると、テスト（InMemory）と本番（Postgres）で API の応答が
//   ずれ、テストが本番の振る舞いを表さなくなる。
// WHY 基底クラス（abstract class TodoRepositoryBase）にしない: 実装に継承を強い、interface を満たすだけのテスト用の
//   スタブ（オブジェクトリテラル）とも形がそろわなくなる。関数なら各実装が `requireTodo(await this.findById(id), id)`
//   の 1 行で使え、依存も「infra → 自 feature の domain」（.claude/rules/backend.md の層の許可）の範囲に収まる。
// WHY domain に置く（infra の共通ファイルにしない）: 「無い Todo を求めたら not_found」は TodoRepository の約束
//   （上の interface）そのもので、DomainError も domain の型。domain は自 feature と shared の domain だけを参照する。
export function requireTodo(todo: Todo | undefined, id: string): Todo {
  if (todo === undefined) {
    throw new DomainError("not_found", "todo.notFound", { id });
  }
  return todo;
}
