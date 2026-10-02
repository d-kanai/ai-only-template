// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TaskMeta } from "vitest";
import { afterAll, describe, expect, test } from "vitest";
import ApiCoverageReporter, {
  ApiCoverageGate,
  type ApiCoverageModule,
  ApiEndpoints,
} from "./api-coverage-reporter";

// リポジトリの直下（このファイルは apps/backend/test-support/ にある）。
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// 一時ディレクトリにリポジトリと同じ置き場所でファイルを置き、その直下を返す。
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "api-coverage-"));
  fixtureRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const API_DIR = "apps/frontend_customer/app/api";
const PRESENTATION = "apps/backend/features/todo/internal/presentation";
const SPECIFIER = "@repo/backend/features/todo/internal/presentation";

// 本番の api ファイルの最下部と同じ形（export const <METHOD> = new <クラス名>(...).handle）。
function apiFile(method: string, className: string): string {
  return `export class ${className} {}\nexport const ${method} = new ${className}(\n  new Query(),\n).handle;\n`;
}

// 2 つの route（静的・動的セグメント）と 3 つの API の、正しい組み合わせ。
function validFiles(): Record<string, string> {
  return {
    [`${API_DIR}/todos/route.ts`]: [
      "// /api/todos の Route Handler。re-export だけにする（export { X } from の形のコメントは数えない）。",
      `export { POST } from "${SPECIFIER}/create-todo.api";`,
      `export { GET } from "${SPECIFIER}/list-todos.api";`,
    ].join("\n"),
    [`${API_DIR}/todos/[id]/title/route.ts`]: `export { PUT } from "${SPECIFIER}/rename-todo.api";\n`,
    [`${PRESENTATION}/create-todo.api.ts`]: apiFile("POST", "CreateTodoApi"),
    [`${PRESENTATION}/list-todos.api.ts`]: apiFile("GET", "ListTodosApi"),
    [`${PRESENTATION}/rename-todo.api.ts`]: apiFile("PUT", "RenameTodoApi"),
    "apps/backend/spec/journey/a.api-journey.test.ts": "",
    "apps/backend/spec/journey/b.api-journey.test.ts": "",
    "apps/backend/spec/journey/a.feature": "",
  };
}

const VALID_ENDPOINTS = [
  { method: "GET", path: "/api/todos", api: "ListTodosApi" },
  { method: "POST", path: "/api/todos", api: "CreateTodoApi" },
  { method: "PUT", path: "/api/todos/:id/title", api: "RenameTodoApi" },
];

// reporter が受け取る TestModule の、使う部分だけを持つ偽物。tests は各テストの meta.apiCalls。
function testModule(
  root: string,
  file: string,
  tests: (string[] | undefined)[],
): ApiCoverageModule {
  return {
    moduleId: join(root, file),
    children: {
      *allTests() {
        for (const apiCalls of tests) {
          const meta: TaskMeta = apiCalls === undefined ? {} : { apiCalls };
          yield { meta: () => meta };
        }
      },
    },
  };
}

// a と b は 2 つのジャーニーの各テストの meta.apiCalls（undefined は API を呼ばないテスト。Then の step など）。
function journeys(
  root: string,
  a: (string[] | undefined)[],
  b: (string[] | undefined)[],
) {
  return [
    testModule(root, "apps/backend/spec/journey/a.api-journey.test.ts", a),
    testModule(root, "apps/backend/spec/journey/b.api-journey.test.ts", b),
  ];
}

