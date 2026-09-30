// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは command / query のソースを文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 「1 ユースケース = 1 API = 1 command」（.claude/rules/backend.md、Issue #175・#177）を、application の command / query
// （apps/backend/features/*/application/*.command.ts・*.query.ts）の入力で機械的に検査するテスト。
// WHY 検査する: 入力の任意の項目は「指定されたときだけ変える」分岐を command に生み、1 つの command に複数のユースケース
//   （改名・完了の切り替え）が混ざる。ユースケースが違うなら command を分ける（Issue #175）。api 側は rule-tests/api-request.test.ts が
//   リクエストの `.optional()` を止めるが、command の入力の型は api を通さずにも書けるので、command 側でも止める。
// 違反にするもの（規則）:
//   - no-optional-input-field: `type <Name>Input = { ... }`（export の有無は問わない。名前が Input で終わる型。型引数
//     `<Name>Input<T>` と `Readonly<{ ... }>` も）の `{ ... }` の中の
//     任意の項目（`<name>?:`）。`{ ... }` の範囲は括弧の対応で決めるので、入れ子のオブジェクトの型の中の `?:` も数える（安全側）。
//     Input 以外の型（`Result` など）の `?:` は見ない。
//   - no-undefined-branch-on-input: `input.<name>` と `undefined` / `null` の比較（`!==` / `===` / `!=` / `==`、左右どちら向きも。
//     `input?.<name>` も）。項目の有無で分岐する = 複数のユースケースを 1 つの command に混ぜている。`input` 以外（`todo !== undefined`）は見ない。
// WHY `?:` は直前が識別子（か引用符）のときだけ数える: 値の三項演算子 `a ? b : c` は `?` と `:` の間に式があり、型の中で `?` の直後に
//   `:` が来るのは任意の項目だけ。範囲も Input の型の `{ ... }` の中に限る。
// 限界: 行ごとに `//` 以降を落としてから探し、文字列は見分けない。文字列リテラルの中の `//` の後ろは見逃し、文字列の中の `{` `}`・
//   `x?:`・`input.x !== undefined` は数える。ブロックコメントの中も数える（安全側）。`interface <Name>Input`、`Partial<...>`、
//   `x: string | undefined`、別名の型を経由した入力（`type RenameInput = Base & {...}` の Base 側）、任意のメソッド（`x?(): void`）、
//   `input` 以外の名前の引数・分割代入（`{ title }`）の比較、`typeof input.x === "undefined"`・`"x" in input`・`input.x ?? y`・
//   `if (input.x)` のような別の書き方の分岐、`input["x"] !== undefined`・`input.x !== void 0` は見えない。型引数の既定値のある
//   Input（`<T = string>`。`=` で止まる）、Readonly 以外で包んだ Input、Input の型を付けずに引数に直接書いた型
//   （`execute(input: { title?: string })`）も見えない。逆に、Input の中の関数の型の任意の引数（`(x?: string) => void`）は
//   任意の項目と数える（誤検知。Input に関数を持たせる書き方は無い想定）。

type RuleId = "no-optional-input-field" | "no-undefined-branch-on-input";

type UseCaseViolation = { rule: RuleId; line: number };

// 行ごとに `//` 以降を落とす（改行は残し、位置から行番号を出せるようにする）。
// WHY: コメントの「title?: は使わない」「input.title !== undefined で分岐しない」を違反と数えない。
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("//")[0] ?? "")
    .join("\n");
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// code[open] の "{" に対応する "}" の位置（閉じが無ければ末尾）。
function closingBraceOf(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] === "}") depth -= 1;
    if (depth === 0) return index;
  }
  return code.length;
}

