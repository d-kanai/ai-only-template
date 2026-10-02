// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはテストファイルのソースを文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";

// テストの本体のフェーズコメント（.claude/rules/testing.md の「フェーズコメント」。Issue #273、daiki の指示 2026-10-02）を、
//   テストファイルのソースで機械的に検査するテスト。
// 違反にするもの（規則 test-phase-comments）:
//   - テストの本体（コールバックのブロック）の中のフェーズコメント（行頭の `// given` / `// when` / `// then`。後ろに空白か `:` で
//     説明を続けてよい）の並びが「given → when → then、以降は when → then の繰り返し」でない（無い・順が違う・given が 2 つ など）。
//   - `// when` / `// then` の区間（次のフェーズコメントか本体の終わりまで）にコードが無い。
//   - `// given` の区間にコードが無いのに、`// given` の後ろに前提の説明が無い（`// given: beforeEach で空にしてある` のように書く）。
//   - 本体がブロックの関数でない（`() => expect(...)` の式の arrow・関数の参照）。フェーズコメントを置く場所が無いので違反にする。
//   WHY given / when / then を全テストに入れる: 前提・操作・検証の境目が一目で分かり、読む人がテストを仕様として速く読める
//     （daiki の指示「見やすいから」）。操作と検証が 1 行に混ざる書き方（`expect(f(x)).toBe(y)`）も when と then に分かれる。
//   WHY 空の given に説明を求める: 前提が beforeEach やモジュールの定数にあるとき、`// given` の直後に `// when` が来るだけでは
//     前提がどこにあるか分からない。説明を書けば、空の given も読み手への情報になる。
//   WHY when → then の繰り返しを許す: 操作を 2 回以上して状態の変化を確かめるテスト（冪等・連続の操作）を 1 つのテストに保てる。
// 対象のテスト:
//   - 対象のディレクトリ（TARGET_DIRS）の下の `*.test.ts` / `*.test.tsx` の `it(` / `test(`（`.each(...)` / `.for(...)` /
//     `.skipIf(...)` / `.runIf(...)` / `.concurrent` / `.sequential` / `.fails` を挟んだ変種も）。
//   - API 仕様（`*.api-spec.test.ts`）の step（`Given(` / `When(` / `Then(` / `And(` / `But(`）。`*` の step 1 つが Vitest の
//     テスト 1 つになり、前提から検証までを 1 つの step で書くため（.claude/rules/testing.md の「API 仕様テスト（spec/api）」）。
//   - ルール検査テスト（rule-tests/ の直下の `*.test.ts`）の step。API 仕様と同じく `*` の step 1 つが前提から検証までの 1 テスト
//     （Issue #282。rule-tests/rule-test-feature.test.ts）。
//   WHY API ジャーニー（`*.api-journey.test.ts`）の step は対象外: step の Given / When / Then のキーワード自体がフェーズを表し、
//     step 1 つが 1 つのフェーズしか持たない。
//   WHY E2E（apps/e2e/）は対象外（Issue #279）: E2E は .feature と step のクラス（*.steps.ts）だけで書き（手書きの *.spec.ts は
//     rule-tests/e2e-feature.test.ts の e2e-feature-placement が止める）、API ジャーニーと同じく step のキーワードがフェーズを表す。
//     playwright-bdd が生成する apps/e2e/.features-gen/*.spec.js も、自分たちが書くテストではない。
//   直前が `.` の呼び出し（`/x/.test(s)`・`page.test(`）はテストではない。
// 読み方: ソースを字句に分け（文字列・テンプレートリテラル・正規表現・コメントを区別する）、テストの呼び出しの引数のうち、
//   トップレベルの最後の関数（`=>` の直後の `{`、または `function` の本体）を本体とする。文字列の中の `test(`・`// given` は数えない。
// 限界: JSX のテキストに引用符（`'` / `"`）があると文字列として読み、字句解析に失敗する（失敗はファイルの違反にするので見逃しは
//   無い）。正規表現と割り算の区別は直前の字句で推定する（`/` の後に同じ行で閉じる `/` が無ければ割り算として読む）。
//   本体の中の入れ子の関数の中のフェーズコメントも数える。
// 検査の対象の列挙が 0 件なら、実ファイルのテストで失敗させる（0 件だと違反も 0 件で常に緑になる）。
// .feature（test-phases.feature）と step の実装（このファイル）に分けた（Issue #282）。