describe("ApiEndpoints.list（全 API の一覧。route.ts の re-export から本番の Api のクラスへたどる）", () => {
  test("must pass: route.ts ごとに、export したメソッドとパス（[id] は :id）と Api のクラス名を、パス・メソッドの順に並べて返す", () => {
    // given
    const root = fixture(validFiles());

    // when
    const endpoints = ApiEndpoints.list(root);

    // then
    expect(endpoints).toStrictEqual(VALID_ENDPOINTS);
  });

  test("must pass: 空白の無い書き方・セミコロン無し・複数行・名前の後ろのコメント・末尾のカンマ・複数のコメント行・2 つの動的セグメントも読む", () => {
    // given
    const root = fixture({
      [`${API_DIR}/lists/[listId]/items/[itemId]/route.ts`]: [
        "// 1 行目のコメント",
        `export{GET}from"${SPECIFIER}/get-item.api"`,
        "export {",
        "  PUT, // 名前の変更",
        "  POST,",
        `} from "${SPECIFIER}/items.api";`,
        "// 末尾のコメント",
      ].join("\n"),
      [`${PRESENTATION}/get-item.api.ts`]: apiFile("GET", "GetItemApi"),
      [`${PRESENTATION}/items.api.ts`]: `${apiFile("PUT", "RenameItemApi")}${apiFile("POST", "ChangeItemApi")}`,
    });

    // when
    const endpoints = ApiEndpoints.list(root);

    // then
    const path = "/api/lists/:listId/items/:itemId";
    expect(endpoints).toStrictEqual([
      { method: "GET", path, api: "GetItemApi" },
      { method: "POST", path, api: "ChangeItemApi" },
      { method: "PUT", path, api: "RenameItemApi" },
    ]);
  });

  test("must pass: リポジトリの全 API（6 つ）を返す", () => {
    // given: リポジトリの apps/frontend_customer/app/api/ の route.ts

    // when
    const endpoints = ApiEndpoints.list(REPO_ROOT);

    // then
    expect(endpoints).toStrictEqual([
      { method: "GET", path: "/api/todos", api: "ListTodosApi" },
      { method: "POST", path: "/api/todos", api: "CreateTodoApi" },
      { method: "DELETE", path: "/api/todos/:id", api: "DeleteTodoApi" },
      { method: "GET", path: "/api/todos/:id", api: "GetTodoApi" },
      {
        method: "PUT",
        path: "/api/todos/:id/completion",
        api: "ChangeTodoCompletionApi",
      },
      { method: "PUT", path: "/api/todos/:id/title", api: "RenameTodoApi" },
    ]);
  });

  // WHY 読めない形を失敗にする（黙って飛ばさない）: 飛ばすと、その API が一覧から漏れて網羅率の分母が減り、呼ばれていない API が
  //   あっても 100% になる。
  test("must reject: route.ts が 1 つも無い", () => {
    // given
    const root = fixture({ [`${API_DIR}/README.md`]: "" });

    // when
    const listing = () => ApiEndpoints.list(root);

    // then
    expect(listing).toThrow(
      new Error(
        `${join(root, API_DIR)} has no route.ts (API coverage would have no APIs to count).`,
      ),
    );
  });

  test("must reject: route.ts に re-export でない export（Route Handler を直接書く）がある", () => {
    // given
    const root = fixture({
      ...validFiles(),
      [`${API_DIR}/health/route.ts`]:
        "export async function GET() {\n  return new Response(null);\n}\n",
    });

    // when
    const listing = () => ApiEndpoints.list(root);

    // then
    expect(listing).toThrow(
      new Error(
        `${API_DIR}/health/route.ts: has code other than export { <METHOD> } from "@repo/backend/..." (API coverage cannot count its APIs).`,
      ),
    );
  });

  test("must reject: HTTP のメソッドでない名前を re-export する（別名の as も。ルートの設定など）", () => {
    // given
    const root = fixture({
      ...validFiles(),
      [`${API_DIR}/health/route.ts`]: `export { GET, POST as PATCH } from "${SPECIFIER}/list-todos.api";\n`,
    });

    // when
    const listing = () => ApiEndpoints.list(root);

    // then
    expect(listing).toThrow(
      new Error(
        `${API_DIR}/health/route.ts: exports POST as PATCH, which is not an HTTP method (API coverage counts only Route Handlers).`,
      ),
    );
  });

  test("must reject: re-export の参照先が @repo/backend の外", () => {
    // given
    const root = fixture({
      ...validFiles(),
      [`${API_DIR}/health/route.ts`]: `export { GET } from "./health";\n`,
    });

    // when
    const listing = () => ApiEndpoints.list(root);

    // then
    expect(listing).toThrow(
      new Error(
        `${API_DIR}/health/route.ts: GET re-exports "./health", which is outside @repo/backend/ (API coverage cannot resolve its Api class).`,
      ),
    );
  });

  test("must reject: 参照先の api ファイルに export const <METHOD> = new <クラス名>( が無い", () => {
    // given
    const root = fixture({
      ...validFiles(),
      [`${PRESENTATION}/rename-todo.api.ts`]: "export const PUT = handler;\n",
    });

    // when
    const listing = () => ApiEndpoints.list(root);

    // then
    expect(listing).toThrow(
      new Error(
        `${API_DIR}/todos/[id]/title/route.ts: PUT re-exports ${PRESENTATION}/rename-todo.api.ts, which has no export const PUT = new <ClassName>( (API coverage cannot resolve its Api class).`,
      ),
    );
  });
});

