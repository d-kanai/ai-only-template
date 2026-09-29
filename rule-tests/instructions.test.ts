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
//   仕様として固定するテスト（Issue #64。ADR の検査は Issue #96）。
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
//                     （work-logs/ は過去の記録なので除く。このファイルは例を持つので除く）。
//   adr-name          docs/adr/ のファイル（README.md を除く）の名前が yyyymmdd-<topic>.md（topic は英小文字・数字の kebab-case）。
//   adr-title         ADR の 1 行目が「# 」の見出し（決定を 1 文で書く）。
//   adr-meta          ADR の 3〜5 行目が「- 日付: YYYY-MM-DD」（ファイル名の日付と一致）・「- 状態: 採用 | 置き換え（→ <docs/adr に
//                     あるファイル名>）| 廃止」・「- 関連: <空でない>」。
//   adr-sections      ADR に「## 背景」「## 決定」「## 理由」「## 採用しなかった案」「## 影響」がこの順にある（間に別の見出しは可）。
//   adr-index         ADR が docs/adr/README.md の一覧から `](<ファイル名>)` のリンクで辿れる。
//                     WHY（adr-*）: ADR は読み込まれない不変の記録で、決定が変わると「置き換え」で次の ADR に辿る。形が崩れると
//                     日付・状態・理由を取り出せず、一覧に無いと存在しないのと同じになる（Issue #96 で、廃止した docs の orphan-docs を置き換えた）。
//   skill-frontmatter .claude/skills/*/SKILL.md はフロントマターに name と description を持つ（公式 https://code.claude.com/docs/en/skills 。
//                     description は起動時に一覧として読まれ、いつ使うかの判断に使われる）。
//   agent-model       .claude/agents/*.md はフロントマターの model が許可したフル ID（ALLOWED_AGENT_MODELS）のいずれか
//                     （Issue #78。別名 `opus` / `sonnet` や古い ID は意図しないモデルに解決され、消費と品質が変わる。
//                     `.claude/general/orchestration.md`、`docs/adr/20260929-save-usage-limit.md`）。

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
//   （docs/adr/20260929-save-usage-limit.md）で
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

