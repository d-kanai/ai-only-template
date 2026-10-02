// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは md を文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";

// コードのルール文書（.claude/rules/code/*.md）を `| カテゴリ | WHAT | WHY | 強制 |` の表で書く形（Issue #322）を機械的に検査するテスト。
// WHY 表にする（daiki の判断 2026-10-02）: CLAUDE.md 原則 7 のとおり、規則は機械で止められるならそちらを優先する。どの規範が
//   ルール検査テストなどで強制済みで、どれがレビューで見るものかを 1 行ずつ「強制」の列で読めるようにし、レビューの観点の一覧
//   （REVIEW.md）を作ることと、まだ機械で止めていない規範を機械化するかの判断に使う。箇条書き・地の文だと、規範と説明と強制の
//   有無が 1 つの文に混ざり、読む人ごとに解釈がずれる。
// WHY 形を機械で止める: 表に書き換えた後に箇条書きを足したり、強制の列に存在しない検査を書いたりすると、「強制済み」と読めるのに
//   実際には何も止めていない規範ができる（強制の参照はファイルと名前が実在することまで見る）。
// 違反にするもの（規則。違反の文字列の先頭が規則名）:
//   - rules-table-body: フロントマター（1 行目の `---` から次の `---` まで）の後の空でない行は、見出し（`#`〜`######` と空白）・
//     表の行（前後の空白を除いて `|` で始まり、エスケープしていない `|` で終わる）・フェンスのコードブロック（```` ``` ```` で
//     始まる行から次のその行まで。フェンスの行を含む）の中だけ。閉じていないフェンスも開いた行で違反（閉じないと後ろの行が
//     すべてコードとして素通りする）。
//   - rules-table-header: 連続した表の行のかたまり（表）ごとに、1 行目のセルが `カテゴリ` / `WHAT` / `WHY` / `強制` の 4 つ、
//     2 行目が `| --- | --- | --- | --- |`（各セル `---`）、3 行目からのデータ行のセルがちょうど 4 つ。セルは行の先頭と末尾の
//     `|` を除き、`\|` でない `|` で分ける（TS のユニオン型は `\|` と書く）。2 行目が区切り行でなければ、2 行目からをデータ行として見る。
//   - rules-table-cell: データ行（セルが 4 つのもの）のカテゴリ・WHAT・WHY・強制のセルが空でない。WHY が無い行は `-` と書く。
//   - rules-table-rows: ファイルの表のデータ行（3 行目から）が合わせて 1 行以上ある。WHY: 表が 1 つも無い（見出しとコードだけの）
//     ファイルや、表を消してヘッダだけ残したファイルは、ほかの規則に何もかからずに通り、規範を表で書く決まりが素通りする
//     （PR #327 の Codex のレビューの指摘）。
//   - rules-table-heading: 見出しは `#` と `##` の 2 つの深さだけ（`###` 以下は違反）、`#` はファイルに 1 つ、見出しに括弧の注記
//     （`（` `(`）を書かない。表はどれも直前の見出しが `##` で、1 つの `##` の下に表は 1 つ（表の前に `##` が無い・同じ `##` の
//     下の 2 つ目の表・表の無い `##` は違反）。WHY（daiki の判断 2026-10-02、Issue #336）: 分類は「1 段目 = 表（`##` の見出し）、
//     2 段目 = カテゴリの列」の 2 段にそろえる。`###` で 3 段目を作ったり、1 つの見出しに表を並べたりすると、どの表に何があるかが
//     見出しから読めなくなる。括弧の注記（Issue 番号・パス・補足）は見出しを長くして何の表かを読みにくくした（「backend（API 側。
//     apps/backend）」「置き場所（feature は DDD 4 層、shared は意味の単位）」）ので、注記は表の行に書く。
//   - rules-table-enforce: 強制のセル（空でないもの）が `レビュー`（機械で止めていない規範）・`説明`（規範でない説明・一覧・経緯）・
//     機械の検査への参照を `、` で区切った並びのどれか。参照の 1 項目は `` `<パス>` `` か `` `<パス>` の `<名前>` ``（名前が複数なら
//     `` `a`・`b` ``）か `` `pnpm typecheck` `` / `` `pnpm lint` ``。パスはリポジトリ相対（`/` 始まり・`..` を含むものは違反）で、
//     実在するファイル。名前はそのファイルの中に文字列として出てくること（規則名・Biome のルール名など）。
// 検査の対象の列挙（.claude/rules/code/ の直下の *.md）が 0 件なら、実ファイルのテストで失敗させる（0 件だと違反も 0 件で常に緑になる）。
// 限界（見逃す方向）:
//   - 列の中身が正しいか（WHAT が規範か、WHY が理由か、`レビュー` の行が本当に機械で止まっていないか、参照した検査がその規範を
//     止めているか）は見ない（レビューで見る）。名前は部分一致の文字列の検索なので、コメントの中にだけある名前でも通る。
//   - 表の外に置いたコードブロックの中身は何でも通る（コード例のため）。フェンスは ```` ``` ```` だけで、`~~~` は地の文として違反に
//     なる。開きのフェンスに続く ```` ```ts ```` のような行も閉じとして扱う（CommonMark の「閉じには情報文字列を書けない」を見ない）。
//   - 書き換えで内容を削っていないか（コードスパン・Issue・ADR の数）は見ない（Issue #322 の書き換えのときにスクリプトで確かめる）。

