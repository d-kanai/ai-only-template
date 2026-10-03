// @vitest-environment node
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Database } from "../../../../shared/drizzle/database";
import { TestDatabase } from "../../../../test-support/database";
import { PostgresHealthRepository } from "./health-repository.postgres";

// 実 Postgres（compose.yaml。`pnpm db:up` で起動）に対して実行する。
// WHY マイグレーションを当てない: ping は表を読まない（select 1）。表の有無に依存しないことも、当てないまま通ることで確かめる。
let database: TestDatabase;

beforeAll(async () => {
  database = await TestDatabase.create();
});

afterAll(async () => {
  await database.close();
});

describe("PostgresHealthRepository.ping", () => {
  test("DB に問い合わせられれば resolve する", async () => {
    // given
    const repository = new PostgresHealthRepository(database.db);

    // when
    const ping = repository.ping();

    // then
    await expect(ping).resolves.toBeUndefined();
  });

  // WHY 閉じたプールで確かめる: 「DB に問い合わせられない」を、DB を止めずに実 DB の部品だけで作れる。ping が例外を握りつぶさずに
  //   reject すること（query が "unavailable" にできること）を固定する。
  // WHY node-postgres の例外そのもの（drizzle の DrizzleQueryError で包まれていないもの）を比べる: 包んだ例外の message は
  //   「Failed query: select 1\nparams: 」で、logger はクエリを抱えた例外の message を *** にする（apps/shared/log-event.ts の
  //   holdsQueryParameters）。包んだまま渡すと、ログの 1 行から原因（接続の拒否・プールの終了など）が読めない。
  //   文言は pg 8.23.0（完全固定）の Pool の message。
  test("接続を閉じたプールでは、node-postgres の例外（原因）で reject する", async () => {
    // given
    const closed = await TestDatabase.create();
    await closed.close();
    const repository = new PostgresHealthRepository(closed.db);

    // when
    const ping = repository.ping();

    // then
    await expect(ping).rejects.toEqual(
      new Error("Cannot use a pool after calling end on the pool"),
    );
  });

  // WHY 問い合わせの口を差し替える: drizzle-orm 0.45.3 の execute は失敗をすべて DrizzleQueryError で包む（pg-core/session.js）ので、
  //   包まれていない例外は実 DB では作れない。ライブラリが包み方を変えたときに、例外を捨てずにそのまま投げることを固定する。
  test("drizzle が包んでいない例外は、そのまま reject する", async () => {
    // given
    const cause = new TypeError("unexpected failure");
    const db = { execute: () => Promise.reject(cause) } as unknown as Database;
    const repository = new PostgresHealthRepository(db);

    // when
    const ping = repository.ping();

    // then
    await expect(ping).rejects.toBe(cause);
  });
});
