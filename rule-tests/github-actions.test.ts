// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは YAML を文字列として読むだけで DOM を使わないため、
//   node 環境で動かす。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect } from "vitest";
import { casesByName } from "./case-table";

// GitHub Actions のワークフロー（.github/workflows/*.yml / *.yaml）の決まりを検査するルール検査テスト（Issue #351）。
//   規則・更新の手順は .claude/rules/tooling/github-actions.md。
// 違反にするもの（違反の文字列の先頭が規則の名前）:
//   - actions-pinned-sha: `uses:` は `<owner>/<repo>(/<path>)@<40 桁の小文字の 16 進>`（full-length の commit SHA）で書く。
//     WHY: タグ（v4 など）やブランチは action のリポジトリ側で別のコミットに差し替えられ、CI / デプロイで別のコードが動きうる。
//       GitHub 公式の Actions の secure use が「Pin actions to a full-length commit SHA」を挙げる
//       （https://raw.githubusercontent.com/github/docs/main/content/actions/reference/security/secure-use.md ）。
//       短い SHA は同じ接頭辞のコミットを作られうるので拒否する（同じ docs が full-length を求める）。
//     WHY 小文字だけ: git が出す SHA は小文字で、書き方を 1 通りにする（大文字の SHA を GitHub が受け付けるかは未確認）。
//     例外（許可）:
//       - `./` で始まる同じリポジトリの action・再利用ワークフロー: ワークフローと同じコミットのファイルが使われるので、
//         差し替えの心配が無い（ref を書く場所も無い）。
//       - `docker://<image>@sha256:<64 桁の 16 進>`: Docker イメージのタグもタグと同じく差し替えられるので、digest で固定した
//         ものだけを許す（今のワークフローには無い。使うときに迷わないよう、SHA と同じ考えで決めておく）。
//   - job-timeout: jobs の下の各 job は、job の直下に `timeout-minutes: <正の整数>` を持つ。
//     WHY: 書かないと GitHub の既定の 360 分まで止まらず、暴走（テストの無限ループ・待ちの固まり）で Actions の分数を食う
//       （Claude Code の GitHub Actions のドキュメント https://code.claude.com/docs/en/github-actions もコスト管理として
//       workflow の timeout を挙げる）。step の timeout-minutes は job 全体を止めないので数えない。
//     WHY 正の整数の文字だけ: 式（`${{ }}`）は値を静的に確かめられず、0 はすぐ失敗する設定で意図した上限にならない。
//   - 依存の脆弱性の検査（Issue #112。違反の一覧ではなく、ci.yml を真偽で判定する）: auditsDependencies は、ci.yml の ci job が
//     `pnpm audit --audit-level high` を if・continue-on-error なしで、PR と push の両方で実行するか。WHY と限界は関数のコメント、
//     決定は ADR docs/adr/quality/20261003-pnpm-audit-in-ci.md。
// 限界（字句で読む。YAML のパーサを依存に足さない。rule-tests/typecheck.test.ts / work-logs-check.test.ts と同じ理由）:
//   - uses は「行頭（`- ` の後を含む）の `uses:` キー」として行ごとに読む。`run: |` のブロックの中に `uses:` で始まる行があると
//     uses として読む（違反を多く出す方向で、見逃しにはならない）。フロー形式（`{ uses: x }`）は読まない（今は使っていない）。
//   - job は「トップレベルの `jobs:` の下で、最初の job と同じインデントの `<名前>:` の行」として読む。job の直下のキーの
//     インデントは、job の見出しの次の（コメント・空行でない）行のインデントで決める。フロー形式の jobs は読まない。
//     フロー形式の job（`b: { timeout-minutes: 30 }`）は中身を読まず、timeout が書いてあっても違反にする（今は使っていない）。
//   - 再利用ワークフローを呼ぶ job（job の直下に `uses:`）が timeout-minutes を受け付けるかは未確認。使い始めて書けなければ、
//     その job を例外にする規則をここに足す。
//   - timeout-minutes の値の上限（360 分を超える・長すぎる値）は見ない。値が妥当かはワークフローのコメントの WHY と reviewer が見る。
//   - タグを書いた行末のコメント（`# v4.4.0`）があるかは見ない（更新の手順で書く。.claude/rules/tooling/github-actions.md）。