const RULES_DIR = ".claude/rules/code";
const PAREN = /[（(]/;
const HEADER = ["カテゴリ", "WHAT", "WHY", "強制"];
const SEPARATOR_CELL = "---";
// WHY この 2 つだけ参照として許す: パスで指せる検査ファイルが無い（tsc と Biome の全体の実行）。Biome の個々のルールは
//   `biome.json` の `<ルール名>` で指せる。
const COMMAND_REFERENCES = new Set(["`pnpm typecheck`", "`pnpm lint`"]);
const NON_REFERENCE_ENFORCEMENTS = new Set(["レビュー", "説明"]);

// ---- 判定 ----

// フロントマターの後の行（1 始まりの行番号つき）。1 行目が `---` でなければファイル全体。閉じていなければ 1 行目から（`---` が違反になる）。
function bodyLines(content: string): { line: number; text: string }[] {
  const lines = content.split("\n").map((text) => text.replace(/\r$/, ""));
  const closing =
    lines[0] === "---" ? lines.findIndex((l, i) => i > 0 && l === "---") : -1;
  return lines
    .map((text, index) => ({ line: index + 1, text }))
    .slice(closing + 1);
}

function isHeading(text: string): boolean {
  return /^#{1,6}\s+\S/.test(text);
}

function isTableRow(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length >= 2 &&
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    !trimmed.endsWith("\\|")
  );
}

function isFence(text: string): boolean {
  return text.trim().startsWith("```");
}

type Located = { line: number; message: string };

// rules-table-body: 見出し・表の行・フェンスの中とフェンスの行・空行以外の行。
function findBodyViolations(content: string): Located[] {
  const violations: Located[] = [];
  let openFence: number | undefined;
  for (const { line, text } of bodyLines(content)) {
    if (isFence(text)) {
      openFence = openFence === undefined ? line : undefined;
      continue;
    }
    if (openFence !== undefined) continue;
    if (text.trim() === "" || isHeading(text) || isTableRow(text)) continue;
    violations.push({
      line,
      message: "見出し・表の行・コードブロックのどれでもない行",
    });
  }
  if (openFence !== undefined) {
    violations.push({ line: openFence, message: "フェンスが閉じていない" });
  }
  return violations;
}

// rules-table-heading の判定に使う、フェンスの外の見出しと表（表は 1 行目の行番号）の並び。
type Block =
  | { kind: "heading"; level: number; line: number; text: string }
  | { kind: "table"; line: number };

function headingsAndTables(content: string): Block[] {
  const tableStarts = new Set(tables(content).map((rows) => rows[0]?.line));
  const result: Block[] = [];
  let inFence = false;
  for (const { line, text } of bodyLines(content)) {
    if (isFence(text)) inFence = !inFence;
    if (inFence || isFence(text)) continue;
    if (isHeading(text)) {
      const level = /^#+/.exec(text)?.[0].length ?? 0;
      result.push({ kind: "heading", level, line, text });
    } else if (tableStarts.has(line)) {
      result.push({ kind: "table", line });
    }
  }
  return result;
}

// rules-table-heading: 見出しの深さ・括弧の注記・2 つ目の `#` と、表と `##` の 1 対 1。行の順（同じ行は判定の順）。
function findHeadingViolations(content: string): Located[] {
  const blocks = headingsAndTables(content);
  const headings = blocks.flatMap((block) =>
    block.kind === "heading" ? [block] : [],
  );
  const text = headings.flatMap((heading) => [
    ...(heading.level >= 3
      ? [
          {
            line: heading.line,
            message: "見出しは # と ## だけ（### 以下は使わない）",
          },
        ]
      : []),
    ...(PAREN.test(heading.text)
      ? [{ line: heading.line, message: "見出しに括弧の注記を書かない" }]
      : []),
  ]);
  const extraH1 = headings
    .filter((heading) => heading.level === 1)
    .slice(1)
    .map((heading) => ({ line: heading.line, message: "# の見出しが 2 つ目" }));
  return [...text, ...extraH1, ...findSectionViolations(blocks)]
    .map((v, order) => ({ ...v, order }))
    .sort((x, y) => x.line - y.line || x.order - y.order)
    .map(({ line, message }) => ({ line, message }));
}