// WHY この 3 つ: リポジトリの Vitest のテストを置く場所のすべて（vitest.config.mts の include）。
const TARGET_DIRS = ["apps", "rule-tests", "scripts"];
// WHY 除くディレクトリ: 依存・ビルドの出力・Stryker の一時コピーは自分たちのテストではない。
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  "coverage",
  "dist",
  ".stryker-tmp",
  ".git",
]);

const TEST_FUNCTIONS = new Set(["it", "test"]);
const STEP_FUNCTIONS = new Set(["Given", "When", "Then", "And", "But"]);
const MODIFIERS_WITH_ARGS = new Set(["each", "for", "skipIf", "runIf"]);
const MODIFIERS_WITHOUT_ARGS = new Set(["concurrent", "sequential", "fails"]);
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
  "yield",
  "await",
]);
const PHASE_MARKER = /^\/\/ (given|when|then)(?=$|[ :])(.*)$/;

type Token = {
  kind: "word" | "punct" | "string" | "template" | "regex" | "number";
  text: string;
  start: number;
};
type LineComment = { text: string; start: number; ownLine: boolean };
type Lexed = { tokens: Token[]; comments: LineComment[] };

class LexError extends Error {}

// ---- 字句解析 ----

// ソースを字句（tokens）と行コメント（comments）に分ける。メソッドは位置 index から 1 つの字句を読んで進める。
class Lexer {
  readonly tokens: Token[] = [];
  readonly comments: LineComment[] = [];
  // WHY `{` の種類を積む: テンプレートリテラルの `${ ... }` の閉じ `}` で、テンプレートの続きの読みに戻るため。
  private readonly braces: ("block" | "template")[] = [];
  private index = 0;

  constructor(private readonly source: string) {}

  run(): Lexed {
    while (this.index < this.source.length) this.next();
    return { tokens: this.tokens, comments: this.comments };
  }

  private next(): void {
    const char = this.source[this.index] as string;
    if (/\s/.test(char)) this.index += 1;
    else if (this.source.startsWith("//", this.index)) this.lineComment();
    else if (this.source.startsWith("/*", this.index)) this.blockComment();
    else if (char === '"' || char === "'") this.string(char);
    else if (char === "`") this.template(this.index, "");
    else if (/[A-Za-z_$]/.test(char)) this.runOf("word", /[\w$]/);
    else if (/[0-9]/.test(char)) this.runOf("number", /[\w.]/);
    else if (char === "/" && this.regex()) return;
    else if (char === "}" && this.braces.at(-1) === "template") {
      this.braces.pop();
      this.template(this.index, "}");
    } else this.punct(char);
  }

  private push(kind: Token["kind"], start: number): void {
    this.tokens.push({
      kind,
      text: this.source.slice(start, this.index),
      start,
    });
  }

  private lineComment(): void {
    const start = this.index;
    const end = this.source.indexOf("\n", start);
    this.index = end === -1 ? this.source.length : end;
    const lineStart = this.source.lastIndexOf("\n", start - 1) + 1;
    this.comments.push({
      text: this.source.slice(start, this.index).trimEnd(),
      start,
      ownLine: this.source.slice(lineStart, start).trim() === "",
    });
  }

  private blockComment(): void {
    const end = this.source.indexOf("*/", this.index + 2);
    if (end === -1)
      throw new LexError(`閉じていないコメント（${this.index} 文字目）`);
    this.index = end + 2;
  }

  private string(quote: string): void {
    const start = this.index;
    this.index += 1;
    while (this.source[this.index] !== quote) {
      if (this.index >= this.source.length || this.source[this.index] === "\n")
        throw new LexError(`閉じていない文字列（${start} 文字目）`);
      this.index += this.source[this.index] === "\\" ? 2 : 1;
    }
    this.index += 1;
    this.push("string", start);
  }

