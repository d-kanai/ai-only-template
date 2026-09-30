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
import { afterAll, describe, expect, it } from "vitest";

// 「domain の検証は validate を通す」（.claude/rules/backend.md の「入力検証」の domain の項、apps/backend/shared/domain/validate.ts、
// Issue #177）を、domain のソースで機械的に検査するテスト。
// WHY 検査する: zod の issue → DomainError の変換（最初の issue の message をキーにする・キーの無い issue は DomainError ではない
//   Error（500）にする）は validate の 1 か所に置いた。Entity ごとに safeParse して自分で DomainError を作ると、変換が Entity ごとに
//   ずれる（Issue #160）。文章の規則だけだと、zod を使い慣れた書き方（`schema.parse(x)`）が既定のように書かれる。
// 違反にするもの（規則）:
//   - no-direct-zod-parse-in-domain: `.parse(` / `.safeParse(` / `.parseAsync(` / `.safeParseAsync(` の呼び出し。
//     ただし直前の識別子が組み込みの JSON / Date のもの（`JSON.parse(` / `Date.parse(`）は zod ではないので除く
//     （NON_ZOD_RECEIVERS）。受け手が識別子でないもの（`todoPropsSchema().parse(`）も違反にする。
//     `Number.parseInt(` / `parseInt(` は名前が `parse` ではないので、もともと一致しない。
//   - validation-error-only-in-validate: `new DomainError("validation_error"`（validation_error の DomainError を作れるのは
//     validate.ts だけ）。`new DomainError(` と引数の間に空白・改行を挟んでも拾う。`not_found` などほかの種類は違反にしない
//     （requireTodo のように domain の関数が作ってよい）。
// 対象: apps/backend/features/*/domain/ と apps/backend/shared/domain/ の下の *.ts（テストと、変換を持つ validate.ts 自身は除く）。
// 限界: 行ごとに `//` 以降を落としてから探し、文字列は見分けない。文字列リテラルの中の `//`（`"http://..."` の後ろ）は見逃し、
//   文字列の中の `.parse(` / `new DomainError("validation_error"` は違反と数える。ブロックコメント（`/* x.parse() */`）の中も
//   違反と数える（安全側）。JSON / Date 以外の組み込みの `.parse(`（`URL.parse(`）も違反と数える（使うときは NON_ZOD_RECEIVERS に
//   足す）。parse を変数に入れ直して呼ぶ（`const p = schema.parse; p(x)`）・分割代入（`const { parse } = schema`）・
//   `schema["parse"](x)`・`z.parse(schema, x)`、種類を変数で渡す（`new DomainError(kind, ...)`）ものは見えない。

type RuleId =
  | "no-direct-zod-parse-in-domain"
  | "validation-error-only-in-validate";

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
    /\.\s*(?:safeParse|parse|safeParseAsync|parseAsync)\s*\(/g,
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
  return violations.sort((a, b) => a.line - b.line);
}

// 検査の対象か（リポジトリ相対の / 区切りのパス）。
// WHY 判定を関数に切り出す: 対象と対象外の境界（層・テスト・validate.ts）を架空のパスで固定し、同じ関数で列挙する。
function isDomainSource(path: string): boolean {
  // validate.ts は zod の parse と validation_error の DomainError を持つ唯一の場所なので除く。
  if (path === "apps/backend/shared/domain/validate.ts") return false;
  if (!path.endsWith(".ts") || path.endsWith(".test.ts")) return false;
  return /^apps\/backend\/(?:features\/[^/]+|shared)\/domain\//.test(path);
}

// 検査の対象を列挙する。リポジトリ相対の / 区切りで、名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listDomainFiles(root: string): string[] {
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
    .filter(isDomainSource)
    .sort();
}

