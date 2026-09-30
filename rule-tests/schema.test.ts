// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはスキーマのソースを文字列として読むだけで DOM を使わないため、
//   node 環境で動かす。
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
import { describe, expect, it } from "vitest";

// DB の列の型の既定（.claude/rules/backend.md の「列の型」。決定は ADR docs/adr/quality/20260930-db-column-types-default-text-and-integer.md）を、
// Drizzle のスキーマ（apps/backend/**/infra/schema.ts）で機械的に検査するテスト。
// WHY 検査する: 「文字列は text、長さは domain が持つ」は文章だけだと、varchar(255) を書き慣れた人や AI が既定のように書き、
//   domain（zod）と DB の 2 か所に上限ができてずれる。DB の制約違反は 500 になり、domain の 400（errors[] 付き）に負ける。
// 違反にするもの（規則 → 例外を認める WHY の見出し）:
//   - varchar: `varchar(`（長さ付きでも無しでも）→ `// WHY 長さ:`
//   - char: `char(`（固定長）→ `// WHY 長さ:`
//   - timestamp-without-timezone: `timestamp(` で引数に `withTimezone: true` が無い → `// WHY タイムゾーン:`
//   - serial: `serial(` / `bigserial(` / `smallserial(`（id は uuid）→ `// WHY 連番:`
//   - json: `json(`（jsonb でない）→ `// WHY json:`
// 例外の書き方: 違反の呼び出しがある行の直前に続く `//` のコメント行（空行を挟まない）のどれかが「// WHY <見出し>: <理由>」なら通す。
//   理由が空・見出しが違う・空行を挟む・同じ行の末尾・ブロックコメントは認めない。
// WHY 見出しを規則ごとに分ける: 別の理由（例: タイムゾーン）の WHY で varchar が黙って通らないようにする。
// WHY 文字列で判定する（AST にしない）: 対象は Drizzle の pg-core の呼び出しだけで、コメントと文字列を空白に潰せば
//   「名前 + `(`」で呼び出しを取れる。architecture.test.ts の TypeScript の AST API は、この検査には重い。
// 限界: pg-core の関数を変数に入れ直して呼ぶ（`const v = varchar; v("x")`）、options を変数や spread で渡す
//   （`timestamp("x", tz)`）と見えない（後者は withTimezone が見えないので違反になる = 安全側）。import の別名（`varchar as v`）と
//   名前空間（`pg.varchar`）は拾う。

type RuleId =
  | "varchar"
  | "char"
  | "timestamp-without-timezone"
  | "serial"
  | "json";

type ColumnTypeViolation = { rule: RuleId; line: number };

// pg-core の関数名 → 違反の規則。timestamp は引数を見て決めるので別に扱う。
const FORBIDDEN_BUILDERS: Record<string, RuleId> = {
  varchar: "varchar",
  char: "char",
  serial: "serial",
  bigserial: "serial",
  smallserial: "serial",
  json: "json",
};

// 例外を認める WHY の見出し（`// WHY <見出し>: <理由>`）。
const WHY_LABEL: Record<RuleId, string> = {
  varchar: "長さ",
  char: "長さ",
  "timestamp-without-timezone": "タイムゾーン",
  serial: "連番",
  json: "json",
};

