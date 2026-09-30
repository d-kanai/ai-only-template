import type { TransactionRunner } from "../application/transaction";
import type { Transaction } from "../domain/transaction";
import type { Database } from "./database";
import { PostgresWriter, transactionOf } from "./writer";

// TransactionRunner（shared/application/transaction.ts の port。Issue #220 で domain から移した）の Postgres 実装（Issue #215。
//   ADR docs/adr/architecture/20260930-transaction-from-application.md）。
// WHY infra から application を参照する: この port を実装するため。infra が参照してよい application はこの port だけ
//   （rule-tests/architecture.test.ts の SHARED_TRANSACTION_PORT_MODULE）。
// command（application）がコンストラクタで受け取り、execute の本体を run で包む。api ファイルが
//   `new PostgresTransactionRunner(getDatabase().db)` と組み立てる（テストは InMemoryTransactionRunner）。
// WHY トランザクションを張るのはここだけ: Repository（*.postgres.ts）は db.transaction を呼ばない（rule-tests/persistence.test.ts の
//   no-direct-transaction。このファイルは Repository ではないので対象外）。command が張った 1 つのトランザクションの中で、
//   読み込み（findByIdOrThrow の FOR UPDATE）と書き込み（insert / update / delete）を行う。
// WHY work に渡す tx は Writer（記録する書き込みの口）: Repository は writerOf(tx) で Writer を取り出して書き、Writer が文ごとに
//   変更履歴とログを残す（shared/infra/writer.ts）。domain の Transaction の brand で包み、application・domain には中を見せない。
// WHY actorId（変更した利用者の id）を持つ（既定は null）: 変更履歴の actor は要求の文脈で、要求ごとに組み立てる runner が
//   Writer に渡す。ログインが無い今は本番の組み立てが渡さず、常に null。
export class PostgresTransactionRunner implements TransactionRunner {
  constructor(
    private readonly db: Database,
    private readonly actorId: string | null = null,
  ) {}

  // WHY db.transaction に任せる: work が resolve したら COMMIT、reject したら ROLLBACK して同じ例外を投げ直す（drizzle-orm 0.45.3 の
  //   node-postgres の transaction）。分離レベルは既定の READ COMMITTED（同じ Todo の同時更新は findByIdOrThrow の行ロックで
  //   直列化する）。
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) =>
      work(transactionOf(new PostgresWriter(tx, this.actorId))),
    );
  }
}
