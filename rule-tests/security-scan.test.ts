// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは設定ファイルを文字列として読むだけで DOM を使わないため、
//   node 環境で動かす。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { casesByName } from "./case-table";
import {
  indentOf,
  jobProperties,
  readJobs,
  readSteps,
  type Step,
  stepsBlock,
  topLevelBlock,
} from "./workflow-yaml";

// セキュリティの検査ツール（Issue #362）が、固定した版で、コミットフック・CI・デプロイに効く形で入っていることを検査するルール検査テスト。
//   規則・誤検知の抑え方・版の上げ方は .claude/rules/tooling/security-scan.md、決定と採用しなかった案は
//   ADR docs/adr/quality/20261003-security-scan-tools.md。
// 違反にするもの（違反の文字列の先頭が規則の名前）:
//   - scan-image-pinned: scripts/security/scan.sh の `<ツール>_IMAGE="..."` は `<名前>:<タグ>@sha256:<64 桁>` で書く（zizmor を除く）。
//     6 つのツール（ZAP を含む。Issue #364）の変数がそろっていること。
//     WHY digest: イメージのタグは差し替えられる（Trivy は 2026-03 に Docker Hub のタグと Action のタグを乗っ取られた。
//       GHSA-69fq-xp46-6x23）。Actions の SHA 固定（rule-tests/github-actions.test.ts の actions-pinned-sha）と同じ考え。
//     WHY タグも要る: digest だけではどの版か読めず、版の上げ下げを差分で追えない（docker はタグと digest があると digest で取る）。
//   - zizmor-image-version / zizmor-base-pinned / zizmor-requirements-hashed: zizmor は公式のイメージが ghcr.io だけで、クラウド
//     セッションから取れない（2026-10-03 実測）ので scripts/security/zizmor/ の Dockerfile から作る。その代わりに、FROM を digest で、
//     zizmor を requirements.txt の `==` の版とハッシュ（pip の --require-hashes）で固定し、scan.sh のイメージのタグを requirements の
//     版と同じにする（WHY タグをそろえる: scan.sh は同じタグのイメージがあれば作り直さないので、版を上げてもタグが同じだと古い版で動く）。
//   - semgrep-rules-pinned: scan.sh の SEMGREP_RULES_COMMIT は 40 桁の commit SHA（規則が日々変わり、同じコードで結果が変わるのを防ぐ）。
//   - hook-command / hook-settings: lefthook.yml の pre-commit の gitleaks・actionlint・zizmor・hadolint・trivy-config と pre-push の semgrep が、
//     決まった run と glob だけを持つ（skip・only・exclude などを足さない）。フックには commands 以外のキー（skip など）を書かず、
//     トップレベルにはフックのほか（extends・rc・remotes など、別のファイルから設定を足すもの）を書かない（ALLOWED_LEFTHOOK_KEYS）。
//     WHY 完全に一致させる: `|| true`・`skip: true`・glob を狭めるなど、どれも検査を黙って効かなくする（効いているかは見て分からない）。
//   - ci-scan: ci.yml の ci job（required status check）の steps が 6 つの検査を、`run` だけのステップで実行し、job に if・
//     continue-on-error を付けず、ワークフローと job に defaults（run の shell の差し替え）を書かない。WHY ci job: 別の job だと赤でもマージできる（rule-tests/github-actions.test.ts の auditsDependencies と同じ）。
//     WHY フックと CI の両方: フックは `--no-verify` や Docker の止まった手元で飛ばされうる。CI が最後の砦。
//     WHY zap-e2e を ci job に入れない（Issue #405）: ZAP の active scan は数分かかり PR のマージを待たせるので、PR では
//       ZAP を通さない pnpm test:e2e を流し、ZAP は下の zap-daily のジョブで main を毎日検査する（daiki の判断 2026-10-03
//       「PR は普通の E2E、main の daily で ZAP」）。
//   - zap-daily: zap.yml の `on:` に schedule があり、zap job の steps が `scan.sh zap-e2e`（E2E を ZAP 経由で流す受け身の検査と、
//     攻撃を送る active scan）を `run` だけのステップで 1 つ実行し、job に if・continue-on-error を付けず、ワークフローと job に
//     defaults を書かない。WHY: 日次のジョブは PR の required status check ではなく、赤でも誰かが見に行くまで気づかれにくい。
//     if・continue-on-error・defaults・step の shell / env で検査を黙って効かなくしても、ジョブは緑のまま「検査した」ことになる。
//     WHY schedule: schedule が無いと日次で動かず、workflow_dispatch で手で動かさない限り ZAP の検査が一度も走らない。
//   - deploy-image-scan: deploy.yml の deploy job が `scan.sh trivy-image "$IMAGE"` を、マイグレーションとデプロイ（gcloud run）より前に、
//     ほかのステップと同じ if（steps.config.outputs.ready == 'true'）か if なしで、if・name・run のほかのキー（env・shell・
//     continue-on-error など）なしで実行し、ワークフローと job に defaults を書かない。
// 限界（字句で読む。YAML のパーサを依存に足さない。rule-tests/workflow-yaml.ts）:
//   - scan.sh の中でイメージを変数を通さずに書く（`docker run alpine`）ことは見ない。版の変数の定義だけを見る（reviewer が見る）。
//   - lefthook-local.yml（手元だけの上書き）と環境変数 LEFTHOOK=0 は見ない（手元の設定で、repo に入らない。CI が最後の砦）。
//   - ワークフローと job の env（PATH を変えるなど）は見ない（ci.yml の ci job は env で DB の接続先などを渡しているので一律に
//     拒否できない。reviewer が見る）。
//   - ci.yml が PR と push の両方で動くことは rule-tests/github-actions.test.ts の auditsDependencies が見る（同じ ci job）。
//   - デプロイの検査が、イメージをビルドして push した後にあることは見ない（前にあると、まだ無いイメージを検査して失敗するので気づく）。
//   - 検査の中身（ツールの引数・しきい値）は scan.sh に書き、ここでは見ない（scan.sh のコメントと reviewer が見る）。
//   - zap.yml の schedule の cron の値（毎日か・書式が正しいか）、workflow_dispatch の有無、checkout の `ref: main`、zap job の
//     timeout-minutes の値、zap-e2e の前の準備のステップ（install・Postgres・migrate・Playwright）は見ない（準備が欠けると zap-e2e が
//     失敗して気づく。cron と ref は reviewer が見る）。schedule が `on: schedule` のような 1 行の書き方だと読まず違反になる（ブロックで書く）。
//   - 日次のジョブが赤になったときに誰が気づくか（通知）は見ない（GitHub の通知の設定で、repo に無い）。

