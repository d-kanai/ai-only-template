// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは設定ファイルを文字列として読むだけで DOM を使わないため、
//   node 環境で動かす。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

// 型チェックのゲート（pnpm typecheck と CI の ci ジョブ）が効いていることを、仕様として固定するテスト（Issue #68 の reviewer 指摘）。
// WHY このゲートが要る: monorepo 化（Issue #68）の前は、next build がリポジトリ直下の tsconfig（include が **/*.ts）で、
//   テスト・ルール検査テスト・e2e・設定ファイルまで型チェックしていた。apps/frontend の next build は apps/frontend と、そこから
//   import された backend のファイルしか型チェックしない。backend のテストや rule-tests/architecture.test.ts に型エラーを置いても
//   pnpm build が exit 0 になった（reviewer の実測）。Vitest は型を検査しないので、pnpm test でも止まらない。
//   そのため、リポジトリ直下の tsconfig（全体）と apps/backend の tsconfig（DOM の型なし）の両方を tsc で検査する。
// WHY 両方の tsconfig を検査する: リポジトリ直下の tsconfig はテストや設定ファイルを含めた全体を見るが、lib に dom を含む
//   （frontend のテストのため）。apps/backend の tsconfig は DOM の型を入れないので、backend が document などのブラウザの API を
//   使うと型エラーになる（backend を Next・ブラウザに依存させない方針。.claude/rules/backend.md）。
// 検査するのは package.json の scripts.typecheck と、.github/workflows/ci.yml に pnpm typecheck のステップがあること。

const repoRoot = join(import.meta.dirname, "..");

// pnpm typecheck が検査しなければならない tsconfig（tsc -p に渡すディレクトリ）。
const REQUIRED_PROJECTS = [".", "apps/backend"];

// WHY `&&` 以外のつなぎを含むコマンドは丸ごと拒否する（rule-tests/lint.test.ts の runsBiomeCheckWithErrorOnWarnings と同じ考え方）:
//   `|| true` は失敗を打ち消し、`;` と改行は後ろのコマンドの終了コードになり、`|` はパイプの最後の終了コードになり、
//   末尾の `&` はバックグラウンドにして終了コードを見ない。`&&` は前が失敗すればそこで止まるので、失敗は消えない。
const COMMAND_CHAIN = "&&";
const UNSAFE_CHAIN = /[|;&\n]/;

// `tsc -p <dir> --noEmit`（`pnpm exec tsc ...` も可）なら <dir> を返す。それ以外は undefined。
// WHY --noEmit を必須にする: tsconfig の noEmit を外されても、型チェックのために JS を書き出さない（作業ツリーを汚さない）。
//   CLI で明示しておけば、tsconfig の書き換えに関係なく同じ動きになる。
// WHY -p / --project の値を 1 つだけ取る: tsc は -p に 1 つのプロジェクトしか取らない。2 つ目は別のコマンドにする。
// WHY 型チェックを緩める書き方を拒否する: --noCheck は型チェックそのものを止める（TypeScript 5.5 以降）。`false` を値に渡す書き方
//   （`--strict false`、`--noImplicitAny=false` など）は tsconfig の厳しさを CLI で打ち消す。今の scripts には無いが、
//   書き換えで黙って効かなくなるのを防ぐ。
function weakensChecking(arg: string): boolean {
  return (
    arg === "--noCheck" ||
    arg.startsWith("--noCheck=") ||
    arg === "false" ||
    arg.endsWith("=false")
  );
}

function typecheckedProject(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/);
  const args =
    words[0] === "pnpm" && words[1] === "exec" ? words.slice(2) : words;
  if (args[0] !== "tsc" || !args.includes("--noEmit")) return undefined;
  if (args.some(weakensChecking)) return undefined;
  const projectFlags = args
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => arg === "-p" || arg === "--project");
  if (projectFlags.length !== 1) return undefined;
  return args[(projectFlags[0]?.index ?? 0) + 1];
}

// script が REQUIRED_PROJECTS のすべてを tsc --noEmit で検査するか。
function typechecksAllProjects(script: string): boolean {
  const segments = script.split(COMMAND_CHAIN);
  if (segments.some((segment) => UNSAFE_CHAIN.test(segment))) return false;
  const projects = segments.map(typecheckedProject);
  return REQUIRED_PROJECTS.every((project) => projects.includes(project));
}

type WorkflowStep = { run: string | undefined; conditional: boolean };

// GitHub Actions のワークフローから steps を順に取り出す（YAML のパーサを足さず、行で読む）。
// 1 ステップは `- ` で始まる行から次の `- ` の行まで。`run:` の値と、失敗を無視する・実行しないことがある書き方
// （continue-on-error / if）の有無を返す。コメント行（`#` で始まる）は読まない。
// 限界: 複数行の run（`run: |`）の中身は読まない（run は "|" になる）。ci.yml のステップはすべて 1 行の run。
function readWorkflowSteps(yaml: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const content = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
    if (trimmed.startsWith("- ")) {
      steps.push({ run: undefined, conditional: false });
    }
    const current = steps.at(-1);
    if (current === undefined) continue;
    const run = /^run:\s*(.*)$/.exec(content);
    if (run) current.run = run[1]?.trim();
    if (/^(continue-on-error|if):/.test(content)) current.conditional = true;
  }
  return steps;
}

