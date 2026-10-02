// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはファイルを文字列として読むだけで DOM を使わないため、
//   node 環境で動かす。
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// テストだけが使うコード（アプリごとの test-support/。apps/backend/test-support/・apps/frontend_customer/test-support/）を
// 本番に持ち込まないことを、機械的に検査するテスト（Issue #181。.claude/rules/backend.md・frontend.md の「置き場所」）。
// WHY 検査する: テストの補助（実 Postgres のテスト用スキーマを作る createTestDatabase、翻訳の期待値を作る tJa など）は、本番から
//   import されるとテスト専用の処理がアプリの振る舞いに入り、Docker のイメージ（Cloud Run に出るもの）に入ると本番の攻撃面が増える。
//   ファイル名の目印（以前の *.test-support.*）だけでは、import もイメージへの混入も止まらない（ユーザー判断「test-support が
//   build に入らないルールは頑張って」）。
// 違反にするもの（規則）:
//   - dockerignore-entry: .dockerignore に `**/test-support` の行が無い（前後の空白を除いた行が完全一致。コメントアウト・
//     末尾の / 付き・別のパターンは認めない）。
//   - dockerignore-excludes: apps/*/test-support/ の下のファイル（再帰）と、test-support を import する apps/ の下のテスト（*.test.*）と、
//     apps/backend/spec/ の下のファイル（API 仕様 spec/api/ と API ジャーニー spec/journey/。`.feature`・step・support.ts。Issue #219 /
//     #251）のうち、.dockerignore のパターンで除外されないもの。WHY spec も外す: API 仕様の support.ts はテストでない名前のソースで
//     vitest を import する（テストだけが使うコード）。.feature も人が読む仕様でイメージに要らない（.dockerignore の `**/spec`）。
//     WHY (a) と別に持つ: 行があっても、後ろの `!` の行（`!apps/backend/test-support/x.ts` など）で戻されると入る。行の有無だけでなく、
//     実際のファイルが除外されることを確かめる。
//     WHY test-support を import するテストも: test-support を外してもテストがコンテキストに残ると、next build の型チェック
//     （apps/frontend_customer/tsconfig.json の include はテストも含む）が「Cannot find module '@/test-support/i18n'」で失敗する
//     （2026-09-30 に docker build で実測）。CI はイメージを作らないので、main へのデプロイまで気づけない。.dockerignore の
//     `**/*.test.ts`・`**/*.test.tsx` で外す。
//   - production-imports-test-support: 本番のコード（apps/ の下のソースのうち、テスト（*.test.*）と test-support/ の中を除いたもの）が、
//     パスの要素に `test-support` を持つ参照先（`../../test-support/database`・`@/test-support/i18n`・`@repo/backend/test-support/x`）か、
//     名前が `.test-support` で終わる参照先（以前の置き方 `./database.test-support`）を import する。
//     import / import type / 副作用だけの import / dynamic import() / export … from のどれも違反。
//   - exports-test-support: apps/*/package.json の exports のキーか値（条件付きの入れ子も）に `test-support` を含む。
//     WHY: exports に載せると、別のパッケージから `@repo/<pkg>/...` で本番のコードに読み込める入口になる。
//   - deploy-verifies-images: .github/workflows/deploy.yml に、push したイメージに test-support が無いことを確かめるステップ
//     （`Verify runtime image has no test-support`・`Verify migrate image has no test-support`）が無い、そのステップに
//     `if: steps.config.outputs.ready == 'true'` が無い、`run:` に find のパターン `-path "*test-support*"` が無いもの。
//     WHY パターンまで見る: `test-support` の文字だけだと、find を消してもエラーの文言（`::error::test-support が…`）で通る。
//     WHY: この検査（(a)〜(d)）はリポジトリのファイルを見るだけで、ビルドした結果（イメージ）は deploy のステップだけが見る。
//     ステップを消す・名前だけ残して run を変えると、イメージへの混入が黙って通る。WHY if も: 他のステップと同じ条件でないと、
//     Variables の無いリポジトリで失敗するか、条件を変えたときに黙ってスキップされる。
//     限界: ステップは「行頭が `- key:` の行」で区切り、コメントの行（`#` で始まる）は除いて読む。パターンのほか（find の結果を
//     判定に使っているか・対象のイメージ）は見ない（手元のイメージで exit 0 / 混入で exit 1 を実測した。Issue #181 の work-logs）。
//   - in-memory-placement: apps/backend の下の InMemory の実装（名前が `.in-memory.<ソースの拡張子>` で終わるファイル）が
//     apps/backend/test-support/ の下に無い（Issue #191。features/<f>/internal/infra/・shared/infra/・features/<f>/test-support/ は違反）。
//     WHY: InMemory の Repository はテストだけが使うコードで、infra に置くと本番のコードと見分けが付かず、本番の api ファイルが
//     参照でき（architecture.test.ts の規則 presentation の例外の絞り込みだけが頼り）、イメージにも入る。test-support に置けば
//     production-imports-test-support と .dockerignore が本番とイメージから外す。
//     WHY 名前が `.in-memory` で終わるものだけ: api-journey.test.ts の api-journey-no-in-memory と同じ目印。名前に in-memory を含むだけの別名
//     （`in-memory-x.ts`・`x.in-memory-y.ts`）とテスト（`x.in-memory.test.ts`）は対象外。
//     限界: 名前で見分けるので、目印の無い名前の InMemory の実装（`fake-x-repository.ts` など）は見ない。apps/backend の外は見ない。
// 検査の対象の列挙が 0 件（test-support/ のファイル・本番のソース・apps/*/package.json・apps/backend の *.in-memory）なら、実ファイルのテストで失敗させる
//   （列挙が壊れて 0 件になると違反も 0 件になり、常に緑になるため）。
//
// .dockerignore のパターンの解釈（限界）: Docker の .dockerignore は Go の filepath.Match に `**` を足した書き方で、後ろの行ほど優先
//   （`!` で戻す）。ここでは次の 3 形だけを解釈する（今の .dockerignore の行はほぼこの 3 形）。
//   - `**/<name>`: パスのどこかに <name> という要素がある（ディレクトリなら中のファイルも）。
//   - `**/*<suffix>`: パスのどこかに <suffix> で終わる要素がある（`**/*.test.ts`）。
//   - `<name>`: パスの最初の要素が <name>。
//   <name>・<suffix> は `/` とグロブの文字（`*` `?` `[` `\`）を含まないものだけ。それ以外の除外の行（`apps/e2e/test-results`・`.env.*` など）は
//   無視する（除外しない側 = 違反を多く出す側）。`!` の行は、上の 2 形なら一致したファイルを戻し、それ以外（グロブ・`/` を含む）は
//   どのファイルも戻しうるとみなして戻す（安全側。`!` の行を足すと、この検査が失敗して見直しを促す）。
// import の抽出の限界: コメントは除いてから探す。文字列の中の `from "x"` のような文字列は import と数える（多く検出する側）。
//   `require("x")`・テンプレートリテラルの `import(`x`)`・tsconfig の paths や package.json の imports（`#x`）で test-support を
//   別名にした参照は見ない（今のリポジトリの paths は `@/*` だけ）。symlink は列挙でたどらない。
// ほかの保証: deploy.yml が、push した runtime と migrate のイメージに test-support のパスが無いことを find で確かめる（.dockerignore の
//   変更で漏れたときに main へのデプロイで止める。コンテキスト全体が入るのは migrate）。architecture.test.ts の backend-placement / frontend-placement が、apps/backend と
//   apps/frontend_customer の直下に test-support/ を置くことを許す。