  // テンプレートの文字の部分を、閉じの `` ` `` か式の始まりの `${` までの 1 つの字句にする。prefix は `${ ... }` の閉じの `}` から
  //   読み直したときの "}"（字句の先頭に付け、括弧の対応で式の閉じとして数える）。
  private template(start: number, prefix: string): void {
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\\") this.index += 2;
      else if (char === "`") {
        this.index += 1;
        this.tokens.push({ kind: "template", text: `${prefix}\``, start });
        return;
      } else if (this.source.startsWith("${", this.index)) {
        this.index += 2;
        this.braces.push("template");
        this.tokens.push({ kind: "template", text: `${prefix}\${`, start });
        return;
      } else this.index += 1;
    }
    throw new LexError(`閉じていないテンプレートリテラル（${start} 文字目）`);
  }

  private runOf(kind: Token["kind"], pattern: RegExp): void {
    const start = this.index;
    while (pattern.test(this.source[this.index] ?? "")) this.index += 1;
    this.push(kind, start);
  }

  private punct(char: string): void {
    const start = this.index;
    const text = this.source.startsWith("=>", start) ? "=>" : char;
    if (text === "{") this.braces.push("block");
    if (text === "}") this.braces.pop();
    this.index += text.length;
    this.push("punct", start);
  }

  // 正規表現として読めたら読んで true。直前の字句が値の後（割り算になる位置）なら、同じ行で閉じなければ false（割り算として読む）。
  private regex(): boolean {
    if (!this.regexAllowed()) return false;
    const end = this.regexEnd();
    if (end === undefined) return false;
    const start = this.index;
    this.index = end;
    while (/[a-z]/i.test(this.source[this.index] ?? "")) this.index += 1;
    this.push("regex", start);
    return true;
  }

  private regexAllowed(): boolean {
    const previous = this.tokens.at(-1);
    if (previous === undefined) return true;
    if (previous.kind === "word")
      return KEYWORDS_BEFORE_REGEX.has(previous.text);
    if (previous.kind === "punct") return !/^[)\]}]$/.test(previous.text);
    return previous.kind === "template" && previous.text.endsWith("${");
  }

  // 同じ行で閉じる `/` の次の位置（フラグの前）。閉じなければ undefined。
  private regexEnd(): number | undefined {
    let inClass = false;
    for (let position = this.index + 1; position < this.source.length; ) {
      const char = this.source[position];
      if (char === "\n") return undefined;
      if (char === "\\") {
        position += 2;
        continue;
      }
      if (char === "/" && !inClass) return position + 1;
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      position += 1;
    }
    return undefined;
  }
}

function lex(source: string): Lexed {
  return new Lexer(source).run();
}

// ---- テストの本体の取り出し ----

// 括弧の深さの増減。テンプレートの `${` は開き、式の閉じ（`}` で始まるテンプレートの字句）は閉じとして数える。
function depthDelta(token: Token): number {
  if (token.kind === "punct") {
    if (/^[([{]$/.test(token.text)) return 1;
    if (/^[)\]}]$/.test(token.text)) return -1;
    return 0;
  }
  if (token.kind === "template")
    return (
      (token.text.endsWith("${") ? 1 : 0) - (token.text.startsWith("}") ? 1 : 0)
    );
  return 0;
}

// open（深さを増やす字句）に対応する閉じの字句の位置。
function matching(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    depth += depthDelta(tokens[index] as Token);
    if (depth === 0) return index;
  }
  throw new LexError("括弧が閉じていない");
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

