// トランザクションの印の型 Transaction と、トランザクションを張る口（port）TransactionRunner
//   （ADR docs/adr/architecture/20260930-transaction-from-application.md）。
// command（application）がコンストラクタで runner を受け取り、execute の本体を run で包んで、Repository の書き込み（insert /
//   update / delete）と読み込み（findByIdForUpdate）に同じ Transaction を渡す。
// WHY 印の型と port を 1 ファイルに置く（Issue #230。ユーザー判断）: Issue #215 では両方を shared/domain に置き、Issue #220 で
//   port だけをここに移して型を shared/domain に残した（domain は application を参照できないとして分けていた）。
//   トランザクションという 1 つの関心が 2 ファイルに分かれるのを避け、ここにまとめた。domain の Repository の interface
//   （TodoRepository）がこの型を引数に取るので、domain → shared/transaction/transaction の参照だけを型だけ（import type）の
//   例外として許す（rule-tests/architecture.test.ts の SHARED_TRANSACTION_PORT_MODULE と規則 domain）。
// WHY application に置く: トランザクションの範囲を決めるのは command（ユースケース）の関心で、domain は runner を使わず、
//   印の型を受け取って渡すだけ。
// WHY interface だけを置く（依存性の逆転）: application は infra（drizzle・Database）を参照できない（rule-tests/architecture.test.ts
//   の application と core-to-persistence）。実体（Postgres のトランザクションと、その中の記録する Writer）は infra
//   （shared/drizzle/transaction.postgres.ts・shared/drizzle/writer.ts）が持ち、この interface を implements する。infra・domain が参照して
//   よい application はこのモジュールだけで、型だけ（rule-tests/architecture.test.ts の SHARED_TRANSACTION_PORT_MODULE）。

// 中身を見せないトランザクション。application・domain は受け取って Repository に渡すだけで、中を触れない。
// WHY brand（unique symbol のキー）: 構造が空の型（`{}`）だと、どんな値でも Transaction として渡せてしまう。宣言だけの
//   unique symbol をキーにすると、このモジュールの外では作れない型になり、渡せるのは runner が作った値だけになる（infra が
//   1 か所の cast で作る。shared/drizzle/writer.ts の PostgresWriter の asTransaction）。
// WHY 実行時の値を持たない（declare）: 型を区別するためだけの印で、実行時には何も要らない。domain・infra は import type で
//   参照するので、このモジュールに実行時の export を足しても domain・infra には取り込まれない（足すべきでもない）。
declare const transactionBrand: unique symbol;
export type Transaction = { readonly [transactionBrand]: "transaction" };

// トランザクションを張って work を実行する。work が resolve したら COMMIT、reject したら ROLLBACK して同じ例外で reject する。
// 本番は PostgresTransactionRunner（shared/drizzle/transaction.postgres.ts）、テストは InMemoryTransactionRunner
//   （test-support/transaction-runner.in-memory.ts）を command のコンストラクタに渡す。
// WHY 戻り値を work の値にする: command が読み込んで変えた Todo を、トランザクションの外（通知・応答）で使えるようにする。
export interface TransactionRunner {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
