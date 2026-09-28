import type { TransactionRunner } from "../../shared/domain/transaction-runner";
import type { InMemoryTodoRepository } from "./todo-repository.in-memory";

// InMemory のリポジトリ向けの TransactionRunner。DATABASE_URL が無いときと単体テストで、Postgres と同じく
// 「command が失敗したら変更を残さない」振る舞いにするために使う。
// WHY スナップショットで rollback する: InMemory にはトランザクションが無い。fn の前に中身の写しを取り、例外なら写しに戻す。
//   Todo は不変なので、写しは Map の複製だけで済む（todo-repository.in-memory.ts の snapshot）。
// WHY Tx をリポジトリそのものにする: InMemory には「トランザクションの中の接続」に当たるものが無く、
//   同じリポジトリを読み書きすればよい。container.ts の repositoryFor は受け取ったリポジトリをそのまま返す。
// WHY run を 1 つずつ順番に実行する: 並行した 2 つの run の片方が失敗して写しに戻すと、もう片方がその間に確定した
//   変更まで消える。前の run が終わる（成功・失敗のどちらでも）まで次の fn を始めないことで、これを防ぐ。
//   run の外（query）の読み取りは待たないので、実行中の command の途中の状態が見えることはある（InMemory の限界。
//   Postgres では READ COMMITTED で確定した値だけが見える）。
export class InMemoryTransactionRunner
  implements TransactionRunner<InMemoryTodoRepository>
{
  // 最後に受け付けた run が終わると settle する Promise。次の run はこれを待ってから始める。
  private last: Promise<unknown> = Promise.resolve();

  constructor(private readonly repository: InMemoryTodoRepository) {}

  run<T>(fn: (tx: InMemoryTodoRepository) => Promise<T>): Promise<T> {
    const result = this.last.then(() => this.runAlone(fn));
    // 失敗した run でも次の run を止めないよう、待ち合わせ用には結果を捨てた Promise を持つ（例外は呼び出し側が result で受ける）。
    this.last = result.catch(() => undefined);
    return result;
  }

  private async runAlone<T>(
    fn: (tx: InMemoryTodoRepository) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.repository.snapshot();
    try {
      return await fn(this.repository);
    } catch (error) {
      this.repository.restore(snapshot);
      throw error;
    }
  }
}
