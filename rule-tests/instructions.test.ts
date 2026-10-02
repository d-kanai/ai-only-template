// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストはファイルを読むだけで DOM を使わない。
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, posix } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect } from "vitest";
import { casesByName } from "./case-table";

// 指示ファイル（CLAUDE.md / .claude/rules / .claude/skills / .claude/agents）と ADR（docs/adr）の構成を
//   仕様として固定するテスト（Issue #64。ADR の検査は Issue #96、分類ディレクトリは Issue #100）。
// WHY 機械で検査する: 指示ファイルは「読み込まれているか」、ADR は「決まった形で一覧から辿れるか」を人が見落としやすい。
//   rules の paths の typo は、そのルールが黙って読み込まれなくなるだけで、何もエラーにならない（CLAUDE.md の原則 7）。
// ルール検査テスト（.claude/rules/quality/testing.md）なので、判定を関数に切り出し、架空の入力で must pass / must reject を固定してから、
//   一時ディレクトリの fixture と実リポジトリに同じ関数（collectInstructionViolations）を当てる。
//
// 検査すること（違反の文字列の先頭が検査の名前）:
//   claude-md-lines   CLAUDE.md は 200 行以下（公式 https://code.claude.com/docs/en/memory の目安。超えると起動時に警告）。
//   claude-md-import  CLAUDE.md とそこから @ で読むファイルの @path が、存在するファイルを指す。@ で読んでよいのは
//                     LEARNINGS.md だけ（常時読み込む量を増やさないため。常時の要点は .claude/rules/workflow/ に paths 無しで
//                     置けば自動で読まれ、規則は .claude/rules/<分類>/ に paths で置き、手順はスキルにする。Issue #315）。
//   always-lines      .claude/rules/workflow/*.md は 1 ファイル 25 行以下（常時読み込まれるため、短い要点だけにする）。
//   rule-tests-index  CLAUDE.md の「ルール検査テスト N 本」の N が rule-tests/ の直下の .feature の数と同じで、各名前を `<名前>` の
//                     コードスパンで持ち、.claude/rules/quality/testing.md の「今あるもの」が各 `rule-tests/<名前>.test.ts` を持つ（Issue #302）。
//                     WHY: 一覧は手で足すもので、PR #294 で design-system / screen-outline を足したときに両方の一覧に漏れ、testing.md は
//                     settings / work-logs-check も漏れていた。一覧に無いルール検査テストは、規則を探す人とエージェントから見えない。
//                     名前を探すのは CLAUDE.md の「ルール検査テスト N 本（」から最初の「。」までと、testing.md の「今あるもの:」で始まる行だけ。
//                     限界: 名前が書いてあるかだけを見る（説明の中身・消したテストの名前が残っていることは見ない）。
//   rules-category    .claude/rules の下の .md は .claude/rules/<分類>/<名前>.md（分類は RULE_CATEGORIES の 4 つ）に置く（Issue #315）。
//                     WHY: Claude Code は .claude/rules の下を再帰で読む（公式 https://code.claude.com/docs/en/memory 。2026-10-02 確認）
//                     ので置き場所は自由だが、分類を固定して「どこに何があるか」と「常時か paths か」を置き場所で読めるようにする。
//   rules-always      .claude/rules/workflow/*.md はフロントマターに paths を持たない（公式: paths の無い rule は起動時に読まれる。
//                     workflow/ は常時読み込む要点の置き場所なので、paths を書くと黙って常時でなくなる）。
//   rules-paths       workflow/ 以外の .claude/rules/<分類>/*.md はフロントマターに paths（1 件以上の glob）を持ち、各 glob がリポジトリの
//                     ファイルに 1 件以上一致する（一致しない glob は typo として扱う。そのルールは読み込まれないまま残るため。
//                     paths が無いと常時読み込まれ、常時の量が黙って増えるため）。
//   legacy-rules      旧 rules/ ディレクトリが無く、ファイルに rules/code/・rules/general/ への参照が残っていない
//                     （docs/work-logs/ は過去の記録なので除く。このファイルは例を持つので除く）。
//   legacy-general    旧 .claude/general/ ディレクトリが無く、ファイルに .claude/general/ への参照が残っていない（Issue #315 で
//                     .claude/rules/workflow/ に移した。docs/work-logs/ と、不変の記録の docs/adr/ と、このファイルは除く）。
//   ADR は docs/adr/<分類>/<ファイル名>（分類は ADR_CATEGORIES の 4 つ）。ADR への参照（置き換え先・一覧のリンク）は
//   docs/adr/ からの相対パス「<分類>/<ファイル名>」の 1 通りで書く。
//   adr-name          分類の直下のファイルの名前が yyyymmdd-<topic>.md（topic は英小文字・数字の kebab-case）。
//   adr-title         ADR の 1 行目が「# 」の見出し（決定を 1 文で書く）。
//   adr-meta          ADR の 3〜5 行目が「- 日付: YYYY-MM-DD」（ファイル名の日付と一致）・「- 状態: 採用 | 置き換え（→ <分類>/
//                     <ファイル名>。実在する ADR）| 廃止」・「- 関連: <空でない>」。分類なしのファイル名だけの置き換え先は違反。
//   adr-sections      ADR に「## 背景」「## 決定」「## 理由」「## 採用しなかった案」「## 影響」がこの順にある（間に別の見出しは可）。
//   adr-index         ADR が docs/adr/README.md の一覧から `](<分類>/<ファイル名>)` のリンクで辿れる。
//   adr-index-state   docs/adr/README.md の一覧の各行（最後の列がリンク）のリンク先が「<分類>/<ファイル名>」の ADR として実在し、
//                     「状態」列がその ADR の「- 状態:」の値と一致する（置き換えた決定を一覧で採用中と読み違えないため）。
//   adr-category      docs/adr/ の下のディレクトリが 4 つの分類（architecture / tech-stack / quality / workflow）のいずれかで、
//                     分類の下にさらにディレクトリが無い（Issue #100。アーキテクチャでない決定を分けて読めるようにした）。
//   adr-only          docs/ の直下には adr/ と work-logs/ しか無く、docs/adr/ の直下には README.md と分類ディレクトリしか無い
//                     （Issue #96 で docs/*.md の記録を廃止した。別の記録を足させない。Issue #100 で ADR を分類の下に移した。
//                     Issue #101 で作業ログをリポジトリ直下の work-logs/ から docs/work-logs/ に移した）。
//                     WHY（adr-*）: ADR は読み込まれない不変の記録で、決定が変わると「置き換え」で次の ADR に辿る。形が崩れると
//                     日付・状態・理由を取り出せず、一覧に無いと存在しないのと同じになる（Issue #96 で、廃止した docs の orphan-docs を置き換えた）。
//   skill-frontmatter .claude/skills/*/SKILL.md はフロントマターに name と description を持つ（公式 https://code.claude.com/docs/en/skills 。
//                     description は起動時に一覧として読まれ、いつ使うかの判断に使われる）。
//   agent-model       .claude/agents/*.md はフロントマターの model が許可したフル ID（ALLOWED_AGENT_MODELS）のいずれか
//                     （Issue #78。別名 `opus` / `sonnet` や古い ID は意図しないモデルに解決され、消費と品質が変わる。
//                     `.claude/rules/workflow/orchestration.md`、`docs/adr/workflow/20260929-save-usage-limit.md`）。
// .feature（instructions.feature）と step の実装（このファイル）に分けた（Issue #282）。

const repoRoot = join(import.meta.dirname, "..");
const SELF = "rule-tests/instructions.test.ts";

const CLAUDE_MD = "CLAUDE.md";
const CLAUDE_MD_MAX_LINES = 200;
const ALWAYS_MAX_LINES = 25;
// 常時読み込む rule の置き場所（paths を持たない）。
const ALWAYS_RULES_DIR = ".claude/rules/workflow/";
// .claude/rules の分類（Issue #315 のユーザー判断）。workflow は常時、ほかは paths で読む。
// WHY 固定の集合にする: 分類を自由に足せると、置き場所から「何の規則か」「常時か」が読めなくなる。足すときはここと CLAUDE.md の表を直す。
const RULE_CATEGORIES = ["code", "quality", "tooling", "workflow"];

function countLines(text: string): number {
  // WHY 末尾の改行を 1 行と数えない: エディタの行数（wc -l）と合わせる。
  return text.replace(/\n$/, "").split("\n").length;
}

// CLAUDE.md と .claude/rules/workflow/*.md の行数の上限を超えたもの。
function findLineViolations(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => {
    const isClaudeMd = path === CLAUDE_MD;
    const max = isClaudeMd ? CLAUDE_MD_MAX_LINES : ALWAYS_MAX_LINES;
    const lines = countLines(text);
    if (lines <= max) return [];
    const check = isClaudeMd ? "claude-md-lines" : "always-lines";
    return [`${check}: ${path} が ${lines} 行（上限 ${max}）`];
  });
}