// ワークフローに、pnpm typecheck を無条件に実行し、失敗で止まるステップが pnpm build より前にあるか。
// WHY build より前: 型エラーを build（数十秒）より先に、原因の分かるメッセージで止めるため（lint の後、build の前）。
function runsTypecheckBeforeBuild(yaml: string): boolean {
  const steps = readWorkflowSteps(yaml);
  const typecheck = steps.findIndex(
    (step) => step.run === "pnpm typecheck" && !step.conditional,
  );
  const build = steps.findIndex((step) => step.run === "pnpm build");
  return typecheck !== -1 && (build === -1 || typecheck < build);
}

describe("typecheck の判定（typechecksAllProjects）", () => {
  it.each([
    ["tsc -p . --noEmit && tsc -p apps/backend --noEmit"],
    ["tsc --noEmit -p apps/backend && tsc --noEmit --project ."],
    ["pnpm exec tsc -p . --noEmit && pnpm exec tsc -p apps/backend --noEmit"],
    ["tsc -p . --noEmit --strict && tsc -p apps/backend --noEmit --pretty"],
  ])("%s は許可する", (script) => {
    expect(typechecksAllProjects(script)).toBe(true);
  });

  it.each([
    ["tsc -p . --noEmit", "apps/backend を検査しない"],
    ["tsc -p apps/backend --noEmit", "リポジトリ直下を検査しない"],
    ["tsc -p . && tsc -p apps/backend --noEmit", "--noEmit が無い"],
    [
      "tsc -p . --noEmit || true && tsc -p apps/backend --noEmit",
      "|| true で失敗を打ち消す",
    ],
    [
      "tsc -p . --noEmit; tsc -p apps/backend --noEmit",
      "; で前の失敗を無視する",
    ],
    [
      "tsc -p . --noEmit && tsc -p apps/backend --noEmit | cat",
      "| で終了コードを変える",
    ],
    [
      "tsc -p . --noEmit --noCheck && tsc -p apps/backend --noEmit",
      "--noCheck で型チェックを止める",
    ],
    [
      "tsc -p . --noEmit --strict false && tsc -p apps/backend --noEmit",
      "--strict を false にする",
    ],
    [
      "tsc -p . --noEmit && tsc -p apps/backend --noEmit --noImplicitAny=false",
      "= で false を渡す",
    ],
    [
      "echo tsc -p . --noEmit && tsc -p apps/backend --noEmit",
      "tsc を実行していない",
    ],
    [
      "tsc -p . -p apps/backend --noEmit",
      "-p が 2 つ（tsc は 1 つしか取らない）",
    ],
    [
      "tsc -p apps/frontend --noEmit && tsc -p apps/backend --noEmit",
      "別の tsconfig",
    ],
    ["", "空文字"],
  ])("%s（%s）は拒否する", (script) => {
    expect(typechecksAllProjects(script)).toBe(false);
  });
});

describe("ワークフローの判定（runsTypecheckBeforeBuild）", () => {
  const workflow = (...steps: string[]) =>
    ["jobs:", "  ci:", "    steps:", ...steps].join("\n");

  it.each([
    [
      "lint → typecheck → build",
      workflow(
        "      - run: pnpm lint",
        "      - run: pnpm typecheck",
        "      - run: pnpm build",
      ),
    ],
    [
      "名前付きのステップ",
      workflow(
        "      - name: Type check",
        "        run: pnpm typecheck",
        "      - run: pnpm build",
      ),
    ],
  ])("%s は許可する", (_name, yaml) => {
    expect(runsTypecheckBeforeBuild(yaml)).toBe(true);
  });

  it.each([
    [
      "typecheck のステップが無い",
      workflow("      - run: pnpm lint", "      - run: pnpm build"),
    ],
    [
      "コメントアウトされている",
      workflow("      # - run: pnpm typecheck", "      - run: pnpm build"),
    ],
    [
      "continue-on-error で失敗を無視する",
      workflow(
        "      - run: pnpm typecheck",
        "        continue-on-error: true",
        "      - run: pnpm build",
      ),
    ],
    [
      "if で実行しないことがある",
      workflow(
        "      - if: false",
        "        run: pnpm typecheck",
        "      - run: pnpm build",
      ),
    ],
    [
      "|| true で失敗を打ち消す",
      workflow(
        "      - run: pnpm typecheck || true",
        "      - run: pnpm build",
      ),
    ],
    [
      "build の後",
      workflow("      - run: pnpm build", "      - run: pnpm typecheck"),
    ],
  ])("%s は拒否する", (_name, yaml) => {
    expect(runsTypecheckBeforeBuild(yaml)).toBe(false);
  });
});

describe("型チェックのゲート（実ファイル）", () => {
  it("package.json の typecheck は、リポジトリ直下と apps/backend の tsconfig を tsc --noEmit で検査する", () => {
    const scripts: Record<string, string | undefined> = pkg.scripts;
    expect(typechecksAllProjects(scripts.typecheck ?? "")).toBe(true);
  });

  it(".github/workflows/ci.yml は pnpm typecheck を pnpm build より前に、失敗で止まる形で実行する", () => {
    const yaml = readFileSync(
      join(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    // 前提: ステップを読み取れていること（読み取りが壊れて 0 件になり、判定が素通りするのを防ぐ）。
    expect(readWorkflowSteps(yaml).length).toBeGreaterThan(5);
    expect(runsTypecheckBeforeBuild(yaml)).toBe(true);
  });
});
