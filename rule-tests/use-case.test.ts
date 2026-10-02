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
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";

// 「1 ユースケース = 1 API = 1 command」（.claude/rules/code/backend.md、Issue #175・#177）を、application の command / query
// （apps/backend/features/*/internal/application/*.command.ts・*.query.ts）の入力で機械的に検査するテスト。
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
// トランザクションの規則（Issue #215。ADR docs/adr/architecture/20260930-transaction-from-application.md）:
//   - command-runs-in-transaction: *.command.ts の execute の定義（行の先頭が `execute(` / `async execute(`。`public` などの修飾子と
//     型引数も可）の本体（`{ … }`）に、`this.<依存>.run(`（`.` と名前と `(` の間の空白・改行は可）が無い。行は execute の行。
//     execute の定義が 1 つも無い command は 1 行目を違反にする（確かめられないので安全側）。query（*.query.ts）は対象外。
//     WHY: command はトランザクションの範囲を決め、読み込み（findByIdForUpdate の行ロック）と書き込みを runner の run が渡した 1 つの
//       トランザクションで行う。run を通さない command は、Repository に渡す tx が無い（型で止まる）か、別の経路で書き込みを
//       作ってしまう。書き忘れを型より先にここで止め、規則を名前で読めるようにする。
//     WHY query は対象外: query は 1 文の読み取りでトランザクションを張らない（行ロックも取らない。ADR の決定）。
//     例外の書き方: execute の定義の行の直前に続く `//` のコメント行（空行を挟まない）のどれかが「// WHY トランザクション無し: <理由>」
//       なら通す（DB に触らない command。notification の送信など）。理由が空・別の見出しの WHY では通さない。
//     WHY 例外を名前付きの WHY にする（対象の一覧にしない）: DB に触らない command は理由がその場で読め、DB を使うように変えたときに
//       コメントと食い違うことがレビューで分かる。見出しを固定するのは、別の理由の WHY が直前にあるだけで黙って通らないようにするため
//       （rule-tests/api-request.test.ts の `// WHY 任意:` と同じ）。
//     限界: 本体に `this.<何か>.run(` があるかだけを見る。run の依存が TransactionRunner か（型）、Repository の呼び出しが run の
//       コールバックの中か、run が実際に呼ばれる経路にあるか（早い return の後・呼ばれない関数の中）は見ない（command のテストが
//       runner の run が渡した tx で Repository が呼ばれることを確かめる）。`const { run } = this.transactions` のような分割代入・
//       別名の変数（`const t = this.transactions; t.run(…)`）は見逃さず違反と数える（安全側）。本体の範囲は括弧の対応で決めるので、
//       文字列・正規表現の中の `{` `}` があるとずれる。

type RuleId =
  | "no-optional-input-field"
  | "no-undefined-branch-on-input"
  | "command-runs-in-transaction";

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