// --- @ import の抽出 ---
// 公式（memory）の仕様: `@path/to/import` の形で、相対パスは import を書いたファイルからの相対で解決する。コードスパンと
//   コードブロックの中は import として評価されない。
// 抽出の仕様（下の must pass / must reject で固定する）: 行頭か空白の直後の `@` から、次の空白までをパスとする。
//   コードブロック（``` で囲んだ行）とコードスパン（`...`）の中は読まない。
// 未確認: Claude Code 自身の抽出がこれと同じ区切り（全角の括弧の直後の @ など）かは確かめていない。区切りが違っても、
//   ここで拾う形（空白の直後）だけで書けば、実際の読み込みと検査が食い違わない。
function stripCode(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

function extractImports(markdown: string): string[] {
  return [...stripCode(markdown).matchAll(/(?:^|\s)@(\S+)/g)].map(
    (match) => match[1] ?? "",
  );
}

// WHY .claude/rules/workflow/ も許さない: paths の無い rule は自動で読まれるので、@ で読むと同じ内容が 2 度入る。
function isAllowedImportTarget(path: string): boolean {
  return path === "LEARNINGS.md";
}

type FileReader = (path: string) => string | undefined;

// CLAUDE.md から @ で辿れるファイルを順に検査する（読んだファイルの @ も辿る）。
function findImportViolations(read: FileReader): string[] {
  const violations: string[] = [];
  const visited = new Set<string>();
  const queue = [CLAUDE_MD];
  while (queue.length > 0) {
    const source = queue.shift() ?? CLAUDE_MD;
    if (visited.has(source)) continue;
    visited.add(source);
    for (const target of extractImports(read(source) ?? "")) {
      const resolved = posix.normalize(
        posix.join(posix.dirname(source), target),
      );
      if (read(resolved) === undefined) {
        violations.push(`claude-md-import: ${source} → @${target}（無い）`);
      } else if (!isAllowedImportTarget(resolved)) {
        violations.push(
          `claude-md-import: ${source} → @${target}（LEARNINGS.md 以外）`,
        );
      } else {
        queue.push(resolved);
      }
    }
  }
  return violations;
}

// --- フロントマター ---
// 読み取りの仕様: 先頭行が `---` で、次の `---` の行までをフロントマターとする。`key: value` をスカラー、値が空の `key:` の
//   後ろに続く `  - item` をリストとして読む。値の前後の '...' / "..." は外す。
// WHY YAML のパーサを足さない: 読みたいのは paths（glob のリスト）と name / description（1 行の文字列）だけで、行の読み取りで
//   足りる（依存を増やすとサプライチェーンの対象も増える。.claude/rules/tooling/dependencies.md）。
// 限界: フロー形式（`paths: ["a", "b"]`）や複数行の文字列は読まない（paths が無い・値が空として違反になる。見逃す方向ではない）。
type Frontmatter = Record<string, string | string[]>;

function unquote(text: string): string {
  return text.match(/^(['"])(.*)\1$/)?.[2] ?? text;
}

// 先頭の `---` と次の `---` の間の行。フロントマターが無ければ undefined。
function frontmatterLines(markdown: string): string[] | undefined {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  return end < 0 ? undefined : lines.slice(1, end);
}

// 1 行を result に読み込み、次の行がリストの要素として続けてよいキー（値が空の `key:` の直後だけ）を返す。
function readFrontmatterLine(
  result: Frontmatter,
  listKey: string | undefined,
  line: string,
): string | undefined {
  const item = line.match(/^\s+-\s+(.*)$/);
  const list = listKey === undefined ? undefined : result[listKey];
  if (item && Array.isArray(list)) {
    list.push(unquote((item[1] ?? "").trim()));
    return listKey;
  }
  const entry = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
  if (!entry) return undefined;
  const [, key = "", value = ""] = entry;
  const isList = value.trim() === "";
  result[key] = isList ? [] : unquote(value.trim());
  return isList ? key : undefined;
}

function parseFrontmatter(markdown: string): Frontmatter | undefined {
  const lines = frontmatterLines(markdown);
  if (lines === undefined) return undefined;
  const result: Frontmatter = {};
  let listKey: string | undefined;
  for (const line of lines) {
    listKey = readFrontmatterLine(result, listKey, line);
  }
  return result;
}

// .claude/rules/<分類>/<name>.md 1 つの違反。files はリポジトリのファイル（リポジトリ相対のパス）。
function findRuleFileViolations(
  path: string,
  markdown: string,
  files: string[],
): string[] {
  const category = /^\.claude\/rules\/([^/]+)\/[^/]+\.md$/.exec(path)?.[1];
  if (category === undefined || !RULE_CATEGORIES.includes(category)) {
    return [
      `rules-category: ${path} が .claude/rules/<分類>/<名前>.md（分類は ${RULE_CATEGORIES.join(" / ")}）でない`,
    ];
  }
  const frontmatter = parseFrontmatter(markdown);
  if (path.startsWith(ALWAYS_RULES_DIR)) {
    // WHY キーの有無で見る: 空の paths: や値の崩れた paths も、Claude Code の読み方次第で常時でなくなりうるので書かせない。
    return frontmatter !== undefined && "paths" in frontmatter
      ? [
          `rules-always: ${path} に paths がある（workflow/ は常時読み込むので paths を持たない）`,
        ]
      : [];
  }
  const paths = frontmatter?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return [`rules-paths: ${path} にフロントマターの paths（1 件以上）が無い`];
  }
  return paths
    .filter((glob) => !files.some((file) => matchesGlob(file, glob)))
    .map(
      (glob) =>
        `rules-paths: ${path} の glob "${glob}" に一致するファイルが無い`,
    );
}

function findSkillViolations(path: string, markdown: string): string[] {
  const frontmatter = parseFrontmatter(markdown);
  return ["name", "description"]
    .filter((key) => {
      const value = frontmatter?.[key];
      return typeof value !== "string" || value === "";
    })
    .map((key) => `skill-frontmatter: ${path} に ${key} が無い`);
}

// --- サブエージェントの model ---
// WHY フル ID だけを許す: `opus` のような別名は Claude Code の版で解決先が変わり、古い ID はフォールバックや拒否になる。
//   どのモデルで動くかを定義ファイルの差分で読めるようにし、機械的な作業に軽いモデル（Sonnet）を使う運用
//   （docs/adr/workflow/20260929-save-usage-limit.md）で
//   意図したモデルだけが使われるようにする。
const ALLOWED_AGENT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5"];

function findAgentModelViolations(path: string, markdown: string): string[] {
  const model = parseFrontmatter(markdown)?.model;
  if (typeof model === "string" && ALLOWED_AGENT_MODELS.includes(model)) {
    return [];
  }
  const shown = typeof model === "string" ? `"${model}"` : "無し";
  return [
    `agent-model: ${path} の model が ${shown}（許可: ${ALLOWED_AGENT_MODELS.join(" / ")}）`,
  ];
}

// --- 旧 rules/ への参照 ---
// WHY .claude/rules/ を除く: 新しい置き場所（.claude/rules/general.md のような名前）を旧パスと取り違えないため。
// 注意: 分類 code の rule を `.claude/` を付けずに `rules/code/x.md` と略すと、旧パスとして違反になる（誤検出の方向。常に `.claude/` から書く）。
const LEGACY_REFERENCE = /(?<!\.claude\/)\brules\/(?:code|general)\b/;

const WORK_LOGS_DIR = "docs/work-logs/";

function isLegacyScanTarget(path: string): boolean {
  return !path.startsWith(WORK_LOGS_DIR) && path !== SELF;
}

function findLegacyReferences(path: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      LEGACY_REFERENCE.test(line) ? [`legacy-rules: ${path}:${index + 1}`] : [],
    );
}

// --- 旧 .claude/general への参照 ---
// WHY docs/adr/ も除く: ADR は不変の記録で、当時の置き場所の名前を書き換えない（置き換えの ADR で辿る）。
// 限界: 末尾の / の無い `.claude/general` は見ない（移した経緯の説明文に名前だけ出すため。ファイルへの参照は / を伴う）。
const LEGACY_GENERAL_REFERENCE = /\.claude\/general\//;

function isLegacyGeneralScanTarget(path: string): boolean {
  return isLegacyScanTarget(path) && !path.startsWith(ADR_DIR);
}

function findLegacyGeneralReferences(path: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      LEGACY_GENERAL_REFERENCE.test(line)
        ? [`legacy-general: ${path}:${index + 1}`]
        : [],
    );
}

// --- ADR（docs/adr） ---
// 形式の正は docs/adr/README.md（命名・不変の規則・テンプレート・一覧）。ここはその形を機械で固定する。
// 読み取りの仕様: ADR は行の位置で読む（1 行目が見出し、2 行目は空行、3〜5 行目がメタ）。テンプレートの形そのままで、
//   位置がずれたら違反にする（メタを本文の途中に書くと、日付・状態を機械で取り出せなくなるため）。
// 限界: 見出しは行の完全一致で探すので、コードブロックの中に「## 背景」と書いた行も見出しとして数える（見逃す方向。
//   ADR にテンプレートを貼ることは無い想定。テンプレートは README.md にだけ置き、README.md は検査しない）。
const ADR_DIR = "docs/adr/";
const ADR_INDEX = "docs/adr/README.md";
// 分類（Issue #100 のユーザー判断）。分類ごとに置くものは docs/adr/README.md の一覧に 1 行ずつ書く。
// WHY 固定の集合にする: 分類は「どれがアーキテクチャの決定か」を読み分けるためのもので、自由に足せると同じ種類の決定が
//   別の名前の分類に散り、分けた意味が無くなる。分類を足すときは、ここと README.md の説明を同じ変更で直す。
const ADR_CATEGORIES = ["architecture", "tech-stack", "quality", "workflow"];
const ADR_REQUIRED_SECTIONS = [
  "## 背景",
  "## 決定",
  "## 理由",
  "## 採用しなかった案",
  "## 影響",
];

type AdrFile = { path: string; text: string };

// ADR の形式の検査（adr-name ほか）の対象: docs/adr/<4 つの分類のいずれか>/<ファイル>。拡張子や名前は問わない（adr-name が見る）。
// WHY 分類でない場所のファイルを対象から外す: そこに置いたこと自体を adr-category / adr-only の 1 件で示し、同じファイルに
//   adr-name や adr-index の違反を重ねない（原因が置き場所 1 つだと読めるようにする）。docs/adr/ の下のファイルは、
//   この対象・adr-category・adr-only・README.md のどれかに必ず入るので、形式の検査から黙って外れるファイルは無い。
function isAdrFile(file: string): boolean {
  const category = file.match(/^docs\/adr\/([^/]+)\/[^/]+$/)?.[1];
  return category !== undefined && ADR_CATEGORIES.includes(category);
}

// ADR への参照の形（docs/adr/ からの相対パス「<分類>/<ファイル名>」）。一覧のリンクと「置き換え（→ ...）」はこの形で書く。
function adrRef(path: string): string {
  return path.slice(ADR_DIR.length);
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ファイル名の日付（yyyymmdd）。名前が yyyymmdd-<topic>.md の形でなければ undefined。
// WHY topic を英小文字・数字の kebab-case に限る: ファイル名は一覧のリンクと「置き換え（→ ...）」の参照先になり、
//   大文字・空白・全角が混ざると環境（大文字小文字を区別しない FS など）で参照がずれる。
function adrNameDate(name: string): string | undefined {
  return /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)
    ? name.slice(0, 8)
    : undefined;
}

function findAdrMetaViolations(
  path: string,
  lines: string[],
  nameDate: string | undefined,
  adrRefs: string[],
): string[] {
  const violations: string[] = [];
  const date = lines[2]?.match(/^- 日付: (\d{4})-(\d{2})-(\d{2})$/);
  if (!date) {
    violations.push(
      `adr-meta: ${path} の 3 行目が「- 日付: YYYY-MM-DD」でない`,
    );
  } else if (nameDate !== undefined && date.slice(1).join("") !== nameDate) {
    // WHY ファイル名と一致させる: 一覧はファイル名の順に並ぶので、ずれると決定の前後関係を読み違える。
    violations.push(
      `adr-meta: ${path} の日付 ${date.slice(1).join("-")} がファイル名の ${nameDate} と違う`,
    );
  }
  const status = lines[3]?.match(/^- 状態: (?:採用|廃止|置き換え（→ (\S+)）)$/);
  if (!status) {
    violations.push(
      `adr-meta: ${path} の 4 行目が「- 状態: 採用 | 置き換え（→ <分類>/<ファイル名>）| 廃止」でない`,
    );
  } else if (status[1] !== undefined && !adrRefs.includes(status[1])) {
    // WHY 置き換え先の実在を見る: 不変の ADR は「置き換え」から次の ADR に辿って最新の決定を知る。参照先が無いと辿れない。
    // WHY 「<分類>/<ファイル名>」の完全一致にする: 分類なしのファイル名だけ・./ 付き・ADR からの相対（../）を許すと、同じ ADR を
    //   指す書き方が増え、分類を移したときに古い参照を機械で見つけられなくなる。一覧のリンクと同じ形に揃える。
    violations.push(
      `adr-meta: ${path} の置き換え先 ${status[1]} が docs/adr に無い（<分類>/<ファイル名> で書く）`,
    );
  }
  if (!/^- 関連: \S/.test(lines[4] ?? "")) {
    violations.push(
      `adr-meta: ${path} の 5 行目が「- 関連: <Issue / PR / 規則>」でない`,
    );
  }
  return violations;
}

function findAdrSectionViolations(path: string, lines: string[]): string[] {
  const positions = ADR_REQUIRED_SECTIONS.map((heading) =>
    lines.indexOf(heading),
  );
  const missing = ADR_REQUIRED_SECTIONS.filter(
    (_heading, index) => (positions[index] ?? -1) < 0,
  );
  if (missing.length > 0) {
    return missing.map(
      (heading) => `adr-sections: ${path} に「${heading}」が無い`,
    );
  }
  const inOrder = positions.every(
    (position, index) => index === 0 || position > (positions[index - 1] ?? -1),
  );
  return inOrder
    ? []
    : [
        `adr-sections: ${path} の見出しが 背景 → 決定 → 理由 → 採用しなかった案 → 影響 の順でない`,
      ];
}

// adrs は ADR（isAdrFile のファイル）、index は docs/adr/README.md の中身（無ければ undefined）。
function findAdrViolations(
  adrs: AdrFile[],
  index: string | undefined,
): string[] {
  const adrRefs = adrs.map(({ path }) => adrRef(path));
  return adrs.flatMap(({ path, text }) => {
    const nameDate = adrNameDate(fileName(path));
    const lines = text.split("\n");
    return [
      ...(nameDate === undefined
        ? [
            `adr-name: ${path} の名前が yyyymmdd-<topic>.md（topic は英小文字・数字の kebab-case）でない`,
          ]
        : []),
      ...(/^# \S/.test(lines[0] ?? "")
        ? []
        : [`adr-title: ${path} の 1 行目が「# 」の見出しでない`]),
      ...findAdrMetaViolations(path, lines, nameDate, adrRefs),
      ...findAdrSectionViolations(path, lines),
      ...((index ?? "").includes(`](${adrRef(path)})`)
        ? []
        : [`adr-index: ${path} が ${ADR_INDEX} の一覧に無い`]),
    ];
  });
}

// ADR の「- 状態:」の値（4 行目。形が崩れていれば行そのもの。形の違反は adr-meta が別に出す）。
function adrStatus(text: string): string {
  const line = text.split("\n")[3] ?? "";
  return line.startsWith("- 状態: ") ? line.slice("- 状態: ".length) : line;
}

// README.md の一覧の行（最後の列が `[...](<分類>/<ファイル名>)` のリンクの行）と、各 ADR の突き合わせ。
// 読み取りの仕様: `|` で始まり `|` で終わる行を列に分け、最後の列のリンク先を ADR への参照、その 1 つ前の列を状態とする。
//   分類ごとに表が分かれていても、行ごとに読むので同じに扱う。リンク先は adrRef と完全一致で探す（分類なし・./ 付きは無い扱い）。
//   見出しの行・区切りの行（最後の列にリンクが無い）は読まない。タイトルの列に `|` が混ざっても、後ろから数えるので
//   状態とファイルの列はずれない。
// WHY 一覧の状態を ADR と一致させる: 一覧は「今どの決定が生きているか」を読む場所で、ADR を「置き換え」にしても一覧を
//   直し忘れると、置き換わった決定を採用中と読んでしまう。リンク先の実在を見るのは、改名・削除の後に一覧から辿れない
//   行が残らないようにするため（adr-index は ADR → 一覧の向き、ここは一覧 → ADR の向き）。
function findAdrIndexStateViolations(
  adrs: AdrFile[],
  index: string | undefined,
): string[] {
  const statusByRef = new Map(
    adrs.map(({ path, text }) => [adrRef(path), adrStatus(text)]),
  );
  return (index ?? "").split("\n").flatMap((line) => {
    const row = line.trim().match(/^\|(.*)\|$/);
    if (!row) return [];
    const cells = (row[1] ?? "").split("|").map((cell) => cell.trim());
    const target = cells.at(-1)?.match(/^\[[^\]]*\]\(([^)]+)\)$/)?.[1];
    if (target === undefined) return [];
    const expected = statusByRef.get(target);
    if (expected === undefined) {
      return [
        `adr-index-state: ${ADR_INDEX} の一覧の ${target} が docs/adr に無い`,
      ];
    }
    const listed = cells.at(-2) ?? "";
    return listed === expected
      ? []
      : [
          `adr-index-state: ${ADR_INDEX} の一覧の ${target} の状態「${listed}」が ADR の「${expected}」と違う`,
        ];
  });
}

