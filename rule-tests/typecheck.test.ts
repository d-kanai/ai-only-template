// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは設定ファイルを文字列として読むだけで DOM を使わないため、
//   node 環境で動かす。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import pkg from "../package.json";
import { casesByName } from "./case-table";

// 型チェックのゲート（pnpm typecheck と CI の ci ジョブ）が効いていることを、仕様として固定するテスト（Issue #68 の reviewer 指摘）。
// WHY このゲートが要る: monorepo 化（Issue #68）の前は、next build がリポジトリ直下の tsconfig（include が **/*.ts）で、
//   テスト・ルール検査テスト・e2e・設定ファイルまで型チェックしていた。apps/frontend_customer の next build は apps/frontend_customer と、そこから
//   import された backend のファイルしか型チェックしない。backend のテストや rule-tests/architecture.test.ts に型エラーを置いても
//   pnpm build が exit 0 になった（reviewer の実測）。Vitest は型を検査しないので、pnpm test でも止まらない。
//   そのため、リポジトリ直下の tsconfig（全体）と apps/backend・apps/shared の tsconfig（DOM の型なし）を tsc で検査する。
// WHY 両方の tsconfig を検査する: リポジトリ直下の tsconfig はテストや設定ファイルを含めた全体を見るが、lib に dom を含む
//   （frontend のテストのため）。apps/backend の tsconfig は DOM の型を入れないので、backend が document などのブラウザの API を
//   使うと型エラーになる（backend を Next・ブラウザに依存させない方針。.claude/rules/code/backend.md）。
// 検査するのは package.json の scripts.typecheck と、.github/workflows/ci.yml に pnpm typecheck のステップがあること。
// .feature（typecheck.feature）と step の実装（このファイル）に分けた（Issue #282）。

const repoRoot = join(import.meta.dirname, "..");

// pnpm typecheck が検査しなければならない tsconfig（tsc -p に渡すディレクトリ）。
// WHY apps/shared も（Issue #90）: apps/shared の tsconfig も DOM の型を入れない（env・logger はサーバ側の基盤で、ブラウザの API を
//   使うと型エラーにする）。backend が import する env.ts・logger.ts は apps/backend の tsconfig でも検査されるが、apps/shared の
//   テスト（env.test.ts・logger.test.ts）と、backend が import しないファイルは apps/shared の tsconfig でしか DOM なしで検査されない。
const REQUIRED_PROJECTS = [".", "apps/backend", "apps/shared"];

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

const SHARED = "tsc -p apps/shared --noEmit";
const workflow = (...steps: string[]) =>
  ["jobs:", "  ci:", "    steps:", ...steps].join("\n");