type RuleId =
  | "dockerignore-entry"
  | "dockerignore-excludes"
  | "production-imports-test-support"
  | "exports-test-support"
  | "in-memory-placement";

const repoRoot = join(import.meta.dirname, "..");

const TEST_SUPPORT_DIR = "test-support";
// 人が読む仕様（apps/backend/spec/。API 仕様 spec/api/ と API ジャーニー spec/journey/。Issue #219 / #251）。テストだけが使う
//   コードなので、test-support と同じくイメージに入れない。
const SPEC_DIR = "spec";
const DOCKERIGNORE_ENTRY = `**/${TEST_SUPPORT_DIR}`;

// --- (a) .dockerignore の行 ---

function hasDockerignoreEntry(dockerignore: string): boolean {
  return dockerignore
    .split("\n")
    .some((line) => line.trim() === DOCKERIGNORE_ENTRY);
}

// --- (b) .dockerignore のパターンで除外されるか ---

type DockerignorePattern =
  | {
      negated: boolean;
      kind: "any-segment" | "any-segment-suffix" | "first-segment";
      name: string;
    }
  | { negated: boolean; kind: "unsupported" };

// WHY `/` とグロブの文字を含む <name> を解釈しない: Go の filepath.Match の完全な再現は要らず、3 形に限れば判定が単純で誤りにくい。
const PLAIN_NAME = /^[^/*?[\\]+$/;

function parseDockerignore(dockerignore: string): DockerignorePattern[] {
  return dockerignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line): DockerignorePattern => {
      const negated = line.startsWith("!");
      const body = negated ? line.slice(1) : line;
      const anySegment = body.startsWith("**/") ? body.slice(3) : undefined;
      if (anySegment !== undefined && PLAIN_NAME.test(anySegment)) {
        return { negated, kind: "any-segment", name: anySegment };
      }
      const suffix = anySegment?.startsWith("*")
        ? anySegment.slice(1)
        : undefined;
      if (suffix !== undefined && PLAIN_NAME.test(suffix)) {
        return { negated, kind: "any-segment-suffix", name: suffix };
      }
      if (PLAIN_NAME.test(body)) {
        return { negated, kind: "first-segment", name: body };
      }
      return { negated, kind: "unsupported" };
    });
}

function patternMatches(pattern: DockerignorePattern, path: string): boolean {
  const segments = path.split("/");
  switch (pattern.kind) {
    case "any-segment":
      return segments.includes(pattern.name);
    case "any-segment-suffix":
      return segments.some((segment) => segment.endsWith(pattern.name));
    case "first-segment":
      return segments[0] === pattern.name;
    case "unsupported":
      // 解釈できない除外の行は除外しない、解釈できない `!` の行は戻す（どちらも違反を多く出す側）。
      return pattern.negated;
  }
}

// path（リポジトリ相対、/ 区切り）がビルドのコンテキストから外れるか。Docker と同じく、最後に一致した行で決める。
function isExcludedByDockerignore(
  patterns: DockerignorePattern[],
  path: string,
): boolean {
  return patterns.reduce(
    (excluded, pattern) =>
      patternMatches(pattern, path) ? !pattern.negated : excluded,
    false,
  );
}

// --- (c) 本番のコードからの import ---

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/;

// 本番のコードか（path は apps/ の下のリポジトリ相対パス）。テストと test-support/ の中は除く。
// WHY vitest.global-setup.ts を対象にしない: リポジトリ直下のテスト基盤で、apps/ の外なので列挙に入らない（イメージの runtime にも入らない）。
function isProductionSource(path: string): boolean {
  return (
    SOURCE_FILE.test(path) &&
    !TEST_FILE.test(path) &&
    !path.split("/").includes(TEST_SUPPORT_DIR)
  );
}

// コメントを消す（文字列は残す。改行は残して行番号を変えない）。architecture.test.ts の stripComments と同じ正規表現。
// WHY 文字列を先に一致させる: 文字列の中の "//"（URL など）をコメントの開始と誤認しない。
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

function stripComments(source: string): string {
  return source.replace(STRING_OR_COMMENT, (match, literal?: string) =>
    literal === undefined ? match.replace(/[^\n]/g, "") : match,
  );
}

// 参照先が test-support を指すか。パスの要素が test-support（ディレクトリ）か、名前が .test-support で終わる（以前の置き方）もの。
// WHY 要素で比べる: `test-support-x`・`my-test-support` は別のモジュール。
function refersToTestSupport(specifier: string): boolean {
  return specifier
    .split("/")
    .some(
      (segment) =>
        segment === TEST_SUPPORT_DIR ||
        /\.test-support(?:\.[cm]?[jt]sx?)?$/.test(segment),
    );
}

