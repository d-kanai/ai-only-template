// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは子プロセスを起動するだけで DOM を使わないため、
//   jsdom の初期化を省き、ブラウザ相当の globals が Node の API と混ざる余地をなくすため node 環境で動かす。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pkg from "./package.json";

// Biome と Lefthook の導入（rules/code/lint.md）を仕様として固定するテスト。
// 設定ファイルの中身を文字列で照合するのではなく、実際に biome / lefthook を起動して「違反が検出されること」を確かめる。
// 設定を壊した（例: linter を無効にした、pre-commit から biome を消した）ときにテストで気づけるようにするため。

const repoRoot = import.meta.dirname;

// WHY: Biome の recommended には既定 severity が warn / info のルールが多く（noUnusedVariables は warn、useTemplate は info）、
//   biome check は error がなければ終了コード 0 になる。warn は放置されるため、`--error-on-warnings` で warn でも失敗させる
//   （info は biome.json 側で error に上げている）。pnpm lint / pnpm check / pre-commit と同じ引数で検査するため定数にしている。
const ERROR_ON_WARNINGS = "--error-on-warnings";

function pnpmExec(command: string, args: string[]) {
  // WHY: `pnpm exec` 経由にするのは、開発者やフックと同じ経路（package.json で固定した版の node_modules/.bin）で起動するため。
  //   cwd をリポジトリ直下にして、リポジトリの biome.json / lefthook.yml が読まれるようにする。
  return spawnSync("pnpm", ["exec", command, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("biome check（pnpm lint と同じ引数）", () => {
  let dir: string;

  beforeAll(() => {
    // WHY: 違反ファイルをリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残り、
    //   `pnpm lint` や git の差分を汚す。OS の一時ディレクトリに置いて afterAll で消す。
    //   リポジトリ外のファイルでも、cwd（リポジトリ直下）の biome.json が適用されることを確認済み。
    dir = mkdtempSync(join(tmpdir(), "lint-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkSource(fileName: string, lines: string[]) {
    const file = join(dir, fileName);
    writeFileSync(file, [...lines, ""].join("\n"));
    const result = pnpmExec("biome", ["check", ERROR_ON_WARNINGS, file]);
    return { status: result.status, output: result.stdout + result.stderr };
  }

  it("未使用変数と == を含むファイルは非 0 で終わり、ルール名が出力される", () => {
    const { status, output } = checkSource("violation.ts", [
      "export function isAnswer(value: number): boolean {",
      "  const unused = 1;",
      "  return value == 42;",
      "}",
    ]);

    expect(status, output).not.toBe(0);
    expect(output).toContain("noUnusedVariables");
    expect(output).toContain("noDoubleEquals");
  });

  // severity の方針（すべて error 扱い）を、既定 severity ごとの代表ルールで確かめる。
  // 1 ファイル 1 違反にして、他のルールの error に引きずられて非 0 になっているのではないことを保証する。
  it.each([
    [
      "既定 severity が warn の recommended ルール",
      "noUnusedVariables",
      [
        "export function answer(): number {",
        "  const unused = 1;",
        "  return 42;",
        "}",
      ],
    ],
    [
      "既定 severity が info の recommended ルール",
      "useTemplate",
      [
        "export function greet(name: string): string {",
        '  return "Hello, " + name;',
        "}",
      ],
    ],
    [
      "recommended 外で追加したルール",
      "noConsole",
      [
        "export function debug(value: number): void {",
        "  console.log(value);",
        "}",
      ],
    ],
  ])("%s（%s）の違反だけでも非 0 で終わる", (_kind, rule, lines) => {
    const { status, output } = checkSource(`${rule}.ts`, lines);

    expect(status, output).not.toBe(0);
    expect(output).toContain(rule);
  });

  // style/noProcessEnv（Issue #59）: process.env を読んでよいのは backend/shared/infra/env.ts とテストだけ
  //   （rules/code/env.md の「環境変数」）。既定 severity が info なので、biome.json で error にしている。
  // WHY 一時ディレクトリに置いたファイルで must-reject を確かめる: overrides の includes はリポジトリ直下からの相対パスで
  //   照合され、リポジトリの外のファイルは env.ts と同じ名前（.../backend/shared/infra/env.ts）でも一致しない（2026-09-28 実測）。
  //   そのため「env.ts という名前なら何でも許す」ような緩い overrides になっていないことも、同じ仕組みで確かめられる。
  it.each([
    ["env.ts 以外のファイル", "config.ts"],
    [
      "リポジトリの外にある env.ts という名前のファイル（overrides はパスで照合する）",
      "env.ts",
    ],
    ["E2E の spec（テストの overrides の対象外）", "todo.spec.ts"],
  ])(
    "%s で process.env を読むと非 0 で終わり、noProcessEnv が出力される",
    (_kind, fileName) => {
      const { status, output } = checkSource(fileName, [
        "export const url = process.env.DATABASE_URL;",
      ]);

      expect(status, output).not.toBe(0);
      expect(output).toContain("noProcessEnv");
    },
  );

  it.each([["x.test.ts"], ["x.test.tsx"]])(
    "テスト（%s）では process.env を読んでも 0 で終わる（子プロセスに PATH を渡すなどで使う）",
    (fileName) => {
      const { status, output } = checkSource(fileName, [
        "export const path = process.env.PATH;",
      ]);

      expect(status, output).toBe(0);
    },
  );

  it("backend/shared/infra/env.ts は process.env を読んでいても 0 で終わる（環境変数の唯一の入口）", () => {
    const envModule = "backend/shared/infra/env.ts";
    // 前提: env.ts が実際に process.env を読んでいること（読んでいなければ、この検査は何も確かめていない）。
    expect(readFileSync(join(repoRoot, envModule), "utf8")).toContain(
      "process.env",
    );

    const result = pnpmExec("biome", ["check", ERROR_ON_WARNINGS, envModule]);

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("違反のないファイルは 0 で終わる", () => {
    const { status, output } = checkSource("clean.ts", [
      "export function isAnswer(value: number): boolean {",
      "  return value === 42;",
      "}",
    ]);

    expect(status, output).toBe(0);
  });
});

describe("package.json scripts", () => {
  it.each([
    ["lint", pkg.scripts.lint],
    ["check", pkg.scripts.check],
  ])(
    "%s は --error-on-warnings 付きで biome check を実行する",
    (_name, script) => {
      expect(script).toContain("biome check");
      expect(script).toContain(ERROR_ON_WARNINGS);
    },
  );
});

describe("lefthook.yml", () => {
  it("pre-commit で --error-on-warnings 付きの biome check を実行するコマンドが定義されている", () => {
    // WHY: YAML を自前でパースせず `lefthook dump` を使うのは、Lefthook 自身が解釈した結果
    //   （インデント崩れなどで意図と違う構造になっていないか）を検査するため。
    const result = pnpmExec("lefthook", ["dump", "--format", "json"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const config = JSON.parse(result.stdout) as {
      "pre-commit"?: { commands?: Record<string, { run?: string }> };
    };
    const runs = Object.values(config["pre-commit"]?.commands ?? {}).map(
      (command) => command.run ?? "",
    );
    expect(
      runs.filter(
        (run) => run.includes("biome check") && run.includes(ERROR_ON_WARNINGS),
      ),
    ).toHaveLength(1);
  });
});