const repoRoot = join(import.meta.dirname, "..");
const SCAN_SCRIPT = "scripts/security/scan.sh";
const ZIZMOR_DOCKERFILE = "scripts/security/zizmor/Dockerfile";
const ZIZMOR_REQUIREMENTS = "scripts/security/zizmor/requirements.txt";

// ---- 版の固定 ----

// WHY 名前の文字: Docker のイメージの名前の決まり（小文字・数字と、区切りの . _ - と、/ の区切り）。タグは英数字・_ で始まり . と - を含む。
const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:\w[\w.-]{0,127}@sha256:[0-9a-f]{64}$/;

function isPinnedImage(value: string): boolean {
  return PINNED_IMAGE.test(value);
}

const PINNED_TOOLS = [
  "GITLEAKS",
  "ACTIONLINT",
  "HADOLINT",
  "TRIVY",
  "SEMGREP",
  "ZAP",
];
const ZIZMOR_IMAGE_NAME = "ai-only-template/zizmor";

// scan.sh の行頭の `NAME="値"` の代入（コメント・関数の中の local は読まない）。
function readAssignments(script: string): Record<string, string> {
  return Object.fromEntries(
    script.split(/\r?\n/).flatMap((text) => {
      const match = /^([A-Z][A-Z0-9_]*)="([^"]*)"\s*$/.exec(text);
      return match?.[1] === undefined ? [] : [[match[1], match[2] ?? ""]];
    }),
  );
}

// requirements.txt の要求（`\` の継続行を 1 行につなぎ、コメントと空行を除く）。
function readRequirements(requirements: string): string[] {
  return requirements
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text !== "" && !text.startsWith("#"));
}

const HASHED_REQUIREMENT = /^[\w.-]+==[\w.]+(?: --hash=sha256:[0-9a-f]{64})+$/;

type ScanFiles = { script: string; dockerfile: string; requirements: string };

const unless = (ok: boolean, violation: string) => (ok ? [] : [violation]);

function findImageViolations(files: ScanFiles): string[] {
  const assignments = readAssignments(files.script);
  const zizmorImage = assignments.ZIZMOR_IMAGE ?? "（無い）";
  const requirements = readRequirements(files.requirements);
  const zizmorVersion = requirements
    .map((text) => /^zizmor==([\w.]+) /.exec(`${text} `)?.[1])
    .find((version) => version !== undefined);
  const fromImages = [...files.dockerfile.matchAll(/^\s*FROM\s+(\S+)/gim)].map(
    (match) => match[1] ?? "",
  );
  return [
    ...PINNED_TOOLS.map((tool) => `${tool}_IMAGE`)
      .filter((key) => !isPinnedImage(assignments[key] ?? ""))
      .map(
        (key) =>
          `scan-image-pinned: ${SCAN_SCRIPT} の ${key} が digest で固定されていない: ${assignments[key] ?? "（無い）"}`,
      ),
    ...unless(
      zizmorVersion !== undefined &&
        zizmorImage === `${ZIZMOR_IMAGE_NAME}:${zizmorVersion}`,
      `zizmor-image-version: ${SCAN_SCRIPT} の ZIZMOR_IMAGE（${zizmorImage}）が ${ZIZMOR_REQUIREMENTS} の zizmor の版のタグでない`,
    ),
    ...unless(
      fromImages.length > 0 && fromImages.every(isPinnedImage),
      `zizmor-base-pinned: ${ZIZMOR_DOCKERFILE} の FROM が digest で固定されていない: ${fromImages.join(", ") || "（無い）"}`,
    ),
    ...requirements
      .filter((text) => !HASHED_REQUIREMENT.test(text))
      .map(
        (text) =>
          `zizmor-requirements-hashed: ${ZIZMOR_REQUIREMENTS} の要求が == の版とハッシュで固定されていない: ${text}`,
      ),
    ...unless(
      /pip install\b[^\n]*--require-hashes/.test(files.dockerfile),
      `zizmor-requirements-hashed: ${ZIZMOR_DOCKERFILE} の pip install に --require-hashes が無い`,
    ),
    ...unless(
      /^[0-9a-f]{40}$/.test(assignments.SEMGREP_RULES_COMMIT ?? ""),
      `semgrep-rules-pinned: ${SCAN_SCRIPT} の SEMGREP_RULES_COMMIT が 40 桁の commit SHA でない`,
    ),
  ];
}

// ---- コミットフック（lefthook.yml） ----

const scan = (args: string) => `bash ${SCAN_SCRIPT} ${args}`;
const WORKFLOW_GLOB = ".github/workflows/*.{yml,yaml}";
const DOCKERFILE_GLOBS = ["Dockerfile", "**/Dockerfile"];

type HookCommand = Record<string, string[]>;

// フックごとの、検査のコマンドの決まった形（キー → 値の並び。glob の 1 行の書き方は値 1 つの並び）。
const EXPECTED_HOOKS: Record<string, Record<string, HookCommand>> = {
  "pre-commit": {
    gitleaks: { run: [scan("gitleaks-staged")] },
    actionlint: { glob: [WORKFLOW_GLOB], run: [scan("actionlint")] },
    zizmor: { glob: [WORKFLOW_GLOB], run: [scan("zizmor")] },
    hadolint: {
      glob: DOCKERFILE_GLOBS,
      run: [scan("hadolint {staged_files}")],
    },
    "trivy-config": {
      // WHY infra/*.tf も: "**/" は 1 階層以上にだけ一致し、infra/ 直下の .tf を変えたコミットで飛ばされる（reviewer の実測）。
      glob: [...DOCKERFILE_GLOBS, "infra/*.tf", "infra/**/*.tf"],
      run: [scan("trivy-config")],
    },
  },
  "pre-push": { semgrep: { run: [scan("semgrep")] } },
};

const scalar = (raw: string) =>
  raw
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");

const keyOf = (text: string) => text.trim().replace(/\s*:.*$/, "");

// 同じインデント（最初の行のインデント）の行を見出しにして、見出しのキー → 中身の行に分ける。
function groupByHeading(lines: string[]): Record<string, string[]> {
  const headingIndent = indentOf(lines[0] ?? "");
  const groups: Record<string, string[]> = {};
  let current: string[] = [];
  for (const text of lines) {
    if (indentOf(text) === headingIndent) {
      current = [];
      groups[scalar(keyOf(text))] = current;
    } else {
      current.push(text);
    }
  }
  return groups;
}

