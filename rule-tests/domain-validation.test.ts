// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは domain のソースを文字列として読むだけで
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

// 「domain の検証は validate（DomainValidation.validated）を通す」（.claude/rules/code/backend.md の「入力検証」の domain の項、apps/backend/shared/error/validate.ts、
// Issue #177）を、backend のソースで機械的に検査するテスト。
// WHY 検査する: zod の issue → DomainError の変換（最初の issue の message をキーにする・キーの無い issue は DomainError ではない
//   Error（500）にする）は validate の 1 か所に置いた。Entity ごとに safeParse して自分で DomainError を作ると、変換が Entity ごとに
//   ずれる（Issue #160）。文章の規則だけだと、zod を使い慣れた書き方（`schema.parse(x)`）が既定のように書かれる。
// 違反にするもの（規則）:
//   - no-direct-zod-parse-in-domain（domain だけ）: zod のスキーマの検証メソッドの呼び出し。`.parse(` / `.safeParse(` /
//     `.parseAsync(` / `.safeParseAsync(` と、zod 4.6.5 の classic のスキーマが持つ同じ働きのメソッド `.spa(`（safeParseAsync の
//     別名）/ `.decode(` / `.safeDecode(` / `.decodeAsync(` / `.safeDecodeAsync(` / `.validate(` / `.validateAsync(`
//     （node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/classic/schemas.d.ts の ZodType）。
//     ただし直前の識別子が組み込みの JSON / Date のもの（`JSON.parse(` / `Date.parse(`）は zod ではないので除く
//     （NON_ZOD_RECEIVERS）。受け手が識別子でないもの（`todoPropsSchema().parse(`）も違反にする。
//     `Number.parseInt(` / `parseInt(` は名前が `parse` ではないので、もともと一致しない。プロジェクトの
//     `DomainValidation.validated(schema, x)`（Issue #262 で関数 validate からクラスの static メソッドにした）は名前が `validate` ではないので
//     一致しない（`.validate(` だけを見る）。WHY メソッド名を validated にした: `.validate(` だとこの規則に一致し、Entity からの呼び出しも違反になる。
//     WHY domain だけ: presentation はリクエストのスキーマを safeParse して項目ごとの errors にする（json-body.ts）ので、zod を直接呼ぶ。
//   - validation-error-only-in-validate（backend 全体）: `new DomainError("validation_error"`（validation_error の DomainError を
//     作れるのは backend 全体で validate.ts だけ）。`new DomainError(` と引数の間に空白・改行を挟んでも拾う。`not_found` など
//     ほかの種類は違反にしない（RequiredTodo.of のように domain のクラスが作ってよい）。
//     WHY backend 全体: application / presentation で validation_error の DomainError を作っても、同じく変換が 2 か所に分かれる。
// 対象: apps/backend の下の *.ts（テスト・node_modules と、変換を持つ apps/backend/shared/error/validate.ts 自身は除く）。
//   parse の規則は apps/backend/features/*/internal/domain/ と apps/backend/shared/error/ の下だけに当てる（rulesFor）。
//   WHY shared/error（Issue #310 より前は shared/domain）: shared/ を層から意味の単位に分けたとき、domain の部品（DomainError・
//     エラーのキー・validate）は shared/error/ に移った。ここは features の domain が import する検証とエラーの土台で、domain と同じく
//     zod を直接呼ばず validate を通す。shared のほかの単位は domain ではないので validation_error の規則だけを当てる: shared/http は
//     presentation の部品でリクエストのスキーマを safeParse する（json-body.ts・resource-id.ts）。shared/drizzle・shared/change-log・
//     shared/transaction は infra と application の部品（変更の操作の一覧 change-operation.ts は以前 shared/domain にあったが、
//     change-log の記録の部品として change-log/ に移り、zod も使わない）。
// 限界: 行ごとに `//` 以降を落としてから探し、文字列は見分けない。文字列リテラルの中の `//`（`"http://..."` の後ろ）は見逃し、
//   文字列の中の `.parse(` / `new DomainError("validation_error"` は違反と数える。ブロックコメント（`/* x.parse() */`）の中も
//   違反と数える（安全側）。JSON / Date 以外の組み込みの `.parse(`（`URL.parse(`）も違反と数える（使うときは NON_ZOD_RECEIVERS に
//   足す）。parse を変数に入れ直して呼ぶ（`const p = schema.parse; p(x)`）・分割代入（`const { parse } = schema`）・
//   `schema["parse"](x)`・`z.parse(schema, x)`、種類を変数で渡す（`new DomainError(kind, ...)`）ものは見えない。
//   zod のメソッドと同じ名前の別物（`this.validate(`・`new TextDecoder().decode(`）も違反と数える（安全側）。`schema.parse.call(…)`・
//   `globalThis.JSON.parse(`（受け手が組み込みの JSON と見分けられない）も違反と数える（安全側）。encode 系（`.encode(` /
//   `.safeEncode(` など。TextEncoder と同じ名前）は見ない。DomainError のサブクラスを作って validation_error を渡すもの
//   （`new MyError("validation_error"`）は見えない。
// zod の書き方の規則（Issue #332。.claude/rules/code/backend.md の「入力検証」の表の「domain」）。features の domain
//   （apps/backend/features/*/internal/domain/ の下）だけに当てる（shared/error は KeyedIssue・validate などの土台で、zod のスキーマを
//   宣言しない）:
//   - no-zod-length-in-domain: `.min(` / `.max(`（`.` と名前と `(` の間の空白・改行は可）。受け手が組み込みの Math（`Math.min(` /
//     `Math.max(`）は除く。行は名前の行。
//     WHY: 文字数はコードポイント数で数える（`refine` と `Array.from`）。zod 4.6.5 の文字列の `.min` / `.max` は `String#length`
//       （UTF-16 のコード単位）で数え、`"🍎".repeat(100)` を 200 文字として弾く（実測 2026-09-29）。
//     限界: 受け手の型を見ないので、数値・配列・日付の `.min(` / `.max(`（`z.number().max(10)`）も違反と数える（安全側。domain に今は
//       無い。要るようになったら例外の書き方を決める）。`.length(` / `.nonempty(`・`z.string().check(z.minLength(…))`・
//       `z.minLength(` / `z.maxLength(` は見ない。
//   - no-literal-error-in-domain-schema: `error:`（キーの引用符 `"error":` も可）の値が文字列リテラル（`"` / `'` / `` ` `` で始まる）。
//     行は `error` の行。
//     WHY: zod の `error` は任意の文字列を受け付け、キーの打ち間違い・params の渡し忘れを型で止められない。`KeyedIssue.of(key)` /
//       `KeyedIssue.refine(key, params)`（apps/backend/shared/error/keyed-issue.ts）を通してキーと params を型で縛る。
//     限界: `error:` の値が文字列リテラルかだけを見る。関数（`error: () => "x"`・`error: (issue) => …`）、変数経由
//       （`const e = "x"; { error: e }`）、zod の文字列の省略形（`z.string("x")`・`.refine(fn, "x")`）、`message: "x"`（zod 4 で
//       非推奨の別名）、`{ ...{ error: "x" } }` を変数で作って渡す書き方は見ない。値の三項演算子（`a ? error : "x"`）や
//       型の中の `{ error: "x" }` も違反と数える（誤検知。今の domain には無い）。

