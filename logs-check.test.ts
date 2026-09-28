// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはワークフローを文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 作業ログの CI の検査（Issue #64）が ci.yml に効く形で入っていることを、仕様として固定するルール検査テスト。
// WHY: 作業ログ（logs/YYYY-MM-DD.md）の追記漏れを PR 単位で止める（ユーザー判断。文書だけの PR も例外なし）。
//   ステップが消える・失敗を打ち消す書き方になる・push でも動いて main の CI を壊す・履歴が浅くて差分を取れない、
//   のどれでも検査は黙って効かなくなるか、関係のない失敗になる。
// 検査すること（checksLogsInPullRequests）:
//   - `bash scripts/hooks/check-logs-diff.sh origin/${{ github.base_ref }}` をそのまま実行するステップがある
//     （`|| true` / `; exit 0` などを足すと一致しない）。
//   - そのステップの if が `github.event_name == 'pull_request'`（`${{ }}` で囲んでもよい）。
//     WHY: push（main への push）では github.base_ref が空で、差分を取る相手が無い。PR だけで動かす。
//   - continue-on-error が無い（false は可）。
//   - pnpm lint のステップより前にある（lint より先に、原因の分かるメッセージで止める）。
//   - actions/checkout のステップに fetch-depth: 0 がある（三点 diff の分岐点を求めるのに base ブランチと履歴が要る）。
// スクリプトそのものの判定は scripts/hooks/check-logs-diff.test.ts。

const repoRoot = import.meta.dirname;

const CHECK_COMMAND = `bash scripts/hooks/check-logs-diff.sh origin/\${{ github.base_ref }}`;
const PULL_REQUEST_CONDITION = "github.event_name == 'pull_request'";

type WorkflowStep = Record<string, string>;

// GitHub Actions のワークフローから steps を順に取り出す（YAML のパーサを足さず、行で読む。typecheck.test.ts と同じ考え方）。
// 1 ステップは `- ` で始まる行から次の `- ` の行まで。その中の `キー: 値` をすべて平たく集める（`with:` の下の
// `fetch-depth: 0` も同じステップのキーとして入る）。コメント行（`#` で始まる）は読まない。
// 限界: 複数行の値（`run: |`）の中身は読まない（値は "|" になる）。ci.yml のステップはすべて 1 行の run。
//   同じキーが 1 ステップに 2 回あれば後の値になる。
function readWorkflowSteps(yaml: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const isNewStep = trimmed.startsWith("- ");
    if (isNewStep) steps.push({});
    const current = steps.at(-1);
    if (current === undefined) continue;
    const content = isNewStep ? trimmed.slice(2) : trimmed;
    const pair = /^([\w-]+):\s*(.*)$/.exec(content);
    if (pair?.[1] !== undefined) current[pair[1]] = pair[2]?.trim() ?? "";
  }
  return steps;
}

function unwrapExpression(value: string): string {
  const wrapped = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(value);
  return wrapped?.[1] ?? value;
}

// ワークフローが、PR のときだけ作業ログの検査を、失敗で止まる形で pnpm lint より前に実行し、checkout が履歴を全部取るか。
function checksLogsInPullRequests(yaml: string): boolean {
  const steps = readWorkflowSteps(yaml);
  const check = steps.findIndex((step) => step.run === CHECK_COMMAND);
  const step = steps[check];
  if (step === undefined) return false;
  if (unwrapExpression(step.if ?? "") !== PULL_REQUEST_CONDITION) return false;
  if ("continue-on-error" in step && step["continue-on-error"] !== "false")
    return false;
  const lint = steps.findIndex((s) => s.run === "pnpm lint");
  if (lint !== -1 && lint < check) return false;
  const checkout = steps.findIndex((s) =>
    (s.uses ?? "").startsWith("actions/checkout@"),
  );
  return (
    checkout !== -1 &&
    checkout < check &&
    steps[checkout]?.["fetch-depth"] === "0"
  );
}

const workflow = (...lines: string[]) =>
  ["jobs:", "  ci:", "    steps:", ...lines].join("\n");
const checkout = [
  "      - uses: actions/checkout@v4",
  "        with:",
  "          fetch-depth: 0",
];
const checkStep = [
  "      - name: Check work log",
  "        if: github.event_name == 'pull_request'",
  `        run: ${CHECK_COMMAND}`,
];
const lint = ["      - run: pnpm lint"];

