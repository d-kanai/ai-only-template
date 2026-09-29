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

// 指示ファイル（CLAUDE.md / .claude/general / .claude/rules / .claude/skills / docs）の構成を仕様として固定するテスト（Issue #64）。
// WHY 機械で検査する: 指示ファイルは「読み込まれているか」「どこからも辿れない文書が無いか」を人が見落としやすい。
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
//   orphan-docs       docs/*.md は CLAUDE.md・.claude/**/*.md・README.md・docs/README.md のどこかから参照されている
//                     （docs は読み込まれない記録なので、どこからも辿れないと存在しないのと同じになる）。
//   skill-frontmatter .claude/skills/*/SKILL.md はフロントマターに name と description を持つ（公式 https://code.claude.com/docs/en/skills 。
//                     description は起動時に一覧として読まれ、いつ使うかの判断に使われる）。
//   agent-model       .claude/agents/*.md はフロントマターの model が許可したフル ID（ALLOWED_AGENT_MODELS）のいずれか
//                     （Issue #78。別名 `opus` / `sonnet` や古い ID は意図しないモデルに解決され、消費と品質が変わる。
//                     `.claude/general/orchestration.md`、`docs/usage.md`）。

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
//   どのモデルで動くかを定義ファイルの差分で読めるようにし、機械的な作業に軽いモデル（Sonnet）を使う運用（docs/usage.md）で
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

// --- docs の参照 ---
function isDocLinkSource(path: string): boolean {
  return (
    path === CLAUDE_MD ||
    path === "README.md" ||
    path === "docs/README.md" ||
    (path.startsWith(".claude/") && path.endsWith(".md"))
  );
}

// source の中の .md のパスらしい文字列を、リポジトリ相対と source からの相対の両方で解決した集合。
function referencedMarkdown(source: string, text: string): Set<string> {
  const referenced = new Set<string>();
  for (const [token] of text.matchAll(/[\w./-]+\.md(?![\w-]|\.\w)/g)) {
    referenced.add(posix.normalize(token));
    referenced.add(posix.normalize(posix.join(posix.dirname(source), token)));
  }
  return referenced;
}

function findOrphanDocs(
  docs: string[],
  sources: { path: string; text: string }[],
): string[] {
  const referenced = new Set(
    sources.flatMap(({ path, text }) => [...referencedMarkdown(path, text)]),
  );
  return docs
    .filter((doc) => !referenced.has(doc))
    .map((doc) => `orphan-docs: ${doc} がどこからも参照されていない`);
}

// --- リポジトリ全体 ---
// リポジトリのファイル（追跡済みと、.gitignore に無い未追跡）。削除済みで作業ツリーに無いものは除く。
// WHY 未追跡も含める: 作業中（コミット前）に足した docs や rules の paths も同じ条件で検査するため。コミット後は追跡済みと同じ。
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
  docs: string[];
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
    docs: files.filter(
      (file) => /^docs\/[^/]+\.md$/.test(file) && file !== "docs/README.md",
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
    ...findOrphanDocs(
      found.docs,
      found.files
        .filter(isDocLinkSource)
        .map((path) => ({ path, text: read(path) ?? "" })),
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
    expect(isAllowedImportTarget("docs/README.md")).toBe(false);
    expect(isAllowedImportTarget(".claude/general/x.txt")).toBe(false);
  });

  it("無いファイル・許可外のファイルへの @ を違反にし、読んだファイルの @ も辿る", () => {
    const files: Record<string, string> = {
      "CLAUDE.md":
        "@LEARNINGS.md\n@.claude/general/a.md\n@missing.md\n@docs/README.md\n",
      "LEARNINGS.md": "学び\n",
      ".claude/general/a.md": "@b.md と @../../LEARNINGS.md\n",
      "docs/README.md": "一覧\n",
    };
    expect(findImportViolations((path) => files[path])).toEqual([
      "claude-md-import: CLAUDE.md → @missing.md（無い）",
      "claude-md-import: CLAUDE.md → @docs/README.md（LEARNINGS.md と .claude/general/*.md 以外）",
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
    expect(isLegacyScanTarget("docs/work-logs/x.md")).toBe(true);
  });
});

describe("docs の参照", () => {
  const docs = ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"];

  it("CLAUDE.md・.claude・README.md・docs/README.md から参照された docs を孤立にしない（must pass）", () => {
    expect(
      findOrphanDocs(docs, [
        { path: "CLAUDE.md", text: "記録は `docs/a.md`" },
        { path: ".claude/rules/x.md", text: "[実測](../../docs/b.md)" },
        { path: "docs/README.md", text: "- [c](c.md)\n- ./d.md" },
      ]),
    ).toEqual([]);
  });

  it("参照されていない・前方一致だけ・参照元の対象外からだけ参照された docs を孤立にする（must reject）", () => {
    expect(
      findOrphanDocs(docs, [
        {
          path: "CLAUDE.md",
          text: "docs/a.md.bak と docs/b-old.md と mydocs/c.md",
        },
      ]),
    ).toEqual([
      "orphan-docs: docs/a.md がどこからも参照されていない",
      "orphan-docs: docs/b.md がどこからも参照されていない",
      "orphan-docs: docs/c.md がどこからも参照されていない",
      "orphan-docs: docs/d.md がどこからも参照されていない",
    ]);
  });

  it("参照元になるのは CLAUDE.md・.claude/**/*.md・README.md・docs/README.md だけ", () => {
    expect(isDocLinkSource("CLAUDE.md")).toBe(true);
    expect(isDocLinkSource(".claude/rules/x.md")).toBe(true);
    expect(isDocLinkSource(".claude/skills/x/SKILL.md")).toBe(true);
    expect(isDocLinkSource("README.md")).toBe(true);
    expect(isDocLinkSource("docs/README.md")).toBe(true);
    expect(isDocLinkSource("docs/a.md")).toBe(false);
    expect(isDocLinkSource("work-logs/2026-09-28.md")).toBe(false);
    expect(isDocLinkSource(".claude/settings.json")).toBe(false);
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
      "# CLAUDE.md\n@LEARNINGS.md\n- 運用: @.claude/general/workflow.md\n記録は docs/README.md\n",
    "LEARNINGS.md": "学び\n",
    ".claude/general/workflow.md": "要点\n",
    ".claude/rules/backend.md":
      '---\npaths:\n  - "apps/backend/**"\n---\n規則は docs/decisions.md\n',
    ".claude/skills/pr-flow/SKILL.md":
      "---\nname: pr-flow\ndescription: PR を作るとき\n---\n",
    ".claude/agents/worker.md":
      "---\nname: worker\nmodel: claude-opus-5-5\n---\n本文\n",
    "apps/backend/x.ts": "export const x = 1;\n",
    "docs/README.md": "- [decisions](decisions.md)\n",
    "docs/decisions.md": "経緯\n",
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
      "docs/orphan.md": "どこからも参照されない\n",
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
      "orphan-docs: docs/orphan.md がどこからも参照されていない",
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
    expect(found.docs.length).toBeGreaterThan(0);
    expect(found.skills.length).toBeGreaterThan(0);
    expect(found.agents.length).toBeGreaterThan(0);
    expect(
      extractImports(readFileSync(join(repoRoot, CLAUDE_MD), "utf8")).length,
    ).toBeGreaterThan(0);
  });

  it("CLAUDE.md・.claude/general・.claude/rules・スキル・docs に違反が無く、旧 rules/ も残っていない", () => {
    expect(collectInstructionViolations(repoRoot, found)).toEqual([]);
  });
});