// code[open] の "(" に対応する ")" の位置（閉じが無ければ末尾）。
function closingParenOf(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    if (code[index] === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return code.length;
}

// 引数の ")" の後の、本体の "{" の位置（無ければ -1）。戻り値の型の中の "{"（`Promise<{ a: string }>`）は飛ばす。
// WHY `<` と `>` の深さを数える: 戻り値の型の中のオブジェクトの型を本体と取り違えない。`=>`（関数の型）の `>` は数えない。
function bodyOpenOf(code: string, afterParams: number): number {
  let angle = 0;
  for (let index = afterParams; index < code.length; index += 1) {
    const char = code[index];
    if (char === "<") angle += 1;
    if (char === ">" && code[index - 1] !== "=") angle -= 1;
    if (char === "{" && angle === 0) return index;
  }
  return -1;
}

// 例外を認める WHY の見出し（`// WHY トランザクション無し: <理由>`）。理由（空白でない文字）が要る。
const TRANSACTION_OPT_OUT = /^\s*\/\/\s*WHY トランザクション無し:\s*\S/;

// 行（1 始まり）の直前に続く `//` の行に、例外の WHY があるか。
function optedOutOfTransaction(lines: string[], line: number): boolean {
  for (
    let index = line - 2;
    index >= 0 && /^\s*\/\//.test(lines[index] ?? "");
    index -= 1
  ) {
    if (TRANSACTION_OPT_OUT.test(lines[index] ?? "")) return true;
  }
  return false;
}

// *.command.ts の execute の本体が this.<依存>.run( を含まない（トランザクションを張らない）ものの違反。
function findCommandTransactionViolations(text: string): UseCaseViolation[] {
  const lines = text.split("\n");
  const code = stripLineComments(text);
  const definitions = [
    ...code.matchAll(
      /^[ \t]*(?:(?:public|private|protected|override)\s+)*(?:async\s+)?execute\s*(?:<[^>(]*>)?\s*\(/gm,
    ),
  ];
  if (definitions.length === 0) {
    return [{ rule: "command-runs-in-transaction", line: 1 }];
  }
  return definitions.flatMap((definition) => {
    const params = definition.index + definition[0].length - 1;
    const open = bodyOpenOf(code, closingParenOf(code, params) + 1);
    const body =
      open === -1 ? "" : code.slice(open, closingBraceOf(code, open));
    const line = lineOf(
      code,
      definition.index + definition[0].indexOf("execute"),
    );
    return /\bthis\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*run\s*\(/.test(body) ||
      optedOutOfTransaction(lines, line)
      ? []
      : [{ rule: "command-runs-in-transaction" as const, line }];
  });
}

// 検査の対象: apps/backend/features/<f>/internal/application/ の直下の *.command.ts / *.query.ts（テストは除く）。
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
      /^apps\/backend\/features\/[^/]+\/internal\/application\/[^/]+\.(?:command|query)\.ts$/.test(
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
    const violations = [
      ...findUseCaseViolations(text),
      ...(path.endsWith(".command.ts")
        ? findCommandTransactionViolations(text)
        : []),
    ].sort((a, b) => a.line - b.line);
    return violations.map(
      ({ rule, line }) =>
        `${rule}: ${path}:${line}: ${(lines[line - 1] ?? "").trim()}`,
    );
  });
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");
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

const feature = await loadFeature("./use-case.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario(
    "command の入力の判定（findUseCaseViolations）: must pass",
    ({ And }) => {
      And(
        "Input の項目がすべて必須で、input の項目を比較しなければ違反なし（Input 以外の型の ?:・値の三項演算子など）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "Input の項目がすべて必須で、input の項目を比較しない",
              source(
                "export type RenameTodoInput = {",
                "  id: string;",
                "  title: string;",
                "};",
                "async execute(input: RenameTodoInput): Promise<Todo> {",
                "  const current = await this.repository.findByIdForUpdate(input.id);",
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
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findUseCaseViolations(text),
          );

          // then
          expect(violations).toEqual(casesByName(cases, () => []));
        },
      );
    },
  );

  Scenario(
    "command の入力の判定（findUseCaseViolations）: must reject",
    ({ And }) => {
      And(
        "Input の任意の項目と input の項目の有無の分岐は、規則と行で違反になる（title?:・1 行の Input・export の無い Input・? と : の間の空白など）",
        () => {
          // given
          const cases: [string, string, UseCaseViolation[]][] = [
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
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findUseCaseViolations(text),
          );

          // then
          expect(violations).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );
    },
  );

  Scenario(
    "command のトランザクションの判定（findCommandTransactionViolations）: must pass",
    ({ And }) => {
      And(
        "execute の本体を this.transactions.run で包めば違反なし（複数行・return・修飾子・型引数・空白と改行・run の後の通知など）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "execute の本体を this.transactions.run( で包む（複数行・return する）",
              source(
                "export class RenameXCommand {",
                "  constructor(",
                "    private readonly repository: XRepository,",
                "    private readonly transactions: TransactionRunner,",
                "  ) {}",
                "",
                "  async execute(input: RenameXInput): Promise<X> {",
                "    return this.transactions.run(async (tx) => {",
                "      const current = await this.repository.findByIdForUpdate(input.id, tx);",
                "      await this.repository.update(current.rename(input.title), tx);",
                "      return current;",
                "    });",
                "  }",
                "}",
              ),
            ],
            [
              "修飾子・型引数・戻り値の型のオブジェクト型・run の前後の空白と改行・run の後に通知を書く",
              source(
                "  public async execute<T>(input: T): Promise<{ id: string }> {",
                "    const { current } = await this.transactions",
                "      . run (async (tx) => ({ current: await this.repository.findByIdForUpdate(input.id, tx) }));",
                "    this.notify(current.id);",
                "    return current;",
                "  }",
              ),
            ],
            [
              "直前に続くコメント行のどれかに // WHY トランザクション無し: <理由> がある（DB に触らない command）",
              source(
                "// WHY トランザクション無し: 通知をログに出すだけで DB に書かない。",
                "// 送信の失敗の扱いは expose が決める。",
                "  async execute(input: I): Promise<void> {",
                "    await this.sender.send(input.message);",
                "  }",
              ),
            ],
            [
              "戻り値の型に関数の型（=>）を含む",
              source(
                "execute(input: I): Promise<() => void> {",
                "  return this.transactions.run(async () => () => undefined);",
                "}",
              ),
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findCommandTransactionViolations(text),
          );

          // then
          expect(violations).toEqual(casesByName(cases, () => []));
        },
      );
    },
  );

  Scenario(
    "command のトランザクションの判定（findCommandTransactionViolations）: must reject",
    ({ And }) => {
      And(
        "execute を run で包まなければ違反（Repository を直接呼ぶ・run が execute の外にだけあるなど）",
        () => {
          // given
          const cases: [string, string, UseCaseViolation[]][] = [
            [
              "execute が Repository を直接呼び、run で包まない",
              source(
                "export class DeleteXCommand {",
                "  async execute(id: string): Promise<void> {",
                "    await this.repository.findByIdForUpdate(id, tx);",
                "    await this.repository.delete(id, tx);",
                "  }",
                "}",
              ),
              [{ rule: "command-runs-in-transaction", line: 2 }],
            ],
            [
              "run が execute の外（別のメソッド）にだけある",
              source(
                "class A {",
                "  execute(input: I) {",
                "    return this.save(input);",
                "  }",
                "  private save(input: I) {",
                "    return this.transactions.run(async (tx) => this.repository.insert(input, tx));",
                "  }",
                "}",
              ),
              [{ rule: "command-runs-in-transaction", line: 2 }],
            ],
            [
              "this の無い transactions.run( / 名前が run で始まるだけの runLater( / 依存を挟まない this.run( / コメントの中の run",
              source(
                "async execute(input: I) {",
                "  await transactions.run(async (tx) => {});",
                "  await this.transactions.runLater(async (tx) => {});",
                "  await this.run(async (tx) => {});",
                "  // return this.transactions.run(async (tx) => {});",
                "}",
              ),
              [{ rule: "command-runs-in-transaction", line: 1 }],
            ],
            [
              "例外の WHY が空行を挟む・理由が空・別の見出し（WHY 任意:）・execute の中にある",
              source(
                "// WHY トランザクション無し: DB に書かない。",
                "",
                "async execute(a: I) {}",
                "// WHY トランザクション無し: ",
                "async execute(b: I) {}",
                "// WHY 任意: DB に書かない。",
                "async execute(c: I) {",
                "  // WHY トランザクション無し: DB に書かない。",
                "}",
              ),
              [
                { rule: "command-runs-in-transaction", line: 3 },
                { rule: "command-runs-in-transaction", line: 5 },
                { rule: "command-runs-in-transaction", line: 7 },
              ],
            ],
            [
              "execute の定義が無い command（1 行目）",
              source("export class XCommand {", "  run() {}", "}"),
              [{ rule: "command-runs-in-transaction", line: 1 }],
            ],
            [
              "execute の後ろの別のクラスに run がある（本体の範囲は execute の { } だけ）",
              source(
                "class A {",
                "  async execute(input: I) {",
                "    await this.repository.insert(input, tx);",
                "  }",
                "}",
                "class B {",
                "  async execute(input: I) {",
                "    await this.transactions.run(async (tx) => {});",
                "  }",
                "}",
              ),
              [{ rule: "command-runs-in-transaction", line: 2 }],
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findCommandTransactionViolations(text),
          );

          // then
          expect(violations).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );
    },
  );

  // --- 列挙 → 読み取り → 判定を通した fixture テスト ---
  // WHY: 判定が正しくても、対象の列挙（application/*.command.ts・*.query.ts の見つけ方）が漏れれば見逃す。一時ディレクトリに
  //   架空のツリーを置き、本番と同じ collectUseCaseViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
  Scenario("command / query の列挙と検査（fixture）", ({ And }) => {
    And(
      "features/<f>/internal/application/ の .command.ts・.query.ts だけを対象にし、違反を「規則: パス:行: 行の内容」で返す",
      () => {
        // given
        const root = fixture({
          "apps/backend/features/x/internal/application/rename-x.command.ts":
            source(
              "export type RenameXInput = {",
              "  id: string;",
              "  title: string;",
              "};",
              "async execute(input: RenameXInput) {",
              "  return this.transactions.run(async (tx) => {",
              "    const current = await this.repository.findByIdForUpdate(input.id, tx);",
              "  });",
              "}",
            ),
          "apps/backend/features/x/internal/application/update-x.command.ts":
            source(
              "export type UpdateXInput = {",
              "  id: string;",
              "  title?: string;",
              "};",
              "if (input.title !== undefined) current = current.rename(input.title);",
              "async execute(input: UpdateXInput) {",
              "  await this.transactions.run(async (tx) => {});",
              "}",
            ),
          // Issue #215: トランザクションを張らない command（execute の本体に run が無い）。
          "apps/backend/features/x/internal/application/delete-x.command.ts":
            source(
              "export class DeleteXCommand {",
              "  async execute(id: string): Promise<void> {",
              "    await this.repository.delete(id, tx);",
              "  }",
              "}",
            ),
          // query は execute に run が無くても対象外。
          "apps/backend/features/x/internal/application/list-x.query.ts":
            source(
              "export type ListXResult = { next?: string };",
              "execute() {",
              "  return this.repository.findAll();",
              "}",
            ),
          // 対象外: command のテスト、application の command / query 以外、入れ子、domain・presentation、shared、frontend。
          "apps/backend/features/x/internal/application/update-x.command.test.ts":
            partialUpdate,
          "apps/backend/features/x/internal/application/helper.ts":
            partialUpdate,
          "apps/backend/features/x/internal/application/nested/y.command.ts":
            partialUpdate,
          "apps/backend/features/x/internal/domain/x.ts": partialUpdate,
          "apps/backend/features/x/internal/presentation/update-x.api.ts":
            partialUpdate,
          "apps/backend/shared/transaction/y.command.ts": partialUpdate,
          // Issue #208: internal/ を挟まない旧の置き場所（置き場所の規則 backend-placement が違反にする）。
          "apps/backend/features/x/application/old.command.ts": partialUpdate,
          "apps/frontend_customer/features/x/application/y.command.ts":
            partialUpdate,
        });

        // when
        const result = {
          files: listUseCaseFiles(root),
          violations: collectUseCaseViolations(root),
        };

        // then
        expect(result).toEqual({
          files: [
            "apps/backend/features/x/internal/application/delete-x.command.ts",
            "apps/backend/features/x/internal/application/list-x.query.ts",
            "apps/backend/features/x/internal/application/rename-x.command.ts",
            "apps/backend/features/x/internal/application/update-x.command.ts",
          ],
          violations: [
            "command-runs-in-transaction: apps/backend/features/x/internal/application/delete-x.command.ts:2: async execute(id: string): Promise<void> {",
            "no-optional-input-field: apps/backend/features/x/internal/application/update-x.command.ts:3: title?: string;",
            "no-undefined-branch-on-input: apps/backend/features/x/internal/application/update-x.command.ts:5: if (input.title !== undefined) current = current.rename(input.title);",
          ],
        });
      },
    );

    And(
      "apps/backend/features が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const root = fixture({ "README.md": "# x\n" });

        // when
        const result = {
          files: listUseCaseFiles(root),
          violations: collectUseCaseViolations(root),
        };

        // then
        expect(result).toEqual({ files: [], violations: [] });
      },
    );
  });

  Scenario("1 ユースケース = 1 command（実ファイル）", ({ And }) => {
    And(
      "command / query の Input に任意の項目が無く、input の項目の有無で分岐せず、command の execute はトランザクション（runner の run）で包む",
      () => {
        // given: 実ファイル（repoRoot）
        // when
        const files = listUseCaseFiles(repoRoot);
        const violations = collectUseCaseViolations(repoRoot);

        // then
        // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
        expect(files).toContain(
          "apps/backend/features/todo/internal/application/rename-todo.command.ts",
        );
        expect(files).toContain(
          "apps/backend/features/todo/internal/application/list-todos.query.ts",
        );
        expect(violations).toEqual([]);
      },
    );
  });
});
