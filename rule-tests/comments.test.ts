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

// コードのコメントに経緯（このリポジトリの Issue / PR の番号、日付、誰が判断・確認したか、前の形、どこから持ってきたか）を
// 書かせない検査（CLAUDE.md の「5. コードコメント」）。コメントは今のコードの WHY だけを書き、経緯は git log -p・PR の実装経緯・
// docs/work-logs/ に残す。
// WHY 検査する: 経緯はコードが変わっても書き換えられず、今の実装と食い違ったまま残る。文章の規則だけだと、AI が作業の記録を
//   そのままコメントに書き写す。
// 流れ: 列挙（listCommentTargets）→ 抽出（extractComments。言語ごとにコメントだけを取り出す）→ 判定（findHistoryRules。
//   コメントの 1 行ごとに正規表現）→ 一覧（collectCommentViolations。「パス:行: 規則 コメント」）。
// WHY 語ではなく形で判定する: 「だった」「廃止」「旧」「時点」「worker」、番号の無い「Issue」は、今の WHY の説明にも普通に
//   出てくるので誤検知が多い。番号・日付・特定の言い回しに絞り、誤検知をほぼ 0 にする（例外の書き方は作らない）。
// WHY コメントの中だけを見る: テスト名や fixture の文字列の中の番号・日付・`//` は仕様の入力で、経緯ではない。
// 環境変数 COMMENTS_REPORT=<path> があれば、実ファイルの違反の一覧をそのファイルにも書く（書き換えの作業に渡すため）。

type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9";

