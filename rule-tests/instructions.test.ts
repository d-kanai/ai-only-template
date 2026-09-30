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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 指示ファイル（CLAUDE.md / .claude/general / .claude/rules / .claude/skills / .claude/agents）と ADR（docs/adr）の構成を
//   仕様として固定するテスト。
// WHY 機械で検査する: 指示ファイルは「読み込まれているか」、ADR は「決まった形で一覧から辿れるか」を人が見落としやすい。
//   rules の paths の typo は、そのルールが黙って読み込まれなくなるだけで、何もエラーにならない（CLAUDE.md の原則 7）。
// ルール検査テスト（.claude/rules/testing.md）なので、判定を関数に切り出し、架空の入力で must pass / must reject を固定してから、
//   一時ディレクトリの fixture と実リポジトリに同じ関数（collectInstructionViolations）を当てる。
//
// 検査すること（違反の文字列の先頭が検査の名前）:
//   claude-md-lines   CLAUDE.md は 200 行以下（公式 https://code.claude.com/docs/en/memory の目安。超えると起動時に警告）。
//   claude-md-import  CLAUDE.md とそこから @ で読むファイルの @path が、存在するファイルを指す。@ で読んでよいのは
//                     LEARNINGS.md と .claude/general/*.md だけ（常時読み込む量を増やさないため。規則は .claude/rules に
//                     paths で置き、手順はスキルにする）。
//   general-lines     .claude/general/*.md は 1 ファイル 25 行以下（常時読み込まれるため、短い要点だけにする）。
//   rules-paths       .claude/rules/*.md はフロントマターに paths（1 件以上の glob）を持ち、各 glob がリポジトリのファイルに
//                     1 件以上一致する（一致しない glob は typo として扱う。そのルールは読み込まれないまま残るため）。
//   legacy-rules      旧 rules/ ディレクトリが無く、ファイルに rules/code/・rules/general/ への参照が残っていない
//                     （docs/work-logs/ は過去の記録なので除く。このファイルは例を持つので除く）。
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
//                     分類の下にさらにディレクトリが無い（アーキテクチャでない決定を分けて読めるようにする）。
//   adr-only          docs/ の直下には adr/ と work-logs/ しか無く、docs/adr/ の直下には README.md と分類ディレクトリしか無い
//                     （別の記録を足させない。WHY は findNonAdrDocs の上）。
//                     WHY（adr-*）: ADR は読み込まれない不変の記録で、決定が変わると「置き換え」で次の ADR に辿る。形が崩れると
//                     日付・状態・理由を取り出せず、一覧に無いと存在しないのと同じになる。
//   skill-frontmatter .claude/skills/*/SKILL.md はフロントマターに name と description を持つ（公式 https://code.claude.com/docs/en/skills 。
//                     description は起動時に一覧として読まれ、いつ使うかの判断に使われる）。
//   agent-model       .claude/agents/*.md はフロントマターの model が許可したフル ID（ALLOWED_AGENT_MODELS）のいずれか
//                     （別名 `opus` / `sonnet` や古い ID は意図しないモデルに解決され、消費と品質が変わる。
//                     `.claude/general/orchestration.md`、`docs/adr/workflow/20260929-save-usage-limit.md`）。

const repoRoot = join(import.meta.dirname, "..");
const SELF = "rule-tests/instructions.test.ts";

const CLAUDE_MD = "CLAUDE.md";
const CLAUDE_MD_MAX_LINES = 200;
const GENERAL_MAX_LINES = 25;

function countLines(text: string): number {
  // WHY 末尾の改行を 1 行と数えない: エディタの行数（wc -l）と合わせる。
  return text.replace(/\n$/, "").split("\n").length;
}

