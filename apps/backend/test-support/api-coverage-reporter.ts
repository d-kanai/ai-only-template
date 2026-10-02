import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { TaskMeta } from "vitest";

// API 網羅率（Issue #281。.claude/rules/testing.md の「API 網羅率」）の集計と判定の側。vitest.config.mts の reporters が
//   このファイル（default export の ApiCoverageReporter）を読み、Vitest の本体のプロセスで実行の終わりに呼ぶ。
// API 網羅率 = API ジャーニーの実行で 1 回以上呼ばれた API の数 / 全 API の数。100% 未満なら終了コードを 1 にする（CI の
//   ci ジョブの pnpm test が失敗する）。
// WHY（daiki の指示 2026-10-02）: API は必ずどこかの業務の流れ（ジャーニー）に現れるはず。流れに出てこない API は、業務で
//   使われ方が確かめられていないか、要らない API なので、機械的に見つける。
// WHY 全 API を route.ts から数える: 利用者から呼べる API は Next のルーティング（apps/frontend_customer/app/api/**/route.ts）が
//   公開するものだけで、route.ts は backend の api ファイルの re-export だけを置く（.claude/rules/frontend.md）。*.api.ts から
//   数えると、ルーティングにつながっていない Api も分母に入る。
// WHY reporter にする（テストにしない）: 網羅率は全ジャーニーを実行した後でないと決まらず、テストファイルは別々の worker で
//   並行して動く。reporter の onTestRunEnd は全テストの後に 1 回、全テストの結果（meta を含む）を受け取る。

// HTTP のメソッド（Next の Route Handler が受け付ける名前）。route.ts のほかの名前（設定の export など）は API に数えない。
const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const ROUTES_DIR = "apps/frontend_customer/app";
const API_ROUTES_DIR = `${ROUTES_DIR}/api`;
const JOURNEY_DIR = "apps/backend/spec/journey";
const JOURNEY_FILE = /\.api-journey\.test\.ts$/;
const BACKEND_SPECIFIER = "@repo/backend/";
const BACKEND_DIR = "apps/backend/";

export type ApiEndpoint = {
  method: string;
  // Next のルーティングのパス。動的セグメント [id] は :id で書く。
  path: string;
  // 本番の api ファイルが export する handler の Api のクラス名（ApiCoverage.track が記録する名前と同じ）。
  api: string;
};