function isLegacyScanTarget(path: string): boolean {
  return !path.startsWith("work-logs/") && path !== SELF;
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
const ADR_REQUIRED_SECTIONS = [
  "## 背景",
  "## 決定",
  "## 理由",
  "## 採用しなかった案",
  "## 影響",
];

type AdrFile = { path: string; text: string };

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
  adrNames: string[],
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
      `adr-meta: ${path} の 4 行目が「- 状態: 採用 | 置き換え（→ <ファイル名>）| 廃止」でない`,
    );
  } else if (status[1] !== undefined && !adrNames.includes(status[1])) {
    // WHY 置き換え先の実在を見る: 不変の ADR は「置き換え」から次の ADR に辿って最新の決定を知る。参照先が無いと辿れない。
    violations.push(
      `adr-meta: ${path} の置き換え先 ${status[1]} が docs/adr に無い`,
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

// adrs は docs/adr/ の README.md 以外のファイル、index は docs/adr/README.md の中身（無ければ undefined）。
function findAdrViolations(
  adrs: AdrFile[],
  index: string | undefined,
): string[] {
  const adrNames = adrs.map(({ path }) => path.slice(ADR_DIR.length));
  return adrs.flatMap(({ path, text }) => {
    const name = path.slice(ADR_DIR.length);
    const nameDate = adrNameDate(name);
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
      ...findAdrMetaViolations(path, lines, nameDate, adrNames),
      ...findAdrSectionViolations(path, lines),
      ...((index ?? "").includes(`](${name})`)
        ? []
        : [`adr-index: ${path} が ${ADR_INDEX} の一覧に無い`]),
    ];
  });
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
    // WHY .md に限らず docs/adr/ の下をすべて数える: `.MD` や `.txt`、サブディレクトリに置いた ADR も adr-name で違反にし、
    //   形式の検査から黙って外れないようにする。
    adrs: files.filter(
      (file) => file.startsWith(ADR_DIR) && file !== ADR_INDEX,
    ),
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
    "apps/backend/todo/domain/todo.ts",
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

  it("work-logs/ とこのファイルは検査しない", () => {
    expect(isLegacyScanTarget("work-logs/2026-09-28.md")).toBe(false);
    expect(isLegacyScanTarget(SELF)).toBe(false);
    expect(isLegacyScanTarget("README.md")).toBe(true);
    expect(isLegacyScanTarget("apps/work-logs/x.md")).toBe(true);
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

describe("ADR（docs/adr）の形式", () => {
  const name = "20260929-todo-invariants-always-validated.md";
  const path = `docs/adr/${name}`;
  const index = `| 2026-09-29 | [Todo の不変条件](${name}) | 採用 |\n`;

  // 1 件の ADR を README の一覧に載せた状態で検査する（adr-index 以外の検査を単独で見るため）。
  function check(text: string, adrPath = path): string[] {
    const listed = adrPath.slice("docs/adr/".length);
    return findAdrViolations(
      [
        { path: adrPath, text },
        {
          path: "docs/adr/20260928-old.md",
          text: adrText({ date: "- 日付: 2026-09-28" }),
        },
      ],
      `${index}| [old](20260928-old.md) |\n| [x](${listed}) |\n`,
    );
  }

  it.each([
    ["テンプレートどおり（採用）", adrText()],
    ["状態が廃止", adrText({ status: "- 状態: 廃止" })],
    [
      "状態が置き換えで、置き換え先が docs/adr にある",
      adrText({ status: "- 状態: 置き換え（→ 20260928-old.md）" }),
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
    "sub/20260929-todo.md",
  ])("ファイル名 %s を違反にする（must reject）", (fileName) => {
    const adrPath = `docs/adr/${fileName}`;
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
    ["置き換えの括弧が半角", "- 状態: 置き換え(→ 20260928-old.md)"],
  ])("4 行目の状態が%sなら違反にする（must reject）", (_name, status) => {
    expect(check(adrText({ status }))).toEqual([
      `adr-meta: ${path} の 4 行目が「- 状態: 採用 | 置き換え（→ <ファイル名>）| 廃止」でない`,
    ]);
  });

  it("置き換え先が docs/adr に無ければ違反にする（must reject）", () => {
    expect(
      check(adrText({ status: "- 状態: 置き換え（→ 20260930-missing.md）" })),
    ).toEqual([
      `adr-meta: ${path} の置き換え先 20260930-missing.md が docs/adr に無い`,
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
    ["ファイル名が文字としてあるだけ", `- ${name}\n`],
    ["リンク先が別の名前", "| [x](20260929-todo-invariants.md) |\n"],
  ])("%s なら違反にする（must reject）", (_name, readme) => {
    expect(findAdrViolations([{ path, text: adrText() }], readme)).toEqual([
      `adr-index: ${path} が docs/adr/README.md の一覧に無い`,
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
    "docs/adr/README.md":
      "```markdown\n## 背景\n```\n| [Todo](20260929-todo.md) |\n| [旧](20260928-old.md) |\n",
    "docs/adr/20260929-todo.md": adrText(),
    "docs/adr/20260928-old.md": adrText({
      date: "- 日付: 2026-09-28",
      status: "- 状態: 置き換え（→ 20260929-todo.md）",
    }),
    "work-logs/2026-09-28.md": "rules/code/test.md を書いた（過去の記録）\n",
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

  it("許可される構成では違反 0 件（must pass。.gitignore の中と work-logs/ の旧参照は数えない）", () => {
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
      "docs/adr/README.md": `${passing["docs/adr/README.md"]}| [bad](20260929_bad.md) |\n`,
      "docs/adr/20260929_bad.md": adrText(),
      // 一覧に無く、見出し・メタ・必須の見出しがすべて崩れた ADR。
      "docs/adr/20260928-broken.md": adrText({
        title: "決定",
        date: "- 日付: 2026-09-29",
        status: "- 状態: 置き換え（→ 20260930-missing.md）",
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
      "adr-title: docs/adr/20260928-broken.md の 1 行目が「# 」の見出しでない",
      "adr-meta: docs/adr/20260928-broken.md の日付 2026-09-29 がファイル名の 20260928 と違う",
      "adr-meta: docs/adr/20260928-broken.md の置き換え先 20260930-missing.md が docs/adr に無い",
      "adr-meta: docs/adr/20260928-broken.md の 5 行目が「- 関連: <Issue / PR / 規則>」でない",
      "adr-sections: docs/adr/20260928-broken.md に「## 影響」が無い",
      "adr-index: docs/adr/20260928-broken.md が docs/adr/README.md の一覧に無い",
      "adr-name: docs/adr/20260929_bad.md の名前が yyyymmdd-<topic>.md（topic は英小文字・数字の kebab-case）でない",
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

  it("CLAUDE.md・.claude/general・.claude/rules・スキル・エージェント・ADR に違反が無く、旧 rules/ も残っていない", () => {
    expect(collectInstructionViolations(repoRoot, found)).toEqual([]);
  });
});