function findUseCaseViolations(text: string): UseCaseViolation[] {
  const code = stripLineComments(text);
  const violations: UseCaseViolation[] = [];
  // WHY `Input\b[^=]*=`: 型引数（`PageInput<T>`）を挟んでも拾う。`\b` で `InputResult` のような名前の途中の Input を外す。
  // WHY `(?:Readonly<\s*)?`: `Readonly<{ ... }>` で包んだ Input も拾う。
  for (const type of code.matchAll(
    /\btype\s+[\w$]*Input\b[^=]*=\s*(?:Readonly<\s*)?\{/g,
  )) {
    const open = type.index + type[0].length - 1;
    const body = code.slice(open, closingBraceOf(code, open));
    for (const field of body.matchAll(/[\w$"']\s*\?\s*:/g)) {
      violations.push({
        rule: "no-optional-input-field",
        line: lineOf(code, open + field.index),
      });
    }
  }
  // WHY `(?<![\w$.])input`: `userInput.x` や `this.input.x` を command の引数の input と取り違えない。
  const inputField = String.raw`(?<![\w$.])input\s*\??\.\s*[A-Za-z_$][\w$]*`;
  const nullish = String.raw`(?:undefined|null)\b`;
  const compare = String.raw`\s*[!=]==?\s*`;
  for (const branch of code.matchAll(
    new RegExp(
      `${inputField}${compare}${nullish}|\\b${nullish}${compare}${inputField}`,
      "g",
    ),
  )) {
    violations.push({
      rule: "no-undefined-branch-on-input",
      line: lineOf(code, branch.index),
    });
  }
  return violations.sort((a, b) => a.line - b.line);
}

// 検査の対象: apps/backend/features/<f>/application/ の直下の *.command.ts / *.query.ts（テストは除く）。
//   リポジトリ相対の / 区切りで、名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listUseCaseFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, "apps/backend/features"), {
      recursive: true,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return entries
    .map((path) => `apps/backend/features/${path.split(sep).join("/")}`)
    .filter((path) =>
      // `*.command.test.ts` は `.command.ts` で終わらないので、この形だけでテストは外れる。
      /^apps\/backend\/features\/[^/]+\/application\/[^/]+\.(?:command|query)\.ts$/.test(
        path,
      ),
    )
    .sort();
}

// 違反を「<規則>: <パス>:<行>: <行の内容（前後の空白を除く）>」で返す。
function collectUseCaseViolations(root: string): string[] {
  return listUseCaseFiles(root).flatMap((path) => {
    const text = readFileSync(join(root, path), "utf8");
    const lines = text.split("\n");
    return findUseCaseViolations(text).map(
      ({ rule, line }) =>
        `${rule}: ${path}:${line}: ${(lines[line - 1] ?? "").trim()}`,
    );
  });
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

describe("command の入力の判定（findUseCaseViolations）: must pass", () => {
  it.each([
    [
      "Input の項目がすべて必須で、input の項目を比較しない",
      source(
        "export type RenameTodoInput = {",
        "  id: string;",
        "  title: string;",
        "};",
        "async execute(input: RenameTodoInput): Promise<Todo> {",
        "  const current = await this.repository.findByIdOrThrow(input.id);",
        "  return current.rename(input.title);",
        "}",
      ),
    ],
    [
      "Input 以外の型（Result / Props）の ?: は対象外",
      source(
        "export type RenameTodoInput = { id: string };",
        "export type RenameTodoResult = {",
        "  warning?: string;",
        "};",
        "type Props = { note?: string };",
        // 名前の途中に Input があるだけの型（Input で終わらない）。
        "type InputResult = { next?: string };",
      ),
    ],
    [
      "値の三項演算子（a ? b : c）は ?: と数えない（Input の型の中の条件型も）",
      source(
        "export type ListInput = {",
        "  order: Order extends Asc ? 'asc' : 'desc';",
        "};",
        "const label = input.completed ? done : todo;",
        "const x = a ?b : c;",
      ),
    ],
    [
      "input 以外の値と undefined / null の比較（todo !== undefined / userInput.x / this.input.x）",
      source(
        "if (todo !== undefined) return todo;",
        "if (userInput.title === undefined) return;",
        "if (this.input.title != null) return;",
      ),
    ],
    [
      "input の項目を undefined 以外と比べる（input.completed === true）",
      source("if (input.completed === true) notify();"),
    ],
    [
      "コメントの中の ?: と input.x !== undefined は数えない",
      source(
        "export type RenameTodoInput = {",
        "  id: string; // title?: にしない（部分更新にしない）",
        "  title: string;",
        "};",
        "// input.title !== undefined で分岐しない。",
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findUseCaseViolations(text)).toEqual([]);
  });
});

describe("command の入力の判定（findUseCaseViolations）: must reject", () => {
  it.each<[string, string, UseCaseViolation[]]>([
    [
      "Input の任意の項目（title?: / completed?:）",
      source(
        "export type UpdateTodoInput = {",
        "  id: string;",
        "  title?: string;",
        "  completed?: boolean;",
        "};",
      ),
      [
        { rule: "no-optional-input-field", line: 3 },
        { rule: "no-optional-input-field", line: 4 },
      ],
    ],
    [
      "1 行で書いた Input・export の無い Input・名前が Input だけ・? と : の間の空白",
      source(
        "export type UpdateTodoInput = { id: string; title?: string };",
        "type LocalInput = { note?: string };",
        "type Input = {",
        "  due ? : Date;",
        "};",
      ),
      [
        { rule: "no-optional-input-field", line: 1 },
        { rule: "no-optional-input-field", line: 2 },
        { rule: "no-optional-input-field", line: 4 },
      ],
    ],
    [
      "Readonly<{ ... }> とジェネリクスの Input",
      source(
        "export type RenameXInput = Readonly<{",
        "  title?: string;",
        "}>;",
        "export type PageInput<T> = {",
        "  cursor?: T;",
        "};",
      ),
      [
        { rule: "no-optional-input-field", line: 2 },
        { rule: "no-optional-input-field", line: 5 },
      ],
    ],
    [
      '引用符で囲んだ項目名（"title"?:）と入れ子のオブジェクトの型の中の ?:',
      source(
        "export type UpdateTodoInput = {",
        '  "title"?: string;',
        "  filter: {",
        "    tag?: string;",
        "  };",
        "};",
      ),
      [
        { rule: "no-optional-input-field", line: 2 },
        { rule: "no-optional-input-field", line: 4 },
      ],
    ],
    [
      "input.title !== undefined / === undefined / != null / == null",
      source(
        "if (input.title !== undefined) current = current.rename(input.title);",
        "if (input.title === undefined) return current;",
        "if (input.completed != null) done();",
        "if (input.completed == null) return;",
      ),
      [
        { rule: "no-undefined-branch-on-input", line: 1 },
        { rule: "no-undefined-branch-on-input", line: 2 },
        { rule: "no-undefined-branch-on-input", line: 3 },
        { rule: "no-undefined-branch-on-input", line: 4 },
      ],
    ],
    [
      "逆向き（undefined !== input.title）・input?.title・演算子の前後の空白と改行",
      source(
        "if (undefined !== input.title) rename();",
        "if (input?.title !== undefined) rename();",
        "if (",
        "  input . completed",
        "    !==",
        "  undefined",
        ") done();",
      ),
      [
        { rule: "no-undefined-branch-on-input", line: 1 },
        { rule: "no-undefined-branch-on-input", line: 2 },
        { rule: "no-undefined-branch-on-input", line: 4 },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findUseCaseViolations(text)).toEqual(expected);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（application/*.command.ts・*.query.ts の見つけ方）が漏れれば見逃す。一時ディレクトリに
//   架空のツリーを置き、本番と同じ collectUseCaseViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("command / query の列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "use-case-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const partialUpdate = source(
    "export type UpdateXInput = {",
    "  title?: string;",
    "};",
    "if (input.title !== undefined) rename();",
  );

  it("features/<f>/application/*.command.ts・*.query.ts だけを対象にし、違反を「規則: パス:行: 行の内容」で返す", () => {
    const root = fixture({
      "apps/backend/features/x/application/rename-x.command.ts": source(
        "export type RenameXInput = {",
        "  id: string;",
        "  title: string;",
        "};",
        "const current = await this.repository.findByIdOrThrow(input.id);",
      ),
      "apps/backend/features/x/application/update-x.command.ts": source(
        "export type UpdateXInput = {",
        "  id: string;",
        "  title?: string;",
        "};",
        "if (input.title !== undefined) current = current.rename(input.title);",
      ),
      "apps/backend/features/x/application/list-x.query.ts": source(
        "export type ListXResult = { next?: string };",
        "const items = await this.repository.findAll();",
      ),
      // 対象外: command のテスト、application の command / query 以外、入れ子、domain・presentation、shared、frontend。
      "apps/backend/features/x/application/update-x.command.test.ts":
        partialUpdate,
      "apps/backend/features/x/application/helper.ts": partialUpdate,
      "apps/backend/features/x/application/nested/y.command.ts": partialUpdate,
      "apps/backend/features/x/domain/x.ts": partialUpdate,
      "apps/backend/features/x/presentation/update-x.api.ts": partialUpdate,
      "apps/backend/shared/application/y.command.ts": partialUpdate,
      "apps/frontend_customer/features/x/application/y.command.ts":
        partialUpdate,
    });
    expect({
      files: listUseCaseFiles(root),
      violations: collectUseCaseViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/x/application/list-x.query.ts",
        "apps/backend/features/x/application/rename-x.command.ts",
        "apps/backend/features/x/application/update-x.command.ts",
      ],
      violations: [
        "no-optional-input-field: apps/backend/features/x/application/update-x.command.ts:3: title?: string;",
        "no-undefined-branch-on-input: apps/backend/features/x/application/update-x.command.ts:5: if (input.title !== undefined) current = current.rename(input.title);",
      ],
    });
  });

  it("apps/backend/features が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listUseCaseFiles(root),
      violations: collectUseCaseViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("1 ユースケース = 1 command（実ファイル）", () => {
  it("command / query の Input に任意の項目が無く、input の項目の有無で分岐しない", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    const files = listUseCaseFiles(repoRoot);
    expect(files).toContain(
      "apps/backend/features/todo/application/rename-todo.command.ts",
    );
    expect(files).toContain(
      "apps/backend/features/todo/application/list-todos.query.ts",
    );
    expect(collectUseCaseViolations(repoRoot)).toEqual([]);
  });
});
