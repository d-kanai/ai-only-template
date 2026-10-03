import { DrizzleQueryError, sql } from "drizzle-orm";
import type { Database } from "../../../../shared/drizzle/database";
import type { HealthRepository } from "../domain/health-repository";

// HealthRepository の Postgres 実装（Issue #107）。
// WHY db（Database）をコンストラクタで受け取る: PostgresTodoRepository と同じく、api ファイルが
//   `new PostgresHealthRepository(AppDatabase.get().db)` で本番のプール（プロセスで 1 つ）を渡し、テストはテスト用のスキーマの db を渡す。
//   ヘルスチェックのためにプールを別に作らないので、確かめるのはアプリの API が実際に使う接続そのものになる。
export class PostgresHealthRepository implements HealthRepository {
  constructor(private readonly db: Database) {}

  // WHY select 1: 表を読まずに、プールから接続を取り出して Postgres と 1 往復できるかだけを見る。表を読むと、マイグレーションの
  //   当て忘れや表のロックでも失敗し、「DB に問い合わせられない」と区別できない。
  // WHY 失敗を握りつぶさずに投げる: 失敗をどう扱うか（unavailable にしてログに残す）は呼び出し側（CheckHealthQuery・GetHealthApi）が決める。
  // WHY drizzle の DrizzleQueryError を外し、原因（cause。node-postgres の例外）を投げる: drizzle-orm 0.45.3 は失敗を
  //   「Failed query: select 1\nparams: 」の message の DrizzleQueryError で包む（errors.js）。logger はクエリを抱えた例外の message を
  //   *** にする（apps/shared/log-event.ts の holdsQueryParameters）ので、包んだままではログの 1 行から原因（接続の拒否・プールの終了・
  //   タイムアウト）が読めない。select 1 は利用者の値を含まないので、原因の message を出してよい。
  // 待つ時間の上限は、プールの接続待ち（DATABASE_CONNECTION_TIMEOUT_MS）と DB 側の statement_timeout（shared/drizzle/database.ts）に従う。
  async ping(): Promise<void> {
    try {
      await this.db.execute(sql`select 1`);
    } catch (error) {
      throw error instanceof DrizzleQueryError ? error.cause : error;
    }
  }
}