describe("ApiCoverageGate.evaluate（すべての API ジャーニーを含む実行で、全 API が 1 回は呼ばれたか）", () => {
  test("must pass: 全 API が呼ばれていれば 100% で通す（2 つのジャーニーに分かれていても、同じ API を何度呼んでも、API を呼ばないテストがあってもよい）", () => {
    // given
    const root = fixture(validFiles());
    const modules = journeys(
      root,
      [["CreateTodoApi"], undefined, ["ListTodosApi", "CreateTodoApi"]],
      [["RenameTodoApi"]],
    );

    // when
    const verdict = ApiCoverageGate.evaluate(root, modules, false);

    // then
    expect(verdict).toStrictEqual({
      passed: true,
      lines: [
        "API coverage (API journeys): 3/3 (100.0%)",
        "  ✓ GET /api/todos (ListTodosApi)",
        "  ✓ POST /api/todos (CreateTodoApi)",
        "  ✓ PUT /api/todos/:id/title (RenameTodoApi)",
      ],
    });
  });

  test("must reject: 呼ばれていない API が 1 つでもあれば落とし、その API を ✗ で示す", () => {
    // given
    const root = fixture(validFiles());
    const modules = journeys(root, [["CreateTodoApi"], []], [["ListTodosApi"]]);

    // when
    const verdict = ApiCoverageGate.evaluate(root, modules, false);

    // then
    expect(verdict).toStrictEqual({
      passed: false,
      lines: [
        "API coverage (API journeys): 2/3 (66.7%)",
        "  ✓ GET /api/todos (ListTodosApi)",
        "  ✓ POST /api/todos (CreateTodoApi)",
        "  ✗ PUT /api/todos/:id/title (RenameTodoApi)",
        "Some APIs are never called by any API journey (✗). Add the business flow that uses them to a journey (below 100% fails the run. Issue #281).",
      ],
    });
  });

  test("must reject: ジャーニー以外のテスト（単体・API 仕様）の呼び出しは数えない", () => {
    // given
    const root = fixture(validFiles());
    const modules = [
      ...journeys(root, [["CreateTodoApi", "ListTodosApi"]], [[]]),
      testModule(
        root,
        "apps/backend/spec/api/todo/rename-todo.api-spec.test.ts",
        [["RenameTodoApi"]],
      ),
    ];

    // when
    const verdict = ApiCoverageGate.evaluate(root, modules, false);

    // then
    expect(verdict?.passed).toBe(false);
  });

  test("must reject: API ジャーニーが 1 つも無ければ落とす", () => {
    // given
    const files = validFiles();
    delete files["apps/backend/spec/journey/a.api-journey.test.ts"];
    delete files["apps/backend/spec/journey/b.api-journey.test.ts"];
    const root = fixture(files);

    // when
    const verdict = ApiCoverageGate.evaluate(root, [], false);

    // then
    expect(verdict).toStrictEqual({
      passed: false,
      lines: [
        `${join(root, "apps/backend/spec/journey")} has no *.api-journey.test.ts (API coverage cannot be measured).`,
      ],
    });
  });

  // WHY 一部の実行では判定しない: 1 つのファイルだけ・名前で絞った実行（vitest run x.test.ts・-t）でも API の呼び出しが
  //   足りずに落ちると、手元の速い確認ができない。判定は全体の実行（pnpm test・CI）に任せる。
  test("一部のジャーニーだけの実行では判定しない", () => {
    // given
    const root = fixture(validFiles());
    const [onlyA] = journeys(root, [[]], [[]]);

    // when
    const verdict = ApiCoverageGate.evaluate(root, [onlyA], false);

    // then
    expect(verdict).toBeUndefined();
  });

  test("テストの名前で絞った実行（-t）では判定しない", () => {
    // given
    const root = fixture(validFiles());

    // when
    const verdict = ApiCoverageGate.evaluate(
      root,
      journeys(root, [[]], [[]]),
      true,
    );

    // then
    expect(verdict).toBeUndefined();
  });
});