// 違反の行（1 始まり）。`from "…"`（import / import type / export … from）、`import "…"`、`import("…")` の参照先を見る。
function findTestSupportImports(source: string): number[] {
  const code = stripComments(source);
  return [
    ...code.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*(["'])([^"'\n]+)\1/g),
  ].flatMap((match) =>
    refersToTestSupport(match[2] ?? "")
      ? [code.slice(0, match.index).split("\n").length]
      : [],
  );
}

// --- (d) package.json の exports ---

// exports の中のキーと値（入れ子も）のうち test-support を含むもの。
function findTestSupportInExports(exports: unknown): string[] {
  if (typeof exports === "string") {
    return exports.includes(TEST_SUPPORT_DIR) ? [exports] : [];
  }
  if (typeof exports === "object" && exports !== null) {
    return Object.entries(exports).flatMap(([key, value]) => [
      ...(key.includes(TEST_SUPPORT_DIR) ? [key] : []),
      ...findTestSupportInExports(value),
    ]);
  }
  return [];
}

// --- (f) InMemory の実装の置き場所 ---

const BACKEND_DIR = "apps/backend";
const IN_MEMORY_SOURCE = /\.in-memory\.(?:[cm]?[jt]s|[jt]sx)$/;

// path（リポジトリ相対）が apps/backend の下の InMemory の実装で、apps/backend/test-support/ の外にあるか。
// WHY 前方一致に `/` を付ける: apps/backend-x/ や apps/backend/test-support-x/ を取り違えない。
function isMisplacedInMemory(path: string): boolean {
  return (
    path.startsWith(`${BACKEND_DIR}/`) &&
    IN_MEMORY_SOURCE.test(path) &&
    !path.startsWith(`${BACKEND_DIR}/${TEST_SUPPORT_DIR}/`)
  );
}

// --- 列挙と検査（本番と fixture で同じ関数を通す） ---

// WHY node_modules と .next に入らない: 依存と生成物は検査の対象ではない（architecture.test.ts の EXCLUDED_DIRS と同じ）。
// WHY symlink をたどらない（Dirent の isDirectory / isFile は symlink を見ない）: 循環する symlink で止まらなくなるのを避ける。
function walk(root: string, dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === ".next"
        ? []
        : walk(root, path);
    }
    return entry.isFile() ? [path] : [];
  });
}

// apps/<app>/ の一覧（ディレクトリだけ、名前順）。
function listApps(root: string): string[] {
  return walk(root, "apps")
    .map((path) => path.split("/").slice(0, 2).join("/"))
    .filter((app, index, all) => all.indexOf(app) === index)
    .sort();
}

// apps/*/test-support/ の下のすべてのファイル（再帰、名前順）。
function listTestSupportFiles(root: string): string[] {
  return listApps(root)
    .flatMap((app) => walk(root, `${app}/${TEST_SUPPORT_DIR}`))
    .sort();
}

// apps/ の下の本番のソース（名前順）。
function listProductionSources(root: string): string[] {
  return walk(root, "apps").filter(isProductionSource).sort();
}

// .dockerignore で除外されるべきファイル: apps/*/test-support/ の下のすべてと、test-support を import する apps/ の下のテスト（名前順）。
function listDockerExcludedTargets(root: string): string[] {
  const testsImportingTestSupport = walk(root, "apps").filter(
    (path) =>
      TEST_FILE.test(path) &&
      findTestSupportImports(readFileSync(join(root, path), "utf8")).length > 0,
  );
  const apiSpecFiles = walk(root, "apps").filter((path) =>
    path.split("/").includes(SPEC_DIR),
  );
  // WHY 重ねを除く: spec/api の step は test-support を import するテストでもあり、2 つの列挙の両方に入る。
  return [
    ...new Set([
      ...listTestSupportFiles(root),
      ...testsImportingTestSupport,
      ...apiSpecFiles,
    ]),
  ].sort();
}

// apps/backend の下の InMemory の実装（置き場所を問わず、名前順）。
function listBackendInMemorySources(root: string): string[] {
  return walk(root, BACKEND_DIR)
    .filter((path) => IN_MEMORY_SOURCE.test(path))
    .sort();
}

// apps/*/package.json（名前順）。
function listAppPackageJsons(root: string): string[] {
  return listApps(root)
    .map((app) => `${app}/package.json`)
    .filter((path) => existsSync(join(root, path)));
}

