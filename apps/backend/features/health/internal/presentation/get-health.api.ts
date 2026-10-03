import { logger } from "@repo/shared/logger";
import { AppDatabase } from "../../../../shared/drizzle/database";
import { ProblemResponse } from "../../../../shared/http/problem";
import {
  CheckHealthQuery,
  type HealthReport,
} from "../application/check-health.query";
import { PostgresHealthRepository } from "../infra/health-repository.postgres";

// GET /api/health: ヘルスチェック（Issue #107）。アプリが応答でき、DB に問い合わせられるかを返す。
//   200: { status: "ok", checks: { database: "ok" } }
//   503: { status: "unavailable", checks: { database: "unavailable" } }（DB に問い合わせられないとき。原因はログにだけ残す）
// 認証の対象外（今はアプリに認証そのものが無い）。
// WHY liveness と readiness を分けない（1 本で DB まで見る）: 今 Cloud Run のアプリ（infra/modules/app/run.tf）にはプローブが無く、
//   使うのは外からの監視（DB まで含めて使えるかを知りたい）だけ。将来 Cloud Run の liveness probe に使うなら、DB を含まない口を
//   別に足す（liveness に DB を含めると、DB の障害で全インスタンスが再起動される）。決定と採用しなかった案は ADR
//   docs/adr/architecture/20261003-health-check-and-shutdown.md。

// WHY DTO をこのファイルで定義する: list-todos.api.ts と同じ（1 API = 1 ファイルで、その API の契約を同じファイルで読める）。
export type GetHealthResponse = {
  // 全体の結果。checks のどれか 1 つでも unavailable なら unavailable。
  status: "ok" | "unavailable";
  // 確かめた先ごとの結果。今は DB だけ。
  checks: { database: "ok" | "unavailable" };
};

// GET /api/health の Route Handler を持つクラス。形（コンストラクタで query を受け取る・handle をアロー関数のプロパティにして
//   ProblemResponse.wrap で包む・型を Pick<..., "execute"> にする）と WHY は list-todos.api.ts の ListTodosApi と同じ。
export class GetHealthApi {
  constructor(
    private readonly checkHealth: Pick<CheckHealthQuery, "execute">,
  ) {}

  // WHY ProblemResponse.wrap で包む: DB の不通は query が報告（unavailable）で返すので、ここに例外は来ない。それ以外の想定外の
  //   例外（実装の誤り）は、ほかの API と同じく 500 の Problem Details とログ（server_error）にする（規則
  //   presentation-with-problem-response）。
  readonly handle = ProblemResponse.wrap(
    async (_request: Request): Promise<Response> => {
      const report = await this.checkHealth.execute();
      if (report.database === "unavailable") {
        // WHY ここ（presentation）でログに出す: application は logger を使えない（rule-tests/architecture.test.ts の
        //   SHARED_MODULES_BY_LAYER）。原因は query が報告に載せて渡す。
        // WHY 本文ではなくログに原因を出す: 例外の message は接続先のホスト・ポートなど内部の情報を含みうる。
        logger.emit({
          message: "health check failed: database unavailable",
          event: { name: "health_check_failed" },
          error: report.cause,
        });
      }
      return Response.json(this.toResponse(report), {
        // WHY 503: 監視とロードバランサは 503 を「今は使えない」と読む（RFC 9110 の 15.6.4。一時的な状態で、500 の想定外の誤りと
        //   分ける）。
        status: report.database === "ok" ? 200 : 503,
        // WHY no-store: 監視の結果を途中のキャッシュ（CDN・ブラウザ）に残させない。残ると、DB が落ちた後も前の 200 が返り続ける。
        headers: { "cache-control": "no-store" },
      });
    },
  );

  // WHY 補助を private メソッドにする: list-todos.api.ts の toResponseItem と同じ（Issue #262・#300）。
  private toResponse(report: HealthReport): GetHealthResponse {
    return {
      status: report.database,
      checks: { database: report.database },
    };
  }
}

// app/api/health/route.ts が re-export する Route Handler。本番は常に Postgres で組み立てる。
// WHY ここで組み立てる・AppDatabase.get().db を渡す: list-todos.api.ts の GET と同じ（プールはプロセスで 1 つ）。アプリの API が
//   実際に使うプールに問い合わせるので、プールの枯渇（接続待ちのタイムアウト）も unavailable として見える。
export const GET = new GetHealthApi(
  new CheckHealthQuery(new PostgresHealthRepository(AppDatabase.get().db)),
).handle;