// 表と `##` の 1 対 1。`###` 以下は区切りにしない（深さの違反は別に出す）。
function findSectionViolations(blocks: Block[]): Located[] {
  const violations: Located[] = [];
  // 今の `##` の行と、その下の表の数。`##` の前（または `#` の後）は undefined。
  let section: { line: number; tables: number } | undefined;
  const closeSection = () => {
    if (section?.tables === 0) {
      violations.push({
        line: section.line,
        message: "## の見出しの下に表が無い",
      });
    }
  };
  for (const block of blocks) {
    if (block.kind === "heading") {
      if (block.level > 2) continue;
      closeSection();
      section = block.level === 2 ? { line: block.line, tables: 0 } : undefined;
      continue;
    }
    if (section === undefined) {
      violations.push({
        line: block.line,
        message: "表の前に ## の見出しが無い",
      });
      continue;
    }
    section.tables += 1;
    if (section.tables > 1) {
      violations.push({
        line: block.line,
        message: "1 つの ## の下に 2 つ目の表",
      });
    }
  }
  closeSection();
  return violations;
}

// 行の先頭と末尾の `|` を除き、`\|` でない `|` で分けたセル（前後の空白を除く）。
function tableCells(row: string): string[] {
  return row
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

// フェンスの外の、連続した表の行のかたまり。
function tables(content: string): { line: number; text: string }[][] {
  const result: { line: number; text: string }[][] = [];
  let current: { line: number; text: string }[] = [];
  let inFence = false;
  for (const entry of bodyLines(content)) {
    if (isFence(entry.text)) inFence = !inFence;
    if (!inFence && !isFence(entry.text) && isTableRow(entry.text)) {
      current.push(entry);
      continue;
    }
    if (current.length > 0) result.push(current);
    current = [];
  }
  if (current.length > 0) result.push(current);
  return result;
}

const sameCells = (cells: string[], expected: string[]) =>
  cells.length === expected.length &&
  cells.every((cell, index) => cell === expected[index]);

// 規則名つきの違反（行番号つき）。rules-table-header / rules-table-cell / rules-table-enforce。
type RuleViolation = { rule: string; line: number; message: string };

function findTableViolations(
  content: string,
  referenceRoot: string,
): RuleViolation[] {
  return tables(content).flatMap((rows) => {
    const [header, separator, ...rest] = rows;
    const violations: RuleViolation[] = [];
    if (header && !sameCells(tableCells(header.text), HEADER)) {
      violations.push({
        rule: "rules-table-header",
        line: header.line,
        message: `ヘッダが | ${HEADER.join(" | ")} | でない`,
      });
    }
    const separatorIsValid =
      separator !== undefined &&
      sameCells(
        tableCells(separator.text),
        HEADER.map(() => SEPARATOR_CELL),
      );
    if (!separatorIsValid) {
      violations.push({
        rule: "rules-table-header",
        line: separator?.line ?? header?.line ?? 0,
        message: "ヘッダの次の行が | --- | --- | --- | --- | でない",
      });
    }
    const dataRows = separatorIsValid
      ? rest
      : [separator, ...rest].filter((row) => row !== undefined);
    for (const row of dataRows) {
      violations.push(...findRowViolations(row, referenceRoot));
    }
    return violations;
  });
}

function findRowViolations(
  row: { line: number; text: string },
  referenceRoot: string,
): RuleViolation[] {
  const cells = tableCells(row.text);
  if (cells.length !== HEADER.length) {
    return [
      {
        rule: "rules-table-header",
        line: row.line,
        message: `セルが ${cells.length} 個（${HEADER.length} 個にする。セルの中の | は \\| と書く）`,
      },
    ];
  }
  const empty = HEADER.filter((_, index) => cells[index] === "").map(
    (name): RuleViolation => ({
      rule: "rules-table-cell",
      line: row.line,
      message: `${name} のセルが空（WHY が無ければ - と書く）`,
    }),
  );
  const enforcement = cells[3] ?? "";
  const enforce =
    enforcement === ""
      ? []
      : findEnforcementViolations(enforcement, referenceRoot).map(
          (message): RuleViolation => ({
            rule: "rules-table-enforce",
            line: row.line,
            message,
          }),
        );
  return [...empty, ...enforce];
}

// rules-table-enforce: 強制のセルの違反（場所なし）。
function findEnforcementViolations(
  cell: string,
  referenceRoot: string,
): string[] {
  if (NON_REFERENCE_ENFORCEMENTS.has(cell)) return [];
  return cell
    .split("、")
    .map((item) => item.trim())
    .flatMap((item) => findReferenceViolations(item, referenceRoot));
}

function findReferenceViolations(
  item: string,
  referenceRoot: string,
): string[] {
  if (COMMAND_REFERENCES.has(item)) return [];
  const match = /^`([^`]+)`(?: の (`[^`]+`(?:・`[^`]+`)*))?$/.exec(item);
  if (!match) {
    return [
      `強制が「レビュー」「説明」か検査への参照（\`<パス>\` / \`<パス>\` の \`<名前>\`）でない: ${item}`,
    ];
  }
  const path = match[1] ?? "";
  if (path.startsWith("/") || path.split("/").includes("..")) {
    return [`参照のパスがリポジトリ相対でない: ${path}`];
  }
  const content = readFileIfExists(join(referenceRoot, path));
  if (content === undefined) return [`参照のパスのファイルが無い: ${path}`];
  const names = [...(match[2] ?? "").matchAll(/`([^`]+)`/g)].map(
    (name) => name[1] ?? "",
  );
  return names
    .filter((name) => !content.includes(name))
    .map((name) => `参照の名前 ${name} が ${path} の中に無い`);
}

function readFileIfExists(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

// 表のデータ行（各表の 3 行目から）が 1 つも無ければ、ファイルの 1 行目で違反。
function findMissingRowViolations(content: string): RuleViolation[] {
  const dataRows = tables(content).reduce(
    (count, rows) => count + Math.max(0, rows.length - 2),
    0,
  );
  return dataRows > 0
    ? []
    : [
        {
          rule: "rules-table-rows",
          line: 1,
          message: "表のデータ行が 1 つも無い",
        },
      ];
}

// 1 ファイルのすべての違反（`<規則名>: <パス>:<行> <内容>`）。行の順、同じ行は規則の判定の順。
function checkRulesFile(
  path: string,
  content: string,
  referenceRoot: string,
): string[] {
  const all: RuleViolation[] = [
    ...findBodyViolations(content).map((v) => ({
      rule: "rules-table-body",
      ...v,
    })),
    ...findHeadingViolations(content).map((v) => ({
      rule: "rules-table-heading",
      ...v,
    })),
    ...findTableViolations(content, referenceRoot),
    ...findMissingRowViolations(content),
  ];
  return all
    .map((v, order) => ({ ...v, order }))
    .sort((a, b) => a.line - b.line || a.order - b.order)
    .map((v) => `${v.rule}: ${path}:${v.line} ${v.message}`);
}

// ---- 列挙と検査（本番と fixture で同じ処理を通す） ----

// .claude/rules/code/ の直下の *.md（リポジトリ相対、名前順）。無ければ空。
function listRulesFiles(root: string): string[] {
  try {
    return readdirSync(join(root, RULES_DIR), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => `${RULES_DIR}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