// コメントと文字列（'...' "..." `...`）の中身を空白に置き換える（改行は残し、位置と行番号を変えない）。
// WHY: コメントの「varchar(100) にしない」や列名の文字列を呼び出しと取り違えない。timestamp の引数の中の
//   `// withTimezone: true` を有効な指定と数えない。
// 限界: テンプレートリテラルの `${...}` の中も文字列として潰す（スキーマで pg-core を ${} の中で呼ぶ書き方は無い想定）。
function maskCommentsAndStrings(text: string): string {
  let masked = "";
  let index = 0;
  const blank = (chunk: string) => chunk.replace(/[^\n]/g, " ");
  while (index < text.length) {
    const rest = text.slice(index);
    const comment = /^(\/\/[^\n]*|\/\*[\s\S]*?(\*\/|$))/.exec(rest);
    const quoted = /^(["'`])(\\[\s\S]|(?!\1)[^\\])*(\1|$)/.exec(rest);
    const skipped = comment?.[0] ?? quoted?.[0];
    if (skipped) {
      masked += blank(skipped);
      index += skipped.length;
    } else {
      masked += text[index];
      index += 1;
    }
  }
  return masked;
}

// `import { a, b as c } from "drizzle-orm/pg-core"` の別名 → 元の名前。
// WHY: `varchar as vc` と別名で import して `vc(...)` と呼ぶと、名前だけでは見逃す。
function pgCoreAliases(text: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const imports = text.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']drizzle-orm\/pg-core["']/g,
  );
  for (const [, specifiers = ""] of imports) {
    for (const specifier of specifiers.split(",")) {
      const [imported, local] = specifier.trim().split(/\s+as\s+/);
      if (imported && local) aliases.set(local.trim(), imported.trim());
    }
  }
  return aliases;
}

// masked[open] の "(" に対応する ")" までの中身（閉じが無ければ末尾まで）。
function argumentsOf(masked: string, open: number): string {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "(") depth += 1;
    if (masked[index] === ")") depth -= 1;
    if (depth === 0) return masked.slice(open + 1, index);
  }
  return masked.slice(open + 1);
}

// 違反の行（0 始まり）の直前に続く `//` の行に「// WHY <見出し>: <理由>」があるか。
function hasWhyAbove(
  lines: string[],
  lineIndex: number,
  label: string,
): boolean {
  const why = new RegExp(`^//\\s*WHY ${label}:\\s*\\S`);
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed.startsWith("//")) return false;
    if (why.test(trimmed)) return true;
  }
  return false;
}