// コマンドの中身の行から、直下のキー → 値の並び。値のあるキーの下の深い行は値の続き（YAML の plain scalar）としてつなぎ、
//   値の無いキーの下の `- ` の行は並びの要素にする。WHY 続きをつなぐ: 次の行に書いた `|| true` を見逃さない（workflow-yaml.ts の
//   readStep と同じ）。
function readCommand(body: string[]): HookCommand {
  const propertyIndent = indentOf(body[0] ?? "");
  const command: HookCommand = {};
  let values: string[] = [];
  let continues = false;
  for (const text of body) {
    if (indentOf(text) === propertyIndent) {
      const value = scalar(text.trim().replace(/^[^:]*:/, ""));
      values = value === "" ? [] : [value];
      continues = value !== "";
      command[keyOf(text)] = values;
    } else if (continues) {
      values[values.length - 1] = `${values.at(-1)} ${scalar(text)}`;
    } else {
      values.push(scalar(text.trim().replace(/^-\s*/, "")));
    }
  }
  return command;
}

type Hook = { keys: string[]; commands: Record<string, HookCommand> };

// トップレベルのフック（pre-commit など）の直下のキーと、commands の下のコマンド。フックが無ければ undefined。
function readHook(yaml: string, hook: string): Hook | undefined {
  const block = topLevelBlock(yaml, hook);
  if (block.length === 0) return undefined;
  const groups = groupByHeading(block);
  return {
    keys: Object.keys(groups),
    commands: Object.fromEntries(
      Object.entries(groupByHeading(groups.commands ?? [])).map(
        ([name, body]) => [name, readCommand(body)],
      ),
    ),
  };
}