describe("ワークフローの判定（checksLogsInPullRequests）", () => {
  it.each([
    ["checkout → 検査 → lint", workflow(...checkout, ...checkStep, ...lint)],
    [
      "if を式の括弧で囲む",
      workflow(
        ...checkout,
        `      - if: \${{ github.event_name == 'pull_request' }}`,
        `        run: ${CHECK_COMMAND}`,
        ...lint,
      ),
    ],
    [
      "continue-on-error: false を明示する",
      workflow(
        ...checkout,
        ...checkStep,
        "        continue-on-error: false",
        ...lint,
      ),
    ],
    [
      "間に別のステップがある",
      workflow(
        ...checkout,
        "      - run: pnpm install --frozen-lockfile",
        ...checkStep,
        "      - run: pnpm db:migrate",
        ...lint,
      ),
    ],
  ])("%s は許可する", (_name, yaml) => {
    expect(checksLogsInPullRequests(yaml)).toBe(true);
  });

  it.each([
    ["検査のステップが無い", workflow(...checkout, ...lint)],
    [
      "コメントアウトされている",
      workflow(
        ...checkout,
        "      # - if: github.event_name == 'pull_request'",
        `      #   run: ${CHECK_COMMAND}`,
        ...lint,
      ),
    ],
    [
      "|| true で失敗を打ち消す",
      workflow(
        ...checkout,
        "      - if: github.event_name == 'pull_request'",
        `        run: ${CHECK_COMMAND} || true`,
        ...lint,
      ),
    ],
    [
      "; exit 0 で失敗を打ち消す",
      workflow(
        ...checkout,
        "      - if: github.event_name == 'pull_request'",
        `        run: ${CHECK_COMMAND}; exit 0`,
        ...lint,
      ),
    ],
    [
      "continue-on-error: true で失敗を無視する",
      workflow(
        ...checkout,
        ...checkStep,
        "        continue-on-error: true",
        ...lint,
      ),
    ],
    [
      "if が無い（push でも動き、base_ref が空で失敗する）",
      workflow(...checkout, `      - run: ${CHECK_COMMAND}`, ...lint),
    ],
    [
      "if が push",
      workflow(
        ...checkout,
        "      - if: github.event_name == 'push'",
        `        run: ${CHECK_COMMAND}`,
        ...lint,
      ),
    ],
    [
      "if が false（実行しない）",
      workflow(
        ...checkout,
        "      - if: false",
        `        run: ${CHECK_COMMAND}`,
        ...lint,
      ),
    ],
    [
      "if に条件を足して実行しないことがある",
      workflow(
        ...checkout,
        "      - if: github.event_name == 'pull_request' && false",
        `        run: ${CHECK_COMMAND}`,
        ...lint,
      ),
    ],
    [
      "base を固定の origin/main にする",
      workflow(
        ...checkout,
        "      - if: github.event_name == 'pull_request'",
        "        run: bash scripts/hooks/check-logs-diff.sh origin/main",
        ...lint,
      ),
    ],
    ["pnpm lint の後", workflow(...checkout, ...lint, ...checkStep)],
    [
      "checkout に fetch-depth が無い（既定の 1 では分岐点を求められない）",
      workflow("      - uses: actions/checkout@v4", ...checkStep, ...lint),
    ],
    [
      "fetch-depth が 1",
      workflow(
        "      - uses: actions/checkout@v4",
        "        with:",
        "          fetch-depth: 1",
        ...checkStep,
        ...lint,
      ),
    ],
    [
      "fetch-depth: 0 がコメントアウトされている",
      workflow(
        "      - uses: actions/checkout@v4",
        "        with:",
        "          # fetch-depth: 0",
        ...checkStep,
        ...lint,
      ),
    ],
    ["checkout が無い", workflow(...checkStep, ...lint)],
    ["空文字", ""],
  ])("%s は拒否する", (_name, yaml) => {
    expect(checksLogsInPullRequests(yaml)).toBe(false);
  });
});

describe("作業ログの CI の検査（実ファイル）", () => {
  it(".github/workflows/ci.yml は PR のときだけ check-logs-diff.sh を失敗で止まる形で pnpm lint より前に実行し、checkout は fetch-depth: 0", () => {
    const yaml = readFileSync(
      join(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    // 前提: ステップを読み取れていること（読み取りが壊れて 0 件になり、判定が素通りするのを防ぐ）。
    expect(readWorkflowSteps(yaml).length).toBeGreaterThan(5);
    expect(checksLogsInPullRequests(yaml)).toBe(true);
  });
});
