import { type RunnerTestCase, TestRunner } from "vitest";

// API 網羅率（Issue #281。.claude/rules/quality/testing.md の「API 網羅率」）の記録の側。API ジャーニーの handler を track で包むと、
//   handler を呼んだテスト（vitest-cucumber の step 1 つ = Vitest の test 1 つ）の meta.apiCalls に Api のクラス名が残る。
//   集計と判定は Vitest の reporter（api-coverage-reporter.ts）が、実行の終わりに全テストの meta を読んで行う。
// WHY テストの meta に載せる: Vitest はテストファイルを別の worker で動かすので、モジュールの変数は reporter（Vitest の本体の
//   プロセス）から読めない。meta は Vitest がテストの結果と一緒に本体へ送り、reporter が TestCase.meta() で読める
//   （Vitest 5.0.1 で実測、2026-10-02 の work-logs）。ファイルや環境変数を介さないので、後始末も process.env の例外も要らない
//   （process.env は apps/shared/env.ts だけが読む。.claude/rules/tooling/env.md）。
// WHY クラス名で記録する: 全 API の一覧（reporter）は route.ts の re-export から、本番の api ファイルの `export const <METHOD> = new
//   <クラス名>(` をたどってクラス名に結ぶ。ジャーニーは本番と同じクラスを db だけ変えて組み立てるので、クラス名が両方をつなぐ
//   唯一の共通の名前になる（handler の変数名や要求のパスは、ジャーニーが自由に書けて本番と結べない）。
declare module "vitest" {
  interface TaskMeta {
    // 呼ばれた Api のクラス名（重複なし。呼ばれた順）。
    apiCalls?: string[];
  }
}

type Handler<A extends unknown[]> = (...args: A) => Promise<Response>;

export class ApiCoverage {
  // Api の handle を包み、呼ばれたら記録してから本物の handle に渡す。
  // WHY 呼んだときに記録する（track したときではない）: 組み立てただけで呼ばない API を網羅に数えない。
  // currentTest は記録の先（今のテスト）。テストの外の呼び出しを確かめるテストだけが差し替える。
  // WHY 差し替えの口を置く: テストの外の呼び出しは beforeAll で作れるが、beforeAll の中で確かめた分岐の変異は Stryker で
  //   生き残った（2026-10-02 の実測。Stryker が変異をテストごとに切り替えるためと推定、未確認）。テストの中で「今のテストが無い」を
  //   作れるようにする。
  static track<A extends unknown[]>(
    api: { readonly handle: Handler<A> },
    currentTest: () => RunnerTestCase | undefined = () =>
      TestRunner.getCurrentTest<RunnerTestCase | undefined>(),
  ): Handler<A> {
    const name = api.constructor.name;
    return async (...args: A) => {
      ApiCoverage.record(name, currentTest());
      return api.handle(...args);
    };
  }

  private static record(name: string, test: RunnerTestCase | undefined): void {
    // WHY テストの外（beforeAll など）の呼び出しを失敗にする: 記録の先が無いので、黙って捨てると呼んだのに網羅率に数えられず、
    //   原因の分からない 100% 未満になる。
    if (test === undefined) {
      throw new Error(
        `${name} was called outside a test. API coverage records each call on the running test, so call the handler inside a step (test).`,
      );
    }
    const calls = test.meta.apiCalls ?? [];
    if (!calls.includes(name)) {
      test.meta.apiCalls = [...calls, name];
    }
  }
}