function collectRulesTableViolations(root: string): string[] {
  return listRulesFiles(root).flatMap((path) =>
    checkRulesFile(path, readFileSync(join(root, path), "utf8"), root),
  );
}

const repoRoot = join(import.meta.dirname, "..");
const lines = (...parts: string[]) => parts.join("\n");
const TABLE_HEAD = lines(
  "| カテゴリ | WHAT | WHY | 強制 |",
  "| --- | --- | --- | --- |",
);
const FRONT = lines("---", "paths:", '  - "apps/x/**"', "---");

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rules-table-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

// 強制の参照の判定に使うファイル（must pass / must reject の共通の参照先）。
const referenceRoot = fixture({
  "rule-tests/x.test.ts": "// rule-a: ...\n// rule-b: ...\n",
  "biome.json": '{ "noExplicitAny": "error" }\n',
  "dir/keep.txt": "x\n",
});

const feature = await loadFeature("./rules-table.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("本文の行（rules-table-body）", ({ And }) => {
    And(
      "フロントマターの後の見出し・表の行・フェンスのコードブロックの中の行とフェンスの行・空行は違反なし",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "フロントマターの中の行（paths の箇条書き）",
            lines(FRONT, "# 見出し"),
          ],
          ["見出し（# から ######）", lines("# a", "## b", "###### c")],
          ["表の行（前後の空白）", lines("| a |", "  | b | c |  ")],
          [
            "フェンスの中の箇条書き・地の文とフェンスの行",
            lines("```ts", "- a", "地の文", "> 引用", "```"),
          ],
          ["空行と空白だけの行", lines("# a", "", "   ", "## b")],
          ["空", ""],
        ];

        // when
        const result = casesByName(cases, ([, content]) =>
          findBodyViolations(content),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "箇条書き・地の文・番号付きリスト・引用・縦棒で終わらない行・フロントマターの無いファイルの区切り・閉じていないフェンスは、ファイルと行で違反になる",
      () => {
        // given
        const bad = "見出し・表の行・コードブロックのどれでもない行";
        const cases: [string, string, Located[]][] = [
          [
            "箇条書き（- と *）",
            lines(FRONT, "# a", "- x", "* y"),
            [
              { line: 6, message: bad },
              { line: 7, message: bad },
            ],
          ],
          ["地の文", lines(FRONT, "地の文"), [{ line: 5, message: bad }]],
          ["番号付きリスト", lines("1. x"), [{ line: 1, message: bad }]],
          ["引用", lines("> x"), [{ line: 1, message: bad }]],
          [
            "# の後に空白の無い行",
            lines("#見出し"),
            [{ line: 1, message: bad }],
          ],
          [
            "縦棒で始まり縦棒で終わらない行・エスケープした縦棒で終わる行",
            lines("| a | b", "| a \\|"),
            [
              { line: 1, message: bad },
              { line: 2, message: bad },
            ],
          ],
          [
            "表の間の地の文",
            lines(TABLE_HEAD, "説明", TABLE_HEAD),
            [{ line: 3, message: bad }],
          ],
          [
            "閉じていないフロントマター（--- と後ろの行）",
            lines("---", "paths: x"),
            [
              { line: 1, message: bad },
              { line: 2, message: bad },
            ],
          ],
          [
            "閉じたフェンスの後の地の文",
            lines("```", "x", "```", "地の文"),
            [{ line: 4, message: bad }],
          ],
          [
            "閉じていないフェンス",
            lines("# a", "```", "- x"),
            [{ line: 2, message: "フェンスが閉じていない" }],
          ],
          ["~~~ のフェンス", lines("~~~"), [{ line: 1, message: bad }]],
        ];

        // when
        const result = casesByName(cases, ([, content]) =>
          findBodyViolations(content),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );
  });

  Scenario("表のヘッダと列（rules-table-header）", ({ And }) => {
    And(
      "ヘッダが カテゴリ・WHAT・WHY・強制 で 2 行目が区切り行、データ行が 4 セル（エスケープした縦棒はセルの区切りにしない）の表は違反なし",
      () => {
        // given
        const cases: [string, string][] = [
          ["データ行の無い表", TABLE_HEAD],
          ["データ行 1 つ", lines(TABLE_HEAD, "| a | b | c | レビュー |")],
          [
            "セルの中のエスケープした縦棒",
            lines(TABLE_HEAD, "| 型 | `A \\| B` と書く | - | 説明 |"),
          ],
          [
            "見出しで分けた 2 つの表",
            lines(TABLE_HEAD, "| a | b | c | 説明 |", "## x", TABLE_HEAD),
          ],
          ["フェンスの中の表でない縦棒の行", lines("```", "| x |", "```")],
        ];

        // when
        const result = casesByName(cases, ([, content]) =>
          findTableViolations(content, referenceRoot),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "ヘッダの列名違い・列の数違い・区切り行が無い・データ行のセルが 3 個や 5 個は、ファイルと行で違反になる",
      () => {
        // given
        const header = (line: number): RuleViolation => ({
          rule: "rules-table-header",
          line,
          message: "ヘッダが | カテゴリ | WHAT | WHY | 強制 | でない",
        });
        const separator = (line: number): RuleViolation => ({
          rule: "rules-table-header",
          line,
          message: "ヘッダの次の行が | --- | --- | --- | --- | でない",
        });
        const cells = (line: number, n: number): RuleViolation => ({
          rule: "rules-table-header",
          line,
          message: `セルが ${n} 個（4 個にする。セルの中の | は \\| と書く）`,
        });
        const cases: [string, string, RuleViolation[]][] = [
          [
            "ヘッダの列名違い（理由）",
            lines(
              "| カテゴリ | WHAT | 理由 | 強制 |",
              "| --- | --- | --- | --- |",
            ),
            [header(1)],
          ],
          [
            "ヘッダの列の数違い（3 列）",
            lines("| カテゴリ | WHAT | WHY |", "| --- | --- | --- | --- |"),
            [header(1)],
          ],
          [
            "区切り行が無い（2 行目がデータ行）",
            lines("| カテゴリ | WHAT | WHY | 強制 |", "| a | b | c | 説明 |"),
            [separator(2)],
          ],
          ["ヘッダだけ", "| カテゴリ | WHAT | WHY | 強制 |", [separator(1)]],
          [
            "区切り行のセルが 3 個",
            lines("| カテゴリ | WHAT | WHY | 強制 |", "| --- | --- | --- |"),
            [separator(2), cells(2, 3)],
          ],
          [
            "データ行のセルが 3 個",
            lines(TABLE_HEAD, "| a | b | 説明 |"),
            [cells(3, 3)],
          ],
          [
            "データ行のセルが 5 個（エスケープしない縦棒）",
            lines(TABLE_HEAD, "| a | `A | B` | c | 説明 |"),
            [cells(3, 5)],
          ],
          [
            "2 つ目の表のヘッダ違い",
            lines(
              TABLE_HEAD,
              "",
              "| a | b | c | d |",
              "| --- | --- | --- | --- |",
            ),
            [header(4)],
          ],
        ];

        // when
        const result = casesByName(cases, ([, content]) =>
          findTableViolations(content, referenceRoot),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );
  });

  Scenario("データ行のある表（rules-table-rows）", ({ And }) => {
    And("表のデータ行が合わせて 1 行以上あれば違反なし", () => {
      // given
      const cases: [string, string][] = [
        ["データ行 1 つ", lines(TABLE_HEAD, "| a | b | c | 説明 |")],
        [
          "データ行の無い表と、データ行のある表",
          lines(TABLE_HEAD, "## x", TABLE_HEAD, "| a | b | c | 説明 |"),
        ],
      ];

      // when
      const result = casesByName(cases, ([, content]) =>
        findMissingRowViolations(content),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => []));
    });

    And(
      "表が無い・ヘッダと区切り行だけの表しか無いファイルは、1 行目で違反になる",
      () => {
        // given
        const missing: RuleViolation[] = [
          {
            rule: "rules-table-rows",
            line: 1,
            message: "表のデータ行が 1 つも無い",
          },
        ];
        const cases: [string, string][] = [
          ["空のファイル", ""],
          ["フロントマターと見出しだけ", lines(FRONT, "# x", "## y")],
          [
            "コードブロックの中の表",
            lines("# x", "```", TABLE_HEAD, "| a | b | c | 説明 |", "```"),
          ],
          [
            "ヘッダと区切り行だけの表が 2 つ",
            lines(TABLE_HEAD, "## x", TABLE_HEAD),
          ],
        ];

        // when
        const result = casesByName(cases, ([, content]) =>
          findMissingRowViolations(content),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => missing));
      },
    );
  });

  Scenario("空でないセル（rules-table-cell）", ({ And }) => {
    And(
      "カテゴリ・WHAT・WHY・強制が空なら違反になり、WHY の - は違反なし",
      () => {
        // given
        const empty = (name: string): RuleViolation => ({
          rule: "rules-table-cell",
          line: 3,
          message: `${name} のセルが空（WHY が無ければ - と書く）`,
        });
        const cases: [string, string, RuleViolation[]][] = [
          ["WHY が -", "| a | b | - | レビュー |", []],
          ["カテゴリが空", "| | b | c | レビュー |", [empty("カテゴリ")]],
          [
            "WHAT が空（空白だけ）",
            "| a |   | c | レビュー |",
            [empty("WHAT")],
          ],
          ["WHY が空", "| a | b || レビュー |", [empty("WHY")]],
          ["強制が空", "| a | b | c | |", [empty("強制")]],
          [
            "すべて空",
            "| | | | |",
            [empty("カテゴリ"), empty("WHAT"), empty("WHY"), empty("強制")],
          ],
        ];

        // when
        const result = casesByName(cases, ([, row]) =>
          findTableViolations(lines(TABLE_HEAD, row), referenceRoot),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );
  });

  Scenario("見出しと表の対応（rules-table-heading）", ({ And }) => {
    And(
      "# が 1 つ、表ごとに直前の ## が 1 つ、括弧の注記の無い見出しは違反なし",
      () => {
        // given
        const row = "| a | b | c | 説明 |";
        const cases: [string, string][] = [
          [
            "# と ## ごとの表",
            lines(
              FRONT,
              "# a",
              "",
              "## b",
              "",
              TABLE_HEAD,
              row,
              "",
              "## c",
              TABLE_HEAD,
            ),
          ],
          [
            "表の後のコードブロック",
            lines(
              "## b",
              TABLE_HEAD,
              row,
              "```",
              "# コードの中の見出し",
              "| x |",
              "```",
            ),
          ],
          ["# だけ", lines("# a")],
          ["空", ""],
        ];

        // when
        const result = casesByName(cases, ([, content]) =>
          findHeadingViolations(content),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "### 以下の見出し・括弧の注記・2 つ目の #・## の無い表・同じ ## の下の 2 つ目の表・表の無い ## は、ファイルと行で違反になる",
      () => {
        // given
        const row = "| a | b | c | 説明 |";
        const cases: [string, string, Located[]][] = [
          [
            "### と ######",
            lines("## a", TABLE_HEAD, "### b", "###### c"),
            [
              {
                line: 4,
                message: "見出しは # と ## だけ（### 以下は使わない）",
              },
              {
                line: 5,
                message: "見出しは # と ## だけ（### 以下は使わない）",
              },
            ],
          ],
          [
            "全角と半角の括弧",
            lines("# a（x）", "## b (y)", TABLE_HEAD),
            [
              { line: 1, message: "見出しに括弧の注記を書かない" },
              { line: 2, message: "見出しに括弧の注記を書かない" },
            ],
          ],
          [
            "2 つ目の #",
            lines("# a", "# b"),
            [{ line: 2, message: "# の見出しが 2 つ目" }],
          ],
          [
            "見出しの無い表と、# の直後の表",
            lines(TABLE_HEAD, row, "", "# a", TABLE_HEAD),
            [
              { line: 1, message: "表の前に ## の見出しが無い" },
              { line: 6, message: "表の前に ## の見出しが無い" },
            ],
          ],
          [
            "同じ ## の下の 2 つ目の表（### を挟んでも）",
            lines("## a", TABLE_HEAD, "", TABLE_HEAD, "### b", TABLE_HEAD),
            [
              { line: 5, message: "1 つの ## の下に 2 つ目の表" },
              {
                line: 7,
                message: "見出しは # と ## だけ（### 以下は使わない）",
              },
              { line: 8, message: "1 つの ## の下に 2 つ目の表" },
            ],
          ],
          [
            "表の無い ##（# の前と、ファイルの最後）",
            lines("## a", "# b", "## c", "```", "| x |", "```"),
            [
              { line: 1, message: "## の見出しの下に表が無い" },
              { line: 3, message: "## の見出しの下に表が無い" },
            ],
          ],
        ];

        // when
        const result = casesByName(cases, ([, content]) =>
          findHeadingViolations(content),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );
  });

  Scenario("強制の書き方（rules-table-enforce）", ({ And }) => {
    And(
      "レビュー・説明・実在するファイルへの参照・そのファイルに出てくる名前・複数の参照と名前・pnpm typecheck と pnpm lint は違反なし",
      () => {
        // given
        const cases: [string, string][] = [
          ["レビュー", "レビュー"],
          ["説明", "説明"],
          ["パスだけ", "`rule-tests/x.test.ts`"],
          ["パスと名前", "`rule-tests/x.test.ts` の `rule-a`"],
          ["パスと複数の名前", "`rule-tests/x.test.ts` の `rule-a`・`rule-b`"],
          [
            "複数の参照",
            "`rule-tests/x.test.ts` の `rule-b`、`biome.json` の `noExplicitAny`",
          ],
          ["pnpm typecheck", "`pnpm typecheck`"],
          ["pnpm lint と参照", "`pnpm lint`、`biome.json`"],
        ];

        // when
        const result = casesByName(cases, ([, cell]) =>
          findEnforcementViolations(cell, referenceRoot),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "未知の語・参照の書き方の崩れ・存在しないパス・ディレクトリ・リポジトリの外のパス・ファイルに出てこない名前は違反になる",
      () => {
        // given
        const form = (item: string) =>
          `強制が「レビュー」「説明」か検査への参照（\`<パス>\` / \`<パス>\` の \`<名前>\`）でない: ${item}`;
        const cases: [string, string, string[]][] = [
          ["未知の語", "テスト", [form("テスト")]],
          [
            "レビューに語を足したもの",
            "レビュー（一部）",
            [form("レビュー（一部）")],
          ],
          [
            "コードスパンでないパス",
            "rule-tests/x.test.ts",
            [form("rule-tests/x.test.ts")],
          ],
          [
            "名前がコードスパンでない",
            "`rule-tests/x.test.ts` の rule-a",
            [form("`rule-tests/x.test.ts` の rule-a")],
          ],
          [
            "名前の区切りが ・ でない",
            "`rule-tests/x.test.ts` の `rule-a`, `rule-b`",
            [form("`rule-tests/x.test.ts` の `rule-a`, `rule-b`")],
          ],
          [
            "参照とレビューの混在",
            "`biome.json`、レビュー",
            [form("レビュー")],
          ],
          [
            "存在しないパス",
            "`rule-tests/none.test.ts`",
            ["参照のパスのファイルが無い: rule-tests/none.test.ts"],
          ],
          ["ディレクトリ", "`dir`", ["参照のパスのファイルが無い: dir"]],
          [
            "pnpm の別のコマンド",
            "`pnpm test`",
            ["参照のパスのファイルが無い: pnpm test"],
          ],
          [
            "絶対パス",
            "`/etc/hosts`",
            ["参照のパスがリポジトリ相対でない: /etc/hosts"],
          ],
          ["親への ..", "`../x`", ["参照のパスがリポジトリ相対でない: ../x"]],
          [
            "名前がファイルに無い",
            "`rule-tests/x.test.ts` の `rule-c`",
            ["参照の名前 rule-c が rule-tests/x.test.ts の中に無い"],
          ],
          [
            "複数の名前の 1 つだけ無い",
            "`rule-tests/x.test.ts` の `rule-a`・`rule-z`",
            ["参照の名前 rule-z が rule-tests/x.test.ts の中に無い"],
          ],
          [
            "複数の参照の 2 つ目だけ違反",
            "`rule-tests/x.test.ts`、`biome.json` の `noFoo`",
            ["参照の名前 noFoo が biome.json の中に無い"],
          ],
        ];

        // when
        const result = casesByName(cases, ([, cell]) =>
          findEnforcementViolations(cell, referenceRoot),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );
  });

  Scenario("列挙と検査（fixture）", ({ And }) => {
    And(
      "コードのルール文書のディレクトリの直下の md だけを検査し、規則ごとの違反をファイルと行で返す",
      () => {
        // given
        const root = fixture({
          [`${RULES_DIR}/a.md`]: lines(
            FRONT,
            "",
            "# a",
            "",
            "地の文",
            "",
            "### x（y）",
            TABLE_HEAD,
            "| x | y | z | `rule-tests/r.test.ts` の `rule-r` |",
            "| x | y | | テスト |",
            "| x | y |",
            "",
            "```ts",
            "- コード例",
            "```",
          ),
          [`${RULES_DIR}/b.md`]: lines(
            FRONT,
            "# b",
            "## c",
            TABLE_HEAD,
            "| x | y | - | `rule-tests/r.test.ts` の `rule-r` |",
          ),
          "rule-tests/r.test.ts": "// rule-r\n",
          // 対象外: 直下でない md・md でないファイル・別の分類のディレクトリ。
          [`${RULES_DIR}/sub/c.md`]: "- 箇条書き\n",
          [`${RULES_DIR}/d.txt`]: "- 箇条書き\n",
          ".claude/rules/quality/e.md": "- 箇条書き\n",
        });
        const a = `${RULES_DIR}/a.md`;

        // when
        const result = {
          files: listRulesFiles(root),
          violations: collectRulesTableViolations(root),
        };

        // then
        expect(result).toEqual({
          files: [a, `${RULES_DIR}/b.md`],
          violations: [
            `rules-table-body: ${a}:8 見出し・表の行・コードブロックのどれでもない行`,
            `rules-table-heading: ${a}:10 見出しは # と ## だけ（### 以下は使わない）`,
            `rules-table-heading: ${a}:10 見出しに括弧の注記を書かない`,
            `rules-table-heading: ${a}:11 表の前に ## の見出しが無い`,
            `rules-table-cell: ${a}:14 WHY のセルが空（WHY が無ければ - と書く）`,
            `rules-table-enforce: ${a}:14 強制が「レビュー」「説明」か検査への参照（\`<パス>\` / \`<パス>\` の \`<名前>\`）でない: テスト`,
            `rules-table-header: ${a}:15 セルが 2 個（4 個にする。セルの中の | は \\| と書く）`,
          ],
        });
      },
    );

    And("仕様の例の表は、実リポジトリの参照で違反なし", () => {
      // given: Issue #322 の書き換えの仕様の「例」（backend.md の「依存の向き」の表の「モジュールの境界」）。参照は実リポジトリの rule-tests/architecture.test.ts。
      const example = lines(
        FRONT,
        "",
        "## モジュールの境界",
        "",
        TABLE_HEAD,
        "| 概要 | backend の feature を 1 つのモジュールとし、他のモジュールとは `expose/` を通してだけつながる（モジュラーモノリス） | 決定と採用しなかった案は ADR `docs/adr/architecture/20260930-modular-monolith-expose-internal.md` | 説明 |",
        "| 境界 | 他のモジュールの `internal/` を参照しない（値・型だけ・re-export・dynamic import のどれも。どの層からでも、`expose/` からでも） | `internal/` はモジュールの中身で、他のモジュールが依存すると中身を変えるたびに壊れ、境界が無くなる。公開するものは `expose/` のファイルで決める | `rule-tests/architecture.test.ts` の `module-internal` |",
        "| 境界 | `expose/` が公開するのは `expose/` に書いたクラス（中で internal を組み立てる入口。notification の `Notifier`）と型にとどめ、internal の実装のクラスをそのまま公開しない。関数は export しない（Issue #262） | internal の実装のクラスをそのまま公開すると境界が薄くなる。`expose-imports` は re-export を止めない（何を公開するかは `expose/` が決める設計） | レビュー |",
        "",
        "```ts",
        "// 表の直後のコード例",
        "```",
      );

      // when
      const result = checkRulesFile("example.md", example, repoRoot);

      // then
      expect(result).toEqual([]);
    });

    And(
      "ディレクトリが無ければ対象は 0 件で違反も 0 件になる（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const root = fixture({ "README.md": "- x\n" });

        // when
        const result = {
          files: listRulesFiles(root),
          violations: collectRulesTableViolations(root),
        };

        // then
        expect(result).toEqual({ files: [], violations: [] });
      },
    );
  });

  Scenario("実ファイル", ({ And }) => {
    And("コードのルール文書は表の形で書く", () => {
      // given: 実ファイル（repoRoot）
      // when
      const files = listRulesFiles(repoRoot);
      const violations = collectRulesTableViolations(repoRoot);

      // then
      // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
      //   backend.md は消えない（paths で backend の作業のたびに読まれる規則の本体）ので、それが列挙に入ることを見る。
      expect(files).toContain(`${RULES_DIR}/backend.md`);
      expect(violations).toEqual([]);
    });
  });
});