// CLAUDE.md と .claude/general/*.md の行数の上限を超えたもの。
function findLineViolations(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => {
    const isClaudeMd = path === CLAUDE_MD;
    const max = isClaudeMd ? CLAUDE_MD_MAX_LINES : GENERAL_MAX_LINES;
    const lines = countLines(text);
    if (lines <= max) return [];
    const check = isClaudeMd ? "claude-md-lines" : "general-lines";
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

function isAllowedImportTarget(path: string): boolean {
  return (
    path === "LEARNINGS.md" ||
    (path.startsWith(".claude/general/") &&
      path.endsWith(".md") &&
      !path.slice(".claude/general/".length).includes("/"))
  );
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
          `claude-md-import: ${source} → @${target}（LEARNINGS.md と .claude/general/*.md 以外）`,
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
//   足りる（依存を増やすとサプライチェーンの対象も増える。.claude/rules/dependencies.md）。
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

// .claude/rules/<name>.md 1 つの違反。files はリポジトリのファイル（リポジトリ相対のパス）。
function findRuleFileViolations(
  path: string,
  markdown: string,
  files: string[],
): string[] {
  const paths = parseFrontmatter(markdown)?.paths;
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

// --- ADR（docs/adr） ---
// 形式の正は docs/adr/README.md（命名・不変の規則・テンプレート・一覧）。ここはその形を機械で固定する。
// 読み取りの仕様: ADR は行の位置で読む（1 行目が見出し、2 行目は空行、3〜5 行目がメタ）。テンプレートの形そのままで、
//   位置がずれたら違反にする（メタを本文の途中に書くと、日付・状態を機械で取り出せなくなるため）。
// 限界: 見出しは行の完全一致で探すので、コードブロックの中に「## 背景」と書いた行も見出しとして数える（見逃す方向。
//   ADR にテンプレートを貼ることは無い想定。テンプレートは README.md にだけ置き、README.md は検査しない）。
const ADR_DIR = "docs/adr/";
const ADR_INDEX = "docs/adr/README.md";
// 分類。分類ごとに置くものは docs/adr/README.md の一覧に 1 行ずつ書く。
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
//   .claude/general/work-log.md。CI の check-work-logs-diff.sh はサブディレクトリの .md も数える）。
// WHY docs/ を ADR と作業ログだけにする: 決定は ADR、日付付きの確認結果・経緯は作業ログ、一次情報は規則の WHY に置き、読み込まれない記録を
//   docs/ の 2 つにまとめる。docs/ に別の記録を足せる状態だと、最新の規則と記録の二重管理（ずれ）が起きる
//   （docs/adr/workflow/20260929-replace-docs-with-adr.md）。
// WHY docs/adr/ の直下を README.md だけにする: 直下に ADR を置けると、分類の無い ADR が
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
  generalFiles: string[];
  adrs: string[];
  skills: string[];
  agents: string[];
};

function inventory(files: string[]): Inventory {
  return {
    files,
    ruleFiles: files.filter((file) =>
      /^\.claude\/rules\/[^/]+\.md$/.test(file),
    ),
    generalFiles: files.filter((file) =>
      /^\.claude\/general\/[^/]+\.md$/.test(file),
    ),
    // WHY .md に限らず分類の直下をすべて数える: `.MD` や `.txt` に置いた ADR も adr-name で違反にし、形式の検査から黙って
    //   外れないようにする。分類の外・分類の下のディレクトリに置いたものは adr-category / adr-only が拾う（isAdrFile）。
    adrs: files.filter(isAdrFile),
    skills: files.filter((file) =>
      /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file),
    ),
    agents: files.filter((file) => /^\.claude\/agents\/[^/]+\.md$/.test(file)),
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
      [CLAUDE_MD, ...found.generalFiles].map((path) => ({
        path,
        text: read(path) ?? "",
      })),
    ),
    ...findImportViolations(read),
    ...found.ruleFiles.flatMap((path) =>
      findRuleFileViolations(path, read(path) ?? "", found.files),
    ),
    ...(existsSync(join(root, "rules")) ? ["legacy-rules: rules/ がある"] : []),
    ...found.files
      .filter(isLegacyScanTarget)
      .flatMap((path) => findLegacyReferences(path, read(path) ?? "")),
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

describe("CLAUDE.md の行数と @ import の抽出", () => {
  it("行数は末尾の改行を数えない（wc -l と同じ）", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\n\nb\n")).toBe(3);
  });

  it("CLAUDE.md は 200 行まで、.claude/general は 25 行までを許し、超えたら違反にする", () => {
    const lines = (count: number) => "x\n".repeat(count);
    expect(
      findLineViolations([
        { path: "CLAUDE.md", text: lines(200) },
        { path: ".claude/general/a.md", text: lines(25) },
      ]),
    ).toEqual([]);
    expect(
      findLineViolations([
        { path: "CLAUDE.md", text: lines(201) },
        { path: ".claude/general/a.md", text: lines(26) },
      ]),
    ).toEqual([
      "claude-md-lines: CLAUDE.md が 201 行（上限 200）",
      "general-lines: .claude/general/a.md が 26 行（上限 25）",
    ]);
  });

  it("行頭か空白の直後の @path を import として拾う（must reject 側の入力）", () => {
    expect(
      extractImports(
        "@LEARNINGS.md\n- ブランチ: @.claude/general/workflow.md\n",
      ),
    ).toEqual(["LEARNINGS.md", ".claude/general/workflow.md"]);
  });

  it("コードブロック・コードスパン・メールアドレスの @ は拾わない（must pass 側の入力）", () => {
    expect(
      extractImports(
        "```\n@rules/code/test.md\n```\n`@x.md` と a@b.com と `pnpm --filter @repo/backend`\n",
      ),
    ).toEqual([]);
  });

  it("@ で読んでよいのは LEARNINGS.md と .claude/general の直下の .md だけ", () => {
    expect(isAllowedImportTarget("LEARNINGS.md")).toBe(true);
    expect(isAllowedImportTarget(".claude/general/workflow.md")).toBe(true);
    expect(isAllowedImportTarget(".claude/rules/backend.md")).toBe(false);
    expect(isAllowedImportTarget(".claude/general/sub/x.md")).toBe(false);
    expect(isAllowedImportTarget("docs/adr/README.md")).toBe(false);
    expect(isAllowedImportTarget(".claude/general/x.txt")).toBe(false);
  });

  it("無いファイル・許可外のファイルへの @ を違反にし、読んだファイルの @ も辿る", () => {
    const files: Record<string, string> = {
      "CLAUDE.md":
        "@LEARNINGS.md\n@.claude/general/a.md\n@missing.md\n@docs/adr/README.md\n",
      "LEARNINGS.md": "学び\n",
      ".claude/general/a.md": "@b.md と @../../LEARNINGS.md\n",
      "docs/adr/README.md": "一覧\n",
    };
    expect(findImportViolations((path) => files[path])).toEqual([
      "claude-md-import: CLAUDE.md → @missing.md（無い）",
      "claude-md-import: CLAUDE.md → @docs/adr/README.md（LEARNINGS.md と .claude/general/*.md 以外）",
      "claude-md-import: .claude/general/a.md → @b.md（無い）",
    ]);
  });

  it("許可されたファイルだけを指す @ は違反にしない", () => {
    const files: Record<string, string> = {
      "CLAUDE.md": "@LEARNINGS.md\n@.claude/general/a.md\n",
      "LEARNINGS.md": "学び\n",
      ".claude/general/a.md": "要点\n",
    };
    expect(findImportViolations((path) => files[path])).toEqual([]);
  });
});

describe(".claude/rules のフロントマター", () => {
  const files = [
    "apps/backend/features/todo/domain/todo.ts",
    "biome.json",
    "lint.test.ts",
  ];

  it("paths のリストを読み、クォートを外す", () => {
    expect(
      parseFrontmatter(
        '---\npaths:\n  - "apps/backend/**"\n  - biome.json\n---\n本文\n',
      ),
    ).toEqual({ paths: ["apps/backend/**", "biome.json"] });
  });

  it("すべての glob がファイルに一致すれば違反にしない（must pass）", () => {
    expect(
      findRuleFileViolations(
        ".claude/rules/x.md",
        '---\npaths:\n  - "apps/backend/**"\n  - "biome.json"\n  - "*.test.ts"\n---\n',
        files,
      ),
    ).toEqual([]);
  });

  it.each([
    ["フロントマターが無い", "# 本文だけ\n"],
    ["閉じの --- が無い", '---\npaths:\n  - "apps/backend/**"\n'],
    ["paths が無い", "---\nname: x\n---\n"],
    ["paths が空", "---\npaths:\n---\n"],
    ["paths がスカラー", '---\npaths: "apps/backend/**"\n---\n'],
    ["paths がコメントアウト", '---\n# paths:\n#   - "apps/backend/**"\n---\n'],
  ])("%s なら違反にする（must reject）", (_name, markdown) => {
    expect(
      findRuleFileViolations(".claude/rules/x.md", markdown, files),
    ).toEqual([
      "rules-paths: .claude/rules/x.md にフロントマターの paths（1 件以上）が無い",
    ]);
  });

  it("どのファイルにも一致しない glob（typo）を違反にする（must reject）", () => {
    expect(
      findRuleFileViolations(
        ".claude/rules/x.md",
        '---\npaths:\n  - "apps/backnd/**"\n  - "biome.jsonc"\n  - "apps/backend/**"\n---\n',
        files,
      ),
    ).toEqual([
      'rules-paths: .claude/rules/x.md の glob "apps/backnd/**" に一致するファイルが無い',
      'rules-paths: .claude/rules/x.md の glob "biome.jsonc" に一致するファイルが無い',
    ]);
  });
});

describe("スキルのフロントマター", () => {
  it("name と description があれば違反にしない（must pass）", () => {
    expect(
      findSkillViolations(
        ".claude/skills/x/SKILL.md",
        "---\nname: x\ndescription: いつ使うか\n---\n手順\n",
      ),
    ).toEqual([]);
  });

  it.each([
    ["フロントマターが無い", "手順\n", ["name", "description"]],
    ["name が無い", "---\ndescription: d\n---\n", ["name"]],
    ["description が空", "---\nname: x\ndescription:\n---\n", ["description"]],
    [
      "description が空文字",
      '---\nname: x\ndescription: ""\n---\n',
      ["description"],
    ],
  ])("%s なら違反にする（must reject）", (_name, markdown, missing) => {
    expect(findSkillViolations(".claude/skills/x/SKILL.md", markdown)).toEqual(
      missing.map(
        (key) =>
          `skill-frontmatter: .claude/skills/x/SKILL.md に ${key} が無い`,
      ),
    );
  });
});

describe("サブエージェントの model", () => {
  it.each(ALLOWED_AGENT_MODELS)(
    "許可したフル ID %s なら違反にしない（must pass）",
    (model) => {
      expect(
        findAgentModelViolations(
          ".claude/agents/x.md",
          `---\nname: x\nmodel: ${model}\n---\n本文\n`,
        ),
      ).toEqual([]);
    },
  );

  it.each([
    ["別名", "---\nname: x\nmodel: opus\n---\n", '"opus"'],
    [
      "古い ID",
      "---\nname: x\nmodel: claude-opus-4-1\n---\n",
      '"claude-opus-4-1"',
    ],
    ["空", "---\nname: x\nmodel:\n---\n", "無し"],
    ["model が無い", "---\nname: x\n---\n", "無し"],
    ["フロントマターが無い", "本文だけ\n", "無し"],
  ])("%s なら違反にする（must reject）", (_name, markdown, shown) => {
    expect(findAgentModelViolations(".claude/agents/x.md", markdown)).toEqual([
      `agent-model: .claude/agents/x.md の model が ${shown}（許可: claude-opus-5-5 / claude-sonnet-5-5）`,
    ]);
  });
});

describe("旧 rules/ への参照", () => {
  it.each([
    "詳細は rules/code/architecture.md",
    "（rules/general/branch.md の「CI」）",
    "@rules/code/test.md",
    "`rules/general`",
  ])("%s を違反にする（must reject）", (line) => {
    expect(findLegacyReferences("x.ts", `ok\n${line}\n`)).toEqual([
      "legacy-rules: x.ts:2",
    ]);
  });

  it.each([
    ".claude/rules/backend.md",
    ".claude/rules/general.md",
    "rules/ ディレクトリは削除した",
    "myrules/code/x.md",
    "biome の lint.rules.preset",
  ])("%s は違反にしない（must pass）", (line) => {
    expect(findLegacyReferences("x.ts", line)).toEqual([]);
  });

  it("docs/work-logs/ とこのファイルは検査しない", () => {
    expect(isLegacyScanTarget("docs/work-logs/2026-09-28.md")).toBe(false);
    expect(isLegacyScanTarget(SELF)).toBe(false);
    expect(isLegacyScanTarget("README.md")).toBe(true);
    expect(isLegacyScanTarget("apps/docs/work-logs/x.md")).toBe(true);
    // 除外する作業ログは docs/work-logs/ だけ。リポジトリ直下の work-logs/ に書いたファイルは普通のファイルとして検査する。
    expect(isLegacyScanTarget("work-logs/2026-09-28.md")).toBe(true);
    expect(isLegacyScanTarget("docs/adr/README.md")).toBe(true);
  });
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
    related = "- 関連: Issue #94 / PR #95 / `.claude/rules/backend.md`",
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

describe("ADR（docs/adr/<分類>/）の形式", () => {
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

  it.each([
    ["テンプレートどおり（採用）", adrText()],
    ["状態が廃止", adrText({ status: "- 状態: 廃止" })],
    [
      "状態が置き換えで、置き換え先が同じ分類にある",
      adrText({ status: "- 状態: 置き換え（→ architecture/20260928-old.md）" }),
    ],
    [
      "状態が置き換えで、置き換え先が別の分類にある",
      adrText({ status: "- 状態: 置き換え（→ quality/20260928-gate.md）" }),
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
  ])("%s なら違反にしない（must pass）", (_name, text) => {
    expect(check(text)).toEqual([]);
  });

  it.each([
    "2026-09-29-todo.md",
    "20260929_todo.md",
    "20260929-Todo.md",
    "20260929-todo_invariants.md",
    "20260929-.md",
    "20260929-a--b.md",
    "20260929-todo-.md",
    "2026929-todo.md",
    "20260929-todo.MD",
    "20260929-todo.txt",
    "README.md",
  ])("ファイル名 %s を違反にする（must reject）", (fileName) => {
    const adrPath = `docs/adr/architecture/${fileName}`;
    expect(check(adrText(), adrPath)).toEqual([
      `adr-name: ${adrPath} の名前が yyyymmdd-<topic>.md（topic は英小文字・数字の kebab-case）でない`,
    ]);
  });

  it.each([
    ["見出しが無い", "Todo の不変条件"],
    ["見出しが ## ", "## Todo の不変条件"],
    ["# の後に空白が無い", "#Todo の不変条件"],
    ["見出しが空", "# "],
  ])("1 行目の%sなら違反にする（must reject）", (_name, title) => {
    expect(check(adrText({ title }))).toEqual([
      `adr-title: ${path} の 1 行目が「# 」の見出しでない`,
    ]);
  });

  it.each([
    ["日付の区切りが /", "- 日付: 2026/09/29"],
    ["全角のコロン", "- 日付：2026-09-29"],
    ["日付が無い（行が空）", ""],
  ])("3 行目の%sなら違反にする（must reject）", (_name, date) => {
    expect(check(adrText({ date }))).toEqual([
      `adr-meta: ${path} の 3 行目が「- 日付: YYYY-MM-DD」でない`,
    ]);
  });

  it("日付がファイル名の日付と違えば違反にする（must reject）", () => {
    expect(check(adrText({ date: "- 日付: 2026-09-28" }))).toEqual([
      `adr-meta: ${path} の日付 2026-09-28 がファイル名の 20260929 と違う`,
    ]);
  });

  it.each([
    ["決まった語でない", "- 状態: 採用済み"],
    ["英語", "- 状態: accepted"],
    ["置き換え先が無い", "- 状態: 置き換え"],
    [
      "置き換えの括弧が半角",
      "- 状態: 置き換え(→ architecture/20260928-old.md)",
    ],
  ])("4 行目の状態が%sなら違反にする（must reject）", (_name, status) => {
    expect(check(adrText({ status }))).toEqual([
      `adr-meta: ${path} の 4 行目が「- 状態: 採用 | 置き換え（→ <分類>/<ファイル名>）| 廃止」でない`,
    ]);
  });

  // WHY 分類なしのファイル名・別の書き方を違反にする: 置き換え先は README の一覧のリンクと同じ「<分類>/<ファイル名>」
  //   （docs/adr/ からの相対パス）の 1 通りに揃え、分類を移したときに古い参照が残らないようにする。
  it.each([
    ["存在しない ADR", "architecture/20260930-missing.md"],
    ["分類なしのファイル名だけ", "20260928-old.md"],
    ["分類が違う", "quality/20260928-old.md"],
    ["./ 付き", "./architecture/20260928-old.md"],
    ["ADR からの相対パス", "../architecture/20260928-old.md"],
    ["リポジトリ相対のパス", "docs/adr/architecture/20260928-old.md"],
  ])("置き換え先が%sなら違反にする（must reject）", (_name, target) => {
    expect(
      check(adrText({ status: `- 状態: 置き換え（→ ${target}）` })),
    ).toEqual([
      `adr-meta: ${path} の置き換え先 ${target} が docs/adr に無い（<分類>/<ファイル名> で書く）`,
    ]);
  });

  it.each([
    ["値が空", "- 関連:"],
    ["値が空白だけ", "- 関連: "],
    ["行が別の項目", "- 状態: 採用"],
  ])("5 行目の関連が%sなら違反にする（must reject）", (_name, related) => {
    expect(check(adrText({ related }))).toEqual([
      `adr-meta: ${path} の 5 行目が「- 関連: <Issue / PR / 規則>」でない`,
    ]);
  });

  it.each(ADR_REQUIRED_SECTIONS)(
    "必須の見出し %s が無ければ違反にする（must reject）",
    (heading) => {
      expect(
        check(
          adrText({
            sections: ADR_REQUIRED_SECTIONS.filter((h) => h !== heading),
          }),
        ),
      ).toEqual([`adr-sections: ${path} に「${heading}」が無い`]);
    },
  );

  it("見出しの段が違う・後ろに文字がある見出しは、無いものとして違反にする（must reject）", () => {
    expect(
      check(
        adrText({
          sections: [
            "### 背景",
            "## 決定",
            "## 理由（WHY）",
            "## 採用しなかった案",
            "## 影響",
          ],
        }),
      ),
    ).toEqual([
      `adr-sections: ${path} に「## 背景」が無い`,
      `adr-sections: ${path} に「## 理由」が無い`,
    ]);
  });

  it("必須の見出しの順が違えば違反にする（must reject）", () => {
    expect(
      check(
        adrText({
          sections: [
            "## 背景",
            "## 理由",
            "## 決定",
            "## 採用しなかった案",
            "## 影響",
          ],
        }),
      ),
    ).toEqual([
      `adr-sections: ${path} の見出しが 背景 → 決定 → 理由 → 採用しなかった案 → 影響 の順でない`,
    ]);
  });

  it.each([
    ["README.md が無い", undefined],
    ["一覧にリンクが無い", "| 2026-09-29 | Todo の不変条件 | 採用 |\n"],
    ["ファイル名が文字としてあるだけ", `- ${ref}\n`],
    [
      "リンク先が別の名前",
      "| [x](architecture/20260929-todo-invariants.md) |\n",
    ],
    ["リンク先に分類が無い", `| [x](${name}) |\n`],
    ["リンク先の分類が違う", `| [x](quality/${name}) |\n`],
  ])("%s なら違反にする（must reject）", (_name, readme) => {
    expect(findAdrViolations([{ path, text: adrText() }], readme)).toEqual([
      `adr-index: ${path} が docs/adr/README.md の一覧に無い`,
    ]);
  });
});

describe("ADR の一覧の状態とリンク先（adr-index-state）", () => {
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

  it("状態が ADR と一致し、リンク先がすべてあれば違反にしない（must pass。見出し・区切り・表の外の行は読まない）", () => {
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
    expect(findAdrIndexStateViolations(adrs, index)).toEqual([]);
  });

  it("README.md が無ければ、この検査は違反を出さない（一覧に無いことは adr-index が出す）", () => {
    expect(findAdrIndexStateViolations(adrs, undefined)).toEqual([]);
  });

  it.each([
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
  ])("一覧の状態が%sなら違反にする（must reject）", (_name, listed, actual) => {
    expect(
      findAdrIndexStateViolations(
        adrs,
        header + row(listed, "architecture/20260928-old.md"),
      ),
    ).toEqual([
      `adr-index-state: docs/adr/README.md の一覧の architecture/20260928-old.md の状態「${listed}」が ADR の「${actual}」と違う`,
    ]);
  });

  it("ADR の状態の行が崩れていれば、その行と比べて違反にする（must reject）", () => {
    const broken = [
      {
        path: "docs/adr/architecture/20260929-x.md",
        text: adrText({ status: "- 状態:採用" }),
      },
    ];
    expect(
      findAdrIndexStateViolations(
        broken,
        row("採用", "architecture/20260929-x.md"),
      ),
    ).toEqual([
      "adr-index-state: docs/adr/README.md の一覧の architecture/20260929-x.md の状態「採用」が ADR の「- 状態:採用」と違う",
    ]);
  });

  it.each([
    ["存在しない ADR", "workflow/20260930-missing.md"],
    ["分類なしのファイル名だけ", "20260929-new.md"],
    ["分類が違う", "architecture/20260929-new.md"],
    ["./ 付きのパス", "./workflow/20260929-new.md"],
    ["README.md 自身", "README.md"],
  ])("リンク先が%sなら違反にする（must reject）", (_name, target) => {
    expect(
      findAdrIndexStateViolations(
        adrs,
        `| 2026-09-29 | t | 採用 | [x](${target}) |`,
      ),
    ).toEqual([
      `adr-index-state: docs/adr/README.md の一覧の ${target} が docs/adr に無い`,
    ]);
  });
});

describe("ADR の分類ディレクトリ（adr-category）", () => {
  it("4 つの分類の直下のファイルと、分類の外のファイルは違反にしない（must pass。直下のファイルは adr-only が見る）", () => {
    expect(
      findAdrCategoryViolations([
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
      ]),
    ).toEqual([]);
  });

  it("4 つ以外の分類（大文字・前方一致・旧案の名前を含む）と、分類の下のディレクトリを 1 項目ずつ違反にする（must reject）", () => {
    expect(
      findAdrCategoryViolations([
        "docs/adr/misc/x.md",
        "docs/adr/misc/sub/y.md",
        "docs/adr/Architecture/x.md",
        "docs/adr/architecture-old/x.md",
        "docs/adr/design/x.md",
        "docs/adr/tech/x.md",
        "docs/adr/architecture/sub/y.md",
        "docs/adr/quality/a/b/c.md",
        "docs/adr/quality/a/d.md",
      ]),
    ).toEqual([
      "adr-category: docs/adr/misc/ は分類（architecture / tech-stack / quality / workflow）でない",
      "adr-category: docs/adr/Architecture/ は分類（architecture / tech-stack / quality / workflow）でない",
      "adr-category: docs/adr/architecture-old/ は分類（architecture / tech-stack / quality / workflow）でない",
      "adr-category: docs/adr/design/ は分類（architecture / tech-stack / quality / workflow）でない",
      "adr-category: docs/adr/tech/ は分類（architecture / tech-stack / quality / workflow）でない",
      "adr-category: docs/adr/architecture/sub/ がある（分類の下にディレクトリは置けない）",
      "adr-category: docs/adr/quality/a/ がある（分類の下にディレクトリは置けない）",
    ]);
  });

  it("形式の検査（adr-name ほか）の対象は、4 つの分類の直下のファイルだけ", () => {
    expect(
      [
        "docs/adr/README.md",
        "docs/adr/x.md",
        "docs/adr/misc/20260929-x.md",
        "docs/adr/architecture/sub/20260929-x.md",
        "docs/adr/architecture/20260929-x.md",
        "docs/adr/tech-stack/x.MD",
        "docs/adr-old/architecture/20260929-x.md",
      ].filter(isAdrFile),
    ).toEqual([
      "docs/adr/architecture/20260929-x.md",
      "docs/adr/tech-stack/x.MD",
    ]);
  });
});

describe("docs/ には adr/ と work-logs/ だけ、docs/adr/ の直下には README.md と分類だけ（adr-only）", () => {
  it("docs/adr/ の下のディレクトリのファイル・docs/adr/README.md・docs/work-logs/ の下のファイル・docs/ の外のファイルだけなら違反にしない（must pass）", () => {
    expect(
      findNonAdrDocs([
        "README.md",
        "apps/docs/x.md",
        "mydocs/x.md",
        "docs/adr/README.md",
        "docs/adr/architecture/20260929-x.md",
        "docs/adr/sub/y.md",
        "docs/work-logs/2026-09-29.md",
        "docs/work-logs/2026/09-29.md",
        "docs/work-logs/README.md",
      ]),
    ).toEqual([]);
  });

  // WHY 直下の ADR の例を ADR_DIR で組み立てる: 分類なしの古い参照を `git grep` で「docs/adr/」の直後が日付の参照として見つけるので、意図した
  //   違反の例をその検出に掛けない（下の fixture も同じ）。
  it("docs/adr/ の直下の README.md 以外のファイル（ADR・大文字違いの readme・分類名のファイルを含む）を違反にする（must reject）", () => {
    expect(
      findNonAdrDocs([
        `${ADR_DIR}20260929-x.md`,
        "docs/adr/readme.md",
        "docs/adr/architecture",
        "docs/adr/.keep",
      ]),
    ).toEqual([
      `adr-only: ${ADR_DIR}20260929-x.md がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）`,
      "adr-only: docs/adr/readme.md がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）",
      "adr-only: docs/adr/architecture がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）",
      "adr-only: docs/adr/.keep がある（docs/adr/ の直下に置けるのは README.md と分類ディレクトリだけ）",
    ]);
  });

  it("docs/ の直下のファイル・ディレクトリ（adr / work-logs の前方一致と、その名前のファイルを含む）を 1 項目ずつ違反にする（must reject）", () => {
    expect(
      findNonAdrDocs([
        "docs/README.md",
        "docs/adr",
        "docs/adr-old/x.md",
        "docs/work-logs",
        "docs/work-logs-old/x.md",
        "docs/worklogs/x.md",
        "docs/old/a.md",
        "docs/old/b/c.md",
        "docs/.keep",
      ]),
    ).toEqual([
      "adr-only: docs/README.md がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
      "adr-only: docs/adr がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
      "adr-only: docs/adr-old/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
      "adr-only: docs/work-logs がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
      "adr-only: docs/work-logs-old/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
      "adr-only: docs/worklogs/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
      "adr-only: docs/old/ がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
      "adr-only: docs/.keep がある（docs/ の直下に置けるのは adr/ と work-logs/ だけ）",
    ]);
  });
});

describe("fixture のリポジトリを検査したときに検出される違反", () => {
  let dir: string;

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
      "# CLAUDE.md\n@LEARNINGS.md\n- 運用: @.claude/general/workflow.md\n決定は docs/adr/README.md\n",
    "LEARNINGS.md": "学び\n",
    ".claude/general/workflow.md": "要点\n",
    ".claude/rules/backend.md":
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
    "docs/adr/quality/20260928-old.md": adrText({
      date: "- 日付: 2026-09-28",
      status: "- 状態: 置き換え（→ architecture/20260929-todo.md）",
    }),
    "docs/work-logs/2026-09-28.md":
      "rules/code/test.md を書いた（過去の記録）\n",
    ".gitignore": "ignored/\n",
    "ignored/rules/code/x.md": "rules/code/x.md\n",
  };

  beforeAll(() => {
    // WHY OS の一時ディレクトリ: リポジトリの中に置くと、テストが途中で落ちたときに作業ツリーに残る（.claude/rules/testing.md）。
    dir = mkdtempSync(join(tmpdir(), "instructions-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("許可される構成では違反 0 件（must pass。.gitignore の中と docs/work-logs/ の旧参照は数えない）", () => {
    expect(check(makeRepo("pass", passing))).toEqual([]);
  });

  it("違反を入れた構成では、すべての違反を検出する（must reject）", () => {
    const root = makeRepo("reject", {
      ...passing,
      "CLAUDE.md": `${"x\n".repeat(200)}@LEARNINGS.md\n@missing.md\n@.claude/rules/backend.md\n`,
      ".claude/general/long.md": "x\n".repeat(26),
      ".claude/rules/no-paths.md": "# paths が無い\n",
      ".claude/rules/typo.md": '---\npaths:\n  - "apps/backnd/**"\n---\n',
      ".claude/skills/broken/SKILL.md": "---\nname: broken\n---\n",
      ".claude/agents/alias.md": "---\nname: alias\nmodel: sonnet\n---\n",
      "rules/code/test.md": "旧ルール\n",
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
      // リポジトリ直下の work-logs/ は作業ログとして扱わない（旧参照も数える）。
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
    expect(check(root)).toEqual([
      "claude-md-lines: CLAUDE.md が 203 行（上限 200）",
      "general-lines: .claude/general/long.md が 26 行（上限 25）",
      "claude-md-import: CLAUDE.md → @missing.md（無い）",
      "claude-md-import: CLAUDE.md → @.claude/rules/backend.md（LEARNINGS.md と .claude/general/*.md 以外）",
      "rules-paths: .claude/rules/no-paths.md にフロントマターの paths（1 件以上）が無い",
      'rules-paths: .claude/rules/typo.md の glob "apps/backnd/**" に一致するファイルが無い',
      "legacy-rules: rules/ がある",
      "legacy-rules: README.md:1",
      "legacy-rules: work-logs/2026-09-28.md:1",
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

describe("リポジトリの指示ファイル", () => {
  const found = inventory(listRepoFiles(repoRoot));

  it("列挙が空でない（対象 0 件で緑にならない）", () => {
    // WHY 件数の下限を見る: 列挙の正規表現や git ls-files の失敗で対象が 0 件になると、違反も 0 件になり常に緑になる。
    expect(found.files).toContain(CLAUDE_MD);
    expect(found.ruleFiles.length).toBeGreaterThan(0);
    expect(found.generalFiles.length).toBeGreaterThan(0);
    expect(found.adrs.length).toBeGreaterThan(0);
    expect(found.files).toContain(ADR_INDEX);
    expect(found.skills.length).toBeGreaterThan(0);
    expect(found.agents.length).toBeGreaterThan(0);
    expect(
      extractImports(readFileSync(join(repoRoot, CLAUDE_MD), "utf8")).length,
    ).toBeGreaterThan(0);
  });

  // WHY adr-only だけを別のテストにする: docs/ に記録を足した違反（adr-only）と、指示ファイル・ADR の形式の違反を別の失敗として
  //   読めるようにする。1 つのテストにまとめると、片方の違反がもう片方の失敗に紛れて見えにくくなる。
  const violations = collectInstructionViolations(repoRoot, found);

  it("CLAUDE.md・.claude/general・.claude/rules・スキル・エージェント・ADR に違反が無く、旧 rules/ も残っていない", () => {
    expect(violations.filter((v) => !v.startsWith("adr-only:"))).toEqual([]);
  });

  it("docs/ の直下には adr/ と work-logs/ しか無い", () => {
    expect(violations.filter((v) => v.startsWith("adr-only:"))).toEqual([]);
  });
});
