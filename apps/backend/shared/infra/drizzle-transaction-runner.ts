import type { TransactionRunner } from "../domain/transaction-runner";
import type { Database, Executor } from "./database";

// Drizzle（Postgres）のトランザクションで TransactionRunner を実装する。
// db.transaction は fn が正常に終われば COMMIT、例外を投げれば ROLLBACK してその例外を投げ直す（drizzle-orm の
// PgDatabase#transaction）。fn にはトランザクションの中の executor（tx）を渡し、Repository はそれで読み書きする。
// 分離レベルは Postgres の既定（READ COMMITTED）のまま。見直すときの注意は .claude/rules/backend.md の「永続化（Drizzle + Postgres）」。
export class DrizzleTransactionRunner implements TransactionRunner<Executor> {
  constructor(private readonly db: Database) {}

  run<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(tx));
  }
}