// tokens[index] が型引数の `<` なら対応する `>` の次の位置、そうでなければ index。
// WHY 型引数を読み飛ばす: `it.each<[string, number]>(...)` を見逃すと、そのテストが検査されずに通る（worker の報告で発見）。
//   型引数の中の括弧（`(s: T) => void`・`[a, b]`・`{ a: T }`）は組ごとに読み飛ばす。対応する `>` の次が `(` でなければ
//   比較の `<` として扱う（`a < b && c > d`）。
function skipTypeArguments(tokens: Token[], index: number): number {
  if (!isPunct(tokens[index], "<")) return index;
  let depth = 0;
  let position = index;
  while (position < tokens.length && !isPunct(tokens[position], ";")) {
    const token = tokens[position] as Token;
    if (isPunct(token, "<")) depth += 1;
    else if (isPunct(token, ">")) depth -= 1;
    else if (depthDelta(token) > 0) position = matching(tokens, position);
    if (depth === 0)
      return isPunct(tokens[position + 1], "(") ? position + 1 : index;
    position += 1;
  }
  return index;
}

// tokens[from] がテストの呼び出しの関数名なら、引数の `(` の位置。テストでなければ undefined。
function testCallOpen(tokens: Token[], from: number): number | undefined {
  let index = skipTypeArguments(tokens, from + 1);
  while (isPunct(tokens[index], ".") && tokens[index + 1]?.kind === "word") {
    const modifier = (tokens[index + 1] as Token).text;
    const next = skipTypeArguments(tokens, index + 2);
    if (MODIFIERS_WITH_ARGS.has(modifier) && isPunct(tokens[next], "(")) {
      index = skipTypeArguments(tokens, matching(tokens, next) + 1);
    } else if (MODIFIERS_WITHOUT_ARGS.has(modifier)) {
      index = next;
    } else {
      return undefined;
    }
  }
  return isPunct(tokens[index], "(") ? index : undefined;
}

// tokens[index] から始まる関数の本体の `{` の位置（`=>` の直後の `{`、または `function` の引数の後の `{`）。関数でなければ undefined。
function functionBodyAt(tokens: Token[], index: number): number | undefined {
  const token = tokens[index] as Token;
  if (isPunct(token, "=>"))
    return isPunct(tokens[index + 1], "{") ? index + 1 : undefined;
  if (token.kind !== "word" || token.text !== "function") return undefined;
  let paren = index + 1;
  while (paren < tokens.length && !isPunct(tokens[paren], "(")) paren += 1;
  const brace = matching(tokens, paren) + 1;
  return isPunct(tokens[brace], "{") ? brace : undefined;
}

// 引数（open から対応する `)` まで）のトップレベルの最後の関数の本体の `{` の位置。無ければ undefined。
function lastFunctionBody(tokens: Token[], open: number): number | undefined {
  const close = matching(tokens, open);
  let body: number | undefined;
  let index = open + 1;
  while (index < close) {
    const found = functionBodyAt(tokens, index);
    if (found !== undefined) {
      body = found;
      index = matching(tokens, found) + 1;
    } else if (depthDelta(tokens[index] as Token) > 0) {
      index = matching(tokens, index) + 1;
    } else {
      index += 1;
    }
  }
  return body;
}

function lineOf(source: string, position: number): number {
  return source.slice(0, position).split("\n").length;
}

// 1 つの本体（`{` と `}` の字句の位置）のフェーズコメントの違反（理由の文）。
function phaseProblems(lexed: Lexed, open: Token, close: Token): string[] {
  const markers = lexed.comments.flatMap((comment) => {
    if (!comment.ownLine) return [];
    if (comment.start <= open.start || comment.start >= close.start) return [];
    const match = PHASE_MARKER.exec(comment.text);
    if (match === null) return [];
    return [
      {
        phase: match[1] as string,
        described: (match[2] as string).replace(/^[ :]+/, "").trim() !== "",
        start: comment.start,
      },
    ];
  });
  const order = markers.map((marker) => marker.phase).join(" ");
  if (!/^given( when then)+$/.test(order)) {
    return [
      `フェーズコメントが given → when → then の順に無い（実際: ${order === "" ? "無し" : order.replaceAll(" ", " → ")}）`,
    ];
  }
  return markers.flatMap((marker, index) => {
    const end = markers[index + 1]?.start ?? close.start;
    const hasCode = lexed.tokens.some(
      (token) => token.start > marker.start && token.start < end,
    );
    if (hasCode) return [];
    if (marker.phase !== "given")
      return [`// ${marker.phase} の区間にコードが無い`];
    if (!marker.described)
      return [
        "// given の区間にコードが無いのに前提の説明が無い（`// given: <前提>` と書く）",
      ];
    return [];
  });
}

