import { GetHealthQuery } from "../../../features/health/internal/application/get-health.query";
import { PostgresHealthRepository } from "../../../features/health/internal/infra/health-repository.postgres";
import { GetHealthApi } from "../../../features/health/internal/presentation/get-health.api";
import type { Database } from "../../../shared/drizzle/database";

// ヘルスチェックの API 仕様（spec/api/health/*.api-spec.test.ts。Issue #107）が共有する補助: API の組み立て（<Api>Assembly）と要求
//   （HealthSpecRequests）。形と WHY（spec/api の中に置く・クラスの static メソッド・用途ごとにクラスを分ける・組み立てを Api ごとの
//   クラスにする）は ../todo/support.ts の冒頭と同じ。

// 本番の api ファイルの最下部と同じ組み立て（Postgres の Repository → query → Api）で、渡した db を使う handler を返す。
// WHY db を受け取る: テスト用のスキーマの db（使える保存先）と、閉じたプールの db（問い合わせられない保存先）を step ごとに渡す。
export class GetHealthApiAssembly {
  static handler(db: Database) {
    return new GetHealthApi(
      new GetHealthQuery(new PostgresHealthRepository(db)),
    ).handle;
  }
}

// ヘルスチェックの要求（本文の無い GET）。
export class HealthSpecRequests {
  static get(): Request {
    return new Request("http://localhost/api/health");
  }
}
