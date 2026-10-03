// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { HealthRepository } from "../domain/health-repository";
import { CheckHealthQuery } from "./check-health.query";

// WHY InMemory の実装を test-support に置かず、ping の結果を決めたオブジェクトを渡す: HealthRepository は状態を持たず、
//   「問い合わせられる / られない」の 2 通りしかない。list-todos.api.test.ts の failingRepository と同じく、その場で作る。
class Repositories {
  static reachable(): HealthRepository {
    return { ping: () => Promise.resolve() };
  }

  static unreachable(cause: unknown): HealthRepository {
    return { ping: () => Promise.reject(cause) };
  }
}

describe("CheckHealthQuery", () => {
  test("DB に問い合わせられれば、database が ok の報告を返す", async () => {
    // given
    const query = new CheckHealthQuery(Repositories.reachable());

    // when
    const report = await query.execute();

    // then
    expect(report).toStrictEqual({ database: "ok" });
  });

  // WHY 例外を投げずに報告で返す: ヘルスチェックは「使えない」ことを伝えるのが役目で、DB の不通は想定内の結果（503）。投げると
  //   ProblemResponse.wrap が想定外の例外（500 の server_error）にしてしまう。
  // WHY 原因（cause）を同じ値のまま返す: ログに出すのは presentation（application は logger を使えない。
  //   rule-tests/architecture.test.ts の SHARED_MODULES_BY_LAYER）なので、原因を報告に載せて渡す。
  test("DB に問い合わせられなければ、例外を投げずに database が unavailable の報告を、原因の例外と一緒に返す", async () => {
    // given
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const query = new CheckHealthQuery(Repositories.unreachable(cause));

    // when
    const report = await query.execute();

    // then
    expect(report).toStrictEqual({ database: "unavailable", cause });
    expect(report.database === "unavailable" && report.cause).toBe(cause);
  });
});