// トップレベルのキー（インデント 0 の、コメントでない行の `:` の手前）。
const topLevelKeys = (yaml: string) =>
  yaml
    .split(/\r?\n/)
    .filter((text) => /^[^\s#]/.test(text))
    .map((text) => scalar(keyOf(text)));

// lefthook.yml のトップレベルに書いてよいキー（フックの名前）。WHY 許可リスト: `extends:` で読み込む別のファイルに
//   `skip: true` を書くと、本体の検査は黙って飛ばされ（lefthook 2.1.12 で `(skip) by condition`、exit 0。reviewer の実測）、
//   `rc:` は hook のスクリプトが source するファイルで、`LEFTHOOK=0` を export すれば全部止められる。どちらもこのファイルを
//   読むだけでは分からないので書かせない。フックを足すときはここに足す。
const ALLOWED_LEFTHOOK_KEYS = ["pre-commit", "pre-push", "commit-msg"];

function findHookViolations(yaml: string): string[] {
  const topLevel = topLevelKeys(yaml)
    .filter((key) => !ALLOWED_LEFTHOOK_KEYS.includes(key))
    .map(
      (key) =>
        `hook-settings: lefthook.yml のトップレベルに ${key} がある（フックのほかを書かない）`,
    );
  return [
    ...topLevel,
    ...Object.entries(EXPECTED_HOOKS).flatMap(([hook, expected]) => {
      const actual = readHook(yaml, hook);
      return [
        ...(actual?.keys ?? [])
          .filter((key) => key !== "commands")
          .map(
            (key) =>
              `hook-settings: lefthook.yml の ${hook} に ${key} がある（commands 以外を書かない）`,
          ),
        ...Object.entries(expected).flatMap(([name, command]) => {
          const actualCommand = actual?.commands[name];
          if (actualCommand === undefined)
            return [`hook-command: lefthook.yml の ${hook} に ${name} が無い`];
          return unless(
            isDeepStrictEqual(actualCommand, command),
            `hook-command: lefthook.yml の ${hook} の ${name} が決まった形でない: ${JSON.stringify(actualCommand)}`,
          );
        }),
      ];
    }),
  ];
}

// ---- CI（ci.yml）とデプロイ（deploy.yml） ----

const CI_SCANS = [
  "gitleaks-history",
  "actionlint",
  "zizmor",
  "hadolint",
  "trivy-config",
  "semgrep",
].map(scan);

const isEnforced = (properties: Step) =>
  (properties["continue-on-error"] ?? "false") === "false";

// if（allowedIf のほか）と continue-on-error（どちらも検査を飛ばす・無視する）の違反。where は「ci.yml の ci job」など。
function settingViolations(
  rule: string,
  where: string,
  properties: Step,
  allowedIf?: string,
): string[] {
  return [
    ...unless(
      !("if" in properties) || properties.if === allowedIf,
      `${rule}: ${where}に if がある: ${properties.if}`,
    ),
    ...unless(
      isEnforced(properties),
      `${rule}: ${where}に continue-on-error がある`,
    ),
  ];
}

// ワークフローと job の `defaults:`（run の shell を変えられる）の違反。WHY: `defaults: run: shell: true {0}` のように shell を
//   差し替えると、run の文字列は同じのまま検査が実行されない（step の shell も同じ。step は run 以外のキーを許さないことで止める）。
//   reviewer の指摘。shell の差し替えの実行時の挙動は未確認（Actions の custom shell の仕様からの推測）だが、検査の step の実行の
//   仕方を変える書き方は、正否を確かめずに一律に拒否する。
function defaultsViolations(
  rule: string,
  path: string,
  yaml: string,
  job: string,
  jobBody: string[],
): string[] {
  return [
    ...unless(
      !topLevelKeys(yaml).includes("defaults"),
      `${rule}: ${path} のトップレベルに defaults がある`,
    ),
    ...unless(
      !("defaults" in jobProperties(jobBody)),
      `${rule}: ${path} の ${job} job に defaults がある`,
    ),
  ];
}

function findCiViolations(yaml: string): string[] {
  const ci = readJobs(yaml).find((job) => job.name === "ci");
  if (ci === undefined) return ["ci-scan: ci.yml に ci job が無い"];
  const steps = readSteps(stepsBlock(ci.body));
  return [
    ...defaultsViolations("ci-scan", "ci.yml", yaml, "ci", ci.body),
    ...settingViolations(
      "ci-scan",
      "ci.yml の ci job ",
      jobProperties(ci.body),
    ),
    // WHY run だけのステップ: shell・env（PATH など）・working-directory などで、同じ run の文字列のまま実行の仕方を変えられる。
    ...CI_SCANS.filter(
      (command) =>
        !steps.some(
          (step) => step.run === command && Object.keys(step).length === 1,
        ),
    ).map(
      (command) =>
        `ci-scan: ci.yml の ci job の steps に「${command}」が run だけのステップで無い`,
    ),
  ];
}

const ZAP_SCAN = scan("zap-e2e");

// トップレベルの `on:`（引用符の `"on":` も）の直下のイベント名（rule-tests/github-actions.test.ts の readEvents と同じ読み方）。
//   `on: schedule` のような 1 行の書き方は読まない（イベントが無いことになり、違反になる）。
function readEvents(yaml: string): string[] {
  const block = topLevelBlock(yaml, `(["']?)on\\1`);
  const eventIndent = block[0] === undefined ? 0 : indentOf(block[0]);
  return block
    .filter((text) => indentOf(text) === eventIndent)
    .map((text) => text.trim().replace(/\s*:.*$/, ""));
}

function findZapDailyViolations(yaml: string): string[] {
  const zap = readJobs(yaml).find((job) => job.name === "zap");
  const schedule = unless(
    readEvents(yaml).includes("schedule"),
    "zap-daily: zap.yml の on に schedule が無い（日次で動かない）",
  );
  if (zap === undefined)
    return [...schedule, "zap-daily: zap.yml に zap job が無い"];
  const steps = readSteps(stepsBlock(zap.body));
  return [
    ...schedule,
    ...defaultsViolations("zap-daily", "zap.yml", yaml, "zap", zap.body),
    ...settingViolations(
      "zap-daily",
      "zap.yml の zap job ",
      jobProperties(zap.body),
    ),
    // WHY run だけのステップ: ci-scan と同じ（shell・env・if・continue-on-error で、同じ run の文字列のまま効かなくできる）。
    // WHY 1 つ: 2 つあると片方だけ書き換えても気づきにくく、検査が 2 回走る理由も無い。
    ...unless(
      steps.filter(
        (step) => step.run === ZAP_SCAN && Object.keys(step).length === 1,
      ).length === 1,
      `zap-daily: zap.yml の zap job の steps に「${ZAP_SCAN}」が run だけのステップで 1 つ無い`,
    ),
  ];
}

const DEPLOY_SCAN = scan('trivy-image "$IMAGE"');
// deploy.yml のステップが共通で付ける条件（デプロイの設定がそろったときだけ動く）。
const DEPLOY_READY = "steps.config.outputs.ready == 'true'";

function findDeployViolations(yaml: string): string[] {
  const deploy = readJobs(yaml).find((job) => job.name === "deploy");
  const steps = readSteps(stepsBlock(deploy?.body ?? []));
  const scanIndex = steps.findIndex((step) => step.run === DEPLOY_SCAN);
  const releaseIndex = steps.findIndex((step) =>
    step.run?.startsWith("gcloud run "),
  );
  const scanStep = steps[scanIndex];
  if (scanStep === undefined)
    return [
      `deploy-image-scan: deploy.yml の deploy job の steps に「${DEPLOY_SCAN}」が無い`,
    ];
  return [
    ...defaultsViolations(
      "deploy-image-scan",
      "deploy.yml",
      yaml,
      "deploy",
      deploy?.body ?? [],
    ),
    ...settingViolations(
      "deploy-image-scan",
      "deploy.yml のイメージの検査のステップ",
      scanStep,
      DEPLOY_READY,
    ),
    // WHY if・name・run のほかを書かない: env で IMAGE を別のイメージにする・shell を差し替えると、検査が今回のイメージを見ない
    //   （reviewer の指摘）。continue-on-error は上で別の違反にする。
    ...Object.keys(scanStep)
      .filter(
        (key) => !["if", "name", "run", "continue-on-error"].includes(key),
      )
      .map(
        (key) =>
          `deploy-image-scan: deploy.yml のイメージの検査のステップに ${key} がある（if・name・run のほかを書かない）`,
      ),
    // WHY リリースのステップが無いのも違反: 「より前」を確かめる相手が無いと、順序の検査が黙って効かなくなる。
    ...unless(
      releaseIndex !== -1 && scanIndex < releaseIndex,
      "deploy-image-scan: deploy.yml のイメージの検査が、マイグレーションとデプロイ（gcloud run）より前に無い",
    ),
  ];
}

// ---- fixture ----

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

const SCRIPT = [
  "#!/usr/bin/env bash",
  `GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1@sha256:${HASH}"`,
  `ACTIONLINT_IMAGE="rhysd/actionlint:1.7.12@sha256:${HASH}"`,
  `HADOLINT_IMAGE="hadolint/hadolint:v2.15.1@sha256:${HASH}"`,
  `TRIVY_IMAGE="aquasec/trivy:0.75.0@sha256:${HASH}"`,
  `SEMGREP_IMAGE="semgrep/semgrep:1.179.0@sha256:${HASH}"`,
  `ZAP_IMAGE="zaproxy/zap-stable:2.17.0@sha256:${HASH}"`,
  'ZIZMOR_IMAGE="ai-only-template/zizmor:1.30.1"',
  `SEMGREP_RULES_COMMIT="${COMMIT}"`,
].join("\n");
const DOCKERFILE = [
  `FROM python:3.13-slim@sha256:${HASH}`,
  "RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt",
].join("\n");
const REQUIREMENTS = [
  "# コメント",
  "zizmor==1.30.1 \\",
  `    --hash=sha256:${HASH} \\`,
  `    --hash=sha256:${"c".repeat(64)}`,
].join("\n");
const SCAN_FILES: ScanFiles = {
  script: SCRIPT,
  dockerfile: DOCKERFILE,
  requirements: REQUIREMENTS,
};

const SEMGREP_RUN = "      run: bash scripts/security/scan.sh semgrep";
const LEFTHOOK = [
  "pre-commit:",
  "  commands:",
  "    biome:",
  "      run: pnpm exec biome check {staged_files}",
  "    # gitleaks: 秘密情報",
  "    gitleaks:",
  "      run: bash scripts/security/scan.sh gitleaks-staged",
  "    actionlint:",
  '      glob: ".github/workflows/*.{yml,yaml}"',
  "      run: bash scripts/security/scan.sh actionlint",
  "    zizmor:",
  "      glob: '.github/workflows/*.{yml,yaml}'",
  "      run: bash scripts/security/scan.sh zizmor # 全ファイル",
  "    hadolint:",
  "      glob:",
  '        - "Dockerfile"',
  '        - "**/Dockerfile"',
  "      run: bash scripts/security/scan.sh hadolint {staged_files}",
  "    trivy-config:",
  "      glob:",
  "        - Dockerfile",
  "        - '**/Dockerfile'",
  '        - "infra/*.tf"',
  '        - "infra/**/*.tf"',
  "      run: bash scripts/security/scan.sh trivy-config",
  "",
  "pre-push:",
  "  commands:",
  "    semgrep:",
  SEMGREP_RUN,
  "",
  "commit-msg:",
  "  commands:",
  "    format:",
  "      run: bash scripts/hooks/check-commit-msg.sh {1}",
].join("\n");

// WHY 1 か所の一致を確かめる: 置換の対象が無い・複数あると、意図しない fixture のまま「違反になる」を確かめてしまう（LEARNINGS.md）。
const replaceOnce = (source: string, from: string, to: string) => {
  if (source.split(from).length !== 2)
    throw new Error(`fixture の置換の対象が 1 か所でない: ${from}`);
  return source.replace(from, to);
};

const CI_STEPS = CI_SCANS.map((command) => `      - run: ${command}`);
const ciYaml = (steps: string[] = CI_STEPS, jobLines: string[] = []) =>
  [
    "on:",
    "  pull_request:",
    "  push:",
    "jobs:",
    "  ci:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    ...jobLines,
    "    steps:",
    `      - uses: actions/checkout@${COMMIT}`,
    "      # セキュリティの検査",
    ...steps,
    "      - run: pnpm lint",
  ].join("\n");

const ZAP_STEP = `      - run: ${ZAP_SCAN}`;
const zapYaml = (steps: string[] = [ZAP_STEP], jobLines: string[] = []) =>
  [
    "on:",
    "  schedule:",
    '    - cron: "45 23 * * *"',
    "  workflow_dispatch:",
    "jobs:",
    "  zap:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 45",
    ...jobLines,
    "    steps:",
    `      - uses: actions/checkout@${COMMIT}`,
    "      - run: pnpm install --frozen-lockfile",
    ...steps,
  ].join("\n");

const DEPLOY_STEP = [
  `      - if: ${DEPLOY_READY}`,
  "        name: Scan runtime image for OS vulnerabilities",
  `        run: ${DEPLOY_SCAN}`,
];
const RELEASE_STEPS = [
  `      - if: ${DEPLOY_READY}`,
  "        name: Run migrations",
  '        run: gcloud run jobs execute "$MIGRATE_JOB" --wait',
  `      - if: ${DEPLOY_READY}`,
  '        run: gcloud run deploy "$SERVICE" --image "$IMAGE"',
];
const deployYaml = (steps: string[]) =>
  [
    "jobs:",
    "  deploy:",
    "    if: github.ref == 'refs/heads/main'",
    "    timeout-minutes: 30",
    "    steps:",
    "      - name: Build and push runtime image",
    `        uses: docker/build-push-action@${COMMIT}`,
    ...steps,
  ].join("\n");

const feature = await loadFeature("./security-scan.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("イメージの固定の判定（isPinnedImage）", ({ And }) => {
    And(
      "名前とタグと 64 桁の sha256 の digest で書いたイメージは許可する（Docker Hub の名前・owner の無い名前・タグの . と -）",
      () => {
        // given
        const cases: [string, string][] = [
          ["owner/name", `aquasec/trivy:0.75.0@sha256:${HASH}`],
          ["owner の無い名前", `python:3.13-slim@sha256:${HASH}`],
          ["タグの v と .", `zricethezav/gitleaks:v8.30.1@sha256:${HASH}`],
          ["名前の - と . と _", `my-org/my.tool_x:1@sha256:${HASH}`],
        ];

        // when
        const result = casesByName(cases, ([, value]) => isPinnedImage(value));

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    And(
      "digest の無い・タグの無い・digest が短い・大文字・digest の後ろに文字があるイメージは拒否する",
      () => {
        // given
        const cases: [string, string][] = [
          ["タグだけ", "aquasec/trivy:0.75.0"],
          ["名前だけ", "aquasec/trivy"],
          ["タグの無い digest", `aquasec/trivy@sha256:${HASH}`],
          ["短い digest", "aquasec/trivy:0.75.0@sha256:abc"],
          ["大文字の digest", `aquasec/trivy:0.75.0@sha256:${"A".repeat(64)}`],
          ["digest の後ろに文字", `aquasec/trivy:0.75.0@sha256:${HASH}x`],
          ["sha256 でない", `aquasec/trivy:0.75.0@sha512:${HASH}`],
          ["大文字の名前", `Aquasec/trivy:0.75.0@sha256:${HASH}`],
          ["前の空白", ` aquasec/trivy:0.75.0@sha256:${HASH}`],
          ["空文字", ""],
        ];

        // when
        const result = casesByName(cases, ([, value]) => isPinnedImage(value));

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("検査ツールの版の固定（findImageViolations）", ({ And }) => {
    And(
      "scan.sh のイメージがすべて digest 付きで、zizmor は digest の FROM とハッシュ付きの requirements と同じ版のタグで作り、semgrep-rules をコミットで固定していれば違反なし",
      () => {
        // given
        const files = SCAN_FILES;

        // when
        const violations = findImageViolations(files);

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "タグだけのイメージ・zizmor のタグと requirements の版のずれ・digest の無い FROM・ハッシュの無い requirements・--require-hashes の無い pip・短いコミットの semgrep-rules は、規則ごとの違反になる",
      () => {
        // given
        const cases: [string, ScanFiles][] = [
          [
            "タグだけのイメージ",
            {
              ...SCAN_FILES,
              script: replaceOnce(SCRIPT, `0.75.0@sha256:${HASH}`, "0.75.0"),
            },
          ],
          [
            "コメントアウトしたイメージ",
            {
              ...SCAN_FILES,
              script: replaceOnce(
                SCRIPT,
                "HADOLINT_IMAGE=",
                "# HADOLINT_IMAGE=",
              ),
            },
          ],
          [
            "zizmor のタグと版のずれ",
            {
              ...SCAN_FILES,
              requirements: replaceOnce(REQUIREMENTS, "1.30.1", "1.31.0"),
            },
          ],
          [
            "digest の無い FROM",
            {
              ...SCAN_FILES,
              dockerfile: replaceOnce(DOCKERFILE, `@sha256:${HASH}`, ""),
            },
          ],
          [
            "ハッシュの無い requirements",
            { ...SCAN_FILES, requirements: "zizmor==1.30.1" },
          ],
          [
            "版を固定しない requirements",
            {
              ...SCAN_FILES,
              requirements: `zizmor>=1.30.1 --hash=sha256:${HASH}`,
            },
          ],
          [
            "--require-hashes の無い pip",
            {
              ...SCAN_FILES,
              dockerfile: replaceOnce(DOCKERFILE, " --require-hashes", ""),
            },
          ],
          [
            "短いコミットの semgrep-rules",
            { ...SCAN_FILES, script: replaceOnce(SCRIPT, COMMIT, "bbbbbbb") },
          ],
        ];

        // when
        const result = casesByName(cases, ([, files]) =>
          findImageViolations(files),
        );

        // then
        const versionMismatch =
          "zizmor-image-version: scripts/security/scan.sh の ZIZMOR_IMAGE（ai-only-template/zizmor:1.30.1）が scripts/security/zizmor/requirements.txt の zizmor の版のタグでない";
        expect(result).toEqual({
          タグだけのイメージ: [
            "scan-image-pinned: scripts/security/scan.sh の TRIVY_IMAGE が digest で固定されていない: aquasec/trivy:0.75.0",
          ],
          コメントアウトしたイメージ: [
            "scan-image-pinned: scripts/security/scan.sh の HADOLINT_IMAGE が digest で固定されていない: （無い）",
          ],
          "zizmor のタグと版のずれ": [versionMismatch],
          "digest の無い FROM": [
            "zizmor-base-pinned: scripts/security/zizmor/Dockerfile の FROM が digest で固定されていない: python:3.13-slim",
          ],
          "ハッシュの無い requirements": [
            "zizmor-requirements-hashed: scripts/security/zizmor/requirements.txt の要求が == の版とハッシュで固定されていない: zizmor==1.30.1",
          ],
          "版を固定しない requirements": [
            versionMismatch,
            `zizmor-requirements-hashed: scripts/security/zizmor/requirements.txt の要求が == の版とハッシュで固定されていない: zizmor>=1.30.1 --hash=sha256:${HASH}`,
          ],
          "--require-hashes の無い pip": [
            "zizmor-requirements-hashed: scripts/security/zizmor/Dockerfile の pip install に --require-hashes が無い",
          ],
          "短いコミットの semgrep-rules": [
            "semgrep-rules-pinned: scripts/security/scan.sh の SEMGREP_RULES_COMMIT が 40 桁の commit SHA でない",
          ],
        });
      },
    );
  });

  Scenario("コミットフックの組み込み（findHookViolations）", ({ And }) => {
    And(
      "pre-commit の gitleaks・actionlint・zizmor・hadolint・trivy-config と pre-push の semgrep が、決まった run と glob だけを持てば違反なし（ほかのコマンドがあってもよい）",
      () => {
        // given
        const yaml = LEFTHOOK;

        // when
        const violations = findHookViolations(yaml);

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "コマンドが無い・コメントアウト・run の変更や || true・glob を狭める・skip や only を足す・フックに skip を足す・トップレベルに extends や rc を足す・別のフックに移すと違反になる",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "コマンドが無い",
            replaceOnce(
              LEFTHOOK,
              "    gitleaks:\n      run: bash scripts/security/scan.sh gitleaks-staged\n",
              "",
            ),
          ],
          [
            "コメントアウト",
            replaceOnce(
              LEFTHOOK,
              "    zizmor:\n      glob: '.github/workflows/*.{yml,yaml}'\n      run: bash scripts/security/scan.sh zizmor # 全ファイル",
              "    # zizmor:\n    #   glob: '.github/workflows/*.{yml,yaml}'\n    #   run: bash scripts/security/scan.sh zizmor",
            ),
          ],
          [
            "run の || true",
            replaceOnce(LEFTHOOK, "trivy-config\n", "trivy-config || true\n"),
          ],
          [
            "次の行の || true",
            replaceOnce(
              LEFTHOOK,
              SEMGREP_RUN,
              `${SEMGREP_RUN}\n        || true`,
            ),
          ],
          [
            "glob を狭める",
            replaceOnce(LEFTHOOK, '        - "**/Dockerfile"\n', ""),
          ],
          [
            "skip を足す",
            replaceOnce(
              LEFTHOOK,
              SEMGREP_RUN,
              `${SEMGREP_RUN}\n      skip: true`,
            ),
          ],
          [
            "only を足す",
            replaceOnce(
              LEFTHOOK,
              "    actionlint:\n",
              "    actionlint:\n      only:\n        - ref: main\n",
            ),
          ],
          [
            "フックに skip を足す",
            replaceOnce(LEFTHOOK, "pre-push:\n", "pre-push:\n  skip: true\n"),
          ],
          ["extends を足す", `extends:\n  - extra.yml\n${LEFTHOOK}`],
          ["rc を足す", `rc: .lefthookrc\n${LEFTHOOK}`],
          [
            "別のフックに移す",
            replaceOnce(
              replaceOnce(LEFTHOOK, `    semgrep:\n${SEMGREP_RUN}\n`, ""),
              "    format:\n",
              `    semgrep:\n${SEMGREP_RUN}\n    format:\n`,
            ),
          ],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          findHookViolations(yaml),
        );

        // then
        const shape = (hook: string, name: string, command: HookCommand) =>
          `hook-command: lefthook.yml の ${hook} の ${name} が決まった形でない: ${JSON.stringify(command)}`;
        expect(result).toEqual({
          コマンドが無い: [
            "hook-command: lefthook.yml の pre-commit に gitleaks が無い",
          ],
          コメントアウト: [
            "hook-command: lefthook.yml の pre-commit に zizmor が無い",
          ],
          "run の || true": [
            shape("pre-commit", "trivy-config", {
              glob: [
                "Dockerfile",
                "**/Dockerfile",
                "infra/*.tf",
                "infra/**/*.tf",
              ],
              run: [`${scan("trivy-config")} || true`],
            }),
          ],
          "次の行の || true": [
            shape("pre-push", "semgrep", {
              run: [`${scan("semgrep")} || true`],
            }),
          ],
          "glob を狭める": [
            shape("pre-commit", "hadolint", {
              glob: ["Dockerfile"],
              run: [scan("hadolint {staged_files}")],
            }),
          ],
          "skip を足す": [
            shape("pre-push", "semgrep", {
              run: [scan("semgrep")],
              skip: ["true"],
            }),
          ],
          "only を足す": [
            shape("pre-commit", "actionlint", {
              only: ["ref: main"],
              glob: [WORKFLOW_GLOB],
              run: [scan("actionlint")],
            }),
          ],
          "フックに skip を足す": [
            "hook-settings: lefthook.yml の pre-push に skip がある（commands 以外を書かない）",
          ],
          "extends を足す": [
            "hook-settings: lefthook.yml のトップレベルに extends がある（フックのほかを書かない）",
          ],
          "rc を足す": [
            "hook-settings: lefthook.yml のトップレベルに rc がある（フックのほかを書かない）",
          ],
          別のフックに移す: [
            "hook-command: lefthook.yml の pre-push に semgrep が無い",
          ],
        });
      },
    );
  });

  Scenario("CI の組み込み（findCiViolations）", ({ And }) => {
    And(
      "ci.yml の ci job の steps が 6 つの検査をそのまま実行すれば違反なし",
      () => {
        // given
        const yaml = ciYaml();

        // when
        const violations = findCiViolations(yaml);

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "検査のステップが無い・if で飛ばす・continue-on-error で無視する・次の行の || true・job の if や continue-on-error・steps の外にだけある検査・step の shell や env・job やワークフローの defaults は違反になる",
      () => {
        // given
        const semgrep = scan("semgrep");
        const withoutSemgrep = CI_STEPS.filter(
          (step) => !step.endsWith(semgrep),
        );
        const semgrepStep = (...lines: string[]) =>
          ciYaml([...withoutSemgrep, `      - run: ${semgrep}`, ...lines]);
        const cases: [string, string][] = [
          ["検査のステップが無い", ciYaml(withoutSemgrep)],
          [
            "コメントアウト",
            ciYaml([...withoutSemgrep, `      # - run: ${semgrep}`]),
          ],
          ["if で飛ばす", semgrepStep("        if: false")],
          [
            "continue-on-error で無視する",
            semgrepStep("        continue-on-error: true"),
          ],
          ["次の行の || true", semgrepStep("          || true")],
          ["job の if", ciYaml(CI_STEPS, ["    if: false"])],
          [
            "job の continue-on-error",
            ciYaml(CI_STEPS, ["    continue-on-error: true"]),
          ],
          [
            "steps の外にだけある検査",
            ciYaml(withoutSemgrep, [
              "    strategy:",
              "      matrix:",
              "        include:",
              `          - run: ${semgrep}`,
            ]),
          ],
          ["step の shell", semgrepStep("        shell: true {0}")],
          ["step の env", semgrepStep("        env:", "          PATH: /x")],
          [
            "job の defaults",
            ciYaml(CI_STEPS, [
              "    defaults:",
              "      run:",
              "        shell: true {0}",
            ]),
          ],
          [
            "ワークフローの defaults",
            `defaults:\n  run:\n    shell: true {0}\n${ciYaml()}`,
          ],
          ["ci job が無い", replaceOnce(ciYaml(), "  ci:", "  test:")],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) => findCiViolations(yaml));

        // then
        const missing = `ci-scan: ci.yml の ci job の steps に「${semgrep}」が run だけのステップで無い`;
        expect(result).toEqual({
          検査のステップが無い: [missing],
          コメントアウト: [missing],
          "if で飛ばす": [missing],
          "continue-on-error で無視する": [missing],
          "次の行の || true": [missing],
          "job の if": ["ci-scan: ci.yml の ci job に if がある: false"],
          "job の continue-on-error": [
            "ci-scan: ci.yml の ci job に continue-on-error がある",
          ],
          "steps の外にだけある検査": [missing],
          "step の shell": [missing],
          "step の env": [missing],
          "job の defaults": ["ci-scan: ci.yml の ci job に defaults がある"],
          "ワークフローの defaults": [
            "ci-scan: ci.yml のトップレベルに defaults がある",
          ],
          "ci job が無い": ["ci-scan: ci.yml に ci job が無い"],
        });
      },
    );
  });

  Scenario("日次の ZAP の組み込み（findZapDailyViolations）", ({ And }) => {
    And(
      "zap.yml が schedule で動き、zap job の steps が zap-e2e をそのまま実行すれば違反なし",
      () => {
        // given
        const cases: [string, string][] = [
          ["schedule と workflow_dispatch", zapYaml()],
          [
            "引用符の on と schedule だけ",
            replaceOnce(
              replaceOnce(zapYaml(), "on:\n  schedule", '"on":\n  schedule'),
              "  workflow_dispatch:\n",
              "",
            ),
          ],
          [
            "ほかの job がある",
            `${zapYaml()}\n  notify:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo done`,
          ],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          findZapDailyViolations(yaml),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "ステップが無い・if で飛ばす・continue-on-error で無視する・step の shell や env・job の if や continue-on-error・job やワークフローの defaults・schedule が無い・zap job が無いと違反になる",
      () => {
        // given
        const zapStep = (...lines: string[]) => zapYaml([ZAP_STEP, ...lines]);
        const cases: [string, string][] = [
          ["ステップが無い", zapYaml([])],
          ["コメントアウト", zapYaml([`      # - run: ${ZAP_SCAN}`])],
          ["2 つある", zapYaml([ZAP_STEP, ZAP_STEP])],
          ["if で飛ばす", zapStep("        if: false")],
          [
            "continue-on-error で無視する",
            zapStep("        continue-on-error: true"),
          ],
          ["次の行の || true", zapStep("          || true")],
          ["step の shell", zapStep("        shell: true {0}")],
          ["step の env", zapStep("        env:", "          PATH: /x")],
          ["job の if", zapYaml([ZAP_STEP], ["    if: false"])],
          [
            "job の continue-on-error",
            zapYaml([ZAP_STEP], ["    continue-on-error: true"]),
          ],
          [
            "job の defaults",
            zapYaml(
              [ZAP_STEP],
              ["    defaults:", "      run:", "        shell: true {0}"],
            ),
          ],
          [
            "ワークフローの defaults",
            `defaults:\n  run:\n    shell: true {0}\n${zapYaml()}`,
          ],
          [
            "schedule が無い",
            replaceOnce(
              zapYaml(),
              '  schedule:\n    - cron: "45 23 * * *"\n',
              "",
            ),
          ],
          [
            "schedule をコメントアウト",
            replaceOnce(
              zapYaml(),
              '  schedule:\n    - cron: "45 23 * * *"\n',
              '  # schedule:\n  #   - cron: "45 23 * * *"\n',
            ),
          ],
          [
            "schedule が別のキーの下",
            replaceOnce(
              zapYaml(),
              '  schedule:\n    - cron: "45 23 * * *"\n  workflow_dispatch:\n',
              "  workflow_dispatch:\n    schedule:\n",
            ),
          ],
          ["zap job が無い", replaceOnce(zapYaml(), "  zap:", "  scan:")],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          findZapDailyViolations(yaml),
        );

        // then
        const missing = `zap-daily: zap.yml の zap job の steps に「${ZAP_SCAN}」が run だけのステップで 1 つ無い`;
        const noSchedule =
          "zap-daily: zap.yml の on に schedule が無い（日次で動かない）";
        expect(result).toEqual({
          ステップが無い: [missing],
          コメントアウト: [missing],
          "2 つある": [missing],
          "if で飛ばす": [missing],
          "continue-on-error で無視する": [missing],
          "次の行の || true": [missing],
          "step の shell": [missing],
          "step の env": [missing],
          "job の if": ["zap-daily: zap.yml の zap job に if がある: false"],
          "job の continue-on-error": [
            "zap-daily: zap.yml の zap job に continue-on-error がある",
          ],
          "job の defaults": [
            "zap-daily: zap.yml の zap job に defaults がある",
          ],
          "ワークフローの defaults": [
            "zap-daily: zap.yml のトップレベルに defaults がある",
          ],
          "schedule が無い": [noSchedule],
          "schedule をコメントアウト": [noSchedule],
          "schedule が別のキーの下": [noSchedule],
          "zap job が無い": ["zap-daily: zap.yml に zap job が無い"],
        });
      },
    );
  });

  Scenario("デプロイのイメージの検査（findDeployViolations）", ({ And }) => {
    And(
      "deploy.yml の deploy job が、今回のイメージを trivy-image で検査してからマイグレーションとデプロイをすれば違反なし",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "ほかのステップと同じ if",
            deployYaml([...DEPLOY_STEP, ...RELEASE_STEPS]),
          ],
          [
            "if なし",
            deployYaml([
              "      - name: Scan",
              `        run: ${DEPLOY_SCAN}`,
              ...RELEASE_STEPS,
            ]),
          ],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          findDeployViolations(yaml),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "検査が無い・デプロイの後・別の条件の if・continue-on-error で無視する・検査のステップの shell や env・ワークフローの defaults は違反になる",
      () => {
        // given
        const cases: [string, string][] = [
          ["検査が無い", deployYaml(RELEASE_STEPS)],
          ["デプロイの後", deployYaml([...RELEASE_STEPS, ...DEPLOY_STEP])],
          ["デプロイのステップが無い", deployYaml(DEPLOY_STEP)],
          [
            "別の条件の if",
            deployYaml([
              "      - if: false",
              `        run: ${DEPLOY_SCAN}`,
              ...RELEASE_STEPS,
            ]),
          ],
          [
            "continue-on-error で無視する",
            deployYaml([
              ...DEPLOY_STEP,
              "        continue-on-error: true",
              ...RELEASE_STEPS,
            ]),
          ],
          [
            "検査のステップの shell",
            deployYaml([
              ...DEPLOY_STEP,
              "        shell: true {0}",
              ...RELEASE_STEPS,
            ]),
          ],
          [
            "検査のステップの env",
            deployYaml([
              ...DEPLOY_STEP,
              "        env:",
              "          IMAGE: alpine:3.0",
              ...RELEASE_STEPS,
            ]),
          ],
          [
            "ワークフローの defaults",
            `defaults:\n  run:\n    shell: true {0}\n${deployYaml([...DEPLOY_STEP, ...RELEASE_STEPS])}`,
          ],
          [
            "deploy job が無い",
            replaceOnce(
              deployYaml([...DEPLOY_STEP, ...RELEASE_STEPS]),
              "  deploy:",
              "  release:",
            ),
          ],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          findDeployViolations(yaml),
        );

        // then
        const missing = `deploy-image-scan: deploy.yml の deploy job の steps に「${DEPLOY_SCAN}」が無い`;
        const notBefore =
          "deploy-image-scan: deploy.yml のイメージの検査が、マイグレーションとデプロイ（gcloud run）より前に無い";
        expect(result).toEqual({
          検査が無い: [missing],
          デプロイの後: [notBefore],
          デプロイのステップが無い: [notBefore],
          "別の条件の if": [
            "deploy-image-scan: deploy.yml のイメージの検査のステップに if がある: false",
          ],
          "continue-on-error で無視する": [
            "deploy-image-scan: deploy.yml のイメージの検査のステップに continue-on-error がある",
          ],
          "検査のステップの shell": [
            "deploy-image-scan: deploy.yml のイメージの検査のステップに shell がある（if・name・run のほかを書かない）",
          ],
          "検査のステップの env": [
            "deploy-image-scan: deploy.yml のイメージの検査のステップに env がある（if・name・run のほかを書かない）",
          ],
          "ワークフローの defaults": [
            "deploy-image-scan: deploy.yml のトップレベルに defaults がある",
          ],
          "deploy job が無い": [missing],
        });
      },
    );
  });

  Scenario("セキュリティの検査の組み込み（実ファイル）", ({ And }) => {
    And(
      "リポジトリの scan.sh・zizmor のイメージ・lefthook.yml・ci.yml・zap.yml・deploy.yml は上の規則の違反が無い",
      () => {
        // given
        const read = (path: string) =>
          readFileSync(join(repoRoot, path), "utf8");

        // when
        const violations = [
          ...findImageViolations({
            script: read(SCAN_SCRIPT),
            dockerfile: read(ZIZMOR_DOCKERFILE),
            requirements: read(ZIZMOR_REQUIREMENTS),
          }),
          ...findHookViolations(read("lefthook.yml")),
          ...findCiViolations(read(".github/workflows/ci.yml")),
          ...findZapDailyViolations(read(".github/workflows/zap.yml")),
          ...findDeployViolations(read(".github/workflows/deploy.yml")),
        ];

        // then
        expect(violations).toEqual([]);
      },
    );
  });
});