type RuleId =
  | "no-direct-zod-parse-in-domain"
  | "validation-error-only-in-validate"
  | "no-zod-length-in-domain"
  | "no-literal-error-in-domain-schema";

type DomainValidationViolation = { rule: RuleId; line: number };

// `.parse(` の受け手で、zod ではない組み込みの名前（JSON.parse / Date.parse）。
const NON_ZOD_RECEIVERS = new Set(["JSON", "Date"]);

// 行ごとに `//` 以降を落とす（改行は残し、位置から行番号を出せるようにする）。
// WHY: コメントの「schema.parse() を直接呼ばない」「DomainError("validation_error") を投げる」を違反と数えない。
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("//")[0] ?? "")
    .join("\n");
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

function findDomainValidationViolations(
  text: string,
): DomainValidationViolation[] {
  const code = stripLineComments(text);
  const violations: DomainValidationViolation[] = [];
  for (const call of code.matchAll(
    /\.\s*(?:safeParse|parse|safeParseAsync|parseAsync|spa|safeDecode|decode|safeDecodeAsync|decodeAsync|validate|validateAsync)\s*\(/g,
  )) {
    // WHY 受け手の識別子を `.` の直前から取る: `JSON.parse(` を除き、`schema.parse(` と `todoPropsSchema().parse(` は拾う。
    //   `(?<![\w$.])` で `foo.JSON.parse(` のような「JSON という名前のプロパティ」を組み込みの JSON と取り違えない。
    const receiver = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*$/.exec(
      code.slice(0, call.index),
    )?.[1];
    if (receiver !== undefined && NON_ZOD_RECEIVERS.has(receiver)) continue;
    violations.push({
      rule: "no-direct-zod-parse-in-domain",
      line: lineOf(code, call.index),
    });
  }
  // WHY \s で改行も許す: `new DomainError(\n  "validation_error",` と引数を改行して書く形（Biome の整形でなりうる）を拾う。
  //   報告する行は `new` の行。
  for (const call of code.matchAll(
    /\bnew\s+DomainError\s*\(\s*["'`]validation_error["'`]/g,
  )) {
    violations.push({
      rule: "validation-error-only-in-validate",
      line: lineOf(code, call.index),
    });
  }
  violations.push(...zodStyleViolations(code));
  return violations.sort((a, b) => a.line - b.line);
}

// zod の書き方（no-zod-length-in-domain・no-literal-error-in-domain-schema）の違反。code は `//` 以降を落としたもの。
function zodStyleViolations(code: string): DomainValidationViolation[] {
  const violations: DomainValidationViolation[] = [];
  for (const call of code.matchAll(/\.\s*(?:min|max)\s*\(/g)) {
    // WHY 受け手の識別子を見る（parse の規則と同じ）: 組み込みの `Math.min(` を除き、`config.Math.min(` は拾う。
    const receiver = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*$/.exec(
      code.slice(0, call.index),
    )?.[1];
    if (receiver === "Math") continue;
    violations.push({
      rule: "no-zod-length-in-domain",
      line: lineOf(code, call.index + call[0].search(/m/)),
    });
  }
  // WHY `(?<![\w$])` と引用符の任意: `errors:`・`isError:` のような別の名前を外し、`"error":` のキーの書き方は拾う。
  //   `\s` は改行も含むので、`error :` の後で改行した値も拾う（行は error の行）。
  for (const entry of code.matchAll(/(?<![\w$])["']?error["']?\s*:\s*["'`]/g)) {
    violations.push({
      rule: "no-literal-error-in-domain-schema",
      line: lineOf(code, entry.index),
    });
  }
  return violations;
}

// そのファイルに当てる規則（リポジトリ相対の / 区切りのパス）。対象外なら空。
// WHY 判定を関数に切り出す: 対象と対象外の境界（層・テスト・validate.ts・依存）と規則の範囲を架空のパスで固定し、同じ関数で列挙する。
function rulesFor(path: string): RuleId[] {
  if (!path.startsWith("apps/backend/") || path.includes("/node_modules/")) {
    return [];
  }
  // validate.ts は zod の parse と validation_error の DomainError を持つ唯一の場所なので除く。
  if (path === "apps/backend/shared/error/validate.ts") return [];
  if (!path.endsWith(".ts") || path.endsWith(".test.ts")) return [];
  if (/^apps\/backend\/features\/[^/]+\/internal\/domain\//.test(path)) {
    return [
      "no-direct-zod-parse-in-domain",
      "validation-error-only-in-validate",
      "no-zod-length-in-domain",
      "no-literal-error-in-domain-schema",
    ];
  }
  return /^apps\/backend\/shared\/error\//.test(path)
    ? ["no-direct-zod-parse-in-domain", "validation-error-only-in-validate"]
    : ["validation-error-only-in-validate"];
}

// 検査の対象（規則が 1 つ以上あるファイル）を列挙する。リポジトリ相対の / 区切りで、名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listBackendSources(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, "apps/backend"), {
      recursive: true,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return entries
    .map((path) => `apps/backend/${path.split(sep).join("/")}`)
    .filter((path) => rulesFor(path).length > 0)
    .sort();
}

// 違反を「<規則>: <パス>:<行>: <行の内容（前後の空白を除く）>」で返す。そのファイルに当てない規則（domain 以外の parse）は除く。
function collectDomainValidationViolations(root: string): string[] {
  return listBackendSources(root).flatMap((path) => {
    const text = readFileSync(join(root, path), "utf8");
    const lines = text.split("\n");
    const rules = rulesFor(path);
    return findDomainValidationViolations(text)
      .filter(({ rule }) => rules.includes(rule))
      .map(
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
  const root = mkdtempSync(join(tmpdir(), "domain-validation-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const directParse = source(
  "const result = schema.safeParse(value);",
  'throw new DomainError("validation_error", "x.invalid");',
);
// zod の書き方の規則（Issue #332）だけに違反する例。
const zodStyle = source('const a = z.string({ error: "x.invalid" }).max(9);');

const feature = await loadFeature("./domain-validation.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario(
    "domain の検証の判定（findDomainValidationViolations）: must pass",
    ({ And }) => {
      And(
        "DomainValidation.validated を通す検証と zod でない parse は違反なし（Entity の完全コンストラクタ・JSON.parse / Date.parse など）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "DomainValidation.validated を通して検証する（Entity の完全コンストラクタ）",
              source(
                'import { DomainValidation } from "../../../../shared/error/validate";',
                "const valid = DomainValidation.validated(todoPropsSchema(), props);",
                // プロジェクトの検証は `.validated(` で、zod の `.validate(` ではない（Issue #262 で関数 validate からクラスの static メソッドにした）。
                "return DomainValidation.validated(schema, value);",
              ),
            ],
            [
              "JSON.parse / Date.parse（zod ではない組み込み）",
              source(
                "const value = JSON.parse(text);",
                "const time = Date.parse(iso);",
                "const spaced = JSON . parse (text);",
              ),
            ],
            [
              "Number.parseInt / parseInt / parseFloat（名前が parse ではない）",
              source(
                "const a = Number.parseInt(x, 10);",
                "const b = parseInt(x, 10);",
                "const c = Number.parseFloat(x);",
              ),
            ],
            [
              "名前の一部が parse / validate / decode なだけの別のもの（parseTitle / .parsed / .parseLater / .validated / .decoder）",
              source(
                "const a = parseTitle(x);",
                "const b = result.parsed;",
                "const c = schema.parseLater(x);",
                "const d = result.validated;",
                "const e = codec.decoder(x);",
              ),
            ],
            [
              "not_found など validation_error 以外の DomainError",
              source(
                'throw new DomainError("not_found", "todo.notFound", { id });',
                "throw new DomainError(",
                '  "not_found",',
                '  "todo.notFound",',
                ");",
              ),
            ],
            [
              "コメントの中の parse / validation_error は数えない",
              source(
                "// schema.safeParse(x) を直接呼ばず validate を通す。",
                '// 違反は DomainError("validation_error", key) になる。',
                "const valid = DomainValidation.validated(schema(), x); // schema.parse(x) にしない",
                '// new DomainError("validation_error", "todo.title.empty")',
              ),
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findDomainValidationViolations(text),
          );

          // then
          expect(violations).toEqual(casesByName(cases, () => []));
        },
      );
    },
  );

  Scenario(
    "domain の検証の判定（findDomainValidationViolations）: must reject",
    ({ And }) => {
      And(
        "domain の zod の parse の直接の呼び出しと validate.ts の外の validation_error は、規則と行で違反になる（schema.parse(x)・safeParse / parseAsync など）",
        () => {
          // given
          const cases: [string, string, DomainValidationViolation[]][] = [
            [
              "schema.parse(x)",
              source("const valid = todoPropsSchema.parse(props);"),
              [{ rule: "no-direct-zod-parse-in-domain", line: 1 }],
            ],
            [
              "safeParse / parseAsync / safeParseAsync（各 1 件）",
              source(
                "const a = schema.safeParse(x);",
                "const b = await schema.parseAsync(x);",
                "const c = await schema.safeParseAsync(x);",
              ),
              [
                { rule: "no-direct-zod-parse-in-domain", line: 1 },
                { rule: "no-direct-zod-parse-in-domain", line: 2 },
                { rule: "no-direct-zod-parse-in-domain", line: 3 },
              ],
            ],
            [
              "zod の parse 以外の検証メソッド（spa / decode / safeDecode / decodeAsync / safeDecodeAsync / validate / validateAsync）",
              source(
                "const a = await schema.spa(x);",
                "const b = schema.decode(x);",
                "const c = schema.safeDecode(x);",
                "const d = await schema.decodeAsync(x);",
                "const e = await schema.safeDecodeAsync(x);",
                "if (schema.validate(x)) ok();",
                "const f = await schema.validateAsync(x);",
              ),
              [1, 2, 3, 4, 5, 6, 7].map((line) => ({
                rule: "no-direct-zod-parse-in-domain" as const,
                line,
              })),
            ],
            [
              "受け手が呼び出しの結果（todoPropsSchema().safeParse(x)）",
              source("const result = todoPropsSchema().safeParse(props);"),
              [{ rule: "no-direct-zod-parse-in-domain", line: 1 }],
            ],
            [
              "z.string().trim().parse(x) のような chain・改行した chain（.parse の行を報告する）",
              source(
                "const a = z.string().trim().parse(x);",
                "const b = z",
                "  .string()",
                "  .parse(x);",
              ),
              [
                { rule: "no-direct-zod-parse-in-domain", line: 1 },
                { rule: "no-direct-zod-parse-in-domain", line: 4 },
              ],
            ],
            [
              "JSON という名前のプロパティの parse（foo.JSON.parse）は組み込みの JSON ではない",
              source("const a = config.JSON.parse(x);"),
              [{ rule: "no-direct-zod-parse-in-domain", line: 1 }],
            ],
            [
              'new DomainError("validation_error", ...)',
              source(
                'throw new DomainError("validation_error", "todo.title.empty");',
              ),
              [{ rule: "validation-error-only-in-validate", line: 1 }],
            ],
            [
              'new DomainError( の後で改行して "validation_error"（new の行を報告する）',
              source(
                "if (!ok) {",
                "  throw new DomainError(",
                '    "validation_error",',
                '    "todo.title.empty",',
                "  );",
                "}",
              ),
              [{ rule: "validation-error-only-in-validate", line: 2 }],
            ],
            [
              "単引用符・テンプレートリテラルの validation_error",
              source(
                "throw new DomainError('validation_error', key);",
                "throw new DomainError(`validation_error`, key);",
              ),
              [
                { rule: "validation-error-only-in-validate", line: 1 },
                { rule: "validation-error-only-in-validate", line: 2 },
              ],
            ],
            [
              "parse と validation_error を両方持つ（validate を自前で書き直した形）",
              source(
                "const result = schema.safeParse(value);",
                "if (!result.success) {",
                '  throw new DomainError("validation_error", result.error.issues[0].message);',
                "}",
              ),
              [
                { rule: "no-direct-zod-parse-in-domain", line: 1 },
                { rule: "validation-error-only-in-validate", line: 3 },
              ],
            ],
            [
              "コード部分の後ろのコメントは落とすが、コード部分の parse は数える",
              source("const a = schema.parse(x); // WHY: validate を通さない"),
              [{ rule: "no-direct-zod-parse-in-domain", line: 1 }],
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findDomainValidationViolations(text),
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
    "domain の zod の書き方の判定（findDomainValidationViolations）: must pass",
    ({ And }) => {
      And(
        "コードポイントで数える refine と KeyedIssue を通した error は違反なし（Math.min / Math.max・名前の一部が min / max / error なだけの別のもの・コメントの中など）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "文字数を refine と Array.from で数え、error を KeyedIssue で付ける（todo.ts の形）",
              source(
                "const title = z",
                '  .string(KeyedIssue.of("todo.title.invalid"))',
                "  .trim()",
                '  .refine((v) => Array.from(v).length >= 1, KeyedIssue.of("todo.title.empty"))',
                "  .refine(",
                "    (v) => Array.from(v).length <= TODO_TITLE_MAX_LENGTH,",
                '    KeyedIssue.refine("todo.title.tooLong", { max: TODO_TITLE_MAX_LENGTH }),',
                "  );",
              ),
            ],
            [
              "error の値が KeyedIssue の結果・変数（文字列リテラルでない）",
              source(
                'const a = z.uuid({ ...KeyedIssue.of("todo.id.invalid") });',
                "const b = { error: key };",
                "const c = { error: key, params };",
              ),
            ],
            [
              "Math.min / Math.max（組み込み）",
              source(
                "const a = Math.min(x, y);",
                "const b = Math . max (x, y);",
              ),
            ],
            [
              "名前の一部が min / max / error なだけの別のもの（.minLength・.maximum・.minimum・errors:・errorKey:・isError:）",
              source(
                "const a = s.minLength;",
                "const b = s.maximum(x);",
                "const c = s.minimum;",
                'const d = { errors: "x", errorKey: "y", isError: "z" };',
              ),
            ],
            [
              "コメントの中の .min( / .max( / error: は数えない",
              source(
                "// z.string().min(1) は使わない（String#length で数える）。",
                '// { error: "todo.title.empty" } と直接書かない。',
                'const t = z.string(KeyedIssue.of("x")); // .max(100) にしない',
              ),
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findDomainValidationViolations(text),
          );

          // then
          expect(violations).toEqual(casesByName(cases, () => []));
        },
      );
    },
  );

  Scenario(
    "domain の zod の書き方の判定（findDomainValidationViolations）: must reject",
    ({ And }) => {
      And(
        "zod の min / max と error の文字列リテラルは、規則と行で違反になる（改行した chain・空白・引用符の種類・キーの引用符など）",
        () => {
          // given
          const cases: [string, string, DomainValidationViolation[]][] = [
            [
              "z.string().min(1).max(100)（同じ行の 2 件）",
              source("const title = z.string().trim().min(1).max(100);"),
              [
                { rule: "no-zod-length-in-domain", line: 1 },
                { rule: "no-zod-length-in-domain", line: 1 },
              ],
            ],
            [
              "改行した chain（名前の行を報告する）・. と名前と ( の間の空白・定数の引数",
              source(
                "const title = z",
                "  .string()",
                "  .min(1)",
                "  . max ( TODO_TITLE_MAX_LENGTH );",
              ),
              [
                { rule: "no-zod-length-in-domain", line: 3 },
                { rule: "no-zod-length-in-domain", line: 4 },
              ],
            ],
            [
              "Math という名前のプロパティの min（config.Math.min）は組み込みの Math ではない",
              source("const a = config.Math.min(x, y);"),
              [{ rule: "no-zod-length-in-domain", line: 1 }],
            ],
            [
              "error: に文字列リテラル（二重引用符・単引用符・テンプレートリテラル）",
              source(
                'const a = z.uuid({ error: "todo.id.invalid" });',
                "const b = z.string({ error: 'todo.title.invalid' });",
                "const c = z.boolean({ error: `todo.completed.invalid` });",
              ),
              [1, 2, 3].map((line) => ({
                rule: "no-literal-error-in-domain-schema" as const,
                line,
              })),
            ],
            [
              "refine の error（params 付き）・キーの引用符・error と : と値の間の空白と改行",
              source(
                '.refine((v) => ok(v), { error: "todo.title.tooLong", params: { max: 100 } })',
                '.refine((v) => ok(v), { "error": "todo.title.empty" })',
                "const c = z.date({",
                "  error :",
                '    "todo.createdAt.invalid",',
                "});",
              ),
              [
                { rule: "no-literal-error-in-domain-schema", line: 1 },
                { rule: "no-literal-error-in-domain-schema", line: 2 },
                { rule: "no-literal-error-in-domain-schema", line: 4 },
              ],
            ],
            [
              "コード部分の後ろのコメントは落とすが、コード部分の min と error は数える",
              source(
                'const a = z.string().min(1, { error: "todo.title.empty" }); // WHY: 短く書く',
              ),
              [
                { rule: "no-zod-length-in-domain", line: 1 },
                { rule: "no-literal-error-in-domain-schema", line: 1 },
              ],
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findDomainValidationViolations(text),
          );

          // then
          expect(violations).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );
    },
  );

  Scenario("ファイルごとの規則の範囲（rulesFor）", ({ And }) => {
    And(
      "features の domain のファイルにはすべての規則を当てる（features の internal/domain・サブディレクトリ・features の validate.ts）",
      () => {
        // given
        const cases: [string][] = [
          ["apps/backend/features/todo/internal/domain/todo.ts"],
          ["apps/backend/features/todo/internal/domain/todo-repository.ts"],
          ["apps/backend/features/x/internal/domain/nested/value.ts"],
          // 除くのは shared/error/validate.ts だけで、features の下の validate.ts は対象。
          ["apps/backend/features/x/internal/domain/validate.ts"],
        ];

        // when
        const rules = casesByName(cases, ([path]) => rulesFor(path));

        // then
        expect(rules).toEqual(
          casesByName(cases, () => [
            "no-direct-zod-parse-in-domain",
            "validation-error-only-in-validate",
            "no-zod-length-in-domain",
            "no-literal-error-in-domain-schema",
          ]),
        );
      },
    );

    And(
      "shared/error のファイルには parse と validation_error の規則だけを当てる（zod の書き方の規則は当てない）",
      () => {
        // given
        const cases: [string][] = [
          ["apps/backend/shared/error/keyed-issue.ts"],
          ["apps/backend/shared/error/nested/other.ts"],
        ];

        // when
        const rules = casesByName(cases, ([path]) => rulesFor(path));

        // then
        expect(rules).toEqual(
          casesByName(cases, () => [
            "no-direct-zod-parse-in-domain",
            "validation-error-only-in-validate",
          ]),
        );
      },
    );

    And(
      "domain 以外の backend のファイルには validation_error の規則だけを当てる（application・presentation・infra・internal/ を挟まない domain など）",
      () => {
        // given
        const cases: [string][] = [
          // domain 以外の層（presentation はリクエストのスキーマを safeParse してよいが、validation_error の DomainError は作らない）。
          [
            "apps/backend/features/todo/internal/application/rename-todo.command.ts",
          ],
          [
            "apps/backend/features/todo/internal/presentation/rename-todo.api.ts",
          ],
          [
            "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
          ],
          ["apps/backend/shared/http/json-body.ts"],
          ["apps/backend/shared/drizzle/drizzle.config.ts"],
          // shared の domain でない意味の単位（Issue #310）。change-operation.ts は以前 shared/domain にあった。
          ["apps/backend/shared/change-log/change-operation.ts"],
          ["apps/backend/shared/transaction/transaction.ts"],
          // features の直下でない domain・error で始まる別のディレクトリ（前方一致の境界）・Issue #310 より前の shared/domain。
          ["apps/backend/domain/x.ts"],
          ["apps/backend/shared/error-x/x.ts"],
          ["apps/backend/shared/domain/x.ts"],
          // Issue #208: feature の domain は internal/ の下だけ。internal/ を挟まない domain（Issue #208 より前の置き場所。
          //   置き場所の規則 backend-placement が違反にする）と、前方一致だけが同じ別ディレクトリ（internal-x）は domain ではない。
          ["apps/backend/features/todo/domain/todo.ts"],
          ["apps/backend/features/todo/internal-x/domain/x.ts"],
        ];

        // when
        const result = casesByName(cases, ([path]) => rulesFor(path));

        // then
        expect(result).toEqual(
          casesByName(cases, () => ["validation-error-only-in-validate"]),
        );
      },
    );

    And(
      "validate.ts・テスト・backend の外・ts でないもの・依存は対象外",
      () => {
        // given
        const cases: [string][] = [
          // validate.ts は変換を持つ唯一の場所。
          ["apps/backend/shared/error/validate.ts"],
          // テスト（zod の結果を safeParse で確かめ、期待する DomainError を作ってよい）。
          ["apps/backend/features/todo/internal/domain/todo.test.ts"],
          ["apps/backend/shared/error/validate.test.ts"],
          [
            "apps/backend/features/todo/internal/presentation/rename-todo.api.test.ts",
          ],
          // backend の外・ts でないもの・依存。
          ["apps/frontend_customer/features/todo/domain/x.ts"],
          ["apps/backend-x/features/todo/internal/domain/x.ts"],
          ["apps/backend/features/todo/internal/domain/README.md"],
          ["apps/backend/node_modules/zod/v4/classic/schemas.ts"],
        ];

        // when
        const result = casesByName(cases, ([path]) => rulesFor(path));

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );
  });

  // --- 列挙 → 読み取り → 判定を通した fixture テスト ---
  // WHY: 判定が正しくても、対象の列挙（domain の見つけ方）が漏れれば見逃す。一時ディレクトリに架空のツリーを置き、
  //   本番と同じ collectDomainValidationViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
  Scenario("domain のファイルの列挙と検査（fixture）", ({ And }) => {
    And(
      "apps/backend の .ts（テスト・依存・validate.ts を除く）を対象にし、parse の規則は domain だけに、zod の書き方の規則は features の domain だけに当て、違反を「規則: パス:行: 行の内容」で返す",
      () => {
        // given
        const root = fixture({
          "apps/backend/features/x/internal/domain/x.ts": source(
            'import { DomainValidation } from "../../../../shared/error/validate";',
            "const valid = DomainValidation.validated(xSchema(), props);",
            'throw new DomainError("not_found", "x.notFound", { id });',
          ),
          "apps/backend/features/x/internal/domain/y.ts": source(
            "const a = JSON.parse(text);",
            "const b = ySchema().parse(a);",
          ),
          // Issue #332: features の domain の zod の min / max と error の文字列リテラル。
          "apps/backend/features/x/internal/domain/z.ts": source(
            'const title = z.string({ error: "x.title.invalid" })',
            "  .min(1);",
          ),
          "apps/backend/shared/error/validate.ts": directParse,
          "apps/backend/shared/error/other.ts": directParse,
          // zod の書き方の規則は features の domain だけ（shared/error・application には当てない）。
          "apps/backend/shared/error/keyed-issue.ts": zodStyle,
          "apps/backend/features/x/internal/application/y.query.ts": zodStyle,
          // domain 以外の層: parse は可、validation_error の DomainError は違反。
          "apps/backend/features/x/internal/application/x.command.ts":
            directParse,
          "apps/backend/features/x/internal/presentation/x.api.ts": source(
            "const result = requestSchema().safeParse(body);",
          ),
          "apps/backend/shared/http/y.ts": source(
            "throw new DomainError(",
            '  "validation_error",',
            '  "x.invalid",',
            ");",
          ),
          // 対象外: テスト、frontend、依存。
          "apps/backend/features/x/internal/domain/x.test.ts": directParse,
          "apps/backend/shared/error/validate.test.ts": directParse,
          "apps/backend/features/x/internal/presentation/x.api.test.ts":
            directParse,
          "apps/frontend_customer/features/x/domain/x.ts": directParse,
          "apps/backend/node_modules/x/domain/x.ts": directParse,
        });

        // when
        const result = {
          files: listBackendSources(root),
          violations: collectDomainValidationViolations(root),
        };

        // then
        expect(result).toEqual({
          files: [
            "apps/backend/features/x/internal/application/x.command.ts",
            "apps/backend/features/x/internal/application/y.query.ts",
            "apps/backend/features/x/internal/domain/x.ts",
            "apps/backend/features/x/internal/domain/y.ts",
            "apps/backend/features/x/internal/domain/z.ts",
            "apps/backend/features/x/internal/presentation/x.api.ts",
            "apps/backend/shared/error/keyed-issue.ts",
            "apps/backend/shared/error/other.ts",
            "apps/backend/shared/http/y.ts",
          ],
          violations: [
            'validation-error-only-in-validate: apps/backend/features/x/internal/application/x.command.ts:2: throw new DomainError("validation_error", "x.invalid");',
            "no-direct-zod-parse-in-domain: apps/backend/features/x/internal/domain/y.ts:2: const b = ySchema().parse(a);",
            'no-literal-error-in-domain-schema: apps/backend/features/x/internal/domain/z.ts:1: const title = z.string({ error: "x.title.invalid" })',
            "no-zod-length-in-domain: apps/backend/features/x/internal/domain/z.ts:2: .min(1);",
            "no-direct-zod-parse-in-domain: apps/backend/shared/error/other.ts:1: const result = schema.safeParse(value);",
            'validation-error-only-in-validate: apps/backend/shared/error/other.ts:2: throw new DomainError("validation_error", "x.invalid");',
            "validation-error-only-in-validate: apps/backend/shared/http/y.ts:1: throw new DomainError(",
          ],
        });
      },
    );

    And(
      "apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const root = fixture({ "README.md": "# x\n" });

        // when
        const result = {
          files: listBackendSources(root),
          violations: collectDomainValidationViolations(root),
        };

        // then
        expect(result).toEqual({ files: [], violations: [] });
      },
    );
  });

  Scenario("domain の検証（実ファイル）", ({ And }) => {
    And(
      "domain は zod の parse を直接呼ばず、backend で validation_error の DomainError を作るのは validate.ts だけで、features の domain は zod の min / max と error の文字列リテラルを書かない",
      () => {
        // given: 実ファイル（repoRoot）
        // when
        const files = listBackendSources(repoRoot);
        const violations = collectDomainValidationViolations(repoRoot);

        // then
        // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
        //   domain（parse と validation_error）と domain 以外の層（validation_error だけ）の両方が列挙に入ることを見る。
        expect(files).toContain(
          "apps/backend/features/todo/internal/domain/todo.ts",
        );
        expect(files).toContain("apps/backend/shared/error/keyed-issue.ts");
        expect(files).toContain(
          "apps/backend/features/todo/internal/application/rename-todo.command.ts",
        );
        expect(files).toContain("apps/backend/shared/http/json-body.ts");
        expect(violations).toEqual([]);
      },
    );
  });
});
