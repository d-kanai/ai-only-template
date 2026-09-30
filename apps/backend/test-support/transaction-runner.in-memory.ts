import type { TransactionRunner } from "../shared/application/transaction";
import type { Transaction } from "../shared/domain/transaction";

// TransactionRunner の InMemory 実装（テスト用。Issue #215）。command のテストと、api ファイルのテストの組み立てで
//   InMemory の Repository と一緒に渡す。本番は PostgresTransactionRunner（shared/infra/transaction.postgres.ts）。
// WHY work を呼ぶだけ（rollback を再現しない）: InMemory の Repository は tx を使わず、Map を直接書き換える。work が途中で失敗しても、
//   それまでの書き換えは戻らない。今の command は、失敗しうる処理（findByIdForUpdate の not_found・Entity の検証）をすべて書き込みの前に
//   行い、書き込みは最後の 1 回（insert / update / delete）なので、InMemory で戻らなくても結果は変わらない。rollback（原子性）は
//   Postgres の Repository のテスト（todo-repository.postgres.test.ts）と runner のテスト（transaction.postgres.test.ts）が実 DB で固定する。
//   複数の書き込みを持つ command を足して、途中の失敗で戻ることを command のテストで確かめたくなったら、ここで戻す仕組みを検討する。
export class InMemoryTransactionRunner implements TransactionRunner {
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return work(inMemoryTransaction);
  }
}

// InMemory の runner が work に渡す Transaction。InMemory の Repository は受け取るだけで使わない。
// WHY export する: テストが Repository に直接 Todo を置く（`repository.insert(todo, inMemoryTransaction)`）ときに使う。
// WHY cast: domain の Transaction は brand の型で、infra の実体（Postgres の Writer）以外は作れない。InMemory は中身の要らない
//   印だけを渡す（本番のコードは test-support を参照できないので、この値が本番に混ざることはない。rule-tests/test-support.test.ts）。
//   Postgres の Repository に渡すと writerOf が Error にする（shared/infra/writer.ts）。
export const inMemoryTransaction = Object.freeze({}) as unknown as Transaction;