// docs/adr/ の下のディレクトリのうち、4 つの分類でないもの・分類の下のディレクトリ（ディレクトリごとに 1 項目、末尾に /）。
// WHY 分類の下にディレクトリを置かせない: ADR への参照を「<分類>/<ファイル名>」の 1 通りにし、一覧・置き換えの検査で
//   深さの違う書き方を考えずに済むようにする。分類の中をさらに分けたくなったら、分類を見直す（ADR_CATEGORIES）。
// docs/adr/ の直下のファイルはここでは見ない（adr-only が見る）。
function findAdrCategoryViolations(files: string[]): string[] {
  const entries = new Set(
    files
      .filter((file) => file.startsWith(ADR_DIR))
      .flatMap((file) => {
        const [category = "", child = "", ...deeper] = file
          .slice(ADR_DIR.length)
          .split("/");
        if (child === "") return [];
        if (!ADR_CATEGORIES.includes(category)) {
          return [
            `adr-category: ${ADR_DIR}${category}/ は分類（${ADR_CATEGORIES.join(" / ")}）でない`,
          ];
        }
        return deeper.length > 0
          ? [
              `adr-category: ${ADR_DIR}${category}/${child}/ がある（分類の下にディレクトリは置けない）`,
            ]
          : [];
      }),
  );
  return [...entries];
}

// docs/ の直下に adr/ と work-logs/ 以外のファイル・ディレクトリがあれば、その項目（ディレクトリは末尾に /）。続けて、
//   docs/adr/ の直下の README.md 以外のファイル。docs/work-logs/ の中の構成は見ない（作業ログの置き方は
//   .claude/rules/workflow/work-log.md。CI の check-work-logs-diff.sh はサブディレクトリの .md も数える）。
// WHY docs/ を ADR と作業ログだけにする: Issue #96 で docs/*.md（実測・経緯の記録）を廃止し、決定は ADR、実測は作業ログ、
//   一次情報は規則の WHY に振り分けた。docs/ に別の記録を足せる状態だと、同じ二重管理（最新の規則と記録のずれ）が戻る。
//   Issue #101 で作業ログを docs/work-logs/ に移し、読み込まれない記録を docs/ の 2 つにまとめた（ユーザー指示）。
// WHY docs/adr/ の直下を README.md だけにする: Issue #100 で ADR を分類の下に移した。直下に ADR を置けると、分類の無い ADR が
//   増えて分類で読み分けられなくなる（直下のファイルは形式の検査の対象にも入らない。isAdrFile）。
// 限界: 列挙は git ls-files なので、ファイルの無い空のディレクトリは見えない（git でも追跡されないので実害は無い）。
function findNonAdrDocs(files: string[]): string[] {
  const entries = new Set(
    files
      .filter(
        (file) =>
          file.startsWith("docs/") &&
          !file.startsWith(ADR_DIR) &&
          !file.startsWith(WORK_LOGS_DIR),
      )
      .map((file) => {
        const rest = file.slice("docs/".length);
        const slash = rest.indexOf("/");
        return `docs/${slash < 0 ? rest : rest.slice(0, slash + 1)}`;
      }),
  );
  const adrRootFiles = files.filter(
    (file) =>
      file.startsWith(ADR_DIR) &&
      file !== ADR_INDEX &&
      !file.slice(ADR_DIR.length).includes("/"),
  );
  return [
    ...[...entries].map(
      (entry) =>
        `adr-only: ${entry} がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）`,
    ),
    ...adrRootFiles.map(
      (file) =>
        `adr-only: ${file} がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）`,
    ),
  ];
}

// --- ルール検査テストの一覧 ---
const TESTING_MD = ".claude/rules/quality/testing.md";

const RULE_TEST_FEATURE = /^rule-tests\/([^/]+)\.feature$/;

// ルール検査テストの名前。rule-tests/ の直下の .feature で数える（.feature と step の実装の対は rule-tests/rule-test-feature.test.ts が
//   強制するので、.feature の数 = ルール検査テストの数）。
function ruleTestNames(files: string[]): string[] {
  return files
    .map((file) => RULE_TEST_FEATURE.exec(file)?.[1])
    .filter((name) => name !== undefined)
    .sort();
}

// CLAUDE.md の「ルール検査テスト N 本（`<名前>` / …。」と .claude/rules/quality/testing.md の「今あるもの:」の行の `rule-tests/<名前>.test.ts` が、
//   rule-tests/ の実際のルール検査テストとそろっているか。
function findRuleTestIndexViolations(
  names: string[],
  read: FileReader,
): string[] {
  if (names.length === 0) return [];
  // WHY 一覧の範囲だけを見る: CLAUDE.md の同じ行の Issue の注記や testing.md のほかの節にも名前が出るので、ファイル全体で
  //   探すと一覧から消した名前を見逃す（reviewer の指摘）。範囲が見つからなければ空とし、すべての名前を違反にする。
  const claudeMdMatch = /ルール検査テスト (\d+) 本（([^。\n]*)/.exec(
    read(CLAUDE_MD) ?? "",
  );
  const written = claudeMdMatch?.[1];
  const claudeMd = claudeMdMatch?.[2] ?? "";
  const testingMd =
    (read(TESTING_MD) ?? "")
      .split("\n")
      .find((line) => line.startsWith("今あるもの:")) ?? "";
  const countViolations =
    written === undefined
      ? [
          `rule-tests-index: CLAUDE.md に「ルール検査テスト ${names.length} 本」の記載が無い`,
        ]
      : Number(written) === names.length
        ? []
        : [
            `rule-tests-index: CLAUDE.md の「ルール検査テスト ${written} 本」が rule-tests/*.feature の ${names.length} 本と違う`,
          ];
  return [
    ...countViolations,
    ...names
      .filter((name) => !claudeMd.includes(`\`${name}\``))
      .map((name) => `rule-tests-index: CLAUDE.md に \`${name}\` が無い`),
    ...names
      .filter((name) => !testingMd.includes(`\`rule-tests/${name}.test.ts\``))
      .map(
        (name) =>
          `rule-tests-index: ${TESTING_MD} に \`rule-tests/${name}.test.ts\` が無い`,
      ),
  ];
}

// --- リポジトリ全体 ---
// リポジトリのファイル（追跡済みと、.gitignore に無い未追跡）。削除済みで作業ツリーに無いものは除く。
// WHY 未追跡も含める: 作業中（コミット前）に足した ADR や rules の paths も同じ条件で検査するため。コミット後は追跡済みと同じ。
function listRepoFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(output.split("\n").filter((line) => line !== ""))]
    .filter((file) => existsSync(join(root, file)))
    .sort();
}

type Inventory = {
  files: string[];
  ruleFiles: string[];
  alwaysFiles: string[];
  adrs: string[];
  skills: string[];
  agents: string[];
  ruleTests: string[];
};

function inventory(files: string[]): Inventory {
  return {
    files,
    // WHY 下のすべての .md: Claude Code は再帰で読むので、分類の外に置いたものも rules-category で拾う。
    ruleFiles: files.filter((file) => /^\.claude\/rules\/.+\.md$/.test(file)),
    alwaysFiles: files.filter((file) =>
      /^\.claude\/rules\/workflow\/[^/]+\.md$/.test(file),
    ),
    // WHY .md に限らず分類の直下をすべて数える: `.MD` や `.txt` に置いた ADR も adr-name で違反にし、形式の検査から黙って
    //   外れないようにする。分類の外・分類の下のディレクトリに置いたものは adr-category / adr-only が拾う（isAdrFile）。
    adrs: files.filter(isAdrFile),
    skills: files.filter((file) =>
      /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file),
    ),
    agents: files.filter((file) => /^\.claude\/agents\/[^/]+\.md$/.test(file)),
    ruleTests: ruleTestNames(files),
  };
}

