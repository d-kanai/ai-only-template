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
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { casesByName } from "./case-table";

// DB の列の型の既定（.claude/rules/code/backend.md の「列の型」。決定は ADR docs/adr/quality/20260930-db-column-types-default-text-and-integer.md、
// Issue #145）を、Drizzle のスキーマ（apps/backend/**/infra/schema.ts と apps/backend/shared/ の下の *.schema.ts）で機械的に検査するテスト。
// WHY 検査する: 「文字列は text、長さは domain が持つ」は文章だけだと、varchar(255) を書き慣れた人や AI が既定のように書き、
//   domain（zod）と DB の 2 か所に上限ができてずれる。DB の制約違反は 500 になり、domain の 400（errors[] 付き）に負ける。
// 列の型で違反にするもの（規則 → 例外を認める WHY の見出し）:
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
//   名前空間（`pg.varchar`）は拾う。import に無い名前（別モジュールの再公開など）の `varchar(` も名前で違反にする（安全側）。
//
// サロゲートキー（Issue #213）: 規則 surrogate-key。`pgTable(` ごとに、第 2 引数（列の定義のオブジェクト）の直下に
//   `id: uuid("id").primaryKey()` が無ければ違反（違反の行は `pgTable(` の行）。`uuid("id")` の後ろのチェーンは許可の一覧
//   （ALLOWED_ID_CHAIN: notNull / primaryKey / defaultRandom / default / $defaultFn / $default / unique）のメソッドの呼び出しに限り、
//   `.primaryKey()` を必須にする（`.array()`・`.$type<T>()`・`.references()` などが 1 つでもあれば違反。Issue #233）。
//   uuid は "drizzle-orm/pg-core" からの import（名前・別名 `uuid as u`・名前空間 `import * as pg` の `pg.uuid(`）で
//   pg-core の uuid と言えるものだけを認める（ローカルの `const uuid = text`・別モジュールの `uuid`・`text as uuid`・
//   別の名前空間の `other.uuid(` は違反。Issue #233）。pgTable は列の型と同じく、import に無い名前でも表として見る（安全側）。
//   複合主キー（第 3 引数の `primaryKey({ columns: [...] })`）だけの表、id が uuid でない（`serial` / `text`）表、
//   id が uuid でも `.primaryKey()` の無い表、DB の列名が "id" でない表も違反。
// WHY すべての表（子表・履歴表も）に uuid の id の主キー: どの表の 1 行も id で指せ、変更の記録（change_logs の row_id は uuid）・
//   削除・参照が表によらず一様になる。自然キー・複合キー（例: todo_status_changes の (todo_id, position)）は一意制約（`unique` /
//   `uniqueIndex`）で表す。
// WHY 例外（`// WHY <見出し>:`）を認めない: 主キーの形を表ごとに変える理由は一意制約で足り、例外を作るとそこだけ一様でなくなる。
// 限界（字句の推定）: 第 2 引数が変数・スプレッド（`{ ...base }`）・関数（`(t) => ({ ... })`）だと中を見ず、id を直接書いていなければ
//   違反にする（安全側）。キーを引用符で書く（`"id":`）・uuid の引数にコメントを挟むと見分けられず違反になる。
//   `pgTableCreator` で作った関数や `pgSchema(...).table(` は `pgTable(` でないので見ない。
//   型引数の中のカンマ（`$type<Record<string, X>>()`）は要素の区切りと取り違える（ほかの列なら影響しない。id の列の `$type` は
//   許可の一覧に無いので、どのみち違反）。import した uuid を関数の引数などで同じ名前に隠す（shadowing）と見分けられず通る。
//   列名を省いた `id: uuid().primaryKey()`（Drizzle はキー名を列名に使える）も違反にする（`uuid("id")` と書く。reviewer の probe）。
//
// 列の分類表（Issue #216）: 規則 column-classification。`pgTable(` ごとに、表を受ける変数（`const <名前> = pgTable(`）の名前に
//   Columns を付けた分類表 `export const <名前>Columns = ColumnClassifier.classify(<名前>, { ... })` が同じファイルに無ければ違反（違反の行は
//   `pgTable(` の行）。ColumnClassifier は `column-classification`（apps/backend/shared/drizzle/column-classification.ts）からの
//   名前の import（値。`import type`・inline の `type`・別名 `x as ColumnClassifier`・ほかのモジュールは不可）に限り、呼ぶのは
//   その static メソッド classify（`ColumnClassifier.maskRow(` など別のメソッドは不可）。
//   Issue #262 で関数 classifyColumns をクラス ColumnClassifier の static メソッドにした（ADR docs/adr/architecture/20261002-class-based-backend.md）。
//   表を変数で受けない `pgTable(`（`export default pgTable(`）も違反。例外（`// WHY <見出し>:`）は認めない。
// WHY すべての表に分類表: 書き込みのログ（shared/drizzle/writer.ts の db_write）は changes の before / after に行の値を出し、分類が
//   sensitive の列と分類の無い列を *** にする。分類が無い表は全列 ***（fail closed）で漏れはしないが、ログで追えない表が黙って
//   増える。表を足した時点で、どの列が個人情報かを決めさせる（列の網羅は ColumnClassifier.classify の引数の型が tsc で強制する）。
// WHY 名前を `<表の変数>Columns` に固定し、ColumnClassifier.classify の第 1 引数も見る: 分類表と表の組を字句で決めるため。別の表を渡した
//   分類表（`todosColumns = ColumnClassifier.classify(others, …)`）は、todos の分類が無いのと同じ。
// WHY export を求める: 分類表は schema.ts の外（テスト・調査）から表と並べて読めるようにする。export の無い const は使われない
//   値として Biome（noUnusedVariables）に消されうる。
// 限界（字句の推定）: ColumnClassifier.classify を別の関数で包む・変数に入れ直す・分類のオブジェクトを変数で渡す書き方は見分けず、形が
//   合えば通る（中身の網羅は型が見る）。別名 `import { ColumnClassifier as C }` で `C.classify(` と呼ぶと違反になる（安全側）。
//   ColumnClassifier を同じ名前で shadowing（引数・ローカルのクラス）しても見分けない。

