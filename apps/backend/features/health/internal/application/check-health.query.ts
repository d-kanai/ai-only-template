import type { HealthRepository } from "../domain/health-repository";

// ヘルスチェックの報告（Issue #107）。確かめた先ごとの結果で、今は DB だけ。
// unavailable のときは、問い合わせが失敗した原因（ping が投げた値）を cause に載せる。
// WHY 原因を報告に載せる: ログに出すのは presentation（GetHealthApi）。application は logger を使えない
//   （rule-tests/architecture.test.ts の SHARED_MODULES_BY_LAYER: apps/shared/logger は presentation・infra だけ）。
// WHY cause を unknown にする: Promise の reject は何でも投げられ、catch で受けた値の型は決まらない。そのまま logger に渡し、
//   形の変換（Error → { type, message }）は logger が行う（apps/shared/log-event.ts の LogFieldMarks.error）。
export type HealthReport =
  | { database: "ok" }
  | { database: "unavailable"; cause: unknown };

// DB に問い合わせられるかを確かめる（query: 読むだけで状態を変えない）。
// WHY DB の不通を例外ではなく報告（unavailable）で返す: ヘルスチェックの役目は「使えない」と伝えることで、DB の不通は想定内の
//   結果（503）。例外のまま投げると、handler を包む ProblemResponse.wrap が想定外の例外（500 の server_error）にする。
// liveness と readiness を分けない（1 本で DB まで見る）理由は presentation/get-health.api.ts の冒頭。
export class CheckHealthQuery {
  constructor(private readonly repository: HealthRepository) {}

  async execute(): Promise<HealthReport> {
    try {
      await this.repository.ping();
      return { database: "ok" };
    } catch (cause) {
      return { database: "unavailable", cause };
    }
  }
}