// ソース 1 つの違反（`<行>: <理由>`）。stepFile は API 仕様の step も数えるか。
function findPhaseViolations(source: string, stepFile: boolean): string[] {
  try {
    return testBodyViolations(source, lex(source), stepFile);
  } catch (error) {
    // WHY 字句・括弧の読みの失敗も違反にする: 読めないファイルを黙って通すと、そのファイルのテストは検査されない。
    if (error instanceof LexError)
      return [`字句解析できない（${error.message}）`];
    throw error;
  }
}

function testBodyViolations(
  source: string,
  lexed: Lexed,
  stepFile: boolean,
): string[] {
  const { tokens } = lexed;
  return tokens.flatMap((token, index) => {
    if (token.kind !== "word" || isPunct(tokens[index - 1], ".")) return [];
    const isTest =
      TEST_FUNCTIONS.has(token.text) ||
      (stepFile && STEP_FUNCTIONS.has(token.text));
    if (!isTest) return [];
    const open = testCallOpen(tokens, index);
    if (open === undefined) return [];
    const line = lineOf(source, token.start);
    const body = lastFunctionBody(tokens, open);
    if (body === undefined)
      return [`${line}: テストの本体がブロックの関数でない`];
    const close = tokens[matching(tokens, body)] as Token;
    return phaseProblems(lexed, tokens[body] as Token, close).map(
      (problem) => `${line}: ${problem}`,
    );
  });
}

// ---- 列挙と検査（本番と fixture で同じ処理を通す） ----

function isTargetTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

// 対象のディレクトリの下のテストファイル（リポジトリ相対の / 区切り、名前順）。
function listTestFiles(root: string): string[] {
  const walk = (relative: string): string[] => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const path = posix.join(relative, entry.name);
      if (entry.isDirectory())
        return SKIPPED_DIRS.has(entry.name) ? [] : walk(path);
      return isTargetTestFile(path) ? [path] : [];
    });
  };
  return TARGET_DIRS.flatMap(walk).sort();
}

// step（`*`）1 つが前提から検証までの 1 テストになるファイル: API 仕様と、rule-tests/ の直下のルール検査テスト（Issue #282 で
//   .feature と step の実装に分けた。rule-tests/rule-test-feature.test.ts）。
function isStepFile(path: string): boolean {
  return (
    path.endsWith(".api-spec.test.ts") ||
    /^rule-tests\/[^/]+\.test\.ts$/.test(path)
  );
}

function collectPhaseViolations(root: string): string[] {
  return listTestFiles(root).flatMap((path) =>
    findPhaseViolations(
      readFileSync(join(root, path), "utf8"),
      isStepFile(path),
    ).map((violation) => `test-phase-comments: ${path}:${violation}`),
  );
}