// 列の型の規則（WHY の見出しで例外を認める）。
type ColumnTypeRuleId =
  | "varchar"
  | "char"
  | "timestamp-without-timezone"
  | "serial"
  | "json";

// surrogate-key は例外を認めないので、WHY_LABEL を持つ ColumnTypeRuleId と分ける。
type RuleId = ColumnTypeRuleId | "surrogate-key" | "column-classification";

type ColumnTypeViolation = { rule: RuleId; line: number };

// pg-core の関数名 → 違反の規則。timestamp は引数を見て決めるので別に扱う。
const FORBIDDEN_BUILDERS: Record<string, ColumnTypeRuleId> = {
  varchar: "varchar",
  char: "char",
  serial: "serial",
  bigserial: "serial",
  smallserial: "serial",
  json: "json",
};

// 例外を認める WHY の見出し（`// WHY <見出し>: <理由>`）。
const WHY_LABEL: Record<ColumnTypeRuleId, string> = {
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

const IDENTIFIER = "[A-Za-z_$][\\w$]*";

// "drizzle-orm/pg-core" から値として import した名前。named: ローカルの名前 → pg-core の元の名前（`uuid` → `uuid`、
// `uuid as u` → `u` → `uuid`）。namespaces: `import * as pg` の `pg`。
// WHY: `varchar as vc` と別名で import して `vc(...)` と呼ぶと、名前だけでは見逃す。逆に、名前が `uuid` でも import に無い
//   （ローカルの `const uuid = text`・別モジュールの `uuid`・`text as uuid`）なら pg-core の uuid ではない（Issue #233）。
// WHY `import type` と inline の `type` を除く: 型だけの import は値として呼べず、pg-core の関数を呼んでいる証拠にならない。
type PgCoreImports = { named: Map<string, string>; namespaces: Set<string> };

function pgCoreImports(text: string): PgCoreImports {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  const from = `\\s*from\\s*["']drizzle-orm/pg-core["']`;
  for (const [, specifiers = ""] of text.matchAll(
    new RegExp(`import\\s*\\{([^}]*)\\}${from}`, "g"),
  )) {
    for (const specifier of specifiers.split(",")) {
      const [imported = "", local = imported] = specifier
        .trim()
        .split(/\s+as\s+/);
      if (imported === "" || /^type\s/.test(imported)) continue;
      named.set(local.trim(), imported.trim());
    }
  }
  for (const [, namespace = ""] of text.matchAll(
    new RegExp(`import\\s*\\*\\s*as\\s+(${IDENTIFIER})${from}`, "g"),
  )) {
    namespaces.add(namespace);
  }
  return { named, namespaces };
}

// 呼び出し（masked の中）の正規表現の本体。1: 名前空間などの対象の名前、2: `.`（メンバーの呼び出し）、3: 関数名。
// WHY 対象の名前の直前に `.` や識別子が無いことを見る: `x.pg.uuid(` の `pg` を名前空間と取り違えない（`.uuid(` は
//   対象の名前の無いメンバーの呼び出しとして読む）。
// WHY 名前の途中から一致しない: 正規表現は左から最初に一致する位置で名前を最長に取るので、`myVarchar(` は `varchar` にならない。
const CALL = `(?:(?:(?<![\\w$]|\\.\\s*)(${IDENTIFIER})\\s*)?(\\.)\\s*)?(${IDENTIFIER})\\s*\\(`;

// 呼び出しが pg-core のどの関数か（pg-core の関数と言えなければ undefined）。列の型・pgTable・uuid で同じこの関数を使う。
// - `u(`: named import のローカルの名前なら元の名前（import に無い名前は undefined）。
// - `pg.uuid(`: `pg` が `import * as pg` の名前なら `uuid`（別の名前空間・`).uuid(` などは undefined）。
// 使う側の WHY（安全側の向きが規則で違う）:
//   - 列の型・pgTable は `?? 呼び出しの名前` で、import に無い名前（別モジュールの再公開など）も名前で検査する。
//     undefined を「対象外」にすると、見逃し（違反なし）の方向に倒れる。
//   - surrogate-key の uuid は undefined を「uuid でない」= 違反にする。名前だけで認めると、ローカルの `const uuid = text` も通る。
function pgCoreBuilder(
  object: string | undefined,
  isMember: boolean,
  name: string,
  imports: PgCoreImports,
): string | undefined {
  if (!isMember) return imports.named.get(name);
  return object !== undefined && imports.namespaces.has(object)
    ? name
    : undefined;
}

// masked の pg-core らしい呼び出しの一覧。index は関数名の位置（行番号に使う）、open は `(` の位置、
// builder は pgCoreBuilder の結果、name は呼び出しの名前。
function builderCalls(
  masked: string,
  imports: PgCoreImports,
): { index: number; open: number; name: string; builder?: string }[] {
  return [...masked.matchAll(new RegExp(CALL, "gd"))].map((call) => {
    const [whole, object, member, name = ""] = call;
    return {
      index: call.indices?.[3]?.[0] ?? call.index,
      open: call.index + whole.length - 1,
      name,
      builder: pgCoreBuilder(object, member !== undefined, name, imports),
    };
  });
}

// masked[open] の括弧（`(` / `{` / `[`）に対応する閉じ括弧の位置（閉じが無ければ末尾 = masked.length）。
// WHY 3 種を同じ深さで数える: 列の定義 `{ ... }` の中の `(` `[` と、引数の中の `{` を同じ規則で読み飛ばす。
function closingIndex(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if ("([{".includes(masked[index] ?? "")) depth += 1;
    if (")]}".includes(masked[index] ?? "")) depth -= 1;
    if (depth === 0) return index;
  }
  return masked.length;
}