describe("ApiCoverageReporter（Vitest の reporter）", () => {
  // reporter が使う Vitest の部分だけを持つ偽物。logger の出力を集める。
  function vitest(root: string, testNamePattern?: RegExp) {
    const output: { log: string[]; error: string[] } = { log: [], error: [] };
    return {
      output,
      ctx: {
        config: { root, testNamePattern },
        logger: {
          log: (line: string) => output.log.push(line),
          error: (line: string) => output.error.push(line),
        },
      },
    };
  }

  // WHY process.exitCode を戻す: reporter は失敗のときに process.exitCode = 1 にする。戻さないと、このテストのプロセス
  //   （Vitest の worker）が失敗で終わる。
  function withExitCode<T>(run: () => T): { result: T; exitCode: unknown } {
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = run();
      return { result, exitCode: process.exitCode };
    } finally {
      process.exitCode = saved;
    }
  }

  test("100% なら網羅率を出し、終了コードは変えない", () => {
    // given
    const root = fixture(validFiles());
    const { output, ctx } = vitest(root);
    const reporter = new ApiCoverageReporter();
    reporter.onInit(ctx);
    const modules = journeys(
      root,
      [["CreateTodoApi", "ListTodosApi"]],
      [["RenameTodoApi"]],
    );

    // when
    const { exitCode } = withExitCode(() => reporter.onTestRunEnd(modules));

    // then
    expect(exitCode).toBeUndefined();
    expect(output.log).toStrictEqual(
      ApiCoverageGate.evaluate(root, modules, false)?.lines,
    );
    expect(output.log[0]).toBe("API coverage (API journeys): 3/3 (100.0%)");
    expect(output.error).toStrictEqual([]);
  });

  test("100% 未満なら網羅率をエラーとして出し、終了コードを 1 にする（pnpm test・CI が失敗する）", () => {
    // given
    const root = fixture(validFiles());
    const { output, ctx } = vitest(root);
    const reporter = new ApiCoverageReporter();
    reporter.onInit(ctx);
    const modules = journeys(root, [["CreateTodoApi"]], [[]]);

    // when
    const { exitCode } = withExitCode(() => reporter.onTestRunEnd(modules));

    // then
    expect(exitCode).toBe(1);
    expect(output.log).toStrictEqual([]);
    expect(output.error).toStrictEqual(
      ApiCoverageGate.evaluate(root, modules, false)?.lines,
    );
    expect(output.error[0]).toBe("API coverage (API journeys): 1/3 (33.3%)");
  });

  test("判定しない実行（-t で絞った）では何も出さず、終了コードも変えない", () => {
    // given
    const root = fixture(validFiles());
    const { output, ctx } = vitest(root, /x/);
    const reporter = new ApiCoverageReporter();
    reporter.onInit(ctx);

    // when
    const { exitCode } = withExitCode(() =>
      reporter.onTestRunEnd(journeys(root, [[]], [[]])),
    );

    // then
    expect(exitCode).toBeUndefined();
    expect(output).toStrictEqual({ log: [], error: [] });
  });
});

describe("vitest.config.mts の結線", () => {
  // WHY 設定を検査する: reporters からこの reporter が外れると、網羅率が下がっても pnpm test（CI）は緑のまま、何も出さなくなる。
  //   判定のテストはすべて通り続けるので、結線は設定のソースで固定する。
  test("reporters は Vitest の既定の reporter に、このファイルの reporter を足したものになっている", () => {
    // given
    const config = readFileSync(join(REPO_ROOT, "vitest.config.mts"), "utf8");

    // when
    const reporters = /\breporters:\s*\[([^\]]*)\]/.exec(config)?.[1];

    // then
    expect(
      reporters
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ).toStrictEqual([
      "...configDefaults.reporters",
      '"./apps/backend/test-support/api-coverage-reporter.ts"',
    ]);
  });
});