// 違反を「<規則>: <パス>:<行>: <行の内容（前後の空白を除く）>」で返す。
function collectDomainValidationViolations(root: string): string[] {
  return listDomainFiles(root).flatMap((path) => {
    const text = readFileSync(join(root, path), "utf8");
    const lines = text.split("\n");
    return findDomainValidationViolations(text).map(
      ({ rule, line }) =>
        `${rule}: ${path}:${line}: ${(lines[line - 1] ?? "").trim()}`,
    );
  });
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

describe("domain の検証の判定（findDomainValidationViolations）: must pass", () => {
  it.each([
    [
      "validate を通して検証する（Entity の完全コンストラクタ）",
      source(
        'import { validate } from "../../../shared/domain/validate";',
        "const valid = validate(todoPropsSchema(), props);",
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
      "名前の一部が parse なだけの別のもの（parseTitle / .parsed / .parseLater）",
      source(
        "const a = parseTitle(x);",
        "const b = result.parsed;",
        "const c = schema.parseLater(x);",
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
        "const valid = validate(schema(), x); // schema.parse(x) にしない",
        '// new DomainError("validation_error", "todo.title.empty")',
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findDomainValidationViolations(text)).toEqual([]);
  });
});

describe("domain の検証の判定（findDomainValidationViolations）: must reject", () => {
  it.each<[string, string, DomainValidationViolation[]]>([
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
      source('throw new DomainError("validation_error", "todo.title.empty");'),
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
  ])("%s は違反", (_name, text, expected) => {
    expect(findDomainValidationViolations(text)).toEqual(expected);
  });
});

describe("検査の対象の判定（isDomainSource）", () => {
  it.each([
    "apps/backend/features/todo/domain/todo.ts",
    "apps/backend/features/todo/domain/todo-repository.ts",
    "apps/backend/features/x/domain/nested/value.ts",
    "apps/backend/shared/domain/keyed-issue.ts",
    "apps/backend/shared/domain/nested/other.ts",
  ])("%s は対象（must reject の範囲）", (path) => {
    expect(isDomainSource(path)).toBe(true);
  });

  it.each([
    // validate.ts は変換を持つ唯一の場所。
    "apps/backend/shared/domain/validate.ts",
    // テスト（zod の結果を safeParse で確かめてよい）。
    "apps/backend/features/todo/domain/todo.test.ts",
    "apps/backend/shared/domain/validate.test.ts",
    // domain 以外の層。
    "apps/backend/features/todo/application/rename-todo.command.ts",
    "apps/backend/features/todo/presentation/rename-todo.api.ts",
    "apps/backend/features/todo/infra/todo-repository.postgres.ts",
    "apps/backend/shared/presentation/json-body.ts",
    // features の直下でない domain・backend の外・ts でないもの。
    "apps/backend/domain/x.ts",
    "apps/frontend_customer/features/todo/domain/x.ts",
    "apps/backend/features/todo/domain/README.md",
    // 前方一致の境界（domain で始まる別のディレクトリ）。
    "apps/backend/shared/domain-x/x.ts",
  ])("%s は対象外", (path) => {
    expect(isDomainSource(path)).toBe(false);
  });

  it("features の下の validate.ts は対象（除くのは shared/domain/validate.ts だけ）", () => {
    expect(isDomainSource("apps/backend/features/x/domain/validate.ts")).toBe(
      true,
    );
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（domain の見つけ方）が漏れれば見逃す。一時ディレクトリに架空のツリーを置き、
//   本番と同じ collectDomainValidationViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("domain のファイルの列挙と検査（fixture）", () => {
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

  it("features/*/domain と shared/domain の *.ts（テストと validate.ts を除く）を対象にし、違反を「規則: パス:行: 行の内容」で返す", () => {
    const root = fixture({
      "apps/backend/features/x/domain/x.ts": source(
        'import { validate } from "../../../shared/domain/validate";',
        "const valid = validate(xSchema(), props);",
        'throw new DomainError("not_found", "x.notFound", { id });',
      ),
      "apps/backend/features/x/domain/y.ts": source(
        "const a = JSON.parse(text);",
        "const b = ySchema().parse(a);",
      ),
      "apps/backend/shared/domain/validate.ts": directParse,
      "apps/backend/shared/domain/other.ts": directParse,
      // 対象外: domain のテスト、domain 以外の層、frontend。
      "apps/backend/features/x/domain/x.test.ts": directParse,
      "apps/backend/shared/domain/validate.test.ts": directParse,
      "apps/backend/features/x/application/x.command.ts": directParse,
      "apps/backend/features/x/presentation/x.api.ts": directParse,
      "apps/frontend_customer/features/x/domain/x.ts": directParse,
    });
    expect({
      files: listDomainFiles(root),
      violations: collectDomainValidationViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/x/domain/x.ts",
        "apps/backend/features/x/domain/y.ts",
        "apps/backend/shared/domain/other.ts",
      ],
      violations: [
        "no-direct-zod-parse-in-domain: apps/backend/features/x/domain/y.ts:2: const b = ySchema().parse(a);",
        "no-direct-zod-parse-in-domain: apps/backend/shared/domain/other.ts:1: const result = schema.safeParse(value);",
        'validation-error-only-in-validate: apps/backend/shared/domain/other.ts:2: throw new DomainError("validation_error", "x.invalid");',
      ],
    });
  });

  it("apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listDomainFiles(root),
      violations: collectDomainValidationViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("domain の検証（実ファイル）", () => {
  it("domain は zod の parse を直接呼ばず、validation_error の DomainError を作らない（validate.ts を通す）", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    const files = listDomainFiles(repoRoot);
    expect(files).toContain("apps/backend/features/todo/domain/todo.ts");
    expect(files).toContain("apps/backend/shared/domain/keyed-issue.ts");
    expect(collectDomainValidationViolations(repoRoot)).toEqual([]);
  });
});