// masked[open] の "(" に対応する ")" までの中身（閉じが無ければ末尾まで）。
function argumentsOf(masked: string, open: number): string {
  return masked.slice(open + 1, closingIndex(masked, open));
}

// masked の [start, end) を、括弧の外（深さ 0）のカンマで区切った範囲の一覧（引数・オブジェクトの要素）。
// 限界: `<` `>` は数えないので、型引数の中のカンマ（`$type<Record<string, X>>()`）でも区切る。
function splitTopLevel(
  masked: string,
  start: number,
  end: number,
): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let partStart = start;
  for (let index = start; index < end; index += 1) {
    const char = masked[index] ?? "";
    if ("([{".includes(char)) {
      index = closingIndex(masked, index);
    } else if (char === ",") {
      parts.push({ start: partStart, end: index });
      partStart = index + 1;
    }
  }
  parts.push({ start: partStart, end });
  return parts;
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
  const lines = text.split("\n");
  const violations: ColumnTypeViolation[] = [];
  for (const call of builderCalls(masked, pgCoreImports(text))) {
    const { open } = call;
    // WHY `?? call.name`: import に無い `varchar(` も名前で違反にする（安全側。pgCoreBuilder のコメント）。
    const builder = call.builder ?? call.name;
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

// id の列（`uuid("id")` の後ろ）のチェーンに書いてよいメソッド。これ以外が 1 つでもあれば違反（fail closed。Issue #233）。
// WHY 許可の一覧にする（禁止の一覧にしない）: `.array()` は列を `uuid[]` に、`.$type<T>()` は TypeScript の型を uuid の文字列
//   以外に、`.references()` は主キーを別の表への参照に、`.generatedAlwaysAs()` は生成列に変える。どれも「uuid の id の主キー」
//   でなくなるが、Drizzle のメソッドは版ごとに増えるので、禁止の一覧では新しいメソッドを黙って通す。
// WHY この 7 つ: 主キー（primaryKey）・NOT NULL（notNull。主キーなら冗長だが害は無い）・一意（unique。同じく冗長）と、
//   既定値（defaultRandom / default / $defaultFn / $default。値の作り方を決めるだけで列の型と主キーを変えない）。
const ALLOWED_ID_CHAIN = new Set([
  "notNull",
  "primaryKey",
  "defaultRandom",
  "default",
  "$defaultFn",
  "$default",
  "unique",
]);

// 列の定義の 1 要素（masked の [start, end)）が `id: uuid("id")<.メソッド()...>` で、チェーンが許可の一覧のメソッドの
// 呼び出しだけからなり、`.primaryKey()` を含むか。
function isSurrogateKeyColumn(
  text: string,
  masked: string,
  entry: { start: number; end: number },
  imports: PgCoreImports,
): boolean {
  const value = masked.slice(entry.start, entry.end);
  // キーは素の `id` だけ（`"id":` の引用符付きはコメントと同じく潰れて見えない = 安全側で違反）。
  const head = new RegExp(`^\\s*id\\s*:\\s*${CALL}`).exec(value);
  if (!head) return false;
  const [whole, object, member, name = ""] = head;
  // WHY `?? 呼び出しの名前` で補わない: import で pg-core の uuid と言えるものだけを認める（pgCoreBuilder のコメント）。
  if (pgCoreBuilder(object, member !== undefined, name, imports) !== "uuid") {
    return false;
  }
  const open = entry.start + whole.length - 1;
  const close = closingIndex(masked, open);
  // DB の列名は元のテキスト（文字列は masked では空白）で見る。`"id"` / `'id'` だけ。
  if (!/^\s*(["'])id\1\s*$/.test(text.slice(open + 1, close))) return false;
  // `uuid("id")` に続くメソッドのチェーンをたどる（型引数 `.$type<Id>()` も 1 つの呼び出し）。
  const chainCall = new RegExp(
    `^\\s*\\.\\s*(${IDENTIFIER})\\s*(?:<[^()]*>)?\\s*\\(`,
  );
  let cursor = close + 1;
  let hasPrimaryKey = false;
  for (
    let call = chainCall.exec(masked.slice(cursor, entry.end));
    call;
    call = chainCall.exec(masked.slice(cursor, entry.end))
  ) {
    const method = call[1] ?? "";
    if (!ALLOWED_ID_CHAIN.has(method)) return false;
    if (method === "primaryKey") hasPrimaryKey = true;
    cursor = closingIndex(masked, cursor + call[0].length - 1) + 1;
  }
  // WHY チェーンの後ろに何も無いことを見る: 呼び出しでない続き（`.primaryKey` の参照・`as X` の型の付け替え）を、
  //   許可の一覧を通らないまま認めない（fail closed）。
  return hasPrimaryKey && masked.slice(cursor, entry.end).trim() === "";
}

// `pgTable(` の "(" の位置から、第 2 引数（列の定義）のオブジェクトの直下の要素の範囲の一覧。
// 第 2 引数がオブジェクトのリテラルでない（変数・関数・無い）ときは中を見ず空を返す（= id が無い = 違反。安全側）。
function columnEntries(
  masked: string,
  open: number,
): { start: number; end: number }[] {
  const columns = splitTopLevel(
    masked,
    open + 1,
    closingIndex(masked, open),
  )[1];
  if (columns === undefined) return [];
  const objectStart =
    columns.start + masked.slice(columns.start, columns.end).search(/\S|$/);
  if (masked[objectStart] !== "{") return [];
  return splitTopLevel(
    masked,
    objectStart + 1,
    closingIndex(masked, objectStart),
  );
}

// 各 `pgTable(` の第 2 引数（列の定義のオブジェクト）の直下に `id: uuid("id")....primaryKey()...` が無ければ違反
// （違反の行は `pgTable` の名前の行）。例外（WHY の見出し）は認めない。
function findSurrogateKeyViolations(text: string): ColumnTypeViolation[] {
  const masked = maskCommentsAndStrings(text);
  const imports = pgCoreImports(text);
  const violations: ColumnTypeViolation[] = [];
  for (const call of builderCalls(masked, imports)) {
    // WHY `?? call.name`: pg-core 以外から import した `pgTable(` も表として検査する（安全側。pgCoreBuilder のコメント）。
    if ((call.builder ?? call.name) !== "pgTable") continue;
    const hasSurrogateKey = columnEntries(masked, call.open).some((entry) =>
      isSurrogateKeyColumn(text, masked, entry, imports),
    );
    if (hasSurrogateKey) continue;
    const line = masked.slice(0, call.index).split("\n").length;
    violations.push({ rule: "surrogate-key", line });
  }
  return violations;
}

// `column-classification` から値として名前で import した ColumnClassifier があるか（`ColumnClassifier as x` の別名は不可、
// `x as ColumnClassifier` も不可。import type と inline の type も不可）。パスは元のテキストで見る（masked では文字列が空白）。
// WHY masked で import の位置がコメントでないことを見る: コメントアウトした import（`// import { ColumnClassifier } ...`）を数えない。
function importsClassifyColumns(text: string, masked: string): boolean {
  const imports = text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']([^"']*)["']/g,
  );
  for (const match of imports) {
    const [, specifiers = "", path = ""] = match;
    if (!masked.startsWith("import", match.index)) continue;
    if (!/(?:^|\/)column-classification$/.test(path)) continue;
    if (specifiers.split(",").some((s) => s.trim() === "ColumnClassifier")) {
      return true;
    }
  }
  return false;
}

// `pgTable(` の呼び出し（masked の関数名の位置 index）の表を受ける変数の名前（`const <名前> = pgTable(` / `= pg.pgTable(`）。
// 変数で受けていなければ undefined。
function tableVariableOf(masked: string, index: number): string | undefined {
  return new RegExp(
    `\\b(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*(?:${IDENTIFIER}\\s*\\.\\s*)?$`,
  ).exec(masked.slice(0, index))?.[1];
}

// 各 `pgTable(` について、`export const <名前>Columns = ColumnClassifier.classify(<名前>,` が同じファイルに無ければ違反（違反の行は
// `pgTable` の名前の行）。ColumnClassifier が column-classification からの import でなければ、すべての表が違反。
function findColumnClassificationViolations(
  text: string,
): ColumnTypeViolation[] {
  const masked = maskCommentsAndStrings(text);
  const imported = importsClassifyColumns(text, masked);
  const violations: ColumnTypeViolation[] = [];
  for (const call of builderCalls(masked, pgCoreImports(text))) {
    // WHY `?? call.name`: surrogate-key と同じく、pg-core 以外から import した `pgTable(` も表として検査する（安全側）。
    if ((call.builder ?? call.name) !== "pgTable") continue;
    const table = tableVariableOf(masked, call.index);
    // WHY $ を逃がす: 識別子は $ を含められ（IDENTIFIER）、正規表現では行末の意味になる。
    const name = table?.replaceAll("$", "\\$");
    const classified =
      imported &&
      name !== undefined &&
      new RegExp(
        `\\bexport\\s+const\\s+${name}Columns\\s*=\\s*ColumnClassifier\\s*\\.\\s*classify\\s*\\(\\s*${name}\\s*,`,
      ).test(masked);
    if (classified) continue;
    const line = masked.slice(0, call.index).split("\n").length;
    violations.push({ rule: "column-classification", line });
  }
  return violations;
}

// 検査の対象: apps/backend の下の infra/schema.ts と、apps/backend/shared/ の下の schema.ts / *.schema.ts（node_modules とテストは
//   除く）。リポジトリ相対の / 区切りで、名前順。
// WHY features と shared の両方: drizzle-kit の設定（apps/backend/shared/drizzle/drizzle.config.ts）が読むのは
//   features/*/internal/infra/schema.ts と、横断の表（change_logs）の shared/change-log/change-log.schema.ts。どちらも同じ既定に従わせる。
// WHY shared は *.schema.ts の名前で拾う（1 ファイルに固定しない）: Issue #310 で shared/ を層（infra など）から意味の単位
//   （drizzle / change-log など）のディレクトリに分け、横断の表は shared/<単位>/<単位>.schema.ts に置く形になった。横断の表を足すと
//   別のディレクトリに置かれうるので、名前の形で拾い、drizzle-kit の設定に足す前でも置いた時点で止める。
// WHY shared の外の *.schema.ts（features/x/internal/domain/x.schema.ts など）は拾わない: features の表の置き場所は infra/schema.ts だけで、
//   domain の zod のスキーマ（Entity の検証）などは Drizzle の表ではない。
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
        (/\/infra\/schema\.ts$/.test(path) ||
          /^apps\/backend\/shared\/(?:[^/]+\/)*(?:[^/]+\.)?schema\.ts$/.test(
            path,
          )) &&
        !path.includes("/node_modules/"),
    )
    .sort();
}