const repoRoot = join(import.meta.dirname, "..");
const WORKFLOWS_DIR = ".github/workflows";

// ---- 判定 ----

// WHY owner と repo の文字: GitHub の名前に使える英数字・`-`・`_`（repo は `.` も）。owner に `.` を許さないのは `../x@<SHA>` を
//   owner `..` として通さないため（reviewer の指摘）。path（モノレポの action のサブディレクトリ・
//   再利用ワークフローの .github/workflows/x.yml）は `/` で区切って続けてよい。
const PINNED_REMOTE = /^[\w-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const PINNED_DOCKER = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

function isPinnedUses(value: string): boolean {
  return (
    value.startsWith("./") ||
    PINNED_REMOTE.test(value) ||
    PINNED_DOCKER.test(value)
  );
}

type Uses = { line: number; value: string };

// 行頭（リストの `- ` の後を含む）の `uses:` キー（引用符で囲んだ `"uses":` / `'uses':` も）の値を、1 始まりの行の番号つきで返す。行末のコメント（空白の後の `#`）と
//   前後の引用符を外す。キーと `:` の間の空白（`uses :`）も YAML では同じキーなので読む（Codex の指摘）。コメントの行（`#` で始まる）は読まない。
function readUses(yaml: string): Uses[] {
  return yaml.split(/\r?\n/).flatMap((text, index) => {
    const match = /^\s*(?:-\s+)?(["']?)uses\1\s*:\s*(.*)$/.exec(text);
    if (match === null) return [];
    const value = (match[2] ?? "")
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    return [{ line: index + 1, value }];
  });
}

type Job = { name: string; timeout: string | undefined; body: string[] };

const indentOf = (text: string) => text.length - text.trimStart().length;
const isBlankOrComment = (text: string) => /^\s*(?:#.*)?$/.test(text);

// トップレベルのキー（key は正規表現の文字列）の下の行（コメント・空行を除く。次のトップレベルのキーの手前まで）。
function topLevelBlock(yaml: string, key: string): string[] {
  const heading = new RegExp(`^${key}\\s*:\\s*(?:#.*)?$`);
  const block: string[] = [];
  let inBlock = false;
  for (const text of yaml.split(/\r?\n/)) {
    if (isBlankOrComment(text)) continue;
    if (indentOf(text) === 0) {
      inBlock = heading.test(text);
    } else if (inBlock) {
      block.push(text);
    }
  }
  return block;
}

const jobsBlock = (yaml: string) => topLevelBlock(yaml, "jobs");

// job の見出しの後の行（job の中身）から、job の直下のキーの timeout-minutes の値を返す。直下のキーのインデントは中身の
//   最初の行のインデント（steps の下の step の timeout-minutes を job のものと取り違えないため）。
function jobTimeout(body: string[]): string | undefined {
  const propertyIndent = body[0] === undefined ? 0 : indentOf(body[0]);
  return body
    .filter((text) => indentOf(text) === propertyIndent)
    .map(
      (text) => /^\s*timeout-minutes\s*:\s*(.*?)\s*(?:#.*)?$/.exec(text)?.[1],
    )
    .find((value) => value !== undefined);
}

// トップレベルの `jobs:` の下の job と、job の直下の timeout-minutes の値（無ければ undefined）を返す。
//   job の見出しは、jobs の下の最初の行と同じインデントのすべての行。名前は最初の `:` の手前（前後の引用符を外す）。
//   WHY 同じインデントの行をすべて見出しにする: `<名前>:` の形に限ると、引用符の名前（`"b":`）・アンカー（`b: &x`）・
//     フロー形式（`b: { ... }`）の行が前の job の中身に混ざり、timeout の無い job を見逃した（reviewer の実測）。
//     見出しとして読めば、中身を読めないフロー形式は timeout 無しの違反になる（見逃しを余計な検出に倒す）。
function readJobs(yaml: string): Job[] {
  const block = jobsBlock(yaml);
  const jobIndent = block[0] === undefined ? 0 : indentOf(block[0]);
  const headings = block.flatMap((text, index) =>
    indentOf(text) === jobIndent ? [{ name: jobName(text), index }] : [],
  );
  return headings.map(({ name, index }, position) => {
    const body = block.slice(
      index + 1,
      headings[position + 1]?.index ?? block.length,
    );
    return { name, timeout: jobTimeout(body), body };
  });
}

function jobName(heading: string): string {
  return heading
    .trim()
    .replace(/\s*:.*$/, "")
    .replace(/^(["'])(.*)\1$/, "$2");
}

function hasJobTimeout(job: Job): boolean {
  return job.timeout !== undefined && /^[1-9]\d*$/.test(job.timeout);
}

function findViolations(path: string, yaml: string): string[] {
  return [
    ...readUses(yaml)
      .filter((uses) => !isPinnedUses(uses.value))
      .map(
        (uses) =>
          `actions-pinned-sha: ${path}:${uses.line} の uses: ${uses.value} が commit SHA で固定されていない`,
      ),
    ...readJobs(yaml)
      .filter((job) => !hasJobTimeout(job))
      .map(
        (job) =>
          `job-timeout: ${path} の job ${job.name} に timeout-minutes（正の整数）が無い`,
      ),
  ];
}

// ---- 依存の脆弱性の検査（Issue #112。WHY と値の決め方は .claude/rules/tooling/github-actions.md と
//   ADR docs/adr/quality/20261003-pnpm-audit-in-ci.md） ----

// トップレベルの `on:`（引用符の `"on":` も）の直下のイベント名。ワークフローが PR と main への push の両方で動くかを見る。
//   限界: `on: [push, pull_request]` や `on: push` の 1 行の書き方は読まない（拒否になる。今のワークフローはブロックで書く）。
//   push の branches が main を含むかは見ない（ci.yml と同じ形で書く。reviewer が見る）。
function readEvents(yaml: string): string[] {
  const block = topLevelBlock(yaml, `(["']?)on\\1`);
  const eventIndent = block[0] === undefined ? 0 : indentOf(block[0]);
  return block
    .filter((text) => indentOf(text) === eventIndent)
    .map((text) => text.trim().replace(/\s*:.*$/, ""));
}

// PR と push の両方で動き、`paths` / `paths-ignore` で変更のファイルによって飛ばされないか。
//   WHY paths を拒否する: 飛ばされた実行は required status check を満たし、依存を変えた PR でも audit が動かないことがある（reviewer の指摘）。
const runsOnPullRequestAndPush = (yaml: string) =>
  ["pull_request", "push"].every((event) => readEvents(yaml).includes(event)) &&
  !topLevelBlock(yaml, `(["']?)on\\1`).some((text) =>
    /^\s*paths(?:-ignore)?\s*:/.test(text),
  );

type Step = Record<string, string>;

// job の中身の行から steps を順に取り出す。1 ステップは `- ` で始まる行から次の `- ` の行まで。step の直下のキー（`- ` の後の
//   最初のキーと同じ列）の `キー: 値` だけを集める。
//   WHY 直下のキーだけ: `with:` / `env:` の下のキーを平たく集めると、`with:` の下の `run:` を実行するコマンドと取り違え、
//     `env:` の下の `continue-on-error: false` が step の `continue-on-error: true` を上書きした（reviewer の実測）。
//   WHY 継続行をつなぐ: 値の書いてある直下のキーより深い行は、YAML では値（plain scalar）の続き。読まないと、次の行に書いた
//     `|| true` を見逃した（`run: pnpm audit --audit-level high` の次の行の `|| true` は、YAML では 1 つの値の
//     `pnpm audit --audit-level high || true`。reviewer の実測）。値の無いキー（`with:`）の下の深い行は入れ子のマップなので、つながない。
//   限界: 複数行の値（`run: |`）の中身は読まない（値は "|" になり、下の判定では拒否になる）。継続行は空白 1 つでつなぐ。
function readSteps(body: string[]): Step[] {
  const chunks: string[][] = [];
  for (const text of body) {
    if (text.trim().startsWith("- ")) chunks.push([]);
    chunks.at(-1)?.push(text);
  }
  return chunks.map(readStep);
}

const stripComment = (raw: string) => raw.replace(/\s+#.*$/, "").trim();

// 1 ステップの行（最初の行が `- `）から、直下のキーの値を集める（継続行は直前のキーの値につなぐ）。
function readStep(lines: string[]): Step {
  const propertyIndent = indentOf(lines[0] ?? "") + 2;
  const step: Step = {};
  let lastKey: string | undefined;
  lines.forEach((text, index) => {
    const trimmed = index === 0 ? text.trim().slice(2) : text.trim();
    if (index > 0 && indentOf(text) > propertyIndent) {
      if (lastKey !== undefined)
        step[lastKey] = `${step[lastKey]} ${stripComment(trimmed)}`;
      return;
    }
    const pair = /^([\w-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (pair?.[1] === undefined) return;
    const value = stripComment(pair[2] ?? "");
    step[pair[1]] = value;
    lastKey = value === "" ? undefined : pair[1];
  });
  return step;
}

// job の直下のキー（job の中身の最初の行と同じインデント）の名前。
function jobProperties(body: string[]): string[] {
  const propertyIndent = body[0] === undefined ? 0 : indentOf(body[0]);
  return body
    .filter((text) => indentOf(text) === propertyIndent)
    .map((text) => text.trim().replace(/\s*:.*$/, ""));
}

const AUDIT_COMMAND = "pnpm audit --audit-level high";

// ci.yml の ci job（required status check）が、pnpm audit を high 以上で失敗する形で、PR と main への push の両方で実行するか。
//   WHY ci job: Ruleset protect-main の required status check は ci だけで、別の job に置くと赤でもマージできる。
//   WHY if と continue-on-error を拒否する: 飛ばす・無視すると、high の脆弱性があっても緑になる。job の if も拒否する（skipped の
//     job は required status check を満たす。reviewer の指摘）。
//   WHY コマンドを完全一致で見る: `|| true` や `; exit 0` を足すと失敗が打ち消され、`--audit-level critical` では high を見逃す。
function auditsDependencies(yaml: string): boolean {
  const ci = readJobs(yaml).find((job) => job.name === "ci");
  if (ci === undefined || !runsOnPullRequestAndPush(yaml)) return false;
  if (jobProperties(ci.body).includes("if")) return false;
  return readSteps(ci.body).some(
    (step) =>
      step.run === AUDIT_COMMAND &&
      !("if" in step) &&
      (step["continue-on-error"] ?? "false") === "false",
  );
}

// root の .github/workflows の直下の .yml / .yaml（リポジトリ相対。名前の順）。
function listWorkflows(root: string): string[] {
  return readdirSync(join(root, WORKFLOWS_DIR))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `${WORKFLOWS_DIR}/${name}`);
}

function collectViolations(root: string): string[] {
  return listWorkflows(root).flatMap((path) =>
    findViolations(path, readFileSync(join(root, path), "utf8")),
  );
}

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
// GitHub Actions の式の開き（ドル記号と波かっこ 2 つ）。WHY 定数にする: 文字列リテラルにそのまま書くと Biome の
//   noTemplateCurlyInString（テンプレートリテラルの書き間違いの疑い）に当たるため、テンプレートリテラルの埋め込みで作る。
const EXPRESSION_OPEN = `${"$"}{{`;

let dir: string;

beforeAll(() => {
  // WHY: fixture をリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残る。OS の一時ディレクトリに置いて afterAll で消す。
  dir = mkdtempSync(join(tmpdir(), "github-actions-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const feature = await loadFeature("./github-actions.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("action の参照の判定（isPinnedUses）", ({ And }) => {
    And(
      "40 桁の commit SHA で固定した参照は許可する（owner/repo・サブディレクトリ・再利用ワークフロー・同じリポジトリの ./ ・digest で固定した docker://）",
      () => {
        // given
        const cases: [string, string][] = [
          ["owner/repo", `actions/checkout@${SHA}`],
          ["名前に - と . がある", `google-github-actions/setup.gcloud@${SHA}`],
          ["サブディレクトリの action", `github/codeql-action/init@${SHA}`],
          [
            "再利用ワークフロー",
            `octo-org/shared/.github/workflows/ci.yml@${SHA}`,
          ],
          ["同じリポジトリの action", "./.github/actions/setup"],
          ["同じリポジトリの再利用ワークフロー", "./.github/workflows/x.yml"],
          [
            "digest で固定した docker://",
            `docker://alpine@sha256:${"a".repeat(64)}`,
          ],
        ];

        // when
        const result = casesByName(cases, ([, value]) => isPinnedUses(value));

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    And(
      "commit SHA で固定していない参照は拒否する（メジャーのタグ・完全なタグ・ブランチ・短い SHA・41 桁・大文字・16 進でない文字・式・@ の無い参照・空文字・タグの docker://・digest の無い docker://・owner が .. の参照）",
      () => {
        // given
        const cases: [string, string][] = [
          ["メジャーのタグ", "actions/checkout@v4"],
          ["完全なタグ", "actions/checkout@v4.4.0"],
          ["ブランチ", "actions/checkout@main"],
          ["短い SHA", "actions/checkout@11d5960"],
          ["39 桁", `actions/checkout@${SHA.slice(1)}`],
          ["41 桁", `actions/checkout@${SHA}0`],
          ["大文字", `actions/checkout@${SHA.toUpperCase()}`],
          ["16 進でない文字", `actions/checkout@${SHA.slice(1)}g`],
          ["SHA の後ろに文字", `actions/checkout@${SHA}-x`],
          ["式", `actions/checkout@${EXPRESSION_OPEN} env.REF }}`],
          ["@ の無い参照", "actions/checkout"],
          ["repo の無い参照", `actions@${SHA}`],
          ["空文字", ""],
          ["前の空白", ` actions/checkout@${SHA}`],
          ["タグの docker://", "docker://alpine:3.20"],
          ["digest の無い docker://", "docker://alpine"],
          ["短い digest の docker://", "docker://alpine@sha256:abc"],
          ["../ で始まる参照", "../other/action"],
          ["owner が .. の参照", `../action@${SHA}`],
        ];

        // when
        const result = casesByName(cases, ([, value]) => isPinnedUses(value));

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("action の参照の抽出（readUses）", ({ And }) => {
    And(
      "steps と job の uses を行の番号つきで取り出し、行末のコメントと引用符を外す",
      () => {
        // given
        const yaml = [
          "jobs:",
          "  reuse:",
          `    uses: octo-org/shared/.github/workflows/ci.yml@${SHA}`,
          "  build:",
          "    steps:",
          `      - uses: actions/checkout@${SHA} # v4.4.0`,
          "      - if: always()",
          '        uses: "actions/setup-node@v4"',
          "      - uses: 'pnpm/action-setup@v4' # v4",
          '      - "uses": actions/cache@v4',
          "      - 'uses': actions/cache@v3",
          "      - uses : actions/cache@v2",
        ].join("\n");

        // when
        const result = readUses(yaml);

        // then
        expect(result).toEqual([
          {
            line: 3,
            value: `octo-org/shared/.github/workflows/ci.yml@${SHA}`,
          },
          { line: 6, value: `actions/checkout@${SHA}` },
          { line: 8, value: "actions/setup-node@v4" },
          { line: 9, value: "pnpm/action-setup@v4" },
          { line: 10, value: "actions/cache@v4" },
          { line: 11, value: "actions/cache@v3" },
          { line: 12, value: "actions/cache@v2" },
        ]);
      },
    );

    And(
      "コメントアウトした uses の行と、uses を値に含むだけの行は取り出さない",
      () => {
        // given
        const yaml = [
          "jobs:",
          "  build:",
          "    steps:",
          "      # - uses: actions/checkout@v4",
          "      #   uses: actions/setup-node@v4",
          "      - name: uses: actions/checkout@v4",
          "        run: echo uses: actions/checkout@v4",
        ].join("\n");

        // when
        const result = readUses(yaml);

        // then
        expect(result).toEqual([]);
      },
    );
  });

  Scenario("job の timeout-minutes の判定（readJobs）", ({ And }) => {
    And("job の直下に正の整数の timeout-minutes がある job は違反なし", () => {
      // given
      const yaml = [
        "name: CI",
        "jobs:",
        "  # コメント",
        "  ci:",
        "    runs-on: ubuntu-latest",
        "    # WHY 30 分: 説明",
        "    timeout-minutes: 30 # 行末のコメント",
        "    steps:",
        "      - run: echo",
        "",
        "  deploy :",
        "    timeout-minutes : 5",
        "    runs-on: ubuntu-latest",
      ].join("\n");

      // when
      const result = findViolations("w.yml", yaml);

      // then
      expect(result).toEqual([]);
    });

    And(
      "timeout-minutes の無い job・コメントアウトした timeout-minutes・step にだけある timeout-minutes・0 と式の値は、job の違反になる",
      () => {
        // given
        const yaml = [
          "jobs:",
          "  missing:",
          "    runs-on: ubuntu-latest",
          "  commented:",
          "    runs-on: ubuntu-latest",
          "    # timeout-minutes: 30",
          "  step-only:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo",
          "        timeout-minutes: 10",
          "  zero:",
          "    timeout-minutes: 0",
          "  expression:",
          `    timeout-minutes: ${EXPRESSION_OPEN} inputs.minutes }}`,
          "  ok:",
          "    timeout-minutes: 30",
        ].join("\n");

        // when
        const result = findViolations("w.yml", yaml);

        // then
        expect(result).toEqual([
          "job-timeout: w.yml の job missing に timeout-minutes（正の整数）が無い",
          "job-timeout: w.yml の job commented に timeout-minutes（正の整数）が無い",
          "job-timeout: w.yml の job step-only に timeout-minutes（正の整数）が無い",
          "job-timeout: w.yml の job zero に timeout-minutes（正の整数）が無い",
          "job-timeout: w.yml の job expression に timeout-minutes（正の整数）が無い",
        ]);
      },
    );

    And("jobs の外の同じ名前のキーは job として数えない", () => {
      // given
      const yaml = [
        "on:",
        "  push:",
        "    branches: [main]",
        "env:",
        "  ci: x",
        "jobs:",
        "  build:",
        "    timeout-minutes: 30",
        "    env:",
        "      nested: x",
        "concurrency:",
        "  group: g",
      ].join("\n");

      // when
      const result = readJobs(yaml);

      // then
      // body（job の中身）に jobs の外の concurrency が混ざらないことも見る（steps の検査が body を読むため）。
      expect(result).toEqual([
        {
          name: "build",
          timeout: "30",
          body: ["    timeout-minutes: 30", "    env:", "      nested: x"],
        },
      ]);
    });
  });

  Scenario("job の見出しの読み方（readJobs）", ({ And }) => {
    And(
      "job と同じインデントの行は、引用符の名前・アンカー付き・フロー形式も job の見出しとして読み、中身の無いフロー形式は違反になる",
      () => {
        // given
        const yaml = [
          "jobs:",
          '  "quoted-first":',
          "    timeout-minutes: 30",
          "  anchored: &base",
          "    timeout-minutes: 30",
          "  'single':",
          "    runs-on: ubuntu-latest",
          "  flow: { runs-on: ubuntu-latest, timeout-minutes: 30 }",
          "  ok:",
          "    timeout-minutes: 30",
        ].join("\n");

        // when
        const result = findViolations("w.yml", yaml);

        // then
        expect(result).toEqual([
          "job-timeout: w.yml の job single に timeout-minutes（正の整数）が無い",
          "job-timeout: w.yml の job flow に timeout-minutes（正の整数）が無い",
        ]);
      },
    );
  });

  Scenario("ワークフローの実ファイル", ({ And }) => {
    // 列挙 → 読み取り → 判定を、本番と同じ collectViolations で一時ディレクトリから通す（判定だけ正しくても、列挙や読み取りが
    //   漏れれば違反は見逃されるため。.claude/rules/quality/testing.md の「ルール検査テスト」）。
    And(
      "一時ディレクトリの .github/workflows の yml と yaml から、規則ごとの違反をすべて検出する",
      () => {
        // given
        const root = join(dir, "repo");
        const files: Record<string, string> = {
          "a.yml": [
            "jobs:",
            "  build:",
            "    steps:",
            "      - uses: actions/checkout@v4",
            `      - uses: actions/setup-node@${SHA} # v4.4.0`,
          ].join("\n"),
          "b.yaml": [
            "jobs:",
            "  deploy:",
            "    timeout-minutes: 30",
            "    steps:",
            "      - uses: docker/build-push-action@v7",
          ].join("\n"),
          "c.yml": [
            "jobs:",
            "  ok:",
            "    timeout-minutes: 10",
            "    steps:",
            `      - uses: actions/checkout@${SHA}`,
          ].join("\n"),
          // ワークフローでないファイルは読まない。
          "README.md": "uses: actions/checkout@v4\n",
        };
        mkdirSync(join(root, WORKFLOWS_DIR), { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          writeFileSync(join(root, WORKFLOWS_DIR, name), content);
        }

        // when
        const result = collectViolations(root);

        // then
        expect(result).toEqual([
          "actions-pinned-sha: .github/workflows/a.yml:4 の uses: actions/checkout@v4 が commit SHA で固定されていない",
          "job-timeout: .github/workflows/a.yml の job build に timeout-minutes（正の整数）が無い",
          "actions-pinned-sha: .github/workflows/b.yaml:5 の uses: docker/build-push-action@v7 が commit SHA で固定されていない",
        ]);
      },
    );

    // WHY: 列挙・抽出が 0 件なら違反も 0 件になり、下の「すべて固定」のテストが常に緑になる（ディレクトリ名・正規表現の
    //   書き間違いで起きる）。今のワークフローと、uses・job が 1 件以上取り出せることを先に確かめる。
    And(
      "リポジトリの .github/workflows のワークフローを ci・deploy・mutation を含めて列挙し、uses と job を 1 件以上取り出せる",
      () => {
        // given
        const workflows = listWorkflows(repoRoot);
        const sources = workflows.map((path) =>
          readFileSync(join(repoRoot, path), "utf8"),
        );

        // when
        const result = {
          workflows,
          everyHasUses: sources.every((yaml) => readUses(yaml).length > 0),
          everyHasJobs: sources.every((yaml) => readJobs(yaml).length > 0),
        };

        // then
        expect(result).toEqual({
          workflows: expect.arrayContaining([
            ".github/workflows/ci.yml",
            ".github/workflows/deploy.yml",
            ".github/workflows/mutation.yml",
          ]),
          everyHasUses: true,
          everyHasJobs: true,
        });
      },
    );

    And(
      "リポジトリのワークフローの uses はすべて commit SHA で固定し、すべての job に timeout-minutes がある",
      () => {
        // given: 前提なし（対象はリポジトリの .github/workflows）
        // when
        const result = collectViolations(repoRoot);

        // then
        // 失敗時にどのファイルのどの行・job かが出力に出るよう、違反の一覧を空配列と比較する。
        expect(result).toEqual([]);
      },
    );
  });

  Scenario(
    "依存の脆弱性の検査（auditsDependencies。Issue #112）",
    ({ And }) => {
      const triggers = [
        "on:",
        "  pull_request:",
        "    branches: [main]",
        "  push:",
        "    branches: [main]",
      ];
      const ciWith = (...steps: string[]) =>
        [
          ...triggers,
          "jobs:",
          "  ci:",
          "    timeout-minutes: 30",
          "    steps:",
          "      - run: pnpm install --frozen-lockfile",
          ...steps,
        ].join("\n");

      And(
        "ci.yml の ci job が pnpm audit --audit-level high を、PR と main への push の両方で失敗で止まる形で実行するワークフローは許可する",
        () => {
          // given
          const cases: [string, string][] = [
            ["run だけのステップ", ciWith(`      - run: ${AUDIT_COMMAND}`)],
            [
              "name と行末のコメントと continue-on-error: false",
              ciWith(
                "      - name: Audit dependencies",
                `        run: ${AUDIT_COMMAND} # high 以上で失敗`,
                "        continue-on-error: false",
              ),
            ],
            [
              "with と env を持つ step の後の audit",
              ciWith(
                "      - uses: some/action@v1",
                "        with:",
                "          run: echo",
                "        env:",
                "          A: b",
                `      - run: ${AUDIT_COMMAND}`,
                "        env:",
                "          continue-on-error: true",
              ),
            ],
            [
              "引用符の on と、ci の前に別の job",
              [
                '"on":',
                "  push:",
                "  pull_request:",
                "jobs:",
                "  other:",
                "    steps:",
                "      - run: echo",
                "  ci:",
                "    steps:",
                `      - run: ${AUDIT_COMMAND}`,
              ].join("\n"),
            ],
          ];

          // when
          const result = casesByName(cases, ([, yaml]) =>
            auditsDependencies(yaml),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => true));
        },
      );

      And(
        "pnpm audit が無い・しきい値が high でない・失敗を打ち消す・if で飛ばす・continue-on-error で無視するワークフローは拒否する",
        () => {
          // given
          const cases: [string, string][] = [
            ["pnpm audit が無い", ciWith("      - run: pnpm lint")],
            ["コメントアウト", ciWith(`      # - run: ${AUDIT_COMMAND}`)],
            ["しきい値が無い", ciWith("      - run: pnpm audit")],
            [
              "しきい値が critical",
              ciWith("      - run: pnpm audit --audit-level critical"),
            ],
            ["|| true", ciWith(`      - run: ${AUDIT_COMMAND} || true`)],
            ["; exit 0", ciWith(`      - run: ${AUDIT_COMMAND}; exit 0`)],
            [
              "registry のエラーを無視",
              ciWith(`      - run: ${AUDIT_COMMAND} --ignore-registry-errors`),
            ],
            [
              "複数行の run",
              ciWith("      - run: |", `          ${AUDIT_COMMAND}`),
            ],
            [
              "if で PR のときだけ",
              ciWith(
                "      - if: github.event_name == 'pull_request'",
                `        run: ${AUDIT_COMMAND}`,
              ),
            ],
            [
              "continue-on-error: true",
              ciWith(
                `      - run: ${AUDIT_COMMAND}`,
                "        continue-on-error: true",
              ),
            ],
            [
              "ci でない job",
              [
                ...triggers,
                "jobs:",
                "  audit:",
                "    steps:",
                `      - run: ${AUDIT_COMMAND}`,
              ].join("\n"),
            ],
            [
              "push で動かない",
              ciWith(`      - run: ${AUDIT_COMMAND}`).replace(
                "  push:\n    branches: [main]\n",
                "",
              ),
            ],
            [
              "PR で動かない",
              ciWith(`      - run: ${AUDIT_COMMAND}`).replace(
                "  pull_request:\n",
                "  workflow_dispatch:\n",
              ),
            ],
            [
              "継続行の || true",
              ciWith(`      - run: ${AUDIT_COMMAND}`, "          || true"),
            ],
            [
              "別の step の with の下の run",
              ciWith(
                "      - uses: some/action@v1",
                "        with:",
                `          run: ${AUDIT_COMMAND}`,
              ),
            ],
            [
              "env の下の continue-on-error: false で上書き",
              ciWith(
                `      - run: ${AUDIT_COMMAND}`,
                "        continue-on-error: true",
                "        env:",
                "          continue-on-error: false",
              ),
            ],
            [
              "job の if",
              ciWith(`      - run: ${AUDIT_COMMAND}`).replace(
                "    timeout-minutes: 30\n",
                "    if: false\n    timeout-minutes: 30\n",
              ),
            ],
            [
              "PR の paths",
              ciWith(`      - run: ${AUDIT_COMMAND}`).replace(
                "  pull_request:\n    branches: [main]\n",
                "  pull_request:\n    branches: [main]\n    paths: ['apps/**']\n",
              ),
            ],
            [
              "push の paths-ignore",
              ciWith(`      - run: ${AUDIT_COMMAND}`).replace(
                "  push:\n    branches: [main]\n",
                "  push:\n    branches: [main]\n    paths-ignore: ['docs/**']\n",
              ),
            ],
            [
              "push が入れ子のキーにだけある",
              ciWith(`      - run: ${AUDIT_COMMAND}`).replace(
                "  push:\n    branches: [main]\n",
                "  workflow_dispatch:\n    push:\n",
              ),
            ],
            ["空文字", ""],
          ];

          // when
          const result = casesByName(cases, ([, yaml]) =>
            auditsDependencies(yaml),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => false));
        },
      );
    },
  );

  Scenario("リポジトリの依存の脆弱性の検査（Issue #112）", ({ And }) => {
    And("リポジトリの ci.yml は pnpm audit を上の形で実行する", () => {
      // given
      const yaml = readFileSync(
        join(repoRoot, WORKFLOWS_DIR, "ci.yml"),
        "utf8",
      );

      // when
      const result = auditsDependencies(yaml);

      // then
      expect(result).toBe(true);
    });
  });
});