const feature = await loadFeature("./typecheck.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("typecheck の判定（typechecksAllProjects）", ({ And }) => {
    // 3 つの tsconfig（リポジトリ直下・apps/backend・apps/shared）をどの順で書いてもよい。
    And(
      "3 つの tsconfig を tsc --noEmit で検査するスクリプトは許可する（順不同・--project・pnpm exec・ほかのフラグ）",
      () => {
        // given
        const cases: [string][] = [
          [`tsc -p . --noEmit && tsc -p apps/backend --noEmit && ${SHARED}`],
          [
            `tsc --noEmit -p apps/backend && ${SHARED} && tsc --noEmit --project .`,
          ],
          [
            "pnpm exec tsc -p . --noEmit && pnpm exec tsc -p apps/backend --noEmit && pnpm exec tsc -p apps/shared --noEmit",
          ],
          [
            `tsc -p . --noEmit --strict && tsc -p apps/backend --noEmit --pretty && ${SHARED}`,
          ],
        ];

        // when
        const result = casesByName(cases, ([script]) =>
          typechecksAllProjects(script),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    And(
      "検査しない tsconfig がある・失敗を打ち消す・型チェックを弱めるスクリプトは拒否する（apps/backend・直下・apps/shared が無い・--noEmit が無い・|| true・;・|・--noCheck・false を渡す・tsc でない・-p が 2 つ・別の tsconfig・空文字）",
      () => {
        // given
        const cases: [string, string][] = [
          [`tsc -p . --noEmit && ${SHARED}`, "apps/backend を検査しない"],
          [
            `tsc -p apps/backend --noEmit && ${SHARED}`,
            "リポジトリ直下を検査しない",
          ],
          [
            "tsc -p . --noEmit && tsc -p apps/backend --noEmit",
            "apps/shared を検査しない（Issue #90）",
          ],
          [
            `tsc -p . && tsc -p apps/backend --noEmit && ${SHARED}`,
            "--noEmit が無い",
          ],
          [
            `tsc -p . --noEmit || true && tsc -p apps/backend --noEmit && ${SHARED}`,
            "|| true で失敗を打ち消す",
          ],
          [
            `tsc -p . --noEmit; tsc -p apps/backend --noEmit && ${SHARED}`,
            "; で前の失敗を無視する",
          ],
          [
            `tsc -p . --noEmit && tsc -p apps/backend --noEmit && ${SHARED} | cat`,
            "| で終了コードを変える",
          ],
          [
            `tsc -p . --noEmit --noCheck && tsc -p apps/backend --noEmit && ${SHARED}`,
            "--noCheck で型チェックを止める",
          ],
          [
            `tsc -p . --noEmit --strict false && tsc -p apps/backend --noEmit && ${SHARED}`,
            "--strict を false にする",
          ],
          [
            `tsc -p . --noEmit && tsc -p apps/backend --noEmit --noImplicitAny=false && ${SHARED}`,
            "= で false を渡す",
          ],
          [
            `echo tsc -p . --noEmit && tsc -p apps/backend --noEmit && ${SHARED}`,
            "tsc を実行していない",
          ],
          [
            `tsc -p . -p apps/backend --noEmit && ${SHARED}`,
            "-p が 2 つ（tsc は 1 つしか取らない）",
          ],
          [
            `tsc -p apps/frontend_customer --noEmit && tsc -p apps/backend --noEmit && ${SHARED}`,
            "別の tsconfig",
          ],
          ["", "空文字"],
        ];

        // when
        const result = casesByName(cases, ([script]) =>
          typechecksAllProjects(script),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("ワークフローの判定（runsTypecheckBeforeBuild）", ({ And }) => {
    And(
      "pnpm typecheck を build より前に失敗で止まる形で実行するワークフローは許可する（lint → typecheck → build・名前付きのステップ）",
      () => {
        // given
        const cases: [string, string][] = [
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
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          runsTypecheckBeforeBuild(yaml),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    And(
      "typecheck が無い・効かない・build の後のワークフローは拒否する（ステップが無い・コメントアウト・continue-on-error・if・|| true・build の後）",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "typecheck のステップが無い",
            workflow("      - run: pnpm lint", "      - run: pnpm build"),
          ],
          [
            "コメントアウトされている",
            workflow(
              "      # - run: pnpm typecheck",
              "      - run: pnpm build",
            ),
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
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          runsTypecheckBeforeBuild(yaml),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("型チェックのゲート（実ファイル）", ({ And }) => {
    And(
      "package.json の typecheck は、リポジトリ直下と apps/backend・apps/shared の tsconfig を tsc --noEmit で検査する",
      () => {
        // given
        const scripts: Record<string, string | undefined> = pkg.scripts;

        // when
        const allowed = typechecksAllProjects(scripts.typecheck ?? "");

        // then
        expect(allowed).toBe(true);
      },
    );

    And(
      ".github/workflows/ci.yml は pnpm typecheck を pnpm build より前に、失敗で止まる形で実行する",
      () => {
        // given
        const yaml = readFileSync(
          join(repoRoot, ".github/workflows/ci.yml"),
          "utf8",
        );

        // when
        const steps = readWorkflowSteps(yaml);
        const allowed = runsTypecheckBeforeBuild(yaml);

        // then
        // 前提: ステップを読み取れていること（読み取りが壊れて 0 件になり、判定が素通りするのを防ぐ）。
        expect(steps.length).toBeGreaterThan(5);
        expect(allowed).toBe(true);
      },
    );
  });
});