// 経緯の形（コメントの 1 行に対して判定する）。
// WHY 1 行ごと: 違反を「パス:行」で示して直す場所を 1 行に絞る。行をまたいだ言い回しは見逃す（限界）。
const HISTORY_RULES: [RuleId, RegExp][] = [
  // このリポジトリの Issue / PR の番号。
  ["R1", /\b(?:Issue|PR)\s?#\d+/],
  // 単独の番号（括弧で囲んだ番号など）。語・& / # の直後は除く: 識別子に続く番号（page と番号）、HTML の数値文字参照、
  //   URL の / に続く番号、# の重なりを拾わない。Issue / PR に続く番号は R1 が拾うので二重に数えない。JSON Pointer（# と /）と
  //   shebang（# と !）は数字が続かない。例は must pass / must reject の表。
  ["R2", /(?<![\w&/#]|Issue\s?|PR\s?)#\d+\b/],
  // 日付（年-月-日）。ADR のファイル名の日付はハイフンが無いので当たらない。URL の中の日付は判定の前に URL ごと除く。
  ["R3", /\b20\d\d-\d\d-\d\d\b/],
  // 誰が確認したか。\b で「required reviewers」（GitHub の設定名）を外す。
  ["R4", /\b(?:reviewer|researcher)\b/],
  ["R5", /ユーザーの?(?:判断|指示)/],
  ["R6", /指摘/],
  // 「未実測」は、まだ確かめていないという今の状態の説明なので除く。
  ["R7", /(?<!未)実測/],
  ["R8", /以前(?:は|の)/],
  ["R9", /から移した|に改名|撤回|当初|当時/],
];

// WHY URL を除く: 公式ドキュメントの URL（一次情報）にはパスや query の日付、アンカーの番号が入るが、経緯ではない。
const URL_PATTERN = /https?:\/\/[!-~]+/g;

function findHistoryRules(comment: string): RuleId[] {
  const withoutUrls = comment.replace(URL_PATTERN, " ");
  return HISTORY_RULES.filter(([, pattern]) => pattern.test(withoutUrls)).map(
    ([id]) => id,
  );
}

type Comment = { line: number; text: string };
// js: // と /* */（JS / TS / JSONC）。hash: # から行末（シェル・YAML・Dockerfile・.gitignore など）。tf: # と // と /* */。
type Syntax = "js" | "hash" | "tf";

function extractComments(text: string, syntax: Syntax): Comment[] {
  return syntax === "hash"
    ? extractHashComments(text)
    : extractCStyleComments(text, syntax === "js" ? JS_DIALECT : TF_DIALECT);
}

// # 系: 引用符の外で、行頭か空白の直後の # から行末まで。1 行目の #! は除く。
// WHY 空白の直後だけ: シェルの $# / ${#x} / ${x#y} と a#b はコメントではない（bash は語の始まりの # だけをコメントにする）。
//   YAML も「空白 + #」だけをコメントにする。
// WHY 行ごとに引用符を閉じる: 閉じない引用符（YAML の素の文字列の途中など）が後ろの行を文字列として飲み込まないようにする。
//   複数行にまたがる文字列の中の # はコメントに数える（多く拾う方向。見逃しにはならない）。
// WHY 語の途中の ' と " を引用符にしない: YAML の素の文字列（name: Don't stop # x）では ' は文字で、後ろの # はコメント。
//   シェルで語の途中から引用符を始める書き方（a'b c'）は使わない想定。
// WHY YAML の run: | の中も同じに扱う: 中身はシェルのコードで、そのコメントも経緯を書く場所になる。
function extractHashComments(text: string): Comment[] {
  return text.split("\n").flatMap((content, index) => {
    if (index === 0 && content.startsWith("#!")) return [];
    const start = hashCommentStart(content);
    return start === -1
      ? []
      : [{ line: index + 1, text: content.slice(start).trim() }];
  });
}

function hashCommentStart(content: string): number {
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    const before = content[index - 1] ?? "";
    if (char === "#" && (index === 0 || /\s/.test(before))) return index;
    if ((char === "'" || char === '"') && !/\w/.test(before)) {
      index = quotedEnd(content, index);
    } else {
      index += char === "\\" ? 2 : 1;
    }
  }
  return -1;
}

// start の引用符に対応する閉じ引用符の次の位置（閉じなければ行末）。' の中の \ はエスケープではない（シェルの規則）。
function quotedEnd(content: string, start: number): number {
  const quote = content[start];
  let index = start + 1;
  while (index < content.length && content[index] !== quote) {
    index += content[index] === "\\" && quote === '"' ? 2 : 1;
  }
  return index + 1;
}

// // と /* */ の言語の字句の違い。
//   quotes: 1 行の中で閉じる文字列（${} を持たない）。interpolated: ${} を持つ文字列（JS のテンプレート、HCL の "..."）。
//   multilineInterpolated: その文字列が改行をまたげるか。regex: 正規表現リテラルがあるか。hash: # もコメントか。
type Dialect = {
  quotes: string;
  interpolated: string;
  multilineInterpolated: boolean;
  regex: boolean;
  hash: boolean;
};
const JS_DIALECT: Dialect = {
  quotes: `'"`,
  interpolated: "`",
  multilineInterpolated: true,
  regex: true,
  hash: false,
};
// WHY HCL の ' を文字列にしない: HCL の文字列は "..." だけで、コメントの中の ' （it's）で後ろを飲み込まない。
const TF_DIALECT: Dialect = {
  quotes: "",
  interpolated: '"',
  multilineInterpolated: false,
  regex: false,
  hash: true,
};

// 字句を 1 つずつ読む状態。
//   frames: 開いている ${} ごとの、その中の { の深さ。深さ 0 の } で ${} を閉じ、文字列の続きに戻る。
//   previous: 直前の意味のある字句（/ が正規表現か割り算かを決める）。文字列・正規表現・数値の後は ")" として扱う。
type Scanner = {
  text: string;
  dialect: Dialect;
  index: number;
  previous: string;
  frames: { close: string; depth: number }[];
  ranges: [number, number][];
};

// WHY 自前の字句解析（正規表現 1 本にしない）: 正規表現リテラルの中の ` や //（/[/`]/ など）、テンプレートの ${} の中の入れ子の
//   テンプレートを、1 本の正規表現では区切れない。区切りを誤ると、後ろのコメントを文字列として飲み込んで見逃す。
// 限界: / の前の字句だけで正規表現か割り算かを決める（`) /re/` や `} / 2` は取り違える。書き方としてまれ）。JSX のテキストの中の
//   ' は 1 行の文字列として読み飛ばす（その行の後ろのコメントを見逃しうる）。JSX のテキストの中の // はコメントに数える。
function extractCStyleComments(text: string, dialect: Dialect): Comment[] {
  const scanner: Scanner = {
    text,
    dialect,
    index: 0,
    previous: "",
    frames: [],
    ranges: [],
  };
  if (text.startsWith("#!")) scanner.index = lineEnd(text, 0);
  while (scanner.index < text.length) readToken(scanner);
  const lineStarts = lineStartsOf(text);
  return scanner.ranges.flatMap(([start, end]) =>
    splitIntoLines(text.slice(start, end), lineAt(lineStarts, start)),
  );
}

const TOKEN_READERS = [
  readComment,
  readQuoted,
  readInterpolated,
  readBrace,
  readRegex,
  readWord,
];

function readToken(scanner: Scanner): void {
  if (TOKEN_READERS.some((read) => read(scanner))) return;
  const char = scanner.text[scanner.index] ?? "";
  if (!/\s/.test(char)) scanner.previous = char;
  scanner.index += 1;
}

function readComment(scanner: Scanner): boolean {
  const { text, index } = scanner;
  const two = text.slice(index, index + 2);
  let end: number;
  if (two === "//" || (scanner.dialect.hash && text[index] === "#")) {
    end = lineEnd(text, index);
  } else if (two === "/*") {
    const close = text.indexOf("*/", index + 2);
    end = close === -1 ? text.length : close + 2;
  } else {
    return false;
  }
  scanner.ranges.push([index, end]);
  scanner.index = end;
  return true;
}

// 1 行の中で閉じる文字列。閉じないまま改行に来たら、そこで終える。
function readQuoted(scanner: Scanner): boolean {
  const { text } = scanner;
  const quote = text[scanner.index] ?? "";
  if (quote === "" || !scanner.dialect.quotes.includes(quote)) return false;
  let index = scanner.index + 1;
  while (index < text.length && text[index] !== quote && text[index] !== "\n") {
    index += text[index] === "\\" ? 2 : 1;
  }
  scanner.index = text[index] === quote ? index + 1 : index;
  scanner.previous = ")";
  return true;
}

function readInterpolated(scanner: Scanner): boolean {
  const close = scanner.text[scanner.index] ?? "";
  if (close === "" || !scanner.dialect.interpolated.includes(close))
    return false;
  scanner.index += 1;
  readInterpolatedBody(scanner, close);
  return true;
}

// 文字列の中身を、閉じるか ${ に来るまで読む。${ なら frames に積んでコードに戻る（} で readBrace がここへ戻す）。
function readInterpolatedBody(scanner: Scanner, close: string): void {
  const { text } = scanner;
  let index = scanner.index;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
    } else if (text.startsWith("${", index)) {
      scanner.frames.push({ close, depth: 0 });
      scanner.index = index + 2;
      scanner.previous = "(";
      return;
    } else if (
      char === close ||
      (char === "\n" && !scanner.dialect.multilineInterpolated)
    ) {
      break;
    } else {
      index += 1;
    }
  }
  scanner.index = text[index] === close ? index + 1 : index;
  scanner.previous = ")";
}

function readBrace(scanner: Scanner): boolean {
  const char = scanner.text[scanner.index];
  if (char !== "{" && char !== "}") return false;
  scanner.index += 1;
  scanner.previous = char;
  const frame = scanner.frames.at(-1);
  if (frame === undefined) return true;
  if (char === "{") {
    frame.depth += 1;
  } else if (frame.depth > 0) {
    frame.depth -= 1;
  } else {
    scanner.frames.pop();
    readInterpolatedBody(scanner, frame.close);
  }
  return true;
}

// / の直前がこの字句なら正規表現リテラル、それ以外（識別子・数値・) ] ・文字列）なら割り算。
const BEFORE_REGEX = new Set([..."(,=:[!&|?{};+-*%~^", ""]);
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);

