import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { DatabaseHandle } from "./database";

// マイグレーション（migrations/ の SQL のうち、DB にまだ当てていないもの）を当てる。入口は migrate.ts（pnpm db:migrate と
//   Cloud Run の migrate ジョブ）。
// WHY drizzle-kit migrate ではなく drizzle-orm の migrator を使う（Issue #326）: migrate ジョブをアプリと同じ runtime イメージの
//   コマンド違いで動かすため。drizzle-kit は devDependencies で、runtime イメージ（next build の standalone）には入らない。
//   drizzle-kit migrate も中で同じ drizzle-orm の migrator を、同じ既定（記録は drizzle.__drizzle_migrations）で呼ぶので、
//   drizzle-kit で当てた DB にそのまま続けて当てられる（2026-10-02、当て済みのローカルの DB で何も起きないことを実測）。
export class DatabaseMigration {
  // WHY 終わったら（失敗しても）プールを閉じる: 開いた接続が残ると Node のプロセスが終わらず、ジョブが timeout まで止まる。
  static async run(
    handle: DatabaseHandle,
    migrationsFolder: string,
  ): Promise<void> {
    try {
      await migrate(handle.db, { migrationsFolder });
    } finally {
      await handle.pool.end();
    }
  }
}
