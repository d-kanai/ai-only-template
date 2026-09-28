// 処理をひとまとまり（トランザクション）で実行する窓口。すべて成功すれば確定（commit）し、途中で例外が出たら
// それまでの変更を取り消して（rollback）同じ例外を投げ直す。
// WHY domain に interface だけを置く: 「command は全部成功するか、何も変えないか」という約束は永続化の方式（Postgres /
//   InMemory）によらない。実装（Drizzle のトランザクション、InMemory のスナップショット）は infra 層が持つ
//   （TodoRepository と同じ依存性の逆転）。
// WHY Tx をジェネリックにする: トランザクションの中で使う executor の型は実装ごとに違う（Drizzle ではトランザクション、
//   InMemory ではリポジトリそのもの）。domain が Drizzle などの型に依存しないよう、型引数で受け取る。
// WHY fn に Tx を渡す: トランザクションの中の読み書きは、渡された Tx から作ったリポジトリで行う必要がある
//   （Tx の外の接続で書くと、その書き込みはトランザクションに入らず rollback されない）。組み立ては infra/container.ts が行う。
export interface TransactionRunner<Tx> {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