// 1 ファイルのすべての規則の違反を行の順に返す（同じ行は列の型 → surrogate-key → column-classification の順。sort は安定）。
function findSchemaViolations(text: string): ColumnTypeViolation[] {
  return [
    ...findColumnTypeViolations(text),
    ...findSurrogateKeyViolations(text),
    ...findColumnClassificationViolations(text),
  ].sort((a, b) => a.line - b.line);
}

// 違反を「<規則>: <パス>:<行>」で返す。
function collectSchemaViolations(root: string): string[] {
  return listSchemaFiles(root).flatMap((path) =>
    findSchemaViolations(readFileSync(join(root, path), "utf8")).map(
      ({ rule, line }) => `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");
const IMPORT = 'import * as pg from "drizzle-orm/pg-core";';

const TABLE_IMPORT =
  'import { pgTable, primaryKey, serial, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";';

// --- 列の分類表（column-classification。Issue #216） ---
const CLASSIFY_IMPORT =
  'import { ColumnClassifier } from "../../../../shared/drizzle/column-classification";';
const TODOS =
  'export const todos = pgTable("todos", { id: uuid("id").primaryKey(), title: text("title") });';
const TODOS_COLUMNS =
  'export const todosColumns = ColumnClassifier.classify(todos, { id: "public", title: "sensitive" });';

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
const varcharColumn = source(
  IMPORT,
  'export const t = pg.pgTable("t", { title: pg.varchar("title") });',
);

const feature = await loadFeature("./schema.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("列の型の判定（findColumnTypeViolations）: must pass", ({ And }) => {
    And(
      "既定の列の型と、WHY のある既定外の型は違反なし（uuid / text / integer / numeric / timestamptz / jsonb・コメントや文字列の中・名前の一部だけが一致する別の関数など）",
      () => {
        // given
        const cases: [string, string][] = [
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
            source(
              'const c = { title: text("varchar(1)"), note: text(`json(`) };',
            ),
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
        ];

        // when
        const violations = casesByName(cases, ([, text]) =>
          findColumnTypeViolations(text),
        );

        // then
        expect(violations).toEqual(casesByName(cases, () => []));
      },
    );
  });

  Scenario(
    "列の型の判定（findColumnTypeViolations）: must reject",
    ({ And }) => {
      And(
        "WHY の無い既定外の列の型は、規則と行で違反になる（varchar・char・timezone 無しの timestamp・serial・json・WHY の書き方の誤りなど）",
        () => {
          // given
          const cases: [string, string, ColumnTypeViolation[]][] = [
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
              "pg-core から import していない varchar / 名前空間の名前が違う other.json も名前で違反（安全側）",
              source(
                'import { varchar } from "./x";',
                IMPORT,
                'const c = { title: varchar("title"), raw: other.json("raw") };',
              ),
              [
                { rule: "varchar", line: 3 },
                { rule: "json", line: 3 },
              ],
            ],
            [
              "char（固定長）",
              source(
                IMPORT,
                'const c = { code: pg.char("code", { length: 3 }) };',
              ),
              [{ rule: "char", line: 2 }],
            ],
            [
              "timestamp（options 無し）",
              source(IMPORT, 'const c = { at: pg.timestamp("at") };'),
              [{ rule: "timestamp-without-timezone", line: 2 }],
            ],
            [
              "timestamp（withTimezone が無い options）",
              source(
                IMPORT,
                'const c = { at: pg.timestamp("at", { mode: "date" }) };',
              ),
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
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findColumnTypeViolations(text),
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
    "サロゲートキーの判定（findSurrogateKeyViolations）: must pass",
    ({ And }) => {
      And(
        "表の id が uuid の primaryKey なら違反なし（名前で import・.defaultRandom() が続くなど）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              'id: uuid("id").primaryKey()（名前で import）',
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", {',
                '  id: uuid("id").primaryKey(),',
                '  title: text("title").notNull(),',
                "});",
              ),
            ],
            [
              ".primaryKey() の後ろに .defaultRandom() が続く",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").primaryKey().defaultRandom() });',
              ),
            ],
            [
              ".primaryKey() の前に許可の一覧のメソッド（.notNull() / .unique()）がある",
              source(
                TABLE_IMPORT,
                'export const a = pgTable("a", { id: uuid("id").notNull().primaryKey() });',
                'export const b = pgTable("b", { id: uuid("id").unique().primaryKey() });',
              ),
            ],
            [
              ".primaryKey() の後ろに既定値のメソッド（.$defaultFn / .$default / .default）が続く",
              source(
                TABLE_IMPORT,
                'export const a = pgTable("a", { id: uuid("id").primaryKey().$defaultFn(() => randomUUID()) });',
                'export const b = pgTable("b", { id: uuid("id").primaryKey().$default(() => randomUUID()) });',
                'export const c = pgTable("c", { id: uuid("id").primaryKey().default(sql`gen_random_uuid()`) });',
              ),
            ],
            [
              "import が複数行で末尾にカンマ（実ファイルの書き方）",
              source(
                "import {",
                "  pgTable,",
                "  text,",
                "  uuid,",
                '} from "drizzle-orm/pg-core";',
                'export const t = pgTable("t", { id: uuid("id").primaryKey(), title: text("title") });',
              ),
            ],
            [
              "名前空間（pg.pgTable / pg.uuid）",
              source(
                IMPORT,
                'export const t = pg.pgTable("t", { id: pg.uuid("id").primaryKey() });',
              ),
            ],
            [
              "import の別名（pgTable as table / uuid as u）",
              source(
                'import { pgTable as table, uuid as u } from "drizzle-orm/pg-core";',
                "export const t = table('t', { id: u('id').primaryKey() });",
              ),
            ],
            [
              "複数行のチェーンと、id の前のコメント・ほかの列",
              source(
                TABLE_IMPORT,
                "export const t = pgTable(",
                '  "t",',
                "  {",
                '    title: text("title").notNull(),',
                "    // 行の id。",
                '    id: uuid("id")',
                "      .primaryKey()",
                "      .defaultRandom(),",
                "  },",
                '  (table) => [uniqueIndex("t_title_index").on(table.title)],',
                ");",
              ),
            ],
            [
              "1 つのファイルの複数の表がすべて id を持つ",
              source(
                TABLE_IMPORT,
                'export const a = pgTable("a", { id: uuid("id").primaryKey() });',
                'export const b = pgTable("b", { id: uuid("id").primaryKey(), aId: uuid("a_id").notNull() });',
              ),
            ],
            [
              "コメント・文字列の中の pgTable( は表の定義ではない",
              source(
                '// pgTable("x", { title: text("title") }) とは書かない。',
                'const note = "pgTable(\\"y\\", {})";',
              ),
            ],
            [
              "pgTable を呼ばないオブジェクト（列の定義でない）は見ない",
              source(TABLE_IMPORT, 'const c = { title: text("title") };'),
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findSurrogateKeyViolations(text),
          );

          // then
          expect(violations).toEqual(casesByName(cases, () => []));
        },
      );
    },
  );

  Scenario(
    "サロゲートキーの判定（findSurrogateKeyViolations）: must reject",
    ({ And }) => {
      And(
        "表の id が uuid の primaryKey でなければ違反（id の列が無い・serial・text・uuid を名前に含む別の関数・.primaryKey() が無いなど）",
        () => {
          // given
          const cases: [string, string, ColumnTypeViolation[]][] = [
            [
              "id の列が無い",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { title: text("title").notNull() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "複合主キー（primaryKey({ columns: [...] })）だけ",
              source(
                TABLE_IMPORT,
                "export const t = pgTable(",
                '  "t",',
                '  { todoId: uuid("todo_id").notNull(), position: integer("position").notNull() },',
                "  (table) => [primaryKey({ columns: [table.todoId, table.position] })],",
                ");",
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id が serial",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: serial("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id が text",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: text("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id が uuid を名前に含む別の関数（myUuid）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: myUuid("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id は uuid だが .primaryKey() が無い",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").notNull().defaultRandom() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id は uuid だが主キーは第 3 引数の primaryKey({ columns: [table.id] })",
              source(
                TABLE_IMPORT,
                "export const t = pgTable(",
                '  "t",',
                '  { id: uuid("id").notNull() },',
                "  (table) => [primaryKey({ columns: [table.id] })],",
                ");",
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              ".primaryKey() がコメントの中だけ",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", {',
                '  id: uuid("id"), // .primaryKey()',
                "});",
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              ".primaryKey を呼んでいない（プロパティの参照だけ）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").primaryKey });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "uuid の primaryKey の列が id 以外の名前（キーが todoId）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { todoId: uuid("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "キーは id だが DB の列名が id でない",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("row_id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id が入れ子のオブジェクトの中（表の列ではない）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { meta: { id: uuid("id").primaryKey() } });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id が第 3 引数の中だけ",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { title: text("title") }, () => ({ id: uuid("id").primaryKey() }));',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "列の定義が変数（中は見ない = 安全側で違反）",
              source(TABLE_IMPORT, 'export const t = pgTable("t", columns);'),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "列の定義のスプレッドの中の id は見ない（id を直接書く）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { ...base, title: text("title") });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "名前空間（pg.pgTable）で id が無い",
              source(
                IMPORT,
                'export const t = pg.pgTable("t", { title: pg.text("title") });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "import の別名（pgTable as table）で id が無い",
              source(
                'import { pgTable as table, text } from "drizzle-orm/pg-core";',
                'export const t = table("t", { title: text("title") });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "uuid がローカルの変数（const uuid = text）で pg-core の uuid でない",
              source(
                'import { pgTable, text } from "drizzle-orm/pg-core";',
                "const uuid = text;",
                'export const t = pgTable("t", { id: uuid("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 3 }],
            ],
            [
              "uuid を pg-core でない別のモジュールから import している",
              source(
                'import { pgTable } from "drizzle-orm/pg-core";',
                'import { uuid } from "./x";',
                'export const t = pgTable("t", { id: uuid("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 3 }],
            ],
            [
              "import の別名 uuid が text を指す（text as uuid）",
              source(
                'import { pgTable, text as uuid } from "drizzle-orm/pg-core";',
                'export const t = pgTable("t", { id: uuid("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "uuid を import type だけで import している（値ではない）",
              source(
                'import { pgTable } from "drizzle-orm/pg-core";',
                'import type { uuid } from "drizzle-orm/pg-core";',
                'export const t = pgTable("t", { id: uuid("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 3 }],
            ],
            [
              "名前空間の名前が import と違う（import * as pg で other.uuid）",
              source(
                IMPORT,
                'export const t = pg.pgTable("t", { id: other.uuid("id").primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id のチェーンに .array()（uuid[] の列）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").array().$type<string>().primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id のチェーンに .array() だけ（ほかは許可の一覧）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").primaryKey().array() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id のチェーンに .$type<string>()",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").$type<string>().primaryKey() });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id のチェーンに .references(() => t.id)",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").primaryKey().references(() => other.id) });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id のチェーンに .generatedAlwaysAs(...)",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").primaryKey().generatedAlwaysAs(sql`x`) });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "id のチェーンの後ろに呼び出しでない式（as による型の付け替え）",
              source(
                TABLE_IMPORT,
                'export const t = pgTable("t", { id: uuid("id").primaryKey() as unknown as X });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "pgTable を pg-core 以外から import していても表として見る（安全側）",
              source(
                'import { pgTable } from "./db";',
                'export const t = pgTable("t", { title: text("title") });',
              ),
              [{ rule: "surrogate-key", line: 2 }],
            ],
            [
              "複数の表のうち id の無い表だけを、その pgTable( の行で返す",
              source(
                TABLE_IMPORT,
                'export const a = pgTable("a", { id: uuid("id").primaryKey() });',
                "export const b = pgTable(",
                '  "b",',
                '  { title: text("title") },',
                ");",
              ),
              [{ rule: "surrogate-key", line: 3 }],
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findSurrogateKeyViolations(text),
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
    "列の分類表の判定（findColumnClassificationViolations）: must pass",
    ({ And }) => {
      And(
        "表ごとに列の分類表があれば違反なし（名前空間の pgTable・複数の表・変数名に $ を含む表・pgTable の無いファイルなど）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "表の隣に export const <表>Columns = ColumnClassifier.classify(<表>, { ... })",
              source(TABLE_IMPORT, CLASSIFY_IMPORT, TODOS, TODOS_COLUMNS),
            ],
            [
              "同じディレクトリからの import（shared/change-log/change-log.schema.ts）と、pg.pgTable（名前空間）",
              source(
                IMPORT,
                'import { ColumnClassifier, type ColumnClass } from "./column-classification";',
                'export const logs = pg.pgTable("logs", { id: pg.uuid("id").primaryKey() });',
                'export const logsColumns = ColumnClassifier.classify(logs, { id: "public" });',
              ),
            ],
            [
              "複数の表それぞれに分類表（複数行の呼び出し・第 3 引数のある pgTable）",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                "export const todoStatusChanges = pgTable(",
                '  "todo_status_changes",',
                '  { id: uuid("id").primaryKey() },',
                "  (table) => [],",
                ");",
                TODOS_COLUMNS,
                "export const todoStatusChangesColumns = ColumnClassifier.classify(",
                "  todoStatusChanges,",
                '  { id: "public" },',
                ");",
              ),
            ],
            [
              "変数名に $ を含む表",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                'export const $t = pgTable("t", { id: uuid("id").primaryKey() });',
                'export const $tColumns = ColumnClassifier.classify($t, { id: "public" });',
              ),
            ],
            [
              "pgTable の無いファイル（コメント・文字列の pgTable( は表ではない）",
              source("// pgTable( は書かない", 'const s = "pgTable(";'),
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findColumnClassificationViolations(text),
          );

          // then
          expect(violations).toEqual(casesByName(cases, () => []));
        },
      );
    },
  );

  Scenario(
    "列の分類表の判定（findColumnClassificationViolations）: must reject",
    ({ And }) => {
      And(
        "列の分類表の無い表は違反（分類表が無い・片方の表だけにある・名前が <表>Columns でないなど）",
        () => {
          // given
          const cases: [string, string, ColumnTypeViolation[]][] = [
            [
              "分類表が無い",
              source(TABLE_IMPORT, CLASSIFY_IMPORT, TODOS),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "2 つの表の片方だけに分類表がある（無い表だけが違反）",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                'export const others = pgTable("others", { id: uuid("id").primaryKey() });',
                TODOS_COLUMNS,
              ),
              [{ rule: "column-classification", line: 4 }],
            ],
            [
              "分類表の名前が <表>Columns でない（todoColumns）",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                'export const todoColumns = ColumnClassifier.classify(todos, { id: "public", title: "sensitive" });',
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "分類表が別の表を渡している（todosColumns = ColumnClassifier.classify(others, …)）",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                'export const todosColumns = ColumnClassifier.classify(others, { id: "public" });',
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "分類表を export していない",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                'const todosColumns = ColumnClassifier.classify(todos, { id: "public", title: "sensitive" });',
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "satisfies だけの分類表（ColumnClassifier.classify で登録しない）",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                'export const todosColumns = { id: "public", title: "sensitive" } satisfies Record<keyof typeof todos.$inferSelect, string>;',
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "分類表がコメントアウトされている",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                `// ${TODOS_COLUMNS}`,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "分類表が文字列の中にある",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                `const s = \`${TODOS_COLUMNS}\`;`,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "ColumnClassifier を import していない（ローカルのクラス）",
              source(
                TABLE_IMPORT,
                "class ColumnClassifier { static classify(t: unknown, c: unknown) { return c; } }",
                TODOS,
                TODOS_COLUMNS,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "ColumnClassifier の import がコメントアウトされている",
              source(
                TABLE_IMPORT,
                `// ${CLASSIFY_IMPORT}`,
                TODOS,
                TODOS_COLUMNS,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "ColumnClassifier を import type で import している",
              source(
                TABLE_IMPORT,
                'import type { ColumnClassifier } from "../../../../shared/drizzle/column-classification";',
                TODOS,
                TODOS_COLUMNS,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "ColumnClassifier を inline の type で import している",
              source(
                TABLE_IMPORT,
                'import { type ColumnClassifier } from "../../../../shared/drizzle/column-classification";',
                TODOS,
                TODOS_COLUMNS,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "別の名前を ColumnClassifier の別名で import している",
              source(
                TABLE_IMPORT,
                'import { ColumnClassification as ColumnClassifier } from "../../../../shared/drizzle/column-classification";',
                TODOS,
                TODOS_COLUMNS,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "ColumnClassifier を別のモジュール（前方一致の column-classification-x）から import している",
              source(
                TABLE_IMPORT,
                'import { ColumnClassifier } from "./column-classification-x";',
                TODOS,
                TODOS_COLUMNS,
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "ColumnClassifier を別名で import して呼んでいる（import { ColumnClassifier as C } の C.classify）",
              source(
                TABLE_IMPORT,
                'import { ColumnClassifier as C } from "../../../../shared/drizzle/column-classification";',
                TODOS,
                'export const todosColumns = C.classify(todos, { id: "public", title: "sensitive" });',
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "ColumnClassifier の別のメソッド（maskRow）で分類表を作っている",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                'export const todosColumns = ColumnClassifier.maskRow(todos, { id: "public", title: "sensitive" });',
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
            [
              "別のクラスの classify・素の classify で分類表を作っている",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                TODOS,
                'export const todosColumns = OtherClassifier.classify(todos, { id: "public", title: "sensitive" });',
                'const others = pgTable("others", { id: uuid("id").primaryKey() });',
                'export const othersColumns = classify(others, { id: "public" });',
              ),
              [
                { rule: "column-classification", line: 3 },
                { rule: "column-classification", line: 5 },
              ],
            ],
            [
              "pgTable を変数で受けていない（export default）",
              source(
                TABLE_IMPORT,
                CLASSIFY_IMPORT,
                'export default pgTable("t", { id: uuid("id").primaryKey() });',
              ),
              [{ rule: "column-classification", line: 3 }],
            ],
          ];

          // when
          const violations = casesByName(cases, ([, text]) =>
            findColumnClassificationViolations(text),
          );

          // then
          expect(violations).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );
    },
  );

  Scenario("スキーマの列挙と検査（fixture）", ({ And }) => {
    And(
      "apps/backend の infra/schema.ts と、shared の下の schema.ts・名前が .schema.ts で終わるファイルだけを対象にし、すべての規則（列の型・surrogate-key・column-classification）の違反を「規則: パス:行」の行の順で返す",
      () => {
        // given
        const fixtureFiles = {
          "apps/backend/features/a/internal/infra/schema.ts": source(
            IMPORT,
            'export const a = pg.pgTable("a", {',
            '  title: pg.varchar("title", { length: 100 }),',
            '  at: pg.timestamp("at"),',
            "});",
          ),
          // 違反の無いファイル（uuid の id と分類表）。
          "apps/backend/features/b/internal/infra/schema.ts": source(
            IMPORT,
            'import { ColumnClassifier } from "../../../../shared/drizzle/column-classification";',
            'export const b = pg.pgTable("b", { id: pg.uuid("id").primaryKey() });',
            'export const bColumns = ColumnClassifier.classify(b, { id: "public" });',
          ),
          "apps/backend/shared/change-log/change-log.schema.ts": source(
            IMPORT,
            'export const s = pg.pgTable("s", { id: pg.uuid("id").primaryKey(), raw: pg.json("raw") });',
          ),
          // shared の別の意味の単位に足した横断の表（*.schema.ts）と、名前が schema.ts だけのもの。
          "apps/backend/shared/audit/audit.schema.ts": varcharColumn,
          "apps/backend/shared/audit/schema.ts": varcharColumn,
          // 対象外: infra/schema.ts でないファイル、infra 以外の schema.ts、shared の外の *.schema.ts、shared の schema でない
          //   ファイル・前方一致だけの名前（x-schema.ts）、テスト、node_modules、apps/backend の外。
          "apps/backend/features/c/internal/infra/other.ts": varcharColumn,
          "apps/backend/features/c/internal/domain/schema.ts": varcharColumn,
          "apps/backend/features/c/internal/domain/c.schema.ts": varcharColumn,
          "apps/backend/shared/drizzle/database.ts": varcharColumn,
          "apps/backend/shared/audit/audit-schema.ts": varcharColumn,
          "apps/backend/shared/change-log/change-log.schema.test.ts":
            varcharColumn,
          "apps/backend/features/c/internal/infra/schema.test.ts":
            varcharColumn,
          "apps/backend/node_modules/x/infra/schema.ts": varcharColumn,
          "apps/frontend_customer/features/x/infra/schema.ts": varcharColumn,
        };

        // when
        const result = violationsOfFixture(fixtureFiles);

        // then
        expect(result).toEqual({
          files: [
            "apps/backend/features/a/internal/infra/schema.ts",
            "apps/backend/features/b/internal/infra/schema.ts",
            "apps/backend/shared/audit/audit.schema.ts",
            "apps/backend/shared/audit/schema.ts",
            "apps/backend/shared/change-log/change-log.schema.ts",
          ],
          violations: [
            "surrogate-key: apps/backend/features/a/internal/infra/schema.ts:2",
            "column-classification: apps/backend/features/a/internal/infra/schema.ts:2",
            "varchar: apps/backend/features/a/internal/infra/schema.ts:3",
            "timestamp-without-timezone: apps/backend/features/a/internal/infra/schema.ts:4",
            "varchar: apps/backend/shared/audit/audit.schema.ts:2",
            "surrogate-key: apps/backend/shared/audit/audit.schema.ts:2",
            "column-classification: apps/backend/shared/audit/audit.schema.ts:2",
            "varchar: apps/backend/shared/audit/schema.ts:2",
            "surrogate-key: apps/backend/shared/audit/schema.ts:2",
            "column-classification: apps/backend/shared/audit/schema.ts:2",
            "json: apps/backend/shared/change-log/change-log.schema.ts:2",
            "column-classification: apps/backend/shared/change-log/change-log.schema.ts:2",
          ],
        });
      },
    );

    And(
      "apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）",
      () => {
        // given: 前提なし
        // when
        const result = violationsOfFixture({ "README.md": "# x\n" });

        // then
        expect(result).toEqual({
          files: [],
          violations: [],
        });
      },
    );
  });

  Scenario(
    "DB の列の型・サロゲートキー・列の分類表（実ファイル）",
    ({ And }) => {
      And(
        "apps/backend の infra/schema.ts と shared の .schema.ts はすべて列の型の既定に従い、すべての表が uuid の id の primaryKey と列の分類表を持つ",
        () => {
          // given: 実ファイル（repoRoot）
          // when
          const files = listSchemaFiles(repoRoot);
          const violations = collectSchemaViolations(repoRoot);

          // then
          // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
          //   features と shared の両方の置き場所が列挙に入ることを見る（片方の列挙だけが壊れても気づく）。
          expect(files).toContain(
            "apps/backend/features/todo/internal/infra/schema.ts",
          );
          expect(files).toContain(
            "apps/backend/shared/change-log/change-log.schema.ts",
          );
          expect(violations).toEqual([]);
        },
      );
    },
  );
});