function readRegex(scanner: Scanner): boolean {
  const { text, index, previous } = scanner;
  if (!scanner.dialect.regex || text[index] !== "/") return false;
  if (!BEFORE_REGEX.has(previous) && !KEYWORDS_BEFORE_REGEX.has(previous))
    return false;
  const end = regexEnd(text, index);
  if (end === -1) return false;
  scanner.index = end;
  scanner.previous = ")";
  return true;
}

// 正規表現リテラルの終わり（フラグの後）。文字クラス [...] の中の / では閉じない。行の中で閉じなければ -1（割り算として読む）。
function regexEnd(text: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return -1;
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      const flags = /[a-z]*/y;
      flags.lastIndex = index + 1;
      flags.exec(text);
      return flags.lastIndex;
    }
  }
  return -1;
}

// 識別子・キーワード・数値を 1 語として読む（return の後の / を正規表現と決めるため、語を previous に残す）。
function readWord(scanner: Scanner): boolean {
  const word = /[A-Za-z_$][\w$]*|\d[\w.]*/y;
  word.lastIndex = scanner.index;
  const match = word.exec(scanner.text);
  if (match === null) return false;
  scanner.index = word.lastIndex;
  scanner.previous = /^\d/.test(match[0]) ? ")" : match[0];
  return true;
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  ) {
    starts.push(index + 1);
  }
  return starts;
}