function readDockerignore(root: string): string {
  const path = join(root, ".dockerignore");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// 規則ごとの違反を「<規則>: <パスなど>」で返す。
function collectViolations(root: string): Record<RuleId, string[]> {
  const dockerignore = readDockerignore(root);
  const patterns = parseDockerignore(dockerignore);
  return {
    "dockerignore-entry": hasDockerignoreEntry(dockerignore)
      ? []
      : [`dockerignore-entry: .dockerignore に ${DOCKERIGNORE_ENTRY} が無い`],
    "dockerignore-excludes": listDockerExcludedTargets(root)
      .filter((path) => !isExcludedByDockerignore(patterns, path))
      .map((path) => `dockerignore-excludes: ${path}`),
    "production-imports-test-support": listProductionSources(root).flatMap(
      (path) =>
        findTestSupportImports(readFileSync(join(root, path), "utf8")).map(
          (line) => `production-imports-test-support: ${path}:${line}`,
        ),
    ),
    "exports-test-support": listAppPackageJsons(root).flatMap((path) => {
      const json = JSON.parse(readFileSync(join(root, path), "utf8")) as {
        exports?: unknown;
      };
      return findTestSupportInExports(json.exports).map(
        (entry) => `exports-test-support: ${path} ${entry}`,
      );
    }),
    "in-memory-placement": listBackendInMemorySources(root)
      .filter(isMisplacedInMemory)
      .map((path) => `in-memory-placement: ${path}`),
  };
}

// --- (e) deploy.yml のイメージの検査のステップ ---

const DEPLOY_WORKFLOW = ".github/workflows/deploy.yml";
const VERIFY_STEP_NAMES = [
  "Verify runtime image has no test-support",
  "Verify migrate image has no test-support",
];
const DEPLOY_READY_CONDITION = "if: steps.config.outputs.ready == 'true'";
const FIND_PATTERN = '-path "*test-support*"';

// 行頭の `- ` を除いたキーの行（`- if: x` → `if: x`）。
const stepLine = (line: string) => line.trim().replace(/^-\s+/, "");
const indentOf = (line: string) => line.length - line.trimStart().length;

// ワークフローのステップ（`- key:` で始まるリストの要素）ごとの行。コメントの行と空行は除く。
function readSteps(yaml: string): string[][] {
  const lines = yaml
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const steps: string[][] = [];
  let current: { indent: number; lines: string[] } | undefined;
  for (const line of lines) {
    const startsStep = /^\s*-\s+[\w-]+:/.test(line);
    if (
      current !== undefined &&
      (indentOf(line) < current.indent ||
        (startsStep && indentOf(line) === current.indent))
    ) {
      steps.push(current.lines);
      current = undefined;
    }
    if (current === undefined && startsStep) {
      current = { indent: indentOf(line), lines: [] };
    }
    current?.lines.push(line);
  }
  if (current !== undefined) steps.push(current.lines);
  return steps;
}

// ステップの run の中身（`run:` の行の後ろと、それより深い行）。run が無ければ undefined。
function runOf(step: string[]): string | undefined {
  const index = step.findIndex((line) => /^run:/.test(stepLine(line)));
  if (index === -1) return undefined;
  const runLine = step[index] ?? "";
  const keyIndent =
    indentOf(runLine) + (runLine.trim().startsWith("-") ? 2 : 0);
  // run の後ろで、run のキーより深い行が続くところまで（次のキー・次のステップの前まで）。
  const rest = step.slice(index + 1);
  const end = rest.findIndex((line) => indentOf(line) <= keyIndent);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [stepLine(runLine).slice("run:".length), ...body].join("\n");
}

// 決めた名前のステップごとに、無い・if が無い・run に find のパターンが無いものを返す。
function findDeployVerifyViolations(yaml: string): string[] {
  const steps = readSteps(yaml);
  return VERIFY_STEP_NAMES.flatMap((name) => {
    const step = steps.find((lines) =>
      lines.some((line) => stepLine(line) === `name: ${name}`),
    );
    if (step === undefined) return [`${name}: ステップが無い`];
    return [
      ...(step.some((line) => stepLine(line) === DEPLOY_READY_CONDITION)
        ? []
        : [`${name}: ${DEPLOY_READY_CONDITION} が無い`]),
      ...(runOf(step)?.includes(FIND_PATTERN)
        ? []
        : [`${name}: run に ${FIND_PATTERN} が無い`]),
    ];
  });
}

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const lines = (...parts: string[]) => parts.join("\n");

describe(".dockerignore の行（hasDockerignoreEntry）", () => {
  it.each([
    ["行がある", lines(".git", "**/test-support")],
    ["前後に空白がある", lines(".git", "  **/test-support\t")],
    ["途中の行にある", lines("# x", "**/test-support", ".env")],
  ])("%s は違反なし", (_name, text) => {
    expect(hasDockerignoreEntry(text)).toBe(true);
  });

  it.each([
    ["行が無い", lines(".git", ".env")],
    ["コメントアウト", lines("# **/test-support")],
    ["コメントの後ろ", lines("#**/test-support")],
    ["** の無い test-support（直下だけ）", lines("test-support")],
    ["末尾の / 付き", lines("**/test-support/")],
    ["! で戻す行", lines("!**/test-support")],
    ["別の名前（前方一致）", lines("**/test-support-x")],
    ["空", ""],
  ])("%s は違反", (_name, text) => {
    expect(hasDockerignoreEntry(text)).toBe(false);
  });
});

describe(".dockerignore のパターンの解釈（isExcludedByDockerignore）", () => {
  const excluded = (dockerignore: string, path: string) =>
    isExcludedByDockerignore(parseDockerignore(dockerignore), path);

  it.each([
    [
      "**/<name> がディレクトリの要素に一致",
      "**/test-support",
      "apps/backend/test-support/database.ts",
    ],
    [
      "**/<name> が深い階層の要素に一致",
      "**/test-support",
      "apps/x/features/y/test-support/a/b.ts",
    ],
    ["**/<name> が直下の要素に一致", "**/test-support", "test-support/a.ts"],
    ["<name> が最初の要素に一致", "test-support", "test-support/a.ts"],
    [
      "**/*<suffix> が名前の末尾に一致",
      "**/*.test.tsx",
      "apps/f/features/x/x.test.tsx",
    ],
    ["**/*<suffix> が直下の名前に一致", "**/*.test.ts", "x.test.ts"],
    [
      "**/*<suffix> がディレクトリの要素に一致",
      "**/*.test.ts",
      "apps/b/x.test.ts/y.js",
    ],
    [
      "コメントと空行を挟む",
      lines("# x", "", "  **/test-support  "),
      "apps/a/test-support/b.ts",
    ],
    [
      "解釈できない ! の後ろで除外し直す",
      lines("!apps/a/*.ts", "**/test-support"),
      "apps/a/test-support/b.ts",
    ],
    [
      "別の名前の ! は戻さない",
      lines("**/test-support", "!.env.example"),
      "apps/a/test-support/b.ts",
    ],
  ])("%s は除外される", (_name, dockerignore, path) => {
    expect(excluded(dockerignore, path)).toBe(true);
  });

  it.each([
    ["行が無い", ".git", "apps/a/test-support/b.ts"],
    ["<name> は最初の要素だけ", "test-support", "apps/a/test-support/b.ts"],
    ["前方一致だけの要素", "**/test-support", "apps/a/test-support-x/b.ts"],
    ["後方一致だけの要素", "**/test-support", "apps/a/my-test-support/b.ts"],
    ["コメントアウト", "# **/test-support", "apps/a/test-support/b.ts"],
    [
      "**/<name> の後ろの ! で戻す",
      lines("**/test-support", "!**/test-support"),
      "apps/a/test-support/b.ts",
    ],
    [
      "後ろの ! <name> で戻す",
      lines("**/test-support", "!apps"),
      "apps/a/test-support/b.ts",
    ],
    [
      "後ろの解釈できない ! の行（パスで戻す）",
      lines("**/test-support", "!apps/a/test-support/b.ts"),
      "apps/a/test-support/b.ts",
    ],
    [
      "解釈できない除外の行（/ を含む）",
      "apps/a/test-support",
      "apps/a/test-support/b.ts",
    ],
    ["解釈できない除外の行（グロブ）", "**/test-*", "apps/a/test-support/b.ts"],
    [
      "解釈できない除外の行（suffix にグロブ）",
      "**/*.te?t.ts",
      "apps/a/x.test.ts",
    ],
    ["解釈できない除外の行（** の無い *<suffix>）", "*.test.ts", "x.test.ts"],
    [
      "**/*<suffix> は末尾だけ（.test.ts と .test.tsx は別）",
      "**/*.test.ts",
      "apps/a/x.test.tsx",
    ],
    [
      "**/*<suffix> の後ろの ! で戻す",
      lines("**/*.test.ts", "!**/*.test.ts"),
      "apps/a/x.test.ts",
    ],
    ["空", "", "apps/a/test-support/b.ts"],
  ])("%s は除外されない", (_name, dockerignore, path) => {
    expect(excluded(dockerignore, path)).toBe(false);
  });
});

describe("本番のソースか（isProductionSource）", () => {
  it.each([
    "apps/backend/features/todo/internal/infra/database.ts",
    "apps/frontend_customer/features/todo/components/todo-item.tsx",
    "apps/frontend_customer/proxy.ts",
    "apps/shared/env.ts",
    "apps/e2e/database.ts",
    "apps/backend/features/x/x.mts",
    "apps/backend/features/x/x.cjs",
    "apps/frontend_customer/features/x/test-support-x/y.ts",
    "apps/frontend_customer/features/x/my-test-support.ts",
    "apps/backend/features/x/x.test-helper.ts",
  ])("%s は本番のソース", (path) => {
    expect(isProductionSource(path)).toBe(true);
  });

  it.each([
    "apps/backend/test-support/database.ts",
    "apps/frontend_customer/test-support/i18n.tsx",
    "apps/backend/features/x/test-support/y.ts",
    "apps/backend/features/x/x.test.ts",
    "apps/frontend_customer/features/x/x.test.tsx",
    "apps/backend/features/x/x.test.mjs",
    "apps/backend/features/x/README.md",
    "apps/backend/package.json",
  ])("%s は本番のソースではない", (path) => {
    expect(isProductionSource(path)).toBe(false);
  });
});

describe("本番のコードからの test-support の import（findTestSupportImports）", () => {
  it.each([
    [
      "test-support と関係の無い import",
      lines(
        'import { a } from "../infra/database";',
        'import b from "@/shared/i18n/i18n";',
      ),
    ],
    [
      "前方一致・後方一致だけの別のモジュール",
      lines(
        'import { a } from "./test-support-x/a";',
        'import { b } from "./my-test-support";',
        'import { c } from "./database.test-support-x";',
      ),
    ],
    [
      "行コメントの中の import",
      '// import { createTestDatabase } from "../../test-support/database";',
    ],
    [
      "ブロックコメントの中の import",
      lines("/*", ' import { tJa } from "@/test-support/i18n";', "*/"),
    ],
    [
      "test-support を含む文字列（import ではない）",
      'const note = "test-support/database";',
    ],
    ["空", ""],
  ])("%s は違反なし", (_name, source) => {
    expect(findTestSupportImports(source)).toEqual([]);
  });

  it.each<[string, string, number[]]>([
    [
      "相対パスの値の import",
      'import { createTestDatabase } from "../../test-support/database";',
      [1],
    ],
    ["@/ の alias", 'import { tJa } from "@/test-support/i18n";', [1]],
    [
      "@repo/backend/ のサブパス",
      'import { createTestDatabase } from "@repo/backend/test-support/database";',
      [1],
    ],
    [
      "import type",
      'import type { TestDatabase } from "../../test-support/database";',
      [1],
    ],
    [
      "inline の type",
      'import { type TestDatabase } from "../../test-support/database";',
      [1],
    ],
    ["副作用だけの import", 'import "../../test-support/database";', [1]],
    [
      "dynamic import()",
      'const m = await import("../../test-support/database");',
      [1],
    ],
    [
      "export … from",
      'export { createTestDatabase } from "../../test-support/database";',
      [1],
    ],
    [
      "export type … from",
      'export type { TestDatabase } from "../../test-support/database";',
      [1],
    ],
    ["export * from", "export * from '../../test-support/database';", [1]],
    [
      "ディレクトリそのもの（index）",
      'import { a } from "@/test-support";',
      [1],
    ],
    ["拡張子付き", 'import { a } from "../../test-support/database.ts";', [1]],
    [
      "以前の置き方（.test-support の名前）",
      'import { a } from "./database.test-support";',
      [1],
    ],
    [
      "以前の置き方（拡張子付き）",
      'import { a } from "./i18n.test-support.tsx";',
      [1],
    ],
    [
      "複数行の import（from の行を報告する）",
      lines(
        "import {",
        "  createTestDatabase,",
        '} from "../../test-support/database";',
      ),
      [3],
    ],
    [
      "コメントの後ろの本物の import",
      lines("// x", '/* y */ import { a } from "@/test-support/i18n";'),
      [2],
    ],
    [
      "複数の違反（行の順）",
      lines(
        'import { a } from "@/test-support/i18n";',
        'import { b } from "./ok";',
        'export * from "@/test-support/x";',
      ),
      [1, 3],
    ],
  ])("%s は違反", (_name, source, expected) => {
    expect(findTestSupportImports(source)).toEqual(expected);
  });
});

describe("package.json の exports（findTestSupportInExports）", () => {
  it.each([
    ["exports が無い", undefined],
    [
      "test-support を含まないキーと値",
      {
        "./features/todo/internal/presentation/*.api":
          "./features/todo/internal/presentation/*.api.ts",
      },
    ],
    [
      "条件付きの入れ子",
      { ".": { import: "./index.ts", types: "./index.d.ts" } },
    ],
    ["文字列だけの exports", "./index.ts"],
    ["配列（フォールバック）の値は見ない", { "./x": ["./x.ts"] }],
  ])("%s は違反なし", (_name, exports) => {
    expect(findTestSupportInExports(exports)).toEqual([]);
  });

  it.each<[string, unknown, string[]]>([
    [
      "キーに test-support",
      { "./test-support/database": "./x.ts" },
      ["./test-support/database"],
    ],
    [
      "値に test-support",
      { "./database": "./test-support/database.ts" },
      ["./test-support/database.ts"],
    ],
    [
      "キーと値の両方",
      { "./test-support/*": "./test-support/*.ts" },
      ["./test-support/*", "./test-support/*.ts"],
    ],
    [
      "条件付きの入れ子の値",
      { "./x": { import: "./test-support/x.ts" } },
      ["./test-support/x.ts"],
    ],
    [
      "文字列だけの exports",
      "./test-support/index.ts",
      ["./test-support/index.ts"],
    ],
    [
      "以前の置き方の名前",
      {
        "./shared/infra/database.test-support":
          "./shared/infra/database.test-support.ts",
      },
      [
        "./shared/infra/database.test-support",
        "./shared/infra/database.test-support.ts",
      ],
    ],
  ])("%s は違反", (_name, exports, expected) => {
    expect(findTestSupportInExports(exports)).toEqual(expected);
  });
});

describe("InMemory の実装の置き場所（isMisplacedInMemory）", () => {
  it.each([
    "apps/backend/test-support/x/x-repository.in-memory.ts",
    "apps/backend/test-support/x.in-memory.ts",
    "apps/backend/test-support/x/y/x.in-memory.mts",
    // 名前に in-memory を含むだけの別名（`.in-memory` で終わらない）は対象外。
    "apps/backend/features/x/internal/infra/in-memory-x.ts",
    "apps/backend/features/x/internal/infra/x-in-memory.ts",
    "apps/backend/features/x/internal/infra/x.in-memory-y.ts",
    // テスト・ソースでないファイルは対象外。
    "apps/backend/features/x/internal/infra/x-repository.in-memory.test.ts",
    "apps/backend/features/x/internal/infra/x.in-memory.md",
    // apps/backend の外（前方一致だけが同じ apps/backend-x も）は対象外。
    "apps/frontend_customer/features/x/x.in-memory.ts",
    "apps/backend-x/features/x/internal/infra/x.in-memory.ts",
  ])("%s は違反なし", (path) => {
    expect(isMisplacedInMemory(path)).toBe(false);
  });

  it.each([
    "apps/backend/features/x/internal/infra/x-repository.in-memory.ts",
    "apps/backend/shared/infra/x.in-memory.ts",
    "apps/backend/features/x/internal/application/x.in-memory.mts",
    "apps/backend/features/x/internal/infra/x.in-memory.tsx",
    "apps/backend/x.in-memory.cjs",
    // test-support は apps/backend 直下だけ（features/<f>/test-support/ や前方一致の test-support-x/ は違う）。
    "apps/backend/features/x/test-support/x.in-memory.ts",
    "apps/backend/test-support-x/x.in-memory.ts",
  ])("%s は違反", (path) => {
    expect(isMisplacedInMemory(path)).toBe(true);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、列挙（test-support/ のファイル・本番のソース・package.json の見つけ方）や読み取りが漏れれば見逃す。
//   一時ディレクトリに架空のツリーを置き、本番と同じ collectViolations に通して、違反の集合を丸ごと比較する。
describe("列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "test-support-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const importDatabase =
    'import { createTestDatabase } from "../../../../test-support/database";';
  // API 仕様（Issue #219）。.feature・step（test-support を import するテストでもある）・support.ts のすべてを .dockerignore で外す。
  const apiSpecFiles = {
    "apps/backend/spec/api/x/create-x.feature": "Feature: x\n",
    "apps/backend/spec/api/x/create-x.api-spec.test.ts":
      'import { createTestDatabase } from "../../../test-support/database";\n',
    "apps/backend/spec/api/x/support.ts": 'import { expect } from "vitest";\n',
  };
  const allowedFiles = {
    "apps/backend/test-support/database.ts": lines(
      'import type { Database } from "../shared/infra/database";',
    ),
    "apps/backend/test-support/nested/x.ts": "export const x = 1;\n",
    "apps/frontend_customer/test-support/i18n.tsx": lines(
      'import { createTranslator } from "../shared/i18n/i18n";',
      // test-support の中から test-support を参照するのは本番のコードではない。
      'import { a } from "@/test-support/other";',
    ),
    // テストからの import は production-imports-test-support の対象外。ただし .dockerignore で外れること（dockerignore-excludes）は見る。
    "apps/backend/features/x/internal/infra/x.postgres.test.ts": importDatabase,
    "apps/frontend_customer/features/x/x.test.tsx":
      'import { tJa } from "@/test-support/i18n";\n',
    // test-support を import しないテストは dockerignore-excludes の対象外（コメントの中の import も数えない）。
    "apps/frontend_customer/features/x/y.test.ts": lines(
      'import { a } from "./y";',
      '// import { tJa } from "@/test-support/i18n";',
    ),
    // 本番のコードの test-support と関係の無い import・コメントの中。
    "apps/backend/features/x/internal/infra/x.postgres.ts": lines(
      'import { AppDatabase } from "../../../../shared/infra/database";',
      `// ${importDatabase}`,
    ),
    // 依存と生成物の中は見ない。
    "apps/backend/node_modules/x/index.ts": importDatabase,
    "apps/frontend_customer/.next/server/x.js":
      'import { tJa } from "@/test-support/i18n";\n',
    "apps/backend/package.json": JSON.stringify({
      name: "@repo/backend",
      exports: {
        "./shared/presentation/problem": "./shared/presentation/problem.ts",
      },
    }),
    "apps/frontend_customer/package.json": JSON.stringify({
      name: "@repo/frontend-customer",
    }),
  };

  it("違反の無いツリーは違反 0 件（列挙は test-support/ のファイル・本番のソース・apps/*/package.json）", () => {
    const root = fixture({
      ...allowedFiles,
      ...apiSpecFiles,
      ".dockerignore": lines(
        "# x",
        ".git",
        "**/test-support",
        "**/spec",
        "**/*.test.ts",
        "**/*.test.tsx",
        "!.env.example",
      ),
    });
    expect({
      testSupport: listTestSupportFiles(root),
      excludedTargets: listDockerExcludedTargets(root),
      production: listProductionSources(root),
      packages: listAppPackageJsons(root),
      violations: collectViolations(root),
    }).toEqual({
      testSupport: [
        "apps/backend/test-support/database.ts",
        "apps/backend/test-support/nested/x.ts",
        "apps/frontend_customer/test-support/i18n.tsx",
      ],
      excludedTargets: [
        "apps/backend/features/x/internal/infra/x.postgres.test.ts",
        "apps/backend/spec/api/x/create-x.api-spec.test.ts",
        "apps/backend/spec/api/x/create-x.feature",
        "apps/backend/spec/api/x/support.ts",
        "apps/backend/test-support/database.ts",
        "apps/backend/test-support/nested/x.ts",
        "apps/frontend_customer/features/x/x.test.tsx",
        "apps/frontend_customer/test-support/i18n.tsx",
      ],
      // spec/api の support.ts もテストでない名前のソースなので、本番のソースとして test-support の import を見る（今の形）。
      production: [
        "apps/backend/features/x/internal/infra/x.postgres.ts",
        "apps/backend/spec/api/x/support.ts",
      ],
      packages: [
        "apps/backend/package.json",
        "apps/frontend_customer/package.json",
      ],
      violations: {
        "dockerignore-entry": [],
        "dockerignore-excludes": [],
        "production-imports-test-support": [],
        "exports-test-support": [],
        "in-memory-placement": [],
      },
    });
  });

  it("すべての規則の違反を「規則: パス」で返す", () => {
    const root = fixture({
      ...allowedFiles,
      // **/spec の行が無い → spec/api の .feature と support.ts が除外されない（step は **/*.test.ts の行も無いので除外されない）。
      ...apiSpecFiles,
      // 行が無く、別の書き方（/ 付き）だけ → test-support/ のすべてのファイルが除外されない。
      ".dockerignore": lines(".git", "**/test-support/"),
      "apps/backend/features/x/internal/infra/bad.postgres.ts": lines(
        'import { AppDatabase } from "../../../../shared/infra/database";',
        importDatabase,
      ),
      "apps/frontend_customer/features/x/components/bad.tsx": lines(
        "export { tJa } from '@/test-support/i18n';",
      ),
      "apps/frontend_customer/shared/x/bad.mjs": lines(
        "",
        "",
        'const m = await import("../../test-support/i18n");',
      ),
      "apps/shared/package.json": JSON.stringify({
        name: "@repo/shared",
        exports: { "./test-support/x": "./test-support/x.ts" },
      }),
      "apps/backend/features/x/internal/infra/bad-repository.in-memory.ts":
        "export class InMemoryBadRepository {}\n",
    });
    expect(collectViolations(root)).toEqual({
      "dockerignore-entry": [
        "dockerignore-entry: .dockerignore に **/test-support が無い",
      ],
      "dockerignore-excludes": [
        "dockerignore-excludes: apps/backend/features/x/internal/infra/x.postgres.test.ts",
        "dockerignore-excludes: apps/backend/spec/api/x/create-x.api-spec.test.ts",
        "dockerignore-excludes: apps/backend/spec/api/x/create-x.feature",
        "dockerignore-excludes: apps/backend/spec/api/x/support.ts",
        "dockerignore-excludes: apps/backend/test-support/database.ts",
        "dockerignore-excludes: apps/backend/test-support/nested/x.ts",
        "dockerignore-excludes: apps/frontend_customer/features/x/x.test.tsx",
        "dockerignore-excludes: apps/frontend_customer/test-support/i18n.tsx",
      ],
      "production-imports-test-support": [
        "production-imports-test-support: apps/backend/features/x/internal/infra/bad.postgres.ts:2",
        "production-imports-test-support: apps/frontend_customer/features/x/components/bad.tsx:1",
        "production-imports-test-support: apps/frontend_customer/shared/x/bad.mjs:3",
      ],
      "exports-test-support": [
        "exports-test-support: apps/shared/package.json ./test-support/x",
        "exports-test-support: apps/shared/package.json ./test-support/x.ts",
      ],
      "in-memory-placement": [
        "in-memory-placement: apps/backend/features/x/internal/infra/bad-repository.in-memory.ts",
      ],
    });
  });

  it("行があっても、後ろの ! の行で戻したファイルは除外されない", () => {
    const root = fixture({
      ...allowedFiles,
      ".dockerignore": lines(
        "**/test-support",
        "**/*.test.ts",
        "**/*.test.tsx",
        "!apps/backend/test-support/nested/x.ts",
      ),
    });
    expect(collectViolations(root)["dockerignore-excludes"]).toEqual([
      "dockerignore-excludes: apps/backend/features/x/internal/infra/x.postgres.test.ts",
      "dockerignore-excludes: apps/backend/test-support/database.ts",
      "dockerignore-excludes: apps/backend/test-support/nested/x.ts",
      "dockerignore-excludes: apps/frontend_customer/features/x/x.test.tsx",
      "dockerignore-excludes: apps/frontend_customer/test-support/i18n.tsx",
    ]);
  });

  it("test-support の行があっても、test-support を import するテストの拡張子の行が無ければそのテストだけが違反", () => {
    const root = fixture({
      ...allowedFiles,
      ".dockerignore": lines("**/test-support", "**/*.test.ts"),
    });
    expect(collectViolations(root)).toEqual({
      "dockerignore-entry": [],
      "dockerignore-excludes": [
        "dockerignore-excludes: apps/frontend_customer/features/x/x.test.tsx",
      ],
      "production-imports-test-support": [],
      "exports-test-support": [],
      "in-memory-placement": [],
    });
  });

  it("in-memory-placement: apps/backend の下の *.in-memory のソースを列挙し、test-support/ の外にあるものだけが違反", () => {
    const root = fixture({
      ...allowedFiles,
      ".dockerignore": lines(
        "**/test-support",
        "**/*.test.ts",
        "**/*.test.tsx",
      ),
      "apps/backend/test-support/x/x-repository.in-memory.ts":
        "export class InMemoryXRepository {}\n",
      "apps/backend/test-support/y.in-memory.mts": "export const y = 1;\n",
      // 対象外（別名・テスト・ソースでない・apps/backend の外・依存の中）。
      "apps/backend/features/x/internal/infra/in-memory-x.ts":
        "export const a = 1;\n",
      "apps/backend/features/x/internal/infra/x-repository.in-memory.test.ts":
        'import { test } from "vitest";\n',
      "apps/backend/features/x/internal/infra/x.in-memory.md": "# x\n",
      "apps/frontend_customer/features/x/x.in-memory.ts":
        "export const b = 1;\n",
      "apps/backend/node_modules/x/x.in-memory.ts": "export const c = 1;\n",
      // 違反。
      "apps/backend/features/x/internal/infra/x-repository.in-memory.ts":
        "export class InMemoryXRepository {}\n",
      "apps/backend/shared/infra/z.in-memory.js": "export const z = 1;\n",
      "apps/backend/features/x/test-support/w.in-memory.ts":
        "export const w = 1;\n",
    });
    expect({
      inMemory: listBackendInMemorySources(root),
      violations: collectViolations(root),
    }).toEqual({
      inMemory: [
        "apps/backend/features/x/internal/infra/x-repository.in-memory.ts",
        "apps/backend/features/x/test-support/w.in-memory.ts",
        "apps/backend/shared/infra/z.in-memory.js",
        "apps/backend/test-support/x/x-repository.in-memory.ts",
        "apps/backend/test-support/y.in-memory.mts",
      ],
      violations: {
        "dockerignore-entry": [],
        "dockerignore-excludes": [],
        "production-imports-test-support": [],
        "exports-test-support": [],
        "in-memory-placement": [
          "in-memory-placement: apps/backend/features/x/internal/infra/x-repository.in-memory.ts",
          "in-memory-placement: apps/backend/features/x/test-support/w.in-memory.ts",
          "in-memory-placement: apps/backend/shared/infra/z.in-memory.js",
        ],
      },
    });
  });

  it("apps/ も .dockerignore も無ければ、列挙は 0 件で行が無い違反だけ（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      testSupport: listTestSupportFiles(root),
      excludedTargets: listDockerExcludedTargets(root),
      production: listProductionSources(root),
      packages: listAppPackageJsons(root),
      inMemory: listBackendInMemorySources(root),
      violations: collectViolations(root),
    }).toEqual({
      testSupport: [],
      excludedTargets: [],
      production: [],
      packages: [],
      inMemory: [],
      violations: {
        "dockerignore-entry": [
          "dockerignore-entry: .dockerignore に **/test-support が無い",
        ],
        "dockerignore-excludes": [],
        "production-imports-test-support": [],
        "exports-test-support": [],
        "in-memory-placement": [],
      },
    });
  });
});

describe("deploy.yml のイメージの検査のステップ（findDeployVerifyViolations）", () => {
  const step = (
    name: string,
    run: string[],
    condition = DEPLOY_READY_CONDITION,
  ) =>
    [
      `      - ${condition}`,
      `        name: ${name}`,
      "        run: |",
      ...run.map((line) => `          ${line}`),
    ].join("\n");
  const verify = (image: string) => [
    `docker pull "$${image}"`,
    `found="$(docker run --rm "$${image}" -c 'find / -path "*test-support*" -print')"`,
  ];
  const runtime = step(
    "Verify runtime image has no test-support",
    verify("IMAGE"),
  );
  const migrate = step(
    "Verify migrate image has no test-support",
    verify("MIGRATE_IMAGE"),
  );
  const workflow = (...steps: string[]) =>
    lines("jobs:", "  deploy:", "    steps:", ...steps);

  it.each([
    ["2 つのステップがある", workflow(runtime, migrate)],
    [
      "間に別のステップ・コメントがある",
      workflow(
        runtime,
        "      # マイグレーションのイメージ",
        "      - if: steps.config.outputs.ready == 'true'",
        "        name: Build and push migrate image",
        "        uses: docker/build-push-action@v7",
        migrate,
      ),
    ],
    [
      "run が 1 行（| を使わない）",
      workflow(
        runtime,
        lines(
          "      - name: Verify migrate image has no test-support",
          "        if: steps.config.outputs.ready == 'true'",
          '        run: find / -path "*test-support*" -print',
        ),
      ),
    ],
  ])("%s は違反なし", (_name, yaml) => {
    expect(findDeployVerifyViolations(yaml)).toEqual([]);
  });

  it.each<[string, string, string[]]>([
    [
      "ステップが無い",
      workflow(),
      [
        "Verify runtime image has no test-support: ステップが無い",
        "Verify migrate image has no test-support: ステップが無い",
      ],
    ],
    [
      "migrate のステップが無い",
      workflow(runtime),
      ["Verify migrate image has no test-support: ステップが無い"],
    ],
    [
      "コメントアウトしたステップ",
      workflow(
        runtime,
        migrate
          .split("\n")
          .map((line) => `      # ${line.trim()}`)
          .join("\n"),
      ),
      ["Verify migrate image has no test-support: ステップが無い"],
    ],
    [
      "名前だけ残して run に find のパターンが無い（エラーの文言にだけ test-support）",
      workflow(
        runtime,
        step("Verify migrate image has no test-support", [
          'echo "::error::test-support"',
        ]),
      ),
      [
        'Verify migrate image has no test-support: run に -path "*test-support*" が無い',
      ],
    ],
    [
      "run が無い（名前だけ）",
      workflow(
        runtime,
        lines(
          "      - if: steps.config.outputs.ready == 'true'",
          "        name: Verify migrate image has no test-support",
        ),
      ),
      [
        'Verify migrate image has no test-support: run に -path "*test-support*" が無い',
      ],
    ],
    [
      "test-support が run の外（次のステップ）にだけある",
      workflow(
        runtime,
        step("Verify migrate image has no test-support", ["true"]),
        lines("      - name: Other", "        run: echo test-support"),
      ),
      [
        'Verify migrate image has no test-support: run に -path "*test-support*" が無い',
      ],
    ],
    [
      "test-support が run のコメントにだけある",
      workflow(
        runtime,
        step("Verify migrate image has no test-support", [
          "# test-support",
          "true",
        ]),
      ),
      [
        'Verify migrate image has no test-support: run に -path "*test-support*" が無い',
      ],
    ],
    [
      "if が無い・別の条件",
      workflow(
        step(
          "Verify runtime image has no test-support",
          verify("IMAGE"),
          "if: always()",
        ),
        lines(
          "      - name: Verify migrate image has no test-support",
          '        run: find / -path "*test-support*" -print',
        ),
      ),
      [
        "Verify runtime image has no test-support: if: steps.config.outputs.ready == 'true' が無い",
        "Verify migrate image has no test-support: if: steps.config.outputs.ready == 'true' が無い",
      ],
    ],
    [
      "名前の前方一致だけ（別の名前）",
      workflow(
        runtime,
        step(
          "Verify migrate image has no test-support files",
          verify("MIGRATE_IMAGE"),
        ),
      ),
      ["Verify migrate image has no test-support: ステップが無い"],
    ],
  ])("%s は違反", (_name, yaml, expected) => {
    expect(findDeployVerifyViolations(yaml)).toEqual(expected);
  });
});

describe("test-support（実ファイル）", () => {
  // WHY 規則ごとに it を分ける: fault injection（.dockerignore の行を消す・本番に import を足す）で、どの規則が効いたかを分けて見る。
  const violations = collectViolations(repoRoot);

  it("dockerignore-entry: .dockerignore に **/test-support の行がある", () => {
    expect(violations["dockerignore-entry"]).toEqual([]);
  });

  it("dockerignore-excludes: apps/*/test-support/ のすべてのファイルと test-support を import するテストが .dockerignore で除外される", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    const files = listDockerExcludedTargets(repoRoot);
    expect(files).toContain("apps/backend/test-support/database.ts");
    expect(files).toContain("apps/frontend_customer/test-support/i18n.tsx");
    expect(files).toContain(
      "apps/backend/features/todo/internal/infra/todo-repository.postgres.test.ts",
    );
    expect(files).toContain(
      "apps/frontend_customer/features/todo/components/todo-item.test.tsx",
    );
    // Issue #219 / #251: API 仕様（.feature・step・support.ts）と API ジャーニーの .feature も .dockerignore の **/spec で外す。
    expect(files).toContain("apps/backend/spec/api/todo/support.ts");
    expect(files).toContain("apps/backend/spec/api/todo/create-todo.feature");
    expect(files).toContain("apps/backend/spec/journey/todo-lifecycle.feature");
    expect(violations["dockerignore-excludes"]).toEqual([]);
  });

  it("production-imports-test-support: 本番のコードは test-support を import しない", () => {
    const files = listProductionSources(repoRoot);
    expect(files).toContain("apps/backend/shared/infra/database.ts");
    expect(files).toContain("apps/frontend_customer/shared/i18n/i18n.tsx");
    expect(violations["production-imports-test-support"]).toEqual([]);
  });

  it("deploy-verifies-images: deploy.yml が runtime と migrate のイメージに test-support が無いことを確かめる", () => {
    const yaml = readFileSync(join(repoRoot, DEPLOY_WORKFLOW), "utf8");
    // WHY ステップの区切りが働いていることを先に確かめる: 区切りが壊れて 1 つの塊になると、別のステップの run の test-support で通る。
    expect(readSteps(yaml).length).toBeGreaterThan(8);
    expect(findDeployVerifyViolations(yaml)).toEqual([]);
  });

  it("exports-test-support: apps/*/package.json の exports に test-support が無い", () => {
    const files = listAppPackageJsons(repoRoot);
    expect(files).toContain("apps/backend/package.json");
    expect(files).toContain("apps/shared/package.json");
    expect(violations["exports-test-support"]).toEqual([]);
  });

  it("in-memory-placement: apps/backend の *.in-memory のソースは apps/backend/test-support/ の下だけにある", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listBackendInMemorySources(repoRoot)).toContain(
      "apps/backend/test-support/todo/todo-repository.in-memory.ts",
    );
    expect(violations["in-memory-placement"]).toEqual([]);
  });
});