export class ApiEndpoints {
  // 全 API を、パス・メソッドの順に並べて返す。
  // WHY 読めない形を例外にする（黙って飛ばさない）: 飛ばした API は分母から漏れ、呼ばれていなくても 100% になる。
  static list(root: string): ApiEndpoint[] {
    const routeFiles = ApiEndpoints.routeFiles(join(root, API_ROUTES_DIR));
    if (routeFiles.length === 0) {
      throw new Error(
        `${join(root, API_ROUTES_DIR)} has no route.ts (API coverage would have no APIs to count).`,
      );
    }
    const endpoints = routeFiles
      .flatMap((file) => ApiEndpoints.fromRoute(root, file))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      );
    ApiEndpoints.assertDistinctApis(endpoints);
    return endpoints;
  }

  // WHY 同じ Api のクラスを指す API を例外にする: 判定はクラス名で行うので、2 つの API が同じクラスを指すと、片方を呼ぶだけで
  //   両方が ✓ になる（reviewer の実測、Issue #281）。別の feature に同じ名前のクラスがある場合も同じ。
  private static assertDistinctApis(endpoints: readonly ApiEndpoint[]): void {
    const seen = new Map<string, ApiEndpoint>();
    for (const endpoint of endpoints) {
      const first = seen.get(endpoint.api);
      if (first !== undefined) {
        throw new Error(
          `${first.method} ${first.path} and ${endpoint.method} ${endpoint.path} both use ${endpoint.api} (API coverage tells APIs apart by their Api class).`,
        );
      }
      seen.set(endpoint.api, endpoint);
    }
  }

  private static routeFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry: Dirent) => entry.isFile() && entry.name === "route.ts")
      .map((entry: Dirent) => join(entry.parentPath, entry.name));
  }

  private static fromRoute(root: string, file: string): ApiEndpoint[] {
    const label = relative(root, file).split(sep).join("/");
    // 行コメントを除く（route.ts はファイル冒頭に WHY のコメントを書く）。
    const source = readFileSync(file, "utf8").replace(/\/\/.*/g, "");
    const reExport = /export\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
    // WHY re-export とコメント以外が残れば例外にする: route.ts は backend の api ファイルの re-export だけを置く
    //   （.claude/rules/frontend.md）。Route Handler を直接書いた route.ts は Api のクラスにたどれない。
    if (source.replace(reExport, "").replace(/[\s;]/g, "") !== "") {
      throw new Error(
        `${label}: has code other than export { <METHOD> } from "@repo/backend/..." (API coverage cannot count its APIs).`,
      );
    }
    const path = ApiEndpoints.routePath(root, file);
    return [...source.matchAll(reExport)].flatMap(([, names, specifier]) =>
      ApiEndpoints.exportedNames(label, names as string).map((method) => ({
        method,
        path,
        api: ApiEndpoints.apiClass(root, label, method, specifier as string),
      })),
    );
  }

  // re-export の名前の一覧（`GET, POST`）を、HTTP のメソッドの名前の一覧にする。
  // WHY HTTP のメソッドでない名前を例外にする: Route Handler でない export（ルートの設定など）を API として数えず、黙って
  //   飛ばしもしない（route.ts に何を置いたかを網羅率の側で決めない）。別名（`POST as PATCH`）もメソッドの名前でないので例外に
  //   なる（今は使っていない。route.ts は api ファイルの GET / POST などをそのまま re-export する）。
  private static exportedNames(label: string, names: string): string[] {
    return names
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .map((name) => {
        if (!HTTP_METHODS.has(name)) {
          throw new Error(
            `${label}: exports ${name}, which is not an HTTP method (API coverage counts only Route Handlers).`,
          );
        }
        return name;
      });
  }

  // route.ts のディレクトリを Next のパスにする。動的セグメント [id] は :id にする。
  // 限界: ルートグループ（(admin)）・catch-all（[...slug]）は Next のパスに直さず、ディレクトリ名のまま出す（今は無い。表示だけで、
  //   網羅の判定は Api のクラス名で行うので結果は変わらない）。
  private static routePath(root: string, file: string): string {
    const dir = relative(join(root, ROUTES_DIR), dirname(file));
    return `/${dir
      .split(sep)
      .join("/")
      .replace(/\[([^\]]+)\]/g, ":$1")}`;
  }

  // re-export の参照先の api ファイルで、`export const <名前> = new <クラス名>(` のクラス名を読む。
  private static apiClass(
    root: string,
    label: string,
    method: string,
    specifier: string,
  ): string {
    if (!specifier.startsWith(BACKEND_SPECIFIER)) {
      throw new Error(
        `${label}: ${method} re-exports "${specifier}", which is outside @repo/backend/ (API coverage cannot resolve its Api class).`,
      );
    }
    // WHY パッケージの exports を読まずに直す: apps/backend/package.json の exports は "./x" → "./x.ts" の対応だけ
    //   （rule-tests/architecture.test.ts の BACKEND_EXPORTS が検査する）。
    const apiFile = `${BACKEND_DIR}${specifier.slice(BACKEND_SPECIFIER.length)}.ts`;
    // WHY 文字コードを渡さず String で文字列にする: RegExp#exec は Buffer も文字列にして読むので、"utf8" を渡すと
    //   その引数を消す変異（Stryker）が等価になり、殺せない。
    const source = String(readFileSync(join(root, apiFile)));
    const match = new RegExp(
      `export\\s+const\\s+${method}\\s*=\\s*new\\s+(\\w+)\\s*\\(`,
    ).exec(source);
    if (match === null) {
      throw new Error(
        `${label}: ${method} re-exports ${apiFile}, which has no export const ${method} = new <ClassName>( (API coverage cannot resolve its Api class).`,
      );
    }
    return match[1] as string;
  }
}

// reporter が受け取る Vitest の TestModule のうち、判定に使う部分。
// WHY 型を絞る: テストが偽物の結果を渡して、実行全体を回さずに判定を確かめられる。
export type ApiCoverageModule = {
  readonly moduleId: string;
  readonly children: {
    allTests(): Iterable<{ meta(): TaskMeta }>;
  };
};