// index の行番号（1 始まり）。WHY 二分探索: 数千行・数千コメントのファイル（architecture.test.ts）でも行番号を速く引く。
function lineAt(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

// ブロックコメントは行ごとに分ける（違反を行で示す）。空の行は判定しても何も当たらないので返さない。
function splitIntoLines(comment: string, firstLine: number): Comment[] {
  return comment
    .split("\n")
    .map((text, offset) => ({ line: firstLine + offset, text: text.trim() }))
    .filter(({ text }) => text !== "");
}

// 検査の対象とコメントの書き方。対象外なら undefined。path はリポジトリ相対の / 区切り。
// 対象: apps/・rule-tests/ の JS / TS（テストと test-support を含む）と tsconfig*.json、scripts/ の .sh と JS / TS、infra/ の .tf と
//   *.tfvars.example、.github/workflows/ の YAML、ルート直下の設定、.claude/settings.json（JSON でコメントは書けないが、
//   書けるようになっても見逃さないよう含める）。
// 対象外: .md（文書。経緯を書いてよい場所）、lockfile、drizzle の生成物（.sql と meta/*.json）、tsconfig 以外の .json
//   （コメントが書けない）、patches/、docs/、.claude/ の settings.json 以外（指示ファイルとスキル）、*.tfvars（コミットしない入力）。
const JS_EXTENSION = /\.[cm]?[jt]sx?$/;
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/;
const ROOT_HASH_FILES = new Set([
  "pnpm-workspace.yaml",
  "compose.yaml",
  "lefthook.yml",
  ".gitignore",
  ".dockerignore",
  ".env.example",
  "Dockerfile",
]);

// 最上位のディレクトリ → その下のパスの書き方。
const SYNTAX_BY_TOP_DIR = new Map<string, (path: string) => Syntax | undefined>(
  [
    ["apps", jsOrTsconfigSyntax],
    ["rule-tests", jsOrTsconfigSyntax],
    [
      "scripts",
      (path) => (path.endsWith(".sh") ? "hash" : jsOrTsconfigSyntax(path)),
    ],
    ["infra", infraSyntax],
    [
      ".github",
      (path) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ? "hash" : undefined,
    ],
    [
      ".claude",
      (path) => (path === ".claude/settings.json" ? "js" : undefined),
    ],
  ],
);

function commentSyntaxOf(path: string): Syntax | undefined {
  const slash = path.indexOf("/");
  if (slash === -1) {
    return ROOT_HASH_FILES.has(path) ? "hash" : jsOrTsconfigSyntax(path);
  }
  return SYNTAX_BY_TOP_DIR.get(path.slice(0, slash))?.(path);
}

function jsOrTsconfigSyntax(path: string): Syntax | undefined {
  return JS_EXTENSION.test(path) || TSCONFIG.test(path) ? "js" : undefined;
}

function infraSyntax(path: string): Syntax | undefined {
  if (path.endsWith(".tf")) return "tf";
  return path.endsWith(".tfvars.example") ? "hash" : undefined;
}

// 走査するディレクトリ（中を再帰的に見る）。ルート直下のファイルと .claude/settings.json は別に見る。
// WHY ルートを再帰しない: docs/・.git/・.claude/worktrees/（リポジトリの複製）・.stryker-tmp/（sandbox の複製）・reports/・
//   coverage/ を中に入らずに外す。対象のディレクトリの中に同じ名前（reports など）の feature を作っても外れない。
const TARGET_DIRS = ["apps", "rule-tests", "scripts", "infra", ".github"];
// 対象のディレクトリの中でも入らないディレクトリ（依存と生成物）。
//   node_modules: pnpm の依存（apps/*/node_modules/ もできる）。.next: next build の生成物。.terraform: terraform init の作業ディレクトリ。
const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".terraform"]);

// dir の下のファイルをリポジトリ相対の / 区切りで返す。
// WHY symlink をたどらない: 対象のディレクトリの中の symlink は pnpm の node_modules（除外）の中にしか無い。たどると循環する
//   symlink で再帰が止まらなくなりうる。
function walkFiles(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap(
    (entry: Dirent) => {
      const path = `${dir}/${entry.name}`;
      if (!entry.isDirectory()) return entry.isFile() ? [path] : [];
      return EXCLUDED_DIRS.has(entry.name) ? [] : walkFiles(root, path);
    },
  );
}

function listCommentTargets(root: string): string[] {
  const rootFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const settings = existsSync(join(root, ".claude/settings.json"))
    ? [".claude/settings.json"]
    : [];
  return [
    ...rootFiles,
    ...settings,
    ...TARGET_DIRS.flatMap((dir) => walkFiles(root, dir)),
  ]
    .filter((path) => commentSyntaxOf(path) !== undefined)
    .sort();
}