const repoRoot = join(import.meta.dirname, "..");
const lines = (...parts: string[]) => parts.join("\n");

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "test-phases-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const feature = await loadFeature("./test-phases.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("フェーズコメント（findPhaseViolations）", ({ And }) => {
    And(
      "given → when → then の並びと、テストでない呼び出し・文字列などの中の test の呼び出しの形は違反なし（空の given の説明・when → then の繰り返し・each などの変種・function の本体・割り算と JSX の閉じタグ）",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "given → when → then",
            lines(
              'test("a", () => {',
              "  // given",
              "  const x = 1;",
              "  // when",
              "  const y = f(x);",
              "  // then",
              "  expect(y).toBe(2);",
              "});",
            ),
          ],
          [
            "空の given に説明（: でも空白でも）",
            lines(
              'it("a", async () => {',
              "  // given: beforeEach で空にしてある",
              "  // when",
              "  const y = await f();",
              "  // then",
              "  expect(y).toBe(2);",
              "});",
              'it("b", () => {',
              "  // given 前提なし",
              "  // when",
              "  const y = f();",
              "  // then",
              "  expect(y).toBe(2);",
              "});",
            ),
          ],
          [
            "when → then の繰り返し",
            lines(
              'test("a", () => {',
              "  // given",
              "  const x = 1;",
              "  // when",
              "  f(x);",
              "  // then",
              "  expect(x).toBe(1);",
              "  // when",
              "  f(x);",
              "  // then",
              "  expect(x).toBe(1);",
              "});",
            ),
          ],
          [
            "each・for・concurrent の変種と function の本体",
            lines(
              'it.each([[1, 2]])("%s", (a, b) => {',
              "  // given",
              "  const c = a;",
              "  // when",
              "  const d = c + b;",
              "  // then",
              "  expect(d).toBe(3);",
              "});",
              'test.concurrent.for([1])("x", async function (n) {',
              "  // given",
              "  const c = n;",
              "  // when",
              "  const d = c;",
              "  // then",
              "  expect(d).toBe(1);",
              "});",
            ),
          ],
          [
            "テストでない呼び出し（describe・beforeEach・test.describe・test.use・正規表現の .test・ほかの関数）",
            lines(
              'describe("a", () => {',
              "  beforeEach(() => {",
              "    reset();",
              "  });",
              "});",
              'test.describe("a", () => {',
              '  test.use({ locale: "ja" });',
              "});",
              "const ok = /^a$/.test(s);",
              "function helper() {",
              "  return run(() => 1);",
              "}",
            ),
          ],
          [
            "文字列・テンプレート・正規表現・コメントの中の test(",
            lines(
              "const a = 'test(\"x\", () => {})';",
              'const b = "it(\\"x\\", () => {})";',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture のソースの中のテンプレートリテラル。
              'const c = `it("${name}", () => { ${`test(1, () => {})`} })`;',
              "const d = /it\\(/g;",
              '// test("x", () => {})',
              '/* it("x", () => {}) */',
            ),
          ],
          [
            "割り算と JSX の閉じタグ（正規表現として読まない）",
            lines(
              'test("a", () => {',
              "  // given",
              "  const x = 4 / 2 / 1;",
              "  // when",
              "  const y = render(<p>child</p>);",
              "  // then",
              "  expect(y).toBe(x);",
              "});",
            ),
          ],
        ];
        const stepFile = false;

        // when
        const result = casesByName(cases, ([, source]) =>
          findPhaseViolations(source, stepFile),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "フェーズコメントが無い・順が違う・区間が空・本体がブロックでない・字句解析できないテストは、行と理由で違反になる",
      () => {
        // given
        const cases: [string, string, string[]][] = [
          [
            "フェーズコメントが無い",
            lines('test("a", () => {', "  expect(f()).toBe(1);", "});"),
            [
              "1: フェーズコメントが given → when → then の順に無い（実際: 無し）",
            ],
          ],
          [
            "given が無い",
            lines(
              'it("a", () => {',
              "  // when",
              "  const y = f();",
              "  // then",
              "  expect(y).toBe(1);",
              "});",
            ),
            [
              "1: フェーズコメントが given → when → then の順に無い（実際: when → then）",
            ],
          ],
          [
            "when と then が逆",
            lines(
              'it("a", () => {',
              "  // given",
              "  const x = 1;",
              "  // then",
              "  expect(x).toBe(1);",
              "  // when",
              "  f(x);",
              "});",
            ),
            [
              "1: フェーズコメントが given → when → then の順に無い（実際: given → then → when）",
            ],
          ],
          [
            "then の後に then",
            lines(
              'it("a", () => {',
              "  // given",
              "  const x = 1;",
              "  // when",
              "  f(x);",
              "  // then",
              "  expect(x).toBe(1);",
              "  // then",
              "  expect(x).toBe(1);",
              "});",
            ),
            [
              "1: フェーズコメントが given → when → then の順に無い（実際: given → when → then → then）",
            ],
          ],
          [
            "大文字・空白なし・行の末尾のコメントはフェーズコメントと数えない",
            lines(
              'it("a", () => {',
              "  // Given",
              "  const x = 1; // when",
              "  //when",
              "  f(x);",
              "  // then",
              "  expect(x).toBe(1);",
              "});",
            ),
            [
              "1: フェーズコメントが given → when → then の順に無い（実際: then）",
            ],
          ],
          [
            "when・then の区間が空",
            lines(
              'it("a", () => {',
              "  // given",
              "  const x = 1;",
              "  // when",
              "  // then",
              "  expect(x).toBe(1);",
              "  // when",
              "  f(x);",
              "  // then",
              "});",
            ),
            [
              "1: // when の区間にコードが無い",
              "1: // then の区間にコードが無い",
            ],
          ],
          [
            "空の given に説明が無い",
            lines(
              'it("a", () => {',
              "  // given",
              "  // when",
              "  const y = f();",
              "  // then",
              "  expect(y).toBe(1);",
              "});",
              'it("b", () => {',
              "  // given:",
              "  // when",
              "  const y = f();",
              "  // then",
              "  expect(y).toBe(1);",
              "});",
            ),
            [
              "1: // given の区間にコードが無いのに前提の説明が無い（`// given: <前提>` と書く）",
              "8: // given の区間にコードが無いのに前提の説明が無い（`// given: <前提>` と書く）",
            ],
          ],
          [
            "本体が式の arrow",
            lines('test("a", () => expect(f()).toBe(1));'),
            ["1: テストの本体がブロックの関数でない"],
          ],
          [
            "変種（each・skipIf・fails）と describe の中",
            lines(
              'describe("d", () => {',
              '  it.each([1])("a", (n) => {',
              "    expect(n).toBe(1);",
              "  });",
              '  test.skipIf(x)("b", () => {',
              "    expect(1).toBe(1);",
              "  });",
              '  it.fails("c", () => {',
              "    expect(1).toBe(2);",
              "  });",
              "});",
            ),
            [
              "2: フェーズコメントが given → when → then の順に無い（実際: 無し）",
              "5: フェーズコメントが given → when → then の順に無い（実際: 無し）",
              "8: フェーズコメントが given → when → then の順に無い（実際: 無し）",
            ],
          ],
          [
            "型引数の付いた呼び出し（each の型引数・テスト関数の型引数）",
            lines(
              'it.each<[string, Map<string, number>]>([["a", new Map()]])("%s", (a) => {',
              "  expect(a).toBe(1);",
              "});",
              'test<{ a: number }>("b", () => {',
              "  expect(1).toBe(1);",
              "});",
              "const ok = a < b && c > d;",
              'it.each<[string, (s: T) => void]>([])("%s", (a) => {',
              "  expect(a).toBe(1);",
              "});",
            ),
            [
              "1: フェーズコメントが given → when → then の順に無い（実際: 無し）",
              "4: フェーズコメントが given → when → then の順に無い（実際: 無し）",
              "8: フェーズコメントが given → when → then の順に無い（実際: 無し）",
            ],
          ],
          [
            "入れ子のテンプレートの後のテスト",
            lines(
              // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture のソースの中のテンプレートリテラル。
              "const c = `a${`b${1}`}`;",
              'test("a", () => {',
              "  expect(c).toBe(1);",
              "});",
            ),
            [
              "2: フェーズコメントが given → when → then の順に無い（実際: 無し）",
            ],
          ],
          [
            "閉じていない括弧",
            lines('test("a", () => {', "  f(;"),
            ["字句解析できない（括弧が閉じていない）"],
          ],
          [
            "閉じていない文字列",
            lines('test("a, () => {', "});"),
            ["字句解析できない（閉じていない文字列（5 文字目））"],
          ],
        ];
        const stepFile = false;

        // when
        const result = casesByName(cases, ([, source]) =>
          findPhaseViolations(source, stepFile),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );

    And(
      "API 仕様の step（And など）は stepFile のときだけテストとして数える",
      () => {
        // given
        const source = lines(
          "describeFeature(feature, ({ Scenario }) => {",
          '  Scenario("更新", ({ And, Given, When, Then, But }) => {',
          '    And("a", async () => {',
          "      await put();",
          "    });",
          '    Given("b", () => {',
          "      // given",
          "      const x = 1;",
          "      // when",
          "      put(x);",
          "      // then",
          "      expect(x).toBe(1);",
          "    });",
          '    When("c", () => {});',
          '    Then("d", () => {});',
          '    But("e", () => {});',
          "  });",
          "});",
        );

        // when
        const violations = {
          step: findPhaseViolations(source, true),
          other: findPhaseViolations(source, false),
        };

        // then
        const missing = (line: number) =>
          `${line}: フェーズコメントが given → when → then の順に無い（実際: 無し）`;
        expect(violations).toEqual({
          step: [missing(3), missing(14), missing(15), missing(16)],
          other: [],
        });
      },
    );
  });

  Scenario("列挙と検査（fixture）", ({ And }) => {
    const bare = lines('test("a", () => {', "  expect(1).toBe(1);", "});");
    const step = lines('And("a", () => {', "  expect(1).toBe(1);", "});");

    And("対象のテストファイルだけを検査し、違反をファイルと行で返す", () => {
      // given
      const root = fixture({
        "apps/backend/x.test.ts": bare,
        "apps/frontend/y.test.tsx": `\n${bare}`,
        "apps/e2e/z.spec.ts": bare,
        "apps/e2e/z.steps.ts": step,
        "apps/backend/spec/api/todo/a.api-spec.test.ts": step,
        "apps/backend/spec/journey/b.api-journey.test.ts": step,
        "rule-tests/c.test.ts": step,
        "rule-tests/nested/d.test.ts": step,
        "apps/backend/helper.ts": bare,
        "apps/frontend/w.spec.ts": bare,
        "apps/node_modules/p/q.test.ts": bare,
        "apps/frontend/.next/r.test.ts": bare,
        "other/s.test.ts": bare,
      });

      // when
      const result = {
        files: listTestFiles(root),
        violations: collectPhaseViolations(root),
      };

      // then
      const missing = (path: string, line: number) =>
        `test-phase-comments: ${path}:${line}: フェーズコメントが given → when → then の順に無い（実際: 無し）`;
      expect(result).toEqual({
        files: [
          "apps/backend/spec/api/todo/a.api-spec.test.ts",
          "apps/backend/spec/journey/b.api-journey.test.ts",
          "apps/backend/x.test.ts",
          "apps/frontend/y.test.tsx",
          "rule-tests/c.test.ts",
          "rule-tests/nested/d.test.ts",
        ],
        violations: [
          missing("apps/backend/spec/api/todo/a.api-spec.test.ts", 1),
          missing("apps/backend/x.test.ts", 1),
          missing("apps/frontend/y.test.tsx", 2),
          missing("rule-tests/c.test.ts", 1),
        ],
      });
    });

    And(
      "対象のディレクトリが無ければ対象は 0 件で違反も 0 件になる（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const root = fixture({ "README.md": "# x\n" });

        // when
        const result = {
          files: listTestFiles(root),
          violations: collectPhaseViolations(root),
        };

        // then
        expect(result).toEqual({ files: [], violations: [] });
      },
    );
  });

  Scenario("フェーズコメント（実ファイル）", ({ And }) => {
    And(
      "すべてのテストの本体に given → when → then のフェーズコメントがある",
      () => {
        // given
        // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
        const files = listTestFiles(repoRoot);

        // when
        const violations = collectPhaseViolations(repoRoot);

        // then
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/backend/features/todo/internal/domain/todo.test.ts",
            "apps/backend/spec/api/todo/create-todo.api-spec.test.ts",
            "rule-tests/architecture.test.ts",
          ]),
        );
        expect(violations).toEqual([]);
      },
    );
  });
});