export type ApiCoverageVerdict = { passed: boolean; lines: string[] };

export class ApiCoverageGate {
  // 判定しない実行（一部のジャーニーだけ・名前で絞った）なら undefined を返す。
  // WHY 一部の実行では判定しない: 1 つのファイルだけの実行（vitest run x.test.ts）や -t の実行で、呼び出しが足りずに落ちると
  //   手元の速い確認ができない。判定は全体の実行（pnpm test・CI）に任せる。
  static evaluate(
    root: string,
    modules: readonly ApiCoverageModule[],
    filteredByName: boolean,
  ): ApiCoverageVerdict | undefined {
    const journeyFiles = ApiCoverageGate.journeyFiles(root);
    // WHY ジャーニーが無いときは落とす: 測れないまま判定を飛ばすと、ジャーニーを消すだけでゲートが外れる。
    if (journeyFiles.length === 0) {
      return {
        passed: false,
        lines: [
          `${join(root, JOURNEY_DIR)} has no *.api-journey.test.ts (API coverage cannot be measured).`,
        ],
      };
    }
    const journeyModules = modules.filter((module) =>
      journeyFiles.includes(module.moduleId),
    );
    if (filteredByName || journeyModules.length < journeyFiles.length) {
      return undefined;
    }
    // WHY ?? [] で埋めない: API を呼ばないテスト（Then の step など）の undefined が集合に入っても、Api のクラス名とは
    //   一致しないので結果は同じ（埋める値を変える変異が等価になるので書かない）。
    const called = new Set<string | undefined>(
      journeyModules.flatMap((module) =>
        [...module.children.allTests()].flatMap((test) => test.meta().apiCalls),
      ),
    );
    const endpoints = ApiEndpoints.list(root);
    const covered = endpoints.filter((endpoint) => called.has(endpoint.api));
    const passed = covered.length === endpoints.length;
    const rate = ((covered.length / endpoints.length) * 100).toFixed(1);
    return {
      passed,
      lines: [
        `API coverage (API journeys): ${covered.length}/${endpoints.length} (${rate}%)`,
        ...endpoints.map(
          (endpoint) =>
            `  ${called.has(endpoint.api) ? "✓" : "✗"} ${endpoint.method} ${endpoint.path} (${endpoint.api})`,
        ),
        ...(passed
          ? []
          : [
              "Some APIs are never called by any API journey (✗). Add the business flow that uses them to a journey (below 100% fails the run. Issue #281).",
            ]),
      ],
    };
  }

  private static journeyFiles(root: string): string[] {
    return readdirSync(join(root, JOURNEY_DIR))
      .filter((name) => JOURNEY_FILE.test(name))
      .map((name) => join(root, JOURNEY_DIR, name));
  }
}

// reporter が使う Vitest の部分（onInit の引数）。
type ReporterContext = {
  readonly config: { readonly root: string; readonly testNamePattern?: RegExp };
  readonly logger: {
    log(line: string): void;
    error(line: string): void;
  };
};

// Vitest の reporter（vitest.config.mts の reporters）。Vitest は reporter を default export のクラスとして読む。
export default class ApiCoverageReporter {
  private context: ReporterContext | undefined;

  onInit(context: ReporterContext): void {
    this.context = context;
  }

  onTestRunEnd(modules: readonly ApiCoverageModule[]): void {
    const context = this.context as ReporterContext;
    const verdict = ApiCoverageGate.evaluate(
      context.config.root,
      modules,
      context.config.testNamePattern !== undefined,
    );
    if (verdict === undefined) {
      return;
    }
    const write = verdict.passed
      ? (line: string) => context.logger.log(line)
      : (line: string) => context.logger.error(line);
    for (const line of verdict.lines) {
      write(line);
    }
    if (verdict.passed) {
      return;
    }
    // WHY process.exitCode にする（例外にしない）: Vitest の CLI は失敗したテストがあると exitCode を 1 にし、無ければ触らない
    //   （Vitest 5.0.1 で、全テストが通った実行で reporter が 1 にすると終了コードが 1 になることを実測。2026-10-02 の work-logs）。
    process.exitCode = 1;
  }
}
