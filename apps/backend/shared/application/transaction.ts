import type { Transaction } from "../domain/transaction";

// トランザクションを張る口（port）。Issue #215 で shared/domain に置き、Issue #220 でここに移した
//   （ADR docs/adr/architecture/20260930-transaction-from-application.md）。
// command（application）がコンストラクタで受け取り、execute の本体を run で包んで、Repository の書き込み（insert / update /
//   delete）と読み込み（findByIdForUpdate）に同じ Transaction を渡す。
// WHY application に置く: トランザクションの範囲を決めるのは command（ユースケース）の関心で、domain（Entity・Repository の
//   interface）は runner を使わない。domain が要るのは、TodoRepository の引数に取る brand の型 Transaction だけなので、
//   それは shared/domain/transaction.ts に残した（domain は application を参照できない。rule-tests/architecture.test.ts の domain）。
// WHY interface だけを置く（依存性の逆転）: application は infra（drizzle・Database）を参照できない（rule-tests/architecture.test.ts
//   の application と core-to-persistence）。実体（Postgres のトランザクションと、その中の記録する Writer）は infra
//   （shared/infra/transaction.postgres.ts・shared/infra/writer.ts）が持ち、この interface を implements する。infra が参照して
//   よい application はこのモジュールだけ（rule-tests/architecture.test.ts の SHARED_TRANSACTION_PORT_MODULE）。

// トランザクションを張って work を実行する。work が resolve したら COMMIT、reject したら ROLLBACK して同じ例外で reject する。
// 本番は PostgresTransactionRunner（shared/infra/transaction.postgres.ts）、テストは InMemoryTransactionRunner
//   （test-support/transaction-runner.in-memory.ts）を command のコンストラクタに渡す。
// WHY 戻り値を work の値にする: command が読み込んで変えた Todo を、トランザクションの外（通知・応答）で使えるようにする。
export interface TransactionRunner {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