// 違反を「<パス>:<行>: <規則の ID（複数なら , 区切り）> <その行のコメント>」で返す。
function collectCommentViolations(root: string): string[] {
  return listCommentTargets(root).flatMap((path) => {
    const syntax = commentSyntaxOf(path) ?? "js";
    return extractComments(
      readFileSync(join(root, path), "utf8"),
      syntax,
    ).flatMap(({ line, text }) => {
      const rules = findHistoryRules(text);
      return rules.length === 0
        ? []
        : [`${path}:${line}: ${rules.join(",")} ${text}`];
    });
  });
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

describe("経緯の判定（findHistoryRules）: must reject", () => {
  it.each<[string, RuleId[]]>([
    ["// Issue #150 で足した", ["R1"]],
    ["// PR #38 の変更に合わせる", ["R1"]],
    ["// (Issue#12)", ["R1"]],
    ["/* PR#7 */", ["R1"]],
    ["// #123 を参照", ["R2"]],
    ["// 詳細は（#45）", ["R2"]],
    ["# see #99", ["R2"]],
    ["// Issue #1 と #2", ["R1", "R2"]],
    ["// 2026-09-30 に確認した", ["R3"]],
    ["/* 期限は 2025-01-31 */", ["R3"]],
    ["# 2024-12-01 から有効", ["R3"]],
    ["// reviewer が確認した", ["R4"]],
    ["// researcher の調査による", ["R4"]],
    ["# (reviewer)", ["R4"]],
    ["// ユーザーの判断で決めた", ["R5"]],
    ["// ユーザー判断", ["R5"]],
    ["# ユーザーの指示どおり", ["R5"]],
    ["// 指摘を受けて直した", ["R6"]],
    ["// レビューの指摘", ["R6"]],
    ["# 指摘事項", ["R6"]],
    ["// 実測した", ["R7"]],
    ["// 実測値は 3 秒", ["R7"]],
    ["# 手元で実測", ["R7"]],
    ["// 以前は X だった", ["R8"]],
    ["// 以前の実装", ["R8"]],
    ["# 以前はここで読んだ", ["R8"]],
    ["// a から移した", ["R9"]],
    ["// b に改名した", ["R9"]],
    ["// 方針を撤回した", ["R9"]],
    ["# 当初は", ["R9"]],
    ["// 当時の版", ["R9"]],
    ["// https://example.com/x の Issue #3 と 2026-01-02", ["R1", "R3"]],
  ])("%s は %j", (comment, rules) => {
    expect(findHistoryRules(comment)).toEqual(rules);
  });
});

describe("経緯の判定（findHistoryRules）: must pass", () => {
  it.each([
    ["URL の中の日付", "// https://example.com/blog/2026-09-30/post"],
    [
      "URL の query の日付",
      "// https://docs.example.com/a?version=2024-06-01 を読む",
    ],
    ["URL の /# の後の番号", "// https://example.com/page/#123"],
    ["JSON Pointer", "// JSON Pointer の #/title を指す"],
    ["JSON Pointer（配列の添字）", "// #/items/0"],
    ["shebang", "#!/bin/bash"],
    ["HTML の数値文字参照", "// &#123; はエスケープする"],
    ["語の直後の # と番号", "// page#123 と color#fff"],
    ["required reviewers", "// required reviewers を 1 人にする"],
    ["reviewers（複数形）", "# reviewers"],
    ["未実測", "// 未実測（確かめ方は下に書く）"],
    ["keyedIssue の識別子", "// keyedIssue#3 を返す"],
    ["番号の無い Issue / PR", "// Issue の番号は書かない。PR の本文に書く"],
    ["検査しない語", "// 旧 API だった。廃止した。worker の時点"],
    ["は / の が続かない「以前」", "// それ以前から"],
    ["「から」の無い「移した」", "// 移した先"],
    [
      "ADR のファイル名の日付（ハイフン無し）",
      "// ADR docs/adr/workflow/20260929-save-usage-limit.md",
    ],
    ["WHY だけのコメント", "// WHY: Y だと X になる"],
  ])("%s（%s）は違反なし", (_name, comment) => {
    expect(findHistoryRules(comment)).toEqual([]);
  });
});

describe("コメントの抽出（extractComments）: JS / TS / JSONC", () => {
  it.each<[string, string, Comment[]]>([
    [
      "行末のコメントとブロックコメント（行ごと）",
      source("const a = 1; // tail", "/* one", "   two */", "const b = 2;"),
      [
        { line: 1, text: "// tail" },
        { line: 2, text: "/* one" },
        { line: 3, text: "two */" },
      ],
    ],
    [
      "' と \" の文字列の中の // と /* */ は拾わない",
      source(`const s = "// not"; const t = '/* no */'; // yes`),
      [{ line: 1, text: "// yes" }],
    ],
    [
      "エスケープした引用符で文字列を閉じない",
      source(`const s = "a\\"// b"; // c`),
      [{ line: 1, text: "// c" }],
    ],
    [
      "テンプレートの文字の部分は拾わず、埋め込み式の中のコメントは拾う（入れ子のテンプレートも）",
      source(
        `const t = \`a \${fn(\`// inner \${x /* c1 */}\`)} // text\`; // c2`,
        "// c3",
      ),
      [
        { line: 1, text: "/* c1 */" },
        { line: 1, text: "// c2" },
        { line: 2, text: "// c3" },
      ],
    ],
    [
      "複数行のテンプレートの中の // は拾わない",
      source("const t = `", "// not", "`; // c"),
      [{ line: 3, text: "// c" }],
    ],
    [
      "正規表現リテラルの中の // と文字クラスの / と ` を飛ばす",
      source("const r = /\\/\\/ not/g; const q = /[/`]/; // real", "// next"),
      [
        { line: 1, text: "// real" },
        { line: 2, text: "// next" },
      ],
    ],
    [
      "割り算を正規表現と取り違えない",
      source("const x = a / b; // c", "const y = (a) / 2 / 3; // d"),
      [
        { line: 1, text: "// c" },
        { line: 2, text: "// d" },
      ],
    ],
    [
      "return の後の / は正規表現",
      source("return /\\/\\//.test(x); // e"),
      [{ line: 1, text: "// e" }],
    ],
    [
      "JSX の閉じタグとテキストの ' で後ろの行を飲み込まない",
      source("const el = <p>{x}</p>; // f", "const g = <p>Don't</p>;", "// h"),
      [
        { line: 1, text: "// f" },
        { line: 3, text: "// h" },
      ],
    ],
    [
      "1 行目の #! は除く（// を含む shebang をコメントにしない）",
      source(
        "#!/usr/bin/env -S deno run --allow-net=https://example.com",
        "// g",
      ),
      [{ line: 2, text: "// g" }],
    ],
    [
      "JSONC（tsconfig）の文字列の中の /* を拾わない",
      source('{ "paths": { "@/*": ["./*"] } // h', "}"),
      [{ line: 1, text: "// h" }],
    ],
    [
      "private フィールドの # はコメントではない",
      source("class A { #x = 1; m() { return this.#x; } } // i"),
      [{ line: 1, text: "// i" }],
    ],
  ])("%s", (_name, text, comments) => {
    expect(extractComments(text, "js")).toEqual(comments);
  });
});

describe("コメントの抽出（extractComments）: # 系（シェル・YAML・Dockerfile など）", () => {
  it.each<[string, string, Comment[]]>([
    [
      "行頭と空白の直後の # から。1 行目の #! は除く",
      source("#!/bin/bash", "# a", "echo x # b", "  # c"),
      [
        { line: 2, text: "# a" },
        { line: 3, text: "# b" },
        { line: 4, text: "# c" },
      ],
    ],
    [
      "引用符の中の # は拾わない",
      source(`echo "#x" '# y' "it's" # z`),
      [{ line: 1, text: "# z" }],
    ],
    [
      "シェルの引数の数・長さ・前方の削除（$ に続く #）と語の途中の # はコメントではない",
      source(`echo $# \${#x} \${x#y} a#b`, "# d"),
      [{ line: 2, text: "# d" }],
    ],
    [
      "語の途中の ' は引用符ではない（YAML の素の文字列）",
      source("name: Don't stop # e"),
      [{ line: 1, text: "# e" }],
    ],
    [
      "YAML の run: | の中のシェルのコメントも拾う",
      source(
        "steps:",
        "  - run: |",
        "      # inside",
        "      pnpm test # tail",
        '    name: "a # b"',
      ),
      [
        { line: 3, text: "# inside" },
        { line: 4, text: "# tail" },
      ],
    ],
    [
      "2 行目以降の #! はコメント",
      source("# a", "#!x"),
      [
        { line: 1, text: "# a" },
        { line: 2, text: "#!x" },
      ],
    ],
  ])("%s", (_name, text, comments) => {
    expect(extractComments(text, "hash")).toEqual(comments);
  });
});

describe("コメントの抽出（extractComments）: Terraform", () => {
  it("# / // / /* */ を拾い、文字列（埋め込み式の中の文字列も）の中は拾わない", () => {
    const text = source(
      "# a",
      'resource "x" "y" { # b',
      '  name = "a#b//c" // c',
      "  /* d */",
      `  v = "\${lookup(m, "#k")} # no"`,
      "} # it's",
      "# e",
    );
    expect(extractComments(text, "tf")).toEqual([
      { line: 1, text: "# a" },
      { line: 2, text: "# b" },
      { line: 3, text: "// c" },
      { line: 4, text: "/* d */" },
      { line: 6, text: "# it's" },
      { line: 7, text: "# e" },
    ]);
  });
});

describe("検査の対象（commentSyntaxOf）", () => {
  it.each<[string, Syntax]>([
    ["apps/backend/features/todo/domain/todo.ts", "js"],
    ["apps/backend/features/todo/domain/todo.test.ts", "js"],
    ["apps/backend/shared/test-support/test-database.ts", "js"],
    ["apps/frontend_customer/features/todo/screens/todo-screen.tsx", "js"],
    ["apps/frontend_customer/next-env.d.ts", "js"],
    ["apps/e2e/playwright.config.ts", "js"],
    ["apps/shared/env.mts", "js"],
    ["apps/backend/tsconfig.json", "js"],
    ["rule-tests/comments.test.ts", "js"],
    ["scripts/worktree-env.test.ts", "js"],
    ["scripts/hooks/guard-git.sh", "hash"],
    ["infra/modules/app/main.tf", "tf"],
    ["infra/envs/prod/terraform.tfvars.example", "hash"],
    [".github/workflows/ci.yml", "hash"],
    ["vitest.config.mts", "js"],
    ["stryker.config.mjs", "js"],
    ["vitest.global-setup.ts", "js"],
    ["tsconfig.json", "js"],
    ["pnpm-workspace.yaml", "hash"],
    ["compose.yaml", "hash"],
    ["lefthook.yml", "hash"],
    [".gitignore", "hash"],
    [".dockerignore", "hash"],
    [".env.example", "hash"],
    ["Dockerfile", "hash"],
    [".claude/settings.json", "js"],
  ])("%s は対象（%s）", (path, syntax) => {
    expect(commentSyntaxOf(path)).toBe(syntax);
  });

  it.each([
    "README.md",
    "CLAUDE.md",
    "apps/backend/README.md",
    "docs/adr/README.md",
    "docs/x.ts",
    ".claude/rules/testing.md",
    ".claude/skills/pr-flow/helper.ts",
    ".claude/hooks/x.sh",
    "patches/@stryker-mutator__vitest-runner@10.0.0.patch",
    "pnpm-lock.yaml",
    "infra/envs/prod/.terraform.lock.hcl",
    "infra/envs/prod/terraform.tfvars",
    "apps/backend/shared/drizzle/0000_create_todos.sql",
    "apps/backend/shared/drizzle/meta/_journal.json",
    "apps/backend/package.json",
    "package.json",
    "biome.json",
    ".env",
    ".tool-versions",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".stryker-tmp/sandbox-1/apps/backend/x.ts",
    "reports/mutation/mutation.js",
    "scripts/x.py",
  ])("%s は対象外", (path) => {
    expect(commentSyntaxOf(path)).toBeUndefined();
  });
});

describe("列挙と検査（fixture）", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const makeTree = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "comments-test-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };
  // 対象外の場所にも違反を置き、列挙が外していることを違反の一覧でも確かめる。
  const EXCLUDED_VIOLATION = "// Issue #9";
  const tree = {
    "apps/backend/features/todo/domain/todo.ts": source(
      "// Issue #1 で足した",
      'it("Issue #2 のテスト", () => {});',
      'const code = "// Issue #3";',
    ),
    "apps/backend/features/reports/domain/report.ts":
      "const a = 1; // 以前は b",
    "apps/backend/tsconfig.json": '{ "compilerOptions": {} } // 2026-01-02',
    "apps/backend/package.json": '{ "name": "x" }',
    "apps/backend/node_modules/pkg/index.ts": EXCLUDED_VIOLATION,
    "apps/frontend_customer/.next/server/x.js": EXCLUDED_VIOLATION,
    "apps/backend/shared/drizzle/0000_x.sql": "-- Issue #9",
    "apps/backend/shared/drizzle/meta/_journal.json": "{}",
    "infra/envs/prod/main.tf": source('resource "a" "b" {}', "# 当初は c"),
    "infra/envs/prod/terraform.tfvars.example": 'project_id = "x" # 指摘',
    "infra/envs/prod/.terraform.lock.hcl": "# Issue #9",
    "infra/envs/prod/.terraform/modules/m/main.tf": "# Issue #9",
    "scripts/hooks/a.sh": source("#!/bin/bash", "# reviewer の確認", "echo $#"),
    "scripts/a.ts": "export {};",
    "rule-tests/x.test.ts": 'it("PR #4", () => {}); // 実測',
    ".github/workflows/ci.yml": source(
      "jobs:",
      "  - run: |",
      "      # ユーザーの判断",
      "      pnpm test",
    ),
    ".github/PULL_REQUEST_TEMPLATE.md": "Issue #9",
    ".claude/settings.json": '{ "hooks": {} }',
    ".claude/rules/x.md": "Issue #9",
    ".claude/skills/s/helper.ts": EXCLUDED_VIOLATION,
    ".claude/worktrees/agent-1/apps/x.ts": EXCLUDED_VIOLATION,
    "docs/work-logs/x.md": "Issue #9",
    "docs/x.ts": EXCLUDED_VIOLATION,
    ".stryker-tmp/sandbox-1/apps/x.ts": EXCLUDED_VIOLATION,
    "reports/mutation/x.js": EXCLUDED_VIOLATION,
    "patches/x.patch": EXCLUDED_VIOLATION,
    "vitest.config.mts": "export default {}; // から移した",
    Dockerfile: source("# syntax=docker/dockerfile:1", "FROM node", "# #12"),
    ".env.example": "A=1",
    ".env": "# Issue #9",
    "package.json": "{}",
    "README.md": "Issue #9",
    "pnpm-lock.yaml": "# Issue #9",
  };

  it("対象のファイルだけを、リポジトリ相対の名前順で列挙する", () => {
    expect(listCommentTargets(makeTree(tree))).toEqual([
      ".claude/settings.json",
      ".env.example",
      ".github/workflows/ci.yml",
      "Dockerfile",
      "apps/backend/features/reports/domain/report.ts",
      "apps/backend/features/todo/domain/todo.ts",
      "apps/backend/tsconfig.json",
      "infra/envs/prod/main.tf",
      "infra/envs/prod/terraform.tfvars.example",
      "rule-tests/x.test.ts",
      "scripts/a.ts",
      "scripts/hooks/a.sh",
      "vitest.config.mts",
    ]);
  });

  it("違反を「パス:行: 規則 コメント」ですべて返す（文字列の中と対象外のファイルは数えない）", () => {
    expect(collectCommentViolations(makeTree(tree))).toEqual([
      ".github/workflows/ci.yml:3: R5 # ユーザーの判断",
      "Dockerfile:3: R2 # #12",
      "apps/backend/features/reports/domain/report.ts:1: R8 // 以前は b",
      "apps/backend/features/todo/domain/todo.ts:1: R1 // Issue #1 で足した",
      "apps/backend/tsconfig.json:1: R3 // 2026-01-02",
      "infra/envs/prod/main.tf:2: R9 # 当初は c",
      "infra/envs/prod/terraform.tfvars.example:1: R6 # 指摘",
      "rule-tests/x.test.ts:1: R7 // 実測",
      "scripts/hooks/a.sh:2: R4 # reviewer の確認",
      "vitest.config.mts:1: R9 // から移した",
    ]);
  });

  it("対象のディレクトリが無ければ 0 件（実リポジトリの検査は 0 件を失敗にする）", () => {
    const root = makeTree({ "docs/x.ts": EXCLUDED_VIOLATION });
    expect(listCommentTargets(root)).toEqual([]);
    expect(collectCommentViolations(root)).toEqual([]);
  });
});