function findColumnTypeViolations(text: string): ColumnTypeViolation[] {
  const masked = maskCommentsAndStrings(text);
  const aliases = pgCoreAliases(text);
  const lines = text.split("\n");
  const violations: ColumnTypeViolation[] = [];
  // WHY 名前の途中から一致しない: 正規表現は左から最初に一致する位置で名前を最長に取るので、`myVarchar(` は `varchar` にならない。
  for (const call of masked.matchAll(/(\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [whole, member, name = ""] = call;
    const open = call.index + whole.length - 1;
    // `pg.varchar(` は名前のまま、`vc(` は import の別名を元の名前に戻す。
    const builder = member ? name : (aliases.get(name) ?? name);
    const rule =
      builder === "timestamp"
        ? /\bwithTimezone\s*:\s*true\b/.test(argumentsOf(masked, open))
          ? undefined
          : "timestamp-without-timezone"
        : FORBIDDEN_BUILDERS[builder];
    if (rule === undefined) continue;
    const lineIndex = masked.slice(0, call.index).split("\n").length - 1;
    if (hasWhyAbove(lines, lineIndex, WHY_LABEL[rule])) continue;
    violations.push({ rule, line: lineIndex + 1 });
  }
  return violations;
}

// 検査の対象: apps/backend の下の infra/schema.ts（node_modules は除く）。リポジトリ相対の / 区切りで、名前順。
// WHY features と shared の両方: drizzle-kit の設定（apps/backend/shared/drizzle/drizzle.config.ts）が読むのは
//   features/*/infra/schema.ts だけだが、shared/infra に置いたスキーマも同じ既定に従わせる（置いた時点で止める）。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listSchemaFiles(root: string): string[] {
  const backend = join(root, "apps/backend");
  let entries: string[];
  try {
    entries = readdirSync(backend, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return entries
    .map((path) => `apps/backend/${path.split(sep).join("/")}`)
    .filter(
      (path) =>
        /\/infra\/schema\.ts$/.test(path) && !path.includes("/node_modules/"),
    )
    .sort();
}

// 違反を「<規則>: <パス>:<行>」で返す。
function collectSchemaViolations(root: string): string[] {
  return listSchemaFiles(root).flatMap((path) =>
    findColumnTypeViolations(readFileSync(join(root, path), "utf8")).map(
      ({ rule, line }) => `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");
const IMPORT = 'import * as pg from "drizzle-orm/pg-core";';

describe("列の型の判定（findColumnTypeViolations）: must pass", () => {
  it.each([
    [
      "既定の型（uuid / text / integer / bigint / numeric / boolean / timestamptz / jsonb）",
      source(
        'import { bigint, boolean, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";',
        'export const t = pgTable("t", {',
        '  id: uuid("id").primaryKey(),',
        '  title: text("title").notNull(),',
        '  count: integer("count").notNull(),',
        '  total: bigint("total", { mode: "number" }),',
        '  price: numeric("price", { precision: 12, scale: 2 }),',
        '  done: boolean("done").notNull().default(false),',
        '  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),',
        '  data: jsonb("data"),',
        "});",
      ),
    ],
    [
      "timestamp の options が複数行で、withTimezone: true が後ろにある",
      source(
        IMPORT,
        "const c = {",
        '  at: pg.timestamp("at", {',
        '    mode: "date",',
        "    withTimezone: true,",
        "  }),",
        "};",
      ),
    ],
    [
      "コメントの中の varchar( / json( / serial( は呼び出しではない",
      source(
        "// varchar(100) にしない。json( ではなく jsonb、serial( ではなく uuid。",
        '/* char(3) も timestamp("x") も書かない */',
        'const c = { title: text("title") };',
      ),
    ],
    [
      "文字列の中の varchar( は呼び出しではない（列名など）",
      source('const c = { title: text("varchar(1)"), note: text(`json(`) };'),
    ],
    [
      "名前の一部が一致するだけの別の関数（jsonb / toJson / myVarchar / charCode / timestampz）",
      source(
        'const c = { a: jsonb("a"), b: toJson("b"), c: myVarchar("c"), d: charCode("d"), e: timestampz("e") };',
      ),
    ],
    [
      "import しただけで呼んでいない",
      source(
        'import { json, serial, varchar } from "drizzle-orm/pg-core";',
        'const c = { title: text("title") };',
      ),
    ],
    [
      "varchar の直前の行に // WHY 長さ: がある",
      source(
        IMPORT,
        "const c = {",
        "  // WHY 長さ: 外部の決済サービスの取引コードは 20 文字固定で、DB でも保証する。",
        '  code: pg.varchar("code", { length: 20 }),',
        "};",
      ),
    ],
    [
      "複数行の WHY のコメントの 1 行目に // WHY 長さ: がある（続きの行を挟む）",
      source(
        IMPORT,
        "const c = {",
        "  // WHY 長さ: 国コード（ISO 3166-1 alpha-2）は 2 文字固定。",
        "  //   domain でも検証するが、他システムが直接書き込むので DB でも保証する。",
        '  country: pg.char("country", { length: 2 }),',
        "};",
      ),
    ],
    [
      "timestamp（timezone 無し）の直前の行に // WHY タイムゾーン: がある",
      source(
        IMPORT,
        "const c = {",
        "  // WHY タイムゾーン: 外部の CSV の現地時刻をそのまま保持する。",
        '  localAt: pg.timestamp("local_at"),',
        "};",
      ),
    ],
    [
      "serial の直前の行に // WHY 連番: がある",
      source(
        IMPORT,
        "const c = {",
        "  // WHY 連番: 外部に見せる請求書番号で、欠番の少ない連番が要る。",
        '  invoiceNo: pg.bigserial("invoice_no", { mode: "number" }),',
        "};",
      ),
    ],
    [
      "json の直前の行に // WHY json: がある",
      source(
        IMPORT,
        "const c = {",
        "  // WHY json: 受け取った本文をキーの順序も含めてそのまま残す。",
        '  raw: pg.json("raw"),',
        "};",
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findColumnTypeViolations(text)).toEqual([]);
  });
});

describe("列の型の判定（findColumnTypeViolations）: must reject", () => {
  it.each<[string, string, ColumnTypeViolation[]]>([
    [
      "varchar（長さ付き）",
      source(
        IMPORT,
        'const c = { title: pg.varchar("title", { length: 100 }) };',
      ),
      [{ rule: "varchar", line: 2 }],
    ],
    [
      "varchar（長さ無し）を名前で import して呼ぶ",
      source(
        'import { varchar } from "drizzle-orm/pg-core";',
        'const c = { title: varchar("title") };',
      ),
      [{ rule: "varchar", line: 2 }],
    ],
    [
      "import の別名で varchar を呼ぶ",
      source(
        'import { text, varchar as vc } from "drizzle-orm/pg-core";',
        'const c = { title: vc("title", { length: 255 }) };',
      ),
      [{ rule: "varchar", line: 2 }],
    ],
    [
      "char（固定長）",
      source(IMPORT, 'const c = { code: pg.char("code", { length: 3 }) };'),
      [{ rule: "char", line: 2 }],
    ],
    [
      "timestamp（options 無し）",
      source(IMPORT, 'const c = { at: pg.timestamp("at") };'),
      [{ rule: "timestamp-without-timezone", line: 2 }],
    ],
    [
      "timestamp（withTimezone が無い options）",
      source(IMPORT, 'const c = { at: pg.timestamp("at", { mode: "date" }) };'),
      [{ rule: "timestamp-without-timezone", line: 2 }],
    ],
    [
      "timestamp（withTimezone: false）",
      source(
        IMPORT,
        'const c = { at: pg.timestamp("at", { withTimezone: false }) };',
      ),
      [{ rule: "timestamp-without-timezone", line: 2 }],
    ],
    [
      "timestamp の options の withTimezone: true がコメントアウトされている",
      source(
        IMPORT,
        "const c = {",
        '  at: pg.timestamp("at", {',
        "    // withTimezone: true,",
        '    mode: "date",',
        "  }),",
        "};",
      ),
      [{ rule: "timestamp-without-timezone", line: 3 }],
    ],
    [
      "同じ行の 2 つの timestamp のうち、1 つ目だけ timezone 無し（2 つ目の withTimezone を借りない）",
      source(
        IMPORT,
        'const c = { a: pg.timestamp("a"), b: pg.timestamp("b", { withTimezone: true }) };',
      ),
      [{ rule: "timestamp-without-timezone", line: 2 }],
    ],
    [
      "serial / bigserial / smallserial",
      source(
        'import { bigserial, serial, smallserial } from "drizzle-orm/pg-core";',
        "const c = {",
        '  a: serial("a"),',
        '  b: bigserial("b", { mode: "number" }),',
        '  c: smallserial("c"),',
        "};",
      ),
      [
        { rule: "serial", line: 3 },
        { rule: "serial", line: 4 },
        { rule: "serial", line: 5 },
      ],
    ],
    [
      "json（jsonb でない）",
      source(IMPORT, 'const c = { data: pg.json("data") };'),
      [{ rule: "json", line: 2 }],
    ],
    [
      "WHY の見出しが別の規則（タイムゾーン）",
      source(
        IMPORT,
        "const c = {",
        "  // WHY タイムゾーン: 現地時刻を保持する。",
        '  code: pg.varchar("code", { length: 20 }),',
        "};",
      ),
      [{ rule: "varchar", line: 4 }],
    ],
    [
      "WHY 長さ: の理由が空",
      source(
        IMPORT,
        "const c = {",
        "  // WHY 長さ:",
        '  code: pg.varchar("code", { length: 20 }),',
        "};",
      ),
      [{ rule: "varchar", line: 4 }],
    ],
    [
      "WHY のコメントと列の間に空行がある",
      source(
        IMPORT,
        "const c = {",
        "  // WHY 長さ: 取引コードは 20 文字固定。",
        "",
        '  code: pg.varchar("code", { length: 20 }),',
        "};",
      ),
      [{ rule: "varchar", line: 5 }],
    ],
    [
      "WHY が同じ行の末尾にある（直前の行に書く）",
      source(
        IMPORT,
        'const c = { code: pg.varchar("code", { length: 20 }) }; // WHY 長さ: 取引コードは 20 文字固定。',
      ),
      [{ rule: "varchar", line: 2 }],
    ],
    [
      "WHY がブロックコメント",
      source(
        IMPORT,
        "const c = {",
        "  /* WHY 長さ: 取引コードは 20 文字固定。 */",
        '  code: pg.varchar("code", { length: 20 }),',
        "};",
      ),
      [{ rule: "varchar", line: 4 }],
    ],
    [
      "WHY の見出しの無いコメント",
      source(
        IMPORT,
        "const c = {",
        "  // 長さ: 取引コードは 20 文字固定。",
        '  code: pg.varchar("code", { length: 20 }),',
        "};",
      ),
      [{ rule: "varchar", line: 4 }],
    ],
    [
      "WHY は 1 つ目の列だけに効き、次の列の varchar には効かない",
      source(
        IMPORT,
        "const c = {",
        "  // WHY 長さ: 取引コードは 20 文字固定。",
        '  code: pg.varchar("code", { length: 20 }),',
        '  name: pg.varchar("name", { length: 255 }),',
        "};",
      ),
      [{ rule: "varchar", line: 5 }],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findColumnTypeViolations(text)).toEqual(expected);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（infra/schema.ts の見つけ方）が漏れれば見逃す。一時ディレクトリに架空のツリーを置き、
//   本番と同じ collectSchemaViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
function violationsOfFixture(files: Record<string, string>): {
  files: string[];
  violations: string[];
} {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。落ちても finally で消す。
  const root = mkdtempSync(join(tmpdir(), "schema-test-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return {
      files: listSchemaFiles(root),
      violations: collectSchemaViolations(root),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("スキーマの列挙と検査（fixture）", () => {
  const varcharColumn = source(
    IMPORT,
    'export const t = pg.pgTable("t", { title: pg.varchar("title") });',
  );

  it("apps/backend の features と shared の infra/schema.ts だけを対象にし、違反を「規則: パス:行」で返す", () => {
    const result = violationsOfFixture({
      "apps/backend/features/a/infra/schema.ts": source(
        IMPORT,
        'export const a = pg.pgTable("a", {',
        '  title: pg.varchar("title", { length: 100 }),',
        '  at: pg.timestamp("at"),',
        "});",
      ),
      "apps/backend/features/b/infra/schema.ts": source(
        IMPORT,
        'export const b = pg.pgTable("b", { id: pg.uuid("id").primaryKey() });',
      ),
      "apps/backend/shared/infra/schema.ts": source(
        IMPORT,
        'export const s = pg.pgTable("s", { raw: pg.json("raw") });',
      ),
      // 対象外: infra/schema.ts でないファイル、infra 以外の schema.ts、テスト、node_modules、apps/backend の外。
      "apps/backend/features/c/infra/other.ts": varcharColumn,
      "apps/backend/features/c/domain/schema.ts": varcharColumn,
      "apps/backend/features/c/infra/schema.test.ts": varcharColumn,
      "apps/backend/node_modules/x/infra/schema.ts": varcharColumn,
      "apps/frontend_customer/features/x/infra/schema.ts": varcharColumn,
    });
    expect(result).toEqual({
      files: [
        "apps/backend/features/a/infra/schema.ts",
        "apps/backend/features/b/infra/schema.ts",
        "apps/backend/shared/infra/schema.ts",
      ],
      violations: [
        "varchar: apps/backend/features/a/infra/schema.ts:3",
        "timestamp-without-timezone: apps/backend/features/a/infra/schema.ts:4",
        "json: apps/backend/shared/infra/schema.ts:2",
      ],
    });
  });

  it("apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    expect(violationsOfFixture({ "README.md": "# x\n" })).toEqual({
      files: [],
      violations: [],
    });
  });
});

describe("DB の列の型（実ファイル）", () => {
  it("apps/backend の infra/schema.ts はすべて列の型の既定に従う", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listSchemaFiles(repoRoot)).toContain(
      "apps/backend/features/todo/infra/schema.ts",
    );
    expect(collectSchemaViolations(repoRoot)).toEqual([]);
  });
});