function collectInstructionViolations(
  root: string,
  found: Inventory,
): string[] {
  const read: FileReader = (path) =>
    found.files.includes(path)
      ? readFileSync(join(root, path), "utf8")
      : undefined;
  return [
    ...findLineViolations(
      [CLAUDE_MD, ...found.alwaysFiles].map((path) => ({
        path,
        text: read(path) ?? "",
      })),
    ),
    ...findImportViolations(read),
    ...findRuleTestIndexViolations(found.ruleTests, read),
    ...found.ruleFiles.flatMap((path) =>
      findRuleFileViolations(path, read(path) ?? "", found.files),
    ),
    ...(existsSync(join(root, "rules")) ? ["legacy-rules: rules/ がある"] : []),
    ...found.files
      .filter(isLegacyScanTarget)
      .flatMap((path) => findLegacyReferences(path, read(path) ?? "")),
    ...(existsSync(join(root, ".claude/general"))
      ? ["legacy-general: .claude/general/ がある"]
      : []),
    ...found.files
      .filter(isLegacyGeneralScanTarget)
      .flatMap((path) => findLegacyGeneralReferences(path, read(path) ?? "")),
    ...findAdrViolations(
      found.adrs.map((path) => ({ path, text: read(path) ?? "" })),
      read(ADR_INDEX),
    ),
    ...findAdrIndexStateViolations(
      found.adrs.map((path) => ({ path, text: read(path) ?? "" })),
      read(ADR_INDEX),
    ),
    ...findAdrCategoryViolations(found.files),
    ...findNonAdrDocs(found.files),
    ...found.skills.flatMap((path) =>
      findSkillViolations(path, read(path) ?? ""),
    ),
    ...found.agents.flatMap((path) =>
      findAgentModelViolations(path, read(path) ?? ""),
    ),
  ];
}

// fixture のリポジトリ（「fixture のリポジトリを検査したときに検出される違反」の Scenario）を置く一時ディレクトリ。
let dir: string;