describe("コメントに経緯を書かない（実ファイル）", () => {
  const targets = listCommentTargets(repoRoot);

  it("対象の種類ごとに実在のファイルを列挙し、対象外のファイルを含まない", () => {
    expect(targets).toEqual(
      expect.arrayContaining([
        "apps/backend/tsconfig.json",
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "apps/frontend_customer/next.config.ts",
        "apps/e2e/playwright.config.ts",
        "apps/shared/env.ts",
        "rule-tests/comments.test.ts",
        "scripts/cloud-session-start.sh",
        "scripts/hooks/guard-git.sh",
        "scripts/worktree-env.test.ts",
        "infra/modules/app/main.tf",
        "infra/envs/prod/terraform.tfvars.example",
        ".github/workflows/ci.yml",
        "vitest.config.mts",
        "stryker.config.mjs",
        "vitest.global-setup.ts",
        "tsconfig.json",
        "pnpm-workspace.yaml",
        "compose.yaml",
        "lefthook.yml",
        ".gitignore",
        ".dockerignore",
        ".env.example",
        "Dockerfile",
        ".claude/settings.json",
      ]),
    );
    const excluded = [
      /(^|\/)(node_modules|\.next|\.terraform)\//,
      /^(\.stryker-tmp|reports|docs|patches|\.git)\//,
      /^\.claude\/(?!settings\.json$)/,
      /\.(md|sql|lock\.hcl)$|^pnpm-lock\.yaml$/,
      /(?<!^\.claude\/settings|(^|\/)tsconfig[^/]*)\.json$/,
    ];
    expect(
      targets.filter((path) => excluded.some((pattern) => pattern.test(path))),
    ).toEqual([]);
  });

  it("コードのコメントに経緯（Issue / PR 番号・日付・誰が判断・指摘・実測したか・以前は・移した）を書かない", () => {
    expect(targets.length).toBeGreaterThan(0);
    const violations = collectCommentViolations(repoRoot);
    const reportPath = process.env.COMMENTS_REPORT;
    if (reportPath) writeFileSync(reportPath, `${violations.join("\n")}\n`);
    expect(
      violations.length,
      `コメントは今のコードの WHY だけを書く（CLAUDE.md の「5. コードコメント」）。経緯は git log -p・PR の実装経緯・docs/work-logs/ に残す:\n${violations.join("\n")}\n`,
    ).toBe(0);
  });
});
