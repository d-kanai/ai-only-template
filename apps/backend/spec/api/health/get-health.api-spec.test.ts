// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect, vi } from "vitest";
import type { GetHealthResponse } from "../../../features/health/internal/presentation/get-health.api";
import { TestDatabase } from "../../../test-support/database";
import { GetHealthApiAssembly, HealthSpecRequests } from "./support";

// API 仕様（Issue #107）: get-health.feature の `*` の step を、実 Postgres の上で本番と同じ組み立ての handler（GetHealthApi.handle）を
//   呼んで確かめる。WHY（テストダブルを使わない・`*` を And で定義する）は ../todo/list-todos.api-spec.test.ts の冒頭と同じ。
// WHY 表を空にしない（beforeEach が無い）: ヘルスチェックは表を読まず（select 1）、何も書かない。step は前の step に依存しない。
// WHY マイグレーションを当てない: 表に依存しないことも、当てないまま通ることで確かめる。
// WHY 問い合わせられない保存先を、閉じたプールの db で作る: DB を止めずに、実 DB の部品だけで「問い合わせられない」を作れる
//   （テストダブルを使わない）。本番でも、接続の拒否・プールの枯渇は同じく ping の reject として届く。

let database: TestDatabase;

beforeAll(async () => {
  database = await TestDatabase.create();
});

afterAll(async () => {
  await database.close();
});

const feature = await loadFeature("./get-health.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("レスポンス", ({ And }) => {
    And("保存先に問い合わせられれば、使えると返る", async () => {
      // given
      const handler = GetHealthApiAssembly.handler(database.db);

      // when
      const response = await handler(HealthSpecRequests.get());

      // then
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        status: "ok",
        checks: { database: "ok" },
      } satisfies GetHealthResponse);
    });

    And("確かめた結果は、途中に残さないよう伝えられる", async () => {
      // given
      const handler = GetHealthApiAssembly.handler(database.db);

      // when
      const response = await handler(HealthSpecRequests.get());

      // then
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });

  Scenario("異常系", ({ And }) => {
    // 原因 = node-postgres の例外（health-repository.postgres.ts が drizzle の包みを外したもの）。ログの 1 行（health_check_failed。
    //   ERROR なので console.error）に type と message が入る。
    // WHY console.error を差し替える: 行を確かめ、テストの出力を汚さない（rule-tests/api-spec.test.ts の api-spec-no-vi の例外。
    //   後始末は mockRestore）。
    And(
      "保存先に問い合わせられないときは、使えないと返り、原因が記録に残る",
      async () => {
        // given
        const closed = await TestDatabase.create();
        await closed.close();
        const handler = GetHealthApiAssembly.handler(closed.db);
        const consoleError = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);

        // when
        const response = await handler(HealthSpecRequests.get());

        // then
        const lines = consoleError.mock.calls.map(([line]) =>
          JSON.parse(line as string),
        );
        consoleError.mockRestore();
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toStrictEqual({
          status: "unavailable",
          checks: { database: "unavailable" },
        } satisfies GetHealthResponse);
        expect(lines).toStrictEqual([
          {
            severity: "ERROR",
            time: expect.any(String),
            message: "health check failed: database unavailable",
            event: { name: "health_check_failed" },
            error: {
              type: "Error",
              message: "Cannot use a pool after calling end on the pool",
            },
          },
        ]);
      },
    );
  });
});