beforeAll(() => {
  // WHY OS の一時ディレクトリ: リポジトリの中に置くと、テストが途中で落ちたときに作業ツリーに残る（.claude/rules/quality/testing.md）。
  dir = mkdtempSync(join(tmpdir(), "instructions-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const feature = await loadFeature("./instructions.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("CLAUDE.md の行数と @ import の抽出", ({ And }) => {
    And("行数は末尾の改行を数えない（wc -l と同じ）", () => {
      // given: 前提なし
      // when
      const result = countLines("a\nb\n");

      // then
      expect(result).toBe(2);

      // when
      const twoLineCount = countLines("a\nb");

      // then
      expect(twoLineCount).toBe(2);

      // when
      const blankLineCount = countLines("a\n\nb\n");

      // then
      expect(blankLineCount).toBe(3);
    });

    And(
      "CLAUDE.md は 200 行まで、.claude/rules/workflow は 25 行までを許し、超えたら違反にする",
      () => {
        // given
        const lines = (count: number) => "x\n".repeat(count);

        // when
        const violations = findLineViolations([
          { path: "CLAUDE.md", text: lines(200) },
          { path: ".claude/rules/workflow/a.md", text: lines(25) },
        ]);

        // then
        expect(violations).toEqual([]);

        // when
        const overLimitViolations = findLineViolations([
          { path: "CLAUDE.md", text: lines(201) },
          { path: ".claude/rules/workflow/a.md", text: lines(26) },
        ]);

        // then
        expect(overLimitViolations).toEqual([
          "claude-md-lines: CLAUDE.md が 201 行（上限 200）",
          "always-lines: .claude/rules/workflow/a.md が 26 行（上限 25）",
        ]);
      },
    );

    And(
      "行頭か空白の直後の @path を import として拾う（must reject 側の入力）",
      () => {
        // given: 前提なし
        // when
        const imports = extractImports(
          "@LEARNINGS.md\n- ブランチ: @docs/branch.md\n",
        );

        // then
        expect(imports).toEqual(["LEARNINGS.md", "docs/branch.md"]);
      },
    );

    And(
      "コードブロック・コードスパン・メールアドレスの @ は拾わない（must pass 側の入力）",
      () => {
        // given: 前提なし
        // when
        const imports = extractImports(
          "```\n@rules/code/test.md\n```\n`@x.md` と a@b.com と `pnpm --filter @repo/backend`\n",
        );

        // then
        expect(imports).toEqual([]);
      },
    );

    And(
      "@ で読んでよいのは LEARNINGS.md だけ（.claude/rules/workflow は paths 無しで自動で読まれる）",
      () => {
        // given: 前提なし
        // when
        const result = isAllowedImportTarget("LEARNINGS.md");

        // then
        expect(result).toBe(true);

        // when
        const alwaysAllowed = isAllowedImportTarget(
          ".claude/rules/workflow/commit.md",
        );

        // then
        expect(alwaysAllowed).toBe(false);

        // when
        const rulesAllowed = isAllowedImportTarget(
          ".claude/rules/code/backend.md",
        );

        // then
        expect(rulesAllowed).toBe(false);

        // when
        const nestedAllowed = isAllowedImportTarget("docs/LEARNINGS.md");

        // then
        expect(nestedAllowed).toBe(false);

        // when
        const adrAllowed = isAllowedImportTarget("docs/adr/README.md");

        // then
        expect(adrAllowed).toBe(false);

        // when
        const legacyAllowed = isAllowedImportTarget(
          ".claude/general/workflow.md",
        );

        // then
        expect(legacyAllowed).toBe(false);
      },
    );

    And(
      "無いファイル・許可外のファイルへの @ を違反にし、読んだファイルの @ も辿る",
      () => {
        // given
        const files: Record<string, string> = {
          "CLAUDE.md": "@LEARNINGS.md\n@missing.md\n@docs/adr/README.md\n",
          "LEARNINGS.md": "@b.md と @./LEARNINGS.md\n",
          "docs/adr/README.md": "一覧\n",
        };

        // when
        const violations = findImportViolations((path) => files[path]);

        // then
        expect(violations).toEqual([
          "claude-md-import: CLAUDE.md → @missing.md（無い）",
          "claude-md-import: CLAUDE.md → @docs/adr/README.md（LEARNINGS.md 以外）",
          "claude-md-import: LEARNINGS.md → @b.md（無い）",
        ]);
      },
    );

    And("許可されたファイルだけを指す @ は違反にしない", () => {
      // given
      const files: Record<string, string> = {
        "CLAUDE.md": "@LEARNINGS.md\n",
        "LEARNINGS.md": "学び\n",
      };

      // when
      const violations = findImportViolations((path) => files[path]);

      // then
      expect(violations).toEqual([]);
    });
  });

  Scenario(".claude/rules の分類とフロントマター", ({ And }) => {
    const files = [
      "apps/backend/features/todo/internal/domain/todo.ts",
      "biome.json",
      "lint.test.ts",
    ];

    And("paths のリストを読み、クォートを外す", () => {
      // given: 前提なし
      // when
      const frontmatter = parseFrontmatter(
        '---\npaths:\n  - "apps/backend/**"\n  - biome.json\n---\n本文\n',
      );

      // then
      expect(frontmatter).toEqual({ paths: ["apps/backend/**", "biome.json"] });
    });

    And(
      ".claude/rules/<分類>/<名前>.md（分類は code / quality / tooling / workflow）でなければ違反にする（must reject）（直下・分類でない・分類の下のディレクトリ・大文字）",
      () => {
        // given
        const markdown = '---\npaths:\n  - "apps/backend/**"\n---\n';
        const cases: [string][] = [
          [".claude/rules/backend.md"],
          [".claude/rules/misc/backend.md"],
          [".claude/rules/code/sub/backend.md"],
          [".claude/rules/Code/backend.md"],
          [".claude/rules/codes/backend.md"],
        ];

        // when
        const result = casesByName(cases, ([path]) =>
          findRuleFileViolations(path, markdown, files),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([path]) => [
            `rules-category: ${path} が .claude/rules/<分類>/<名前>.md（分類は code / quality / tooling / workflow）でない`,
          ]),
        );
      },
    );

    And("workflow/ は paths が無ければ違反にしない（must pass）", () => {
      // given
      const cases: [string][] = [
        ["# 常時の要点\n"],
        ["---\nname: x\n---\n本文\n"],
      ];

      // when
      const result = casesByName(cases, ([markdown]) =>
        findRuleFileViolations(".claude/rules/workflow/x.md", markdown, files),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => []));
    });

    And(
      "workflow/ に paths があれば違反にする（must reject。常時読み込むため）",
      () => {
        // given
        const cases: [string][] = [
          ['---\npaths:\n  - "apps/backend/**"\n---\n'],
          ["---\npaths:\n---\n"],
          ['---\npaths: "apps/backend/**"\n---\n'],
        ];

        // when
        const result = casesByName(cases, ([markdown]) =>
          findRuleFileViolations(
            ".claude/rules/workflow/x.md",
            markdown,
            files,
          ),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            "rules-always: .claude/rules/workflow/x.md に paths がある（workflow/ は常時読み込むので paths を持たない）",
          ]),
        );
      },
    );

    And("すべての glob がファイルに一致すれば違反にしない（must pass）", () => {
      // given: 前提なし
      // when
      const violations = findRuleFileViolations(
        ".claude/rules/code/x.md",
        '---\npaths:\n  - "apps/backend/**"\n  - "biome.json"\n  - "*.test.ts"\n---\n',
        files,
      );

      // then
      expect(violations).toEqual([]);
    });

    And(
      "フロントマターの paths が無い・閉じていない・空・スカラー・コメントアウトなら違反にする（must reject）",
      () => {
        // given
        const cases: [string, string][] = [
          ["フロントマターが無い", "# 本文だけ\n"],
          ["閉じの --- が無い", '---\npaths:\n  - "apps/backend/**"\n'],
          ["paths が無い", "---\nname: x\n---\n"],
          ["paths が空", "---\npaths:\n---\n"],
          ["paths がスカラー", '---\npaths: "apps/backend/**"\n---\n'],
          [
            "paths がコメントアウト",
            '---\n# paths:\n#   - "apps/backend/**"\n---\n',
          ],
        ];

        // when
        const result = casesByName(cases, ([, markdown]) =>
          findRuleFileViolations(".claude/rules/code/x.md", markdown, files),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            "rules-paths: .claude/rules/code/x.md にフロントマターの paths（1 件以上）が無い",
          ]),
        );
      },
    );

    And(
      "どのファイルにも一致しない glob（typo）を違反にする（must reject）",
      () => {
        // given: 前提なし
        // when
        const violations = findRuleFileViolations(
          ".claude/rules/code/x.md",
          '---\npaths:\n  - "apps/backnd/**"\n  - "biome.jsonc"\n  - "apps/backend/**"\n---\n',
          files,
        );

        // then
        expect(violations).toEqual([
          'rules-paths: .claude/rules/code/x.md の glob "apps/backnd/**" に一致するファイルが無い',
          'rules-paths: .claude/rules/code/x.md の glob "biome.jsonc" に一致するファイルが無い',
        ]);
      },
    );
  });

  Scenario("スキルのフロントマター", ({ And }) => {
    And("name と description があれば違反にしない（must pass）", () => {
      // given: 前提なし
      // when
      const violations = findSkillViolations(
        ".claude/skills/x/SKILL.md",
        "---\nname: x\ndescription: いつ使うか\n---\n手順\n",
      );

      // then
      expect(violations).toEqual([]);
    });

    And(
      "フロントマターが無い・name が無い・description が空なら、欠けたキーを違反にする（must reject）",
      () => {
        // given
        const cases: [string, string, string[]][] = [
          ["フロントマターが無い", "手順\n", ["name", "description"]],
          ["name が無い", "---\ndescription: d\n---\n", ["name"]],
          [
            "description が空",
            "---\nname: x\ndescription:\n---\n",
            ["description"],
          ],
          [
            "description が空文字",
            '---\nname: x\ndescription: ""\n---\n',
            ["description"],
          ],
        ];

        // when
        const result = casesByName(cases, ([, markdown]) =>
          findSkillViolations(".claude/skills/x/SKILL.md", markdown),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , missing]) =>
            missing.map(
              (key) =>
                `skill-frontmatter: .claude/skills/x/SKILL.md に ${key} が無い`,
            ),
          ),
        );
      },
    );
  });

  Scenario("サブエージェントの model", ({ And }) => {
    And(
      "許可したフル ID なら違反にしない（must pass）（許可したフル ID のそれぞれ）",
      () => {
        // given
        const cases: [string][] = ALLOWED_AGENT_MODELS.map((model) => [model]);

        // when
        const result = casesByName(cases, ([model]) =>
          findAgentModelViolations(
            ".claude/agents/x.md",
            `---\nname: x\nmodel: ${model}\n---\n本文\n`,
          ),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "model が別名・古い ID・空・無い・フロントマターが無いなら違反にする（must reject）",
      () => {
        // given
        const cases: [string, string, string][] = [
          ["別名", "---\nname: x\nmodel: opus\n---\n", '"opus"'],
          [
            "古い ID",
            "---\nname: x\nmodel: claude-opus-4-1\n---\n",
            '"claude-opus-4-1"',
          ],
          ["空", "---\nname: x\nmodel:\n---\n", "無し"],
          ["model が無い", "---\nname: x\n---\n", "無し"],
          ["フロントマターが無い", "本文だけ\n", "無し"],
        ];

        // when
        const result = casesByName(cases, ([, markdown]) =>
          findAgentModelViolations(".claude/agents/x.md", markdown),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , shown]) => [
            `agent-model: .claude/agents/x.md の model が ${shown}（許可: claude-opus-5-5 / claude-sonnet-5-5）`,
          ]),
        );
      },
    );
  });

  Scenario("旧 rules/ への参照", ({ And }) => {
    And(
      "旧 rules/ の code と general への参照（文中・括弧の中・@ の import・コードスパン）を違反にする（must reject）",
      () => {
        // given
        const cases: [string][] = [
          ["詳細は rules/code/architecture.md"],
          ["（rules/general/branch.md の「CI」）"],
          ["@rules/code/test.md"],
          ["`rules/general`"],
        ];

        // when
        const result = casesByName(cases, ([line]) =>
          findLegacyReferences("x.ts", `ok\n${line}\n`),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => ["legacy-rules: x.ts:2"]),
        );
      },
    );

    And(
      ".claude/rules/ の下・旧 rules/ の削除の説明・名前の一部・別の rules は違反にしない（must pass）",
      () => {
        // given
        const cases: [string][] = [
          [".claude/rules/code/backend.md"],
          [".claude/rules/general.md"],
          ["rules/ ディレクトリは削除した"],
          ["myrules/code/x.md"],
          ["biome の lint.rules.preset"],
        ];

        // when
        const result = casesByName(cases, ([line]) =>
          findLegacyReferences("x.ts", line),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And("docs/work-logs/ とこのファイルは検査しない", () => {
      // given: 前提なし
      // when
      const result = isLegacyScanTarget("docs/work-logs/2026-09-28.md");

      // then
      expect(result).toBe(false);

      // when
      const selfTarget = isLegacyScanTarget(SELF);

      // then
      expect(selfTarget).toBe(false);

      // when
      const readmeTarget = isLegacyScanTarget("README.md");

      // then
      expect(readmeTarget).toBe(true);

      // when
      const appsDocsTarget = isLegacyScanTarget("apps/docs/work-logs/x.md");

      // then
      expect(appsDocsTarget).toBe(true);

      // when
      const oldWorkLogsTarget = isLegacyScanTarget("work-logs/2026-09-28.md");

      // then
      // Issue #101 で移す前の置き場所は、作業ログとして除外しない（移した後にそこへ書いたファイルは普通のファイルとして検査する）。
      expect(oldWorkLogsTarget).toBe(true);

      // when
      const adrReadmeTarget = isLegacyScanTarget("docs/adr/README.md");

      // then
      expect(adrReadmeTarget).toBe(true);
    });

    And(
      "旧 .claude/general への参照（文中・@ の import・コードスパン）を違反にする（must reject）",
      () => {
        // given
        const cases: [string][] = [
          ["詳細は .claude/general/workflow.md"],
          ["- 運用: @.claude/general/orchestration.md"],
          ["（`.claude/general/work-log.md`）"],
          ["`.claude/general/` の要点"],
        ];

        // when
        const result = casesByName(cases, ([line]) =>
          findLegacyGeneralReferences("x.sh", `ok\n${line}\n`),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => ["legacy-general: x.sh:2"]),
        );
      },
    );

    And(
      ".claude/rules/general.md のような別の名前・general の単語は違反にしない（must pass）",
      () => {
        // given
        const cases: [string][] = [
          [".claude/rules/general.md"],
          [".claude/rules/workflow/work-log.md"],
          ["general な規則"],
          [".claude/generally.md"],
        ];

        // when
        const result = casesByName(cases, ([line]) =>
          findLegacyGeneralReferences("x.sh", line),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "旧 .claude/general への参照は、docs/adr/（不変の記録）も検査しない",
      () => {
        // given: 前提なし
        // when
        const adrTarget = isLegacyGeneralScanTarget(
          "docs/adr/workflow/20260928-instruction-files-by-load-timing.md",
        );

        // then
        expect(adrTarget).toBe(false);

        // when
        const workLogTarget = isLegacyGeneralScanTarget(
          "docs/work-logs/2026-09-28.md",
        );

        // then
        expect(workLogTarget).toBe(false);

        // when
        const selfTarget = isLegacyGeneralScanTarget(SELF);

        // then
        expect(selfTarget).toBe(false);

        // when
        const skillTarget = isLegacyGeneralScanTarget(
          ".claude/skills/pr-flow/SKILL.md",
        );

        // then
        expect(skillTarget).toBe(true);
      },
    );
  });

  // テンプレート（docs/adr/README.md）どおりの ADR の本文。変えたい行だけを渡して must reject の入力を作る。
  function adrText(
    overrides: {
      title?: string;
      date?: string;
      status?: string;
      related?: string;
      sections?: string[];
    } = {},
  ): string {
    const {
      title = "# Todo の不変条件を常に全フィールドで検証する",
      date = "- 日付: 2026-09-29",
      status = "- 状態: 採用",
      related = "- 関連: Issue #94 / PR #95 / `.claude/rules/code/backend.md`",
      sections = ADR_REQUIRED_SECTIONS,
    } = overrides;
    return [
      title,
      "",
      date,
      status,
      related,
      "",
      ...sections.flatMap((heading) => [heading, "本文", ""]),
    ].join("\n");
  }

  Scenario("ADR（docs/adr/<分類>/）の形式", ({ And }) => {
    const name = "20260929-todo-invariants-always-validated.md";
    const ref = `architecture/${name}`;
    const path = `docs/adr/${ref}`;
    const index = `| 2026-09-29 | [Todo の不変条件](${ref}) | 採用 |\n`;

    // 1 件の ADR を README の一覧に載せた状態で検査する（adr-index 以外の検査を単独で見るため）。
    // 置き換え先の候補として、同じ分類（architecture）と別の分類（quality）に 1 件ずつ置く。
    function check(text: string, adrPath = path): string[] {
      const listed = adrPath.slice("docs/adr/".length);
      return findAdrViolations(
        [
          { path: adrPath, text },
          {
            path: "docs/adr/architecture/20260928-old.md",
            text: adrText({ date: "- 日付: 2026-09-28" }),
          },
          {
            path: "docs/adr/quality/20260928-gate.md",
            text: adrText({ date: "- 日付: 2026-09-28" }),
          },
        ],
        `${index}| [old](architecture/20260928-old.md) |\n| [gate](quality/20260928-gate.md) |\n| [x](${listed}) |\n`,
      );
    }

    And(
      "テンプレートどおり・廃止・同じ分類や別の分類への置き換え・必須の見出しの間の別の見出しは違反にしない（must pass）",
      () => {
        // given
        const cases: [string, string][] = [
          ["テンプレートどおり（採用）", adrText()],
          ["状態が廃止", adrText({ status: "- 状態: 廃止" })],
          [
            "状態が置き換えで、置き換え先が同じ分類にある",
            adrText({
              status: "- 状態: 置き換え（→ architecture/20260928-old.md）",
            }),
          ],
          [
            "状態が置き換えで、置き換え先が別の分類にある",
            adrText({
              status: "- 状態: 置き換え（→ quality/20260928-gate.md）",
            }),
          ],
          [
            "必須の見出しの間に別の見出しがある",
            adrText({
              sections: [
                "## 背景",
                "## 決定",
                "### 補足",
                "## 理由",
                "## 採用しなかった案",
                "## 移行",
                "## 影響",
              ],
            }),
          ],
        ];

        // when
        const result = casesByName(cases, ([, text]) => check(text));

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "ファイル名が yyyymmdd-topic.md（topic は英小文字・数字の kebab-case）でなければ違反にする（must reject）（日付の書き方・区切り・大文字・下線・空の topic・連続や末尾のハイフン・拡張子・README.md）",
      () => {
        // given
        const cases: [string][] = [
          ["2026-09-29-todo.md"],
          ["20260929_todo.md"],
          ["20260929-Todo.md"],
          ["20260929-todo_invariants.md"],
          ["20260929-.md"],
          ["20260929-a--b.md"],
          ["20260929-todo-.md"],
          ["2026929-todo.md"],
          ["20260929-todo.MD"],
          ["20260929-todo.txt"],
          ["README.md"],
        ];
        const adrPathOf = (fileName: string) =>
          `docs/adr/architecture/${fileName}`;

        // when
        const result = casesByName(cases, ([fileName]) =>
          check(adrText(), adrPathOf(fileName)),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([fileName]) => [
            `adr-name: ${adrPathOf(fileName)} の名前が yyyymmdd-<topic>.md（topic は英小文字・数字の kebab-case）でない`,
          ]),
        );
      },
    );

    And(
      "1 行目が「# 」の見出しでなければ違反にする（must reject）（見出しが無い・## ・# の後に空白が無い・見出しが空）",
      () => {
        // given
        const cases: [string, string][] = [
          ["見出しが無い", "Todo の不変条件"],
          ["見出しが ## ", "## Todo の不変条件"],
          ["# の後に空白が無い", "#Todo の不変条件"],
          ["見出しが空", "# "],
        ];

        // when
        const result = casesByName(cases, ([, title]) =>
          check(adrText({ title })),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            `adr-title: ${path} の 1 行目が「# 」の見出しでない`,
          ]),
        );
      },
    );

    And(
      "3 行目が「- 日付: YYYY-MM-DD」でなければ違反にする（must reject）（区切りが /・全角のコロン・日付が無い）",
      () => {
        // given
        const cases: [string, string][] = [
          ["日付の区切りが /", "- 日付: 2026/09/29"],
          ["全角のコロン", "- 日付：2026-09-29"],
          ["日付が無い（行が空）", ""],
        ];

        // when
        const result = casesByName(cases, ([, date]) =>
          check(adrText({ date })),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            `adr-meta: ${path} の 3 行目が「- 日付: YYYY-MM-DD」でない`,
          ]),
        );
      },
    );

    And("日付がファイル名の日付と違えば違反にする（must reject）", () => {
      // given: 前提なし
      // when
      const result = check(adrText({ date: "- 日付: 2026-09-28" }));

      // then
      expect(result).toEqual([
        `adr-meta: ${path} の日付 2026-09-28 がファイル名の 20260929 と違う`,
      ]);
    });

    And(
      "4 行目の状態が決まった形でなければ違反にする（must reject）（決まった語でない・英語・置き換え先が無い・置き換えの括弧が半角）",
      () => {
        // given
        const cases: [string, string][] = [
          ["決まった語でない", "- 状態: 採用済み"],
          ["英語", "- 状態: accepted"],
          ["置き換え先が無い", "- 状態: 置き換え"],
          [
            "置き換えの括弧が半角",
            "- 状態: 置き換え(→ architecture/20260928-old.md)",
          ],
        ];

        // when
        const result = casesByName(cases, ([, status]) =>
          check(adrText({ status })),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            `adr-meta: ${path} の 4 行目が「- 状態: 採用 | 置き換え（→ <分類>/<ファイル名>）| 廃止」でない`,
          ]),
        );
      },
    );

    // WHY 分類なしのファイル名・別の書き方を違反にする: 置き換え先は README の一覧のリンクと同じ「<分類>/<ファイル名>」
    //   （docs/adr/ からの相対パス）の 1 通りに揃え、分類を移したときに古い参照が残らないようにする。
    And(
      "置き換え先が docs/adr に無いか、分類/ファイル名 の形でなければ違反にする（must reject）（存在しない・分類なし・分類が違う・./ 付き・相対パス・リポジトリ相対のパス）",
      () => {
        // given
        const cases: [string, string][] = [
          ["存在しない ADR", "architecture/20260930-missing.md"],
          ["分類なしのファイル名だけ", "20260928-old.md"],
          ["分類が違う", "quality/20260928-old.md"],
          ["./ 付き", "./architecture/20260928-old.md"],
          ["ADR からの相対パス", "../architecture/20260928-old.md"],
          ["リポジトリ相対のパス", "docs/adr/architecture/20260928-old.md"],
        ];

        // when
        const result = casesByName(cases, ([, target]) =>
          check(adrText({ status: `- 状態: 置き換え（→ ${target}）` })),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, target]) => [
            `adr-meta: ${path} の置き換え先 ${target} が docs/adr に無い（<分類>/<ファイル名> で書く）`,
          ]),
        );
      },
    );

    And(
      "5 行目の関連が空・空白だけ・別の項目なら違反にする（must reject）",
      () => {
        // given
        const cases: [string, string][] = [
          ["値が空", "- 関連:"],
          ["値が空白だけ", "- 関連: "],
          ["行が別の項目", "- 状態: 採用"],
        ];

        // when
        const result = casesByName(cases, ([, related]) =>
          check(adrText({ related })),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            `adr-meta: ${path} の 5 行目が「- 関連: <Issue / PR / 規則>」でない`,
          ]),
        );
      },
    );

    And(
      "必須の見出しのどれか 1 つが無ければ、その見出しを違反にする（must reject）（必須の見出しのそれぞれ）",
      () => {
        // given
        const cases: [string][] = ADR_REQUIRED_SECTIONS.map((heading) => [
          heading,
        ]);

        // when
        const result = casesByName(cases, ([heading]) =>
          check(
            adrText({
              sections: ADR_REQUIRED_SECTIONS.filter((h) => h !== heading),
            }),
          ),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([heading]) => [
            `adr-sections: ${path} に「${heading}」が無い`,
          ]),
        );
      },
    );

    And(
      "見出しの段が違う・後ろに文字がある見出しは、無いものとして違反にする（must reject）",
      () => {
        // given: 前提なし
        // when
        const result = check(
          adrText({
            sections: [
              "### 背景",
              "## 決定",
              "## 理由（WHY）",
              "## 採用しなかった案",
              "## 影響",
            ],
          }),
        );

        // then
        expect(result).toEqual([
          `adr-sections: ${path} に「## 背景」が無い`,
          `adr-sections: ${path} に「## 理由」が無い`,
        ]);
      },
    );

    And("必須の見出しの順が違えば違反にする（must reject）", () => {
      // given: 前提なし
      // when
      const result = check(
        adrText({
          sections: [
            "## 背景",
            "## 理由",
            "## 決定",
            "## 採用しなかった案",
            "## 影響",
          ],
        }),
      );

      // then
      expect(result).toEqual([
        `adr-sections: ${path} の見出しが 背景 → 決定 → 理由 → 採用しなかった案 → 影響 の順でない`,
      ]);
    });

    And(
      "ADR が docs/adr/README.md の一覧にリンクで載っていなければ違反にする（must reject）（README.md が無い・リンクが無い・文字だけ・別の名前・分類が無い・分類が違う）",
      () => {
        // given
        const cases: [string, string | undefined][] = [
          ["README.md が無い", undefined],
          ["一覧にリンクが無い", "| 2026-09-29 | Todo の不変条件 | 採用 |\n"],
          ["ファイル名が文字としてあるだけ", `- ${ref}\n`],
          [
            "リンク先が別の名前",
            "| [x](architecture/20260929-todo-invariants.md) |\n",
          ],
          ["リンク先に分類が無い", `| [x](${name}) |\n`],
          ["リンク先の分類が違う", `| [x](quality/${name}) |\n`],
        ];

        // when
        const result = casesByName(cases, ([, readme]) =>
          findAdrViolations([{ path, text: adrText() }], readme),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            `adr-index: ${path} が docs/adr/README.md の一覧に無い`,
          ]),
        );
      },
    );
  });

  Scenario("ADR の一覧の状態とリンク先（adr-index-state）", ({ And }) => {
    const adrs = [
      {
        path: "docs/adr/architecture/20260928-old.md",
        text: adrText({
          date: "- 日付: 2026-09-28",
          status: "- 状態: 置き換え（→ workflow/20260929-new.md）",
        }),
      },
      { path: "docs/adr/workflow/20260929-new.md", text: adrText() },
      {
        path: "docs/adr/quality/20260929-gone.md",
        text: adrText({ status: "- 状態: 廃止" }),
      },
    ];
    const row = (status: string, name: string) =>
      `| 2026-09-29 | タイトル | ${status} | [${name}](${name}) |`;
    const header =
      "| 日付 | タイトル | 状態 | ファイル |\n| --- | --- | --- | --- |\n";

    And(
      "状態が ADR と一致し、リンク先がすべてあれば違反にしない（must pass。見出し・区切り・表の外の行は読まない）",
      () => {
        // given
        const index = [
          "# ADR",
          "本文の [リンク](../x.md) は一覧の行ではない",
          header,
          row(
            "置き換え（→ workflow/20260929-new.md）",
            "architecture/20260928-old.md",
          ),
          "| 2026-09-29 | A | B を含む | 採用 | [20260929-new.md](workflow/20260929-new.md) |",
          `  ${row("廃止", "quality/20260929-gone.md")}  `,
        ].join("\n");

        // when
        const violations = findAdrIndexStateViolations(adrs, index);

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "README.md が無ければ、この検査は違反を出さない（一覧に無いことは adr-index が出す）",
      () => {
        // given: 前提なし
        // when
        const violations = findAdrIndexStateViolations(adrs, undefined);

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "一覧の状態が ADR の状態と違えば違反にする（must reject）（置き換えた ADR を採用のまま・置き換え先の名前が違う・分類が無い・状態が空）",
      () => {
        // given
        const cases: [string, string, string][] = [
          [
            "置き換えた ADR を採用のまま",
            "採用",
            "置き換え（→ workflow/20260929-new.md）",
          ],
          [
            "置き換え先の名前が違う",
            "置き換え（→ workflow/20260929-other.md）",
            "置き換え（→ workflow/20260929-new.md）",
          ],
          [
            "置き換え先の分類が無い",
            "置き換え（→ 20260929-new.md）",
            "置き換え（→ workflow/20260929-new.md）",
          ],
          ["状態が空", "", "置き換え（→ workflow/20260929-new.md）"],
        ];

        // when
        const result = casesByName(cases, ([, listed]) =>
          findAdrIndexStateViolations(
            adrs,
            header + row(listed, "architecture/20260928-old.md"),
          ),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, listed, actual]) => [
            `adr-index-state: docs/adr/README.md の一覧の architecture/20260928-old.md の状態「${listed}」が ADR の「${actual}」と違う`,
          ]),
        );
      },
    );

    And(
      "ADR の状態の行が崩れていれば、その行と比べて違反にする（must reject）",
      () => {
        // given
        const broken = [
          {
            path: "docs/adr/architecture/20260929-x.md",
            text: adrText({ status: "- 状態:採用" }),
          },
        ];

        // when
        const violations = findAdrIndexStateViolations(
          broken,
          row("採用", "architecture/20260929-x.md"),
        );

        // then
        expect(violations).toEqual([
          "adr-index-state: docs/adr/README.md の一覧の architecture/20260929-x.md の状態「採用」が ADR の「- 状態:採用」と違う",
        ]);
      },
    );

    And(
      "一覧のリンク先が docs/adr に無ければ違反にする（must reject）（存在しない・分類なし・分類が違う・./ 付き・README.md 自身）",
      () => {
        // given
        const cases: [string, string][] = [
          ["存在しない ADR", "workflow/20260930-missing.md"],
          ["分類なしのファイル名だけ", "20260929-new.md"],
          ["分類が違う", "architecture/20260929-new.md"],
          ["./ 付きのパス", "./workflow/20260929-new.md"],
          ["README.md 自身", "README.md"],
        ];

        // when
        const result = casesByName(cases, ([, target]) =>
          findAdrIndexStateViolations(
            adrs,
            `| 2026-09-29 | t | 採用 | [x](${target}) |`,
          ),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, target]) => [
            `adr-index-state: docs/adr/README.md の一覧の ${target} が docs/adr に無い`,
          ]),
        );
      },
    );
  });

  Scenario("ADR の分類ディレクトリ（adr-category）", ({ And }) => {
    And(
      "4 つの分類の直下のファイルと、分類の外のファイルは違反にしない（must pass。直下のファイルは adr-only が見る）",
      () => {
        // given: 前提なし
        // when
        const violations = findAdrCategoryViolations([
          "README.md",
          "docs/x.md",
          "docs/adr/README.md",
          "docs/adr/x.md",
          "docs/adr/architecture/20260929-a.md",
          "docs/adr/tech-stack/20260929-b.md",
          "docs/adr/quality/20260929-c.md",
          "docs/adr/workflow/20260929-d.md",
          "docs/adr/workflow/not-an-adr-name.txt",
          "apps/docs/adr/misc/x.md",
          // 分類の検査は docs/adr/ の中だけ（作業ログの日付のファイル・サブディレクトリは分類として読まない）。
          "docs/work-logs/2026-09-29.md",
          "docs/work-logs/2026/09-29.md",
        ]);

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "4 つ以外の分類（大文字・前方一致・旧案の名前を含む）と、分類の下のディレクトリを 1 項目ずつ違反にする（must reject）",
      () => {
        // given: 前提なし
        // when
        const violations = findAdrCategoryViolations([
          "docs/adr/misc/x.md",
          "docs/adr/misc/sub/y.md",
          "docs/adr/Architecture/x.md",
          "docs/adr/architecture-old/x.md",
          "docs/adr/design/x.md",
          "docs/adr/tech/x.md",
          "docs/adr/architecture/sub/y.md",
          "docs/adr/quality/a/b/c.md",
          "docs/adr/quality/a/d.md",
        ]);

        // then
        expect(violations).toEqual([
          "adr-category: docs/adr/misc/ は分類（architecture / tech-stack / quality / workflow）でない",
          "adr-category: docs/adr/Architecture/ は分類（architecture / tech-stack / quality / workflow）でない",
          "adr-category: docs/adr/architecture-old/ は分類（architecture / tech-stack / quality / workflow）でない",
          "adr-category: docs/adr/design/ は分類（architecture / tech-stack / quality / workflow）でない",
          "adr-category: docs/adr/tech/ は分類（architecture / tech-stack / quality / workflow）でない",
          "adr-category: docs/adr/architecture/sub/ がある（分類の下にディレクトリは置けない）",
          "adr-category: docs/adr/quality/a/ がある（分類の下にディレクトリは置けない）",
        ]);
      },
    );

    And(
      "形式の検査（adr-name ほか）の対象は、4 つの分類の直下のファイルだけ",
      () => {
        // given: 前提なし
        // when
        const result = [
          "docs/adr/README.md",
          "docs/adr/x.md",
          "docs/adr/misc/20260929-x.md",
          "docs/adr/architecture/sub/20260929-x.md",
          "docs/adr/architecture/20260929-x.md",
          "docs/adr/tech-stack/x.MD",
          "docs/adr-old/architecture/20260929-x.md",
        ].filter(isAdrFile);

        // then
        expect(result).toEqual([
          "docs/adr/architecture/20260929-x.md",
          "docs/adr/tech-stack/x.MD",
        ]);
      },
    );
  });

  Scenario(
    "docs/ には adr/ と work-logs/ だけ、docs/adr/ の直下には README.md と分類だけ（adr-only）",
    ({ And }) => {
      And(
        "docs/adr/ の下のディレクトリのファイル・docs/adr/README.md・docs/work-logs/ の下のファイル・docs/ の外のファイルだけなら違反にしない（must pass）",
        () => {
          // given: 前提なし
          // when
          const nonAdrDocs = findNonAdrDocs([
            "README.md",
            "apps/docs/x.md",
            "mydocs/x.md",
            "docs/adr/README.md",
            "docs/adr/architecture/20260929-x.md",
            "docs/adr/sub/y.md",
            "docs/work-logs/2026-09-29.md",
            "docs/work-logs/2026/09-29.md",
            "docs/work-logs/README.md",
          ]);

          // then
          expect(nonAdrDocs).toEqual([]);
        },
      );

      // WHY 直下の ADR の例を ADR_DIR で組み立てる: 分類なしの古い参照を `git grep` で「docs/adr/」の直後が日付の参照として見つけるので、意図した
      //   違反の例をその検出に掛けない（下の fixture も同じ）。
      And(
        "docs/adr/ の直下の README.md 以外のファイル（ADR・大文字違いの readme・分類名のファイルを含む）を違反にする（must reject）",
        () => {
          // given: 前提なし
          // when
          const nonAdrDocs = findNonAdrDocs([
            `${ADR_DIR}20260929-x.md`,
            "docs/adr/readme.md",
            "docs/adr/architecture",
            "docs/adr/.keep",
          ]);

          // then
          expect(nonAdrDocs).toEqual([
            `adr-only: ${ADR_DIR}20260929-x.md がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）`,
            "adr-only: docs/adr/readme.md がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）",
            "adr-only: docs/adr/architecture がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）",
            "adr-only: docs/adr/.keep がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）",
          ]);
        },
      );

      And(
        "docs/ の直下のファイル・ディレクトリ（adr / work-logs の前方一致と、その名前のファイルを含む）を 1 項目ずつ違反にする（must reject）",
        () => {
          // given: 前提なし
          // when
          const nonAdrDocs = findNonAdrDocs([
            "docs/README.md",
            "docs/adr",
            "docs/adr-old/x.md",
            "docs/work-logs",
            "docs/work-logs-old/x.md",
            "docs/worklogs/x.md",
            "docs/old/a.md",
            "docs/old/b/c.md",
            "docs/.keep",
          ]);

          // then
          expect(nonAdrDocs).toEqual([
            "adr-only: docs/README.md がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
            "adr-only: docs/adr がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
            "adr-only: docs/adr-old/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
            "adr-only: docs/work-logs がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
            "adr-only: docs/work-logs-old/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
            "adr-only: docs/worklogs/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
            "adr-only: docs/old/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
            "adr-only: docs/.keep がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
          ]);
        },
      );
    },
  );

  Scenario("ルール検査テストの一覧（rule-tests-index）", ({ And }) => {
    const claudeMd =
      "- rule-tests: ルール検査テスト 2 本（`api-spec` / `lint`）\n";
    const testingMd =
      "今あるもの: `rule-tests/api-spec.test.ts`（API 仕様）、`rule-tests/lint.test.ts`\n";
    function readerOf(files: Record<string, string>): FileReader {
      return (path) => files[path];
    }

    And(
      "rule-tests の直下の .feature の名前をルール検査テストとして読み、入れ子とほかの拡張子は読まない",
      () => {
        // given
        const files = [
          "rule-tests/lint.feature",
          "rule-tests/lint.test.ts",
          "rule-tests/api-spec.feature",
          "rule-tests/case-table.ts",
          "rule-tests/fixtures/x.feature",
          "apps/e2e/spec/todo.feature",
          "x/rule-tests/y.feature",
        ];

        // when
        const result = ruleTestNames(files);

        // then
        expect(result).toEqual(["api-spec", "lint"]);
      },
    );

    And(
      "CLAUDE.md の本数と名前、.claude/rules/quality/testing.md の rule-tests/<名前>.test.ts がそろっていれば違反にしない（must pass）",
      () => {
        // given
        const read = readerOf({
          [CLAUDE_MD]: claudeMd,
          [TESTING_MD]: testingMd,
        });

        // when
        const result = findRuleTestIndexViolations(["api-spec", "lint"], read);

        // then
        expect(result).toEqual([]);
      },
    );

    And(
      "CLAUDE.md の本数が違う・本数の記載が無い・名前が無い、testing.md に rule-tests/<名前>.test.ts が無ければ違反にする（must reject。名前は CLAUDE.md の本数の後ろの（…。と testing.md の「今あるもの:」の行の中だけを見る）",
      () => {
        // given
        const cases = [
          [
            "本数が違う",
            {
              [CLAUDE_MD]: claudeMd.replace("2 本", "1 本"),
              [TESTING_MD]: testingMd,
            },
            [
              "rule-tests-index: CLAUDE.md の「ルール検査テスト 1 本」が rule-tests/*.feature の 2 本と違う",
            ],
          ],
          [
            "本数の記載が無い",
            {
              [CLAUDE_MD]: "- rule-tests: `api-spec` / `lint`\n",
              [TESTING_MD]: testingMd,
            },
            [
              "rule-tests-index: CLAUDE.md に「ルール検査テスト 2 本」の記載が無い",
              "rule-tests-index: CLAUDE.md に `api-spec` が無い",
              "rule-tests-index: CLAUDE.md に `lint` が無い",
            ],
          ],
          [
            "名前が本数の後ろの（…。の一覧の外にだけある",
            {
              [CLAUDE_MD]:
                "ルール検査テスト 2 本（`api-spec`。`lint` は Issue #1）\n`api-spec` / `lint`\n",
              [TESTING_MD]: testingMd,
            },
            ["rule-tests-index: CLAUDE.md に `lint` が無い"],
          ],
          [
            "CLAUDE.md が無い",
            { [TESTING_MD]: testingMd },
            [
              "rule-tests-index: CLAUDE.md に「ルール検査テスト 2 本」の記載が無い",
              "rule-tests-index: CLAUDE.md に `api-spec` が無い",
              "rule-tests-index: CLAUDE.md に `lint` が無い",
            ],
          ],
          [
            "名前が無い（コードスパンでない名前・前方一致は数えない）",
            {
              [CLAUDE_MD]: "ルール検査テスト 2 本（api-spec / `lint-x`）\n",
              [TESTING_MD]: testingMd,
            },
            [
              "rule-tests-index: CLAUDE.md に `api-spec` が無い",
              "rule-tests-index: CLAUDE.md に `lint` が無い",
            ],
          ],
          [
            "testing.md に無い（前方一致・別の拡張子は数えない）",
            {
              [CLAUDE_MD]: claudeMd,
              [TESTING_MD]:
                "今あるもの: `rule-tests/api-spec.test.tsx`・`rule-tests/lint.feature`\n",
            },
            [
              "rule-tests-index: .claude/rules/quality/testing.md に `rule-tests/api-spec.test.ts` が無い",
              "rule-tests-index: .claude/rules/quality/testing.md に `rule-tests/lint.test.ts` が無い",
            ],
          ],
          [
            "testing.md の「今あるもの:」の行の外にだけある",
            {
              [CLAUDE_MD]: claudeMd,
              [TESTING_MD]:
                "検査は `rule-tests/lint.test.ts`\n今あるもの: `rule-tests/api-spec.test.ts`\n",
            },
            [
              "rule-tests-index: .claude/rules/quality/testing.md に `rule-tests/lint.test.ts` が無い",
            ],
          ],
        ] as const;

        // when
        const result = casesByName(cases, ([, files]) =>
          findRuleTestIndexViolations(["api-spec", "lint"], readerOf(files)),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );

    And("ルール検査テストが 0 件なら、この検査は違反を出さない", () => {
      // given
      const read = readerOf({});

      // when
      const result = findRuleTestIndexViolations([], read);

      // then
      expect(result).toEqual([]);
    });
  });

  Scenario("fixture のリポジトリを検査したときに検出される違反", ({ And }) => {
    function makeRepo(name: string, files: Record<string, string>): string {
      const root = join(dir, name);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      // WHY git init: 本番と同じ git ls-files で列挙する。一時ディレクトリの新しいリポジトリなので、本体のフックには触れない。
      execFileSync("git", ["init", "-q"], { cwd: root });
      return root;
    }

    function check(root: string): string[] {
      return collectInstructionViolations(root, inventory(listRepoFiles(root)));
    }

    const passing: Record<string, string> = {
      "CLAUDE.md":
        "# CLAUDE.md\n@LEARNINGS.md\n- 運用: `.claude/rules/workflow/issue-pr.md`\n決定は docs/adr/README.md\n",
      "LEARNINGS.md": "学び\n",
      ".claude/rules/workflow/issue-pr.md": "# 常時の要点\n",
      ".claude/rules/code/backend.md":
        '---\npaths:\n  - "apps/backend/**"\n---\n規則の WHY\n',
      ".claude/skills/pr-flow/SKILL.md":
        "---\nname: pr-flow\ndescription: PR を作るとき\n---\n",
      ".claude/agents/worker.md":
        "---\nname: worker\nmodel: claude-opus-5-5\n---\n本文\n",
      "apps/backend/x.ts": "export const x = 1;\n",
      // README.md 自身は ADR の形式の検査対象外（テンプレートの見出しをコードブロックに持つため）。
      // 一覧は 日付 / タイトル / 状態 / ファイル の表。見出しと区切りの行（リンクの無い行）は adr-index-state で読まない。
      "docs/adr/README.md": [
        "```markdown",
        "## 背景",
        "```",
        "| 日付 | タイトル | 状態 | ファイル |",
        "| --- | --- | --- | --- |",
        "| 2026-09-28 | 旧 | 置き換え（→ architecture/20260929-todo.md） | [20260928-old.md](quality/20260928-old.md) |",
        "| 2026-09-29 | Todo（タイトルに | を含む） | 採用 | [20260929-todo.md](architecture/20260929-todo.md) |",
        "",
      ].join("\n"),
      // 置き換え元と置き換え先を別の分類に置く（置き換えの参照が分類をまたいで辿れることを見る）。
      "docs/adr/architecture/20260929-todo.md": adrText(),
      // 不変の ADR に残る旧 .claude/general への参照は数えない（related）。
      "docs/adr/quality/20260928-old.md": adrText({
        date: "- 日付: 2026-09-28",
        status: "- 状態: 置き換え（→ architecture/20260929-todo.md）",
        related: "- 関連: `.claude/general/workflow.md`",
      }),
      "docs/work-logs/2026-09-28.md":
        "rules/code/test.md と .claude/general/workflow.md を書いた（過去の記録）\n",

      ".gitignore": "ignored/\n",
      "ignored/rules/code/x.md": "rules/code/x.md\n",
    };

    And(
      "許可される構成では違反 0 件（must pass。.gitignore の中と docs/work-logs/ の旧参照は数えない）",
      () => {
        // given: 前提なし
        // when
        const result = check(makeRepo("pass", passing));

        // then
        expect(result).toEqual([]);
      },
    );

    And("違反を入れた構成では、すべての違反を検出する（must reject）", () => {
      // given
      const root = makeRepo("reject", {
        ...passing,
        "CLAUDE.md": `${"x\n".repeat(200)}@LEARNINGS.md\n@missing.md\n@.claude/rules/code/backend.md\n`,
        ".claude/rules/workflow/long.md": "x\n".repeat(26),
        ".claude/rules/workflow/scoped.md":
          '---\npaths:\n  - "apps/backend/**"\n---\n',
        ".claude/rules/code/no-paths.md": "# paths が無い\n",
        ".claude/rules/code/typo.md":
          '---\npaths:\n  - "apps/backnd/**"\n---\n',
        ".claude/rules/flat.md": '---\npaths:\n  - "apps/backend/**"\n---\n',
        // 分類の下の入れ子も列挙する（Claude Code は再帰で読むので、列挙から落ちると検査から黙って外れる）。
        ".claude/rules/code/sub/nested.md":
          '---\npaths:\n  - "apps/backend/**"\n---\n',
        ".claude/general/orchestration.md": "旧い置き場所\n",
        "scripts/hook.sh": "echo 詳細は .claude/general/work-log.md\n",
        ".claude/skills/broken/SKILL.md": "---\nname: broken\n---\n",
        ".claude/agents/alias.md": "---\nname: alias\nmodel: sonnet\n---\n",
        "rules/code/test.md": "旧ルール\n",
        // CLAUDE.md にも testing.md にも載っていないルール検査テスト。
        "rule-tests/x.feature": "Feature: x\n",
        "README.md": "詳細は rules/general/branch.md\n",
        // 一覧に載っていて、名前だけが違反の ADR（名前の検査が単独で効くことを見る）。
        // 一覧: 旧の状態を ADR と違う「採用」にし、名前だけが違反の ADR と、存在しない ADR への行を足す。
        "docs/adr/README.md": [
          "| 日付 | タイトル | 状態 | ファイル |",
          "| --- | --- | --- | --- |",
          "| 2026-09-28 | 旧 | 採用 | [20260928-old.md](quality/20260928-old.md) |",
          "| 2026-09-29 | Todo | 採用 | [20260929-todo.md](architecture/20260929-todo.md) |",
          "| 2026-09-29 | bad | 採用 | [20260929_bad.md](workflow/20260929_bad.md) |",
          "| 2026-09-30 | 消した | 採用 | [20260930-gone.md](architecture/20260930-gone.md) |",
          "| 2026-09-29 | 分類なし | 採用 | [20260929-todo.md](20260929-todo.md) |",
          "",
        ].join("\n"),
        // docs/ の直下に adr/ 以外（ファイル・ディレクトリ・adr の前方一致）を置く。
        "docs/README.md": "旧い索引\n",
        "docs/old/a.md": "旧い記録\n",
        "docs/old/b.md": "旧い記録\n",
        "docs/adrx/c.md": "前方一致\n",
        // Issue #101 で移す前の置き場所（リポジトリ直下の work-logs/）は作業ログとして扱わない（旧参照も数える）。
        "work-logs/2026-09-28.md": "rules/code/old.md を書いた\n",
        // docs/adr/ の直下の ADR・分類でないディレクトリ・分類の下のディレクトリ。形式は正しく一覧にも無いが、
        //   adr-only / adr-category の 1 件ずつだけになる（形式の検査の対象に入らない）ことを見る。
        [`${ADR_DIR}20260929-root.md`]: adrText(),
        "docs/adr/misc/20260929-misc.md": adrText(),
        "docs/adr/architecture/sub/20260929-sub.md": adrText(),
        "docs/adr/workflow/20260929_bad.md": adrText(),
        // 一覧に無く、見出し・メタ・必須の見出しがすべて崩れた ADR。置き換え先は分類なしのファイル名だけ（実在する ADR）。
        "docs/adr/tech-stack/20260928-broken.md": adrText({
          title: "決定",
          date: "- 日付: 2026-09-29",
          status: "- 状態: 置き換え（→ 20260929-todo.md）",
          related: "- 関連:",
          sections: ADR_REQUIRED_SECTIONS.filter((h) => h !== "## 影響"),
        }),
      });

      // when
      const result = check(root);

      // then
      expect(result).toEqual([
        "claude-md-lines: CLAUDE.md が 203 行（上限 200）",
        "always-lines: .claude/rules/workflow/long.md が 26 行（上限 25）",
        "claude-md-import: CLAUDE.md → @missing.md（無い）",
        "claude-md-import: CLAUDE.md → @.claude/rules/code/backend.md（LEARNINGS.md 以外）",
        "rule-tests-index: CLAUDE.md に「ルール検査テスト 1 本」の記載が無い",
        "rule-tests-index: CLAUDE.md に `x` が無い",
        "rule-tests-index: .claude/rules/quality/testing.md に `rule-tests/x.test.ts` が無い",
        "rules-paths: .claude/rules/code/no-paths.md にフロントマターの paths（1 件以上）が無い",
        "rules-category: .claude/rules/code/sub/nested.md が .claude/rules/<分類>/<名前>.md（分類は code / quality / tooling / workflow）でない",
        'rules-paths: .claude/rules/code/typo.md の glob "apps/backnd/**" に一致するファイルが無い',
        "rules-category: .claude/rules/flat.md が .claude/rules/<分類>/<名前>.md（分類は code / quality / tooling / workflow）でない",
        "rules-always: .claude/rules/workflow/scoped.md に paths がある（workflow/ は常時読み込むので paths を持たない）",
        "legacy-rules: rules/ がある",
        "legacy-rules: README.md:1",
        "legacy-rules: work-logs/2026-09-28.md:1",
        "legacy-general: .claude/general/ がある",
        "legacy-general: scripts/hook.sh:1",
        "adr-title: docs/adr/tech-stack/20260928-broken.md の 1 行目が「# 」の見出しでない",
        "adr-meta: docs/adr/tech-stack/20260928-broken.md の日付 2026-09-29 がファイル名の 20260928 と違う",
        "adr-meta: docs/adr/tech-stack/20260928-broken.md の置き換え先 20260929-todo.md が docs/adr に無い（<分類>/<ファイル名> で書く）",
        "adr-meta: docs/adr/tech-stack/20260928-broken.md の 5 行目が「- 関連: <Issue / PR / 規則>」でない",
        "adr-sections: docs/adr/tech-stack/20260928-broken.md に「## 影響」が無い",
        "adr-index: docs/adr/tech-stack/20260928-broken.md が docs/adr/README.md の一覧に無い",
        "adr-name: docs/adr/workflow/20260929_bad.md の名前が yyyymmdd-<topic>.md（topic は英小文字・数字の kebab-case）でない",
        "adr-index-state: docs/adr/README.md の一覧の quality/20260928-old.md の状態「採用」が ADR の「置き換え（→ architecture/20260929-todo.md）」と違う",
        "adr-index-state: docs/adr/README.md の一覧の architecture/20260930-gone.md が docs/adr に無い",
        "adr-index-state: docs/adr/README.md の一覧の 20260929-todo.md が docs/adr に無い",
        "adr-category: docs/adr/architecture/sub/ がある（分類の下にディレクトリは置けない）",
        "adr-category: docs/adr/misc/ は分類（architecture / tech-stack / quality / workflow）でない",
        "adr-only: docs/README.md がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
        "adr-only: docs/adrx/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
        "adr-only: docs/old/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
        `adr-only: ${ADR_DIR}20260929-root.md がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）`,
        "skill-frontmatter: .claude/skills/broken/SKILL.md に description が無い",
        'agent-model: .claude/agents/alias.md の model が "sonnet"（許可: claude-opus-5-5 / claude-sonnet-5-5）',
      ]);
    });
  });

  Scenario("リポジトリの指示ファイル", ({ And }) => {
    const found = inventory(listRepoFiles(repoRoot));

    And("列挙が空でない（対象 0 件で緑にならない）", () => {
      // given: 前提なし
      // when
      const files2 = found.files;

      // then
      // WHY 件数の下限を見る: 列挙の正規表現や git ls-files の失敗で対象が 0 件になると、違反も 0 件になり常に緑になる。
      expect(files2).toContain(CLAUDE_MD);

      // when
      const ruleFileCount = found.ruleFiles.length;

      // then
      expect(ruleFileCount).toBeGreaterThan(0);

      // when
      const alwaysFileCount = found.alwaysFiles.length;

      // then
      expect(alwaysFileCount).toBeGreaterThan(0);

      // when
      const adrCount = found.adrs.length;

      // then
      expect(adrCount).toBeGreaterThan(0);

      // when
      const files3 = found.files;

      // then
      expect(files3).toContain(ADR_INDEX);

      // when
      const skillCount = found.skills.length;

      // then
      expect(skillCount).toBeGreaterThan(0);

      // when
      const agentCount = found.agents.length;

      // then
      expect(agentCount).toBeGreaterThan(0);

      // when
      const ruleTestCount = found.ruleTests.length;

      // then
      expect(ruleTestCount).toBeGreaterThan(0);

      // when
      const claudeMdImportCount = extractImports(
        readFileSync(join(repoRoot, CLAUDE_MD), "utf8"),
      ).length;

      // then
      expect(claudeMdImportCount).toBeGreaterThan(0);
    });

    // WHY adr-only だけを別のテストにする: Issue #96 で旧 docs/*.md の削除と、この検査の追加を並行して進めたため、削除が
    //   終わるまで adr-only だけが失敗する。1 つのテストにまとめると、その間ほかの検査の違反が失敗に紛れて見えなくなる。
    const violations = collectInstructionViolations(repoRoot, found);

    And(
      "CLAUDE.md・.claude/rules・スキル・エージェント・ADR に違反が無く、旧 rules/ と .claude/general も残っていない",
      () => {
        // given: 前提なし
        // when
        const result = violations.filter((v) => !v.startsWith("adr-only:"));

        // then
        expect(result).toEqual([]);
      },
    );

    And("docs/ の直下には adr/ と work-logs/ しか無い", () => {
      // given: 前提なし
      // when
      const result = violations.filter((v) => v.startsWith("adr-only:"));

      // then
      expect(result).toEqual([]);
    });
  });
});
