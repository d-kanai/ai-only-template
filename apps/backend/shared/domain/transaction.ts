// トランザクションの口（Issue #215。ADR docs/adr/architecture/20260930-transaction-from-application.md）。
// command（application）がトランザクションの範囲を決め、Repository の書き込み（insert / update / delete）と読み込み
//   （findByIdOrThrow）に同じ Transaction を渡す。
// WHY domain に置く: application は infra（drizzle・Database）を参照できない（rule-tests/architecture.test.ts の application と
//   core-to-persistence）。口（型と interface）だけを domain に置き、実体（Postgres のトランザクションと、その中の記録する Writer）は
//   infra（shared/infra/transaction.postgres.ts・shared/infra/writer.ts）が持つ（依存性の逆転。TodoRepository と同じ形）。

// 中身を見せないトランザクション。application・domain は受け取って Repository に渡すだけで、中を触れない。
// WHY brand（unique symbol のキー）: 構造が空の型（`{}`）だと、どんな値でも Transaction として渡せてしまう。宣言だけの
//   unique symbol をキーにすると、このモジュールの外では作れない型になり、渡せるのは runner が作った値だけになる（infra が
//   1 か所の cast で作る。shared/infra/writer.ts の transactionOf）。
// WHY 実行時の値を持たない（declare）: 型を区別するためだけの印で、実行時には何も要らない。
declare const transactionBrand: unique symbol;
export type Transaction = { readonly [transactionBrand]: "transaction" };

// トランザクションを張って work を実行する。work が resolve したら COMMIT、reject したら ROLLBACK して同じ例外で reject する。
// 本番は PostgresTransactionRunner（shared/infra/transaction.postgres.ts）、テストは InMemoryTransactionRunner
//   （test-support/transaction-runner.in-memory.ts）を command のコンストラクタに渡す。
// WHY 戻り値を work の値にする: command が読み込んで変えた Todo を、トランザクションの外（通知・応答）で使えるようにする。
export interface TransactionRunner {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
