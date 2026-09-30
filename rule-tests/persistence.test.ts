// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは backend のソースを文字列として読むだけで
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
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 永続化の save の規則（.claude/rules/backend.md の「永続化」の `save`。Issue #165 / #172 / #177）を、backend のソースで
// 機械的に検査するテスト。対象は apps/backend/ の下のテスト以外の .ts（*.test.ts を除く）。
// 違反にするもの:
//   - no-upsert: `onConflictDoUpdate` / `onConflictDoNothing`（Drizzle の upsert）の名前がコードにあること。
//     WHY `.` と `(` を要求しない（名前だけを語の境界で探す）: 変数に入れ直す（`const f = q.onConflictDoUpdate`）・
//       ブラケット（`q["onConflictDoUpdate"](…)`）・`.` の後で改行する書き方も拾う。`onConflictDoUpdateLater` のような
//       名前の一部が一致するだけの別の名前は通す。
//     WHY: save は新規なら素の INSERT（2 回目は一意制約違反で気づく）、読み込み済みなら変わった列だけの UPDATE。upsert は
//       2 回目の save や id の衝突を黙って通し、全列を書いて同時更新の他方の変更を巻き戻す（lost update）。
//   - save-uses-changed-props: *.postgres.ts に save のメソッド定義（行の先頭が `save(` / `async save(`。`public` などの修飾子も可）が
//     あるのに、shared/infra/changed-props を値として import していない（`import type` は数えない）。
//     WHY: 読み込み済みの save は、読み込んだときの値（origin）と今の値を changedProps で比べて変わった列だけを書く。
//       自前の比較や全列の UPDATE に戻ると lost update が再発する。
//   - entity-with-reconstruct-has-origin: apps/backend/features/<f>/domain/ の下で `static reconstruct(` を持つファイルが
//     `get origin()` を持たない。
//     WHY: Repository が差分を取るために、読み込んだとき（reconstruct）の値を Entity が持つ。
//   - no-update-delete-on-append-only-tables（Issue #188）: *.postgres.ts で `.update(<表>)` / `.delete(<表>)` の引数の表の名前
//     （識別子。`schema.x` のようなメンバーの参照は最後の名前）が `Changes` か `Events` で終わる（`db.` / `tx.` などの受け手は
//     問わない。`.` と名前と `(` と引数の間の空白・改行は可）。行は update / delete の名前の行。`.insert(` と `.select()` は通す。
//     WHY: 遷移の履歴（todo_status_changes のような `*_changes` の子表）は insert のみの記録で、後から書き換える・消すと
//       「いつ何に変わったか」が失われる。消えるのは親を消したときの外部キーの on delete cascade だけ（ADR
//       docs/adr/architecture/20260930-status-transitions-as-append-only-child-table.md）。
//     WHY 表の名前の接尾辞で見分ける: insert のみの表を列挙すると、表を足したときに一覧への追加を忘れて素通りする。
//       命名（`*Changes` / `*Events`）に縛れば、足した表も同じ検査にかかる。
//     WHY *.postgres.ts だけ: DB に SQL を発行するのは Postgres の Repository だけ。InMemory の `Map#delete(id)` などは表ではない。
//     限界: 表を別名の変数に入れ直す（`const t = todoStatusChanges; db.delete(t)`）・ブラケット（`db["delete"](…)`）・生の SQL
//       （sql`delete from todo_status_changes`）・名前の接尾辞に従わない表は見ない。
// コメントと文字列の扱い（限界）: 各行の `//` 以降を落としてから探す（「// .onConflictDoUpdate( は使わない」を違反と数えない）。
//   文字列の中身は解釈しない。そのため、文字列の中の `//` の後ろは見逃し、文字列の中の `.onConflictDoUpdate(` は違反と数える。
//   ブロックコメント（`/* … */`）の中はコードと同じに扱う（upsert は安全側で違反になるが、`get origin()` と changed-props の
//   import は、ブロックコメントの中にあるだけで満たしたと見なす）。生の SQL（sql`… ON CONFLICT …`）、`save = async (…) =>`
//   のようなプロパティでの定義、import した changedProps を実際に呼んでいるかは見ない。
// 判定の粒度の限界:
//   - `get origin()` の有無はファイル単位で見る（1 ファイルに class が 2 つあると、片方だけが origin を持っていても通る）。
//   - `static async reconstruct(` / `static reconstruct = …` のような書き方の reconstruct は見ない。
//   - `import { type changedProps } from "…/changed-props"`（inline の type）も値の import と数える（`import type` だけを除く）。
//   - 行頭が `save(` の行は定義と見なすので、行頭の素の呼び出し（`save(x);`）も定義として数える（安全側）。
// WHY 文字列で判定する（AST にしない）: 見るのはメソッド名・import の参照先・getter の有無だけで、行単位の正規表現で足りる。

type RuleId =
  | "no-upsert"
  | "save-uses-changed-props"
  | "entity-with-reconstruct-has-origin"
  | "no-update-delete-on-append-only-tables";

type PersistenceViolation = { rule: RuleId; line: number };

// 各行の `//` 以降を落とした行の配列（行の数と位置は変えない。行番号を元のソースと合わせるため）。
function codeLines(source: string): string[] {
  return source.split("\n").map((line) => line.split("//")[0] ?? "");
}

// パターンに一致する行の行番号（1 始まり）。
function matchingLines(lines: string[], pattern: RegExp): number[] {
  return lines.flatMap((line, index) =>
    pattern.test(line) ? [index + 1] : [],
  );
}

// shared/infra/changed-props を値として import しているか（複数行の import も読む。`import type` は数えない）。
function importsChangedProps(code: string): boolean {
  const imports = code.matchAll(
    /\bimport\s+(type\s+)?[^;]*?\bfrom\s*(["'])([^"'\n]+)\2/g,
  );
  return [...imports].some(
    ([, typeOnly, , specifier = ""]) =>
      typeOnly === undefined &&
      // WHY 前後を区切る: `changed-props-x` や shared/infra でない `./changed-props` は別のモジュール。
      /(?:^|\/)shared\/infra\/changed-props(?:\.[cm]?[jt]s)?$/.test(specifier),
  );
}

// insert のみの表（名前が Changes / Events で終わる）への `.update(` / `.delete(` の、update / delete の名前の行番号（1 始まり）。
// WHY 行ではなく、行をつないだコード全体で探す: `.delete(` と表の名前の間に改行を挟む書き方（Biome の整形で chain が折り返される）も拾う。
// WHY 表の名前は `a.b.c` の最後の名前で見る: `schema.todoStatusChanges` のように名前空間から参照しても見分ける。
function appendOnlyTableWrites(lines: string[]): number[] {
  const code = lines.join("\n");
  const writes = code.matchAll(
    /\.\s*(?:update|delete)\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g,
  );
  return [...writes].flatMap(({ 0: whole, 1: table = "", index }) => {
    const name = table.split(".").at(-1)?.trim() ?? "";
    if (!/(?:Changes|Events)$/.test(name)) {
      return [];
    }
    // `.` の後の空白・改行を飛ばした、update / delete の名前の位置で行を数える。
    const methodAt = index + whole.search(/update|delete/);
    return [code.slice(0, methodAt).split("\n").length];
  });
}

// path はリポジトリ相対の / 区切り。規則ごとに対象のパスを絞り、違反を行の順に返す。
function findPersistenceViolations(
  path: string,
  source: string,
): PersistenceViolation[] {
  if (!/^apps\/backend\/.+\.ts$/.test(path) || /\.test\.ts$/.test(path)) {
    return [];
  }
  const lines = codeLines(source);
  const violations: PersistenceViolation[] = matchingLines(
    lines,
    /\bonConflictDo(?:Update|Nothing)\b/,
  ).map((line) => ({ rule: "no-upsert", line }));

  if (/\.postgres\.ts$/.test(path)) {
    violations.push(
      ...appendOnlyTableWrites(lines).map((line) => ({
        rule: "no-update-delete-on-append-only-tables" as const,
        line,
      })),
    );
  }

  if (/\.postgres\.ts$/.test(path) && !importsChangedProps(lines.join("\n"))) {
    const saveDefinitions = matchingLines(
      lines,
      /^\s*(?:(?:public|private|protected|override)\s+)*(?:async\s+)?save\s*[(<]/,
    );
    violations.push(
      ...saveDefinitions.map((line) => ({
        rule: "save-uses-changed-props" as const,
        line,
      })),
    );
  }

  // WHY domain の下の入れ子も対象にする: 規則の文書は features/<f>/domain/*.ts だが、入れ子に Entity を置いたときに黙って
  //   外れないよう広めに取る（今は入れ子のディレクトリは無い）。
  if (
    /^apps\/backend\/features\/[^/]+\/domain\/.+\.ts$/.test(path) &&
    !lines.some((line) => /\bget\s+origin\s*\(\s*\)/.test(line))
  ) {
    violations.push(
      ...matchingLines(lines, /\bstatic\s+reconstruct\s*[(<]/).map((line) => ({
        rule: "entity-with-reconstruct-has-origin" as const,
        line,
      })),
    );
  }
  return violations.sort((a, b) => a.line - b.line);
}

// root の下を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリに入らない: 依存やビルド結果は検査の対象ではない。
function walk(root: string, dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name.startsWith(".")
        ? []
        : walk(root, path);
    }
    return entry.isFile() ? [path] : [];
  });
}

// 検査の対象: apps/backend の下のテスト以外の .ts。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listBackendSources(root: string): string[] {
  return walk(root, "apps/backend")
    .filter((path) => /\.ts$/.test(path) && !/\.test\.ts$/.test(path))
    .sort();
}

// 違反を「<規則>: <パス>:<行>」で返す。
function collectPersistenceViolations(root: string): string[] {
  return listBackendSources(root).flatMap((path) =>
    findPersistenceViolations(path, readFileSync(join(root, path), "utf8")).map(
      ({ rule, line }) => `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const POSTGRES = "apps/backend/features/x/infra/x-repository.postgres.ts";
const IN_MEMORY = "apps/backend/features/x/infra/x-repository.in-memory.ts";
const ENTITY = "apps/backend/features/x/domain/x.ts";
const IMPORT_CHANGED_PROPS =
  'import { changedProps } from "../../../shared/infra/changed-props";';

describe("永続化の判定（findPersistenceViolations）: must pass", () => {
  it.each([
    [
      "*.postgres.ts の save が changed-props を import している（素の INSERT と差分の UPDATE）",
      POSTGRES,
      source(
        IMPORT_CHANGED_PROPS,
        "export class XRepository {",
        "  async save(x: X): Promise<void> {",
        "    await this.db.insert(xs).values(row);",
        "  }",
        "}",
      ),
    ],
    [
      "複数行の import で changed-props を読む（拡張子付き）",
      POSTGRES,
      source(
        "import {",
        "  changedProps,",
        '} from "../../../shared/infra/changed-props.ts";',
        "class XRepository {",
        "  save(x: X) {}",
        "}",
      ),
    ],
    [
      "save を定義していない *.postgres.ts は import 不要（save を呼ぶだけの行も定義ではない）",
      POSTGRES,
      source(
        "export class XReader {",
        "  async findAll(): Promise<X[]> {",
        "    await other.save(x);",
        "    return [];",
        "  }",
        "}",
      ),
    ],
    [
      "*.postgres.ts でない Repository（in-memory）の save は import 不要",
      IN_MEMORY,
      source("class InMemoryXRepository {", "  async save(x: X) {}", "}"),
    ],
    [
      "コメントの中の .onConflictDoUpdate( / .onConflictDoNothing(",
      POSTGRES,
      source(
        "// .onConflictDoUpdate( で上書きしない。",
        "await this.db.insert(xs).values(row); // .onConflictDoNothing() も使わない",
      ),
    ],
    [
      "名前の一部が一致するだけの別のメソッド（onConflictDoUpdateLater / saveAll / resave）",
      POSTGRES,
      source(
        "q.onConflictDoUpdateLater(x);",
        "class XRepository {",
        "  async saveAll(xs: X[]) {}",
        "  resave(x: X) {}",
        "}",
      ),
    ],
    [
      "Entity が static reconstruct( と get origin() を持つ",
      ENTITY,
      source(
        "export class X {",
        "  get origin(): Readonly<XProps> | undefined {",
        "    return this.#origin;",
        "  }",
        "  static reconstruct(values: XProps): X {",
        "    return new X(values, (valid) => valid);",
        "  }",
        "}",
      ),
    ],
    [
      "reconstruct も origin も無い domain のファイル",
      "apps/backend/features/x/domain/x-repository.ts",
      source(
        "export interface XRepository {",
        "  save(x: X): Promise<void>;",
        "}",
      ),
    ],
    [
      "コメントの中の static reconstruct(",
      ENTITY,
      source(
        "// static reconstruct( は Repository が使う。",
        "export class X {}",
      ),
    ],
    [
      "テストファイル（*.test.ts）は対象外",
      "apps/backend/features/x/infra/x-repository.postgres.test.ts",
      source(
        "async save(x) {}",
        "q.onConflictDoUpdate({});",
        "static reconstruct(v) {}",
      ),
    ],
    [
      "shared/domain の reconstruct（entity-with-reconstruct-has-origin は features の domain だけ）",
      "apps/backend/shared/domain/x.ts",
      source("export class X {", "  static reconstruct(v: V) {}", "}"),
    ],
    [
      "backend の外（frontend）は対象外",
      "apps/frontend_customer/features/x/x.ts",
      source("q.onConflictDoUpdate({});"),
    ],
    [
      "insert のみの表（*Changes / *Events）への insert と select、それ以外の表の update / delete",
      POSTGRES,
      source(
        "await tx.insert(todoStatusChanges).values(rows);",
        "await this.db.insert(orderEvents).values(rows);",
        "await this.db.select().from(todoStatusChanges);",
        "await tx.update(todos).set(changed);",
        "await this.db.delete(todos).where(eq(todos.id, id));",
      ),
    ],
    [
      "名前の途中に Changes / Events を含むだけの表（todoChangesLog / eventsArchive）",
      POSTGRES,
      source(
        "await this.db.delete(todoChangesLog);",
        "await this.db.update(eventsArchive).set(row);",
      ),
    ],
    [
      "update / delete で始まる別のメソッド（updateChanges( / deleted( / predelete(）",
      POSTGRES,
      source(
        "q.updateChanges(todoStatusChanges);",
        "q.deleted(todoStatusChanges);",
        "q.predelete(todoStatusChanges);",
      ),
    ],
    [
      "コメントの中の .delete(todoStatusChanges)",
      POSTGRES,
      source(
        "// this.db.delete(todoStatusChanges) は書かない（cascade で消える）。",
        "await this.db.delete(todos); // tx.update(todoStatusChanges) も書かない",
      ),
    ],
    [
      "*.postgres.ts 以外（in-memory）の .delete(xChanges)",
      IN_MEMORY,
      source("this.statusChanges.delete(todoStatusChanges);"),
    ],
  ])("%s は違反なし", (_name, path, text) => {
    expect(findPersistenceViolations(path, text)).toEqual([]);
  });
});

describe("永続化の判定（findPersistenceViolations）: must reject", () => {
  it.each<[string, string, string, PersistenceViolation[]]>([
    [
      ".onConflictDoUpdate(（chain の次の行）",
      POSTGRES,
      source(
        IMPORT_CHANGED_PROPS,
        "await this.db",
        "  .insert(xs)",
        "  .values(row)",
        "  .onConflictDoUpdate({ target: xs.id, set: row });",
      ),
      [{ rule: "no-upsert", line: 5 }],
    ],
    [
      ".onConflictDoNothing()（同じ行）",
      POSTGRES,
      source(
        IMPORT_CHANGED_PROPS,
        "await this.db.insert(xs).values(row).onConflictDoNothing();",
      ),
      [{ rule: "no-upsert", line: 2 }],
    ],
    [
      "空白を挟んだ . onConflictDoNothing (",
      POSTGRES,
      source("q . onConflictDoNothing ( );"),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      "変数に入れ直して呼ぶ（const f = q.onConflictDoUpdate; f({})）",
      POSTGRES,
      source("const f = q.onConflictDoUpdate;", "f({});"),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      'ブラケットで呼ぶ（q["onConflictDoUpdate"](…)）',
      POSTGRES,
      source('q["onConflictDoUpdate"]({ target: xs.id, set: row });'),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      ". の後で改行する（q.\\n  onConflictDoUpdate(）",
      POSTGRES,
      source("q.", "  onConflictDoUpdate({});"),
      [{ rule: "no-upsert", line: 2 }],
    ],
    [
      "*.postgres.ts 以外（in-memory / shared/infra / application）の upsert",
      "apps/backend/shared/infra/x.ts",
      source("q.onConflictDoUpdate({});"),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      "*.postgres.ts の async save( が changed-props を import していない",
      POSTGRES,
      source(
        "export class XRepository {",
        "  async save(x: X): Promise<void> {",
        "    await this.db.update(xs).set(row);",
        "  }",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 2 }],
    ],
    [
      "async の無い save( / public async save( / 型引数付きの save<",
      POSTGRES,
      source(
        "class A {",
        "  save(x: X) {}",
        "}",
        "class B {",
        "  public async save(x: X) {}",
        "}",
        "class C {",
        "  save<T>(x: T) {}",
        "}",
      ),
      [
        { rule: "save-uses-changed-props", line: 2 },
        { rule: "save-uses-changed-props", line: 5 },
        { rule: "save-uses-changed-props", line: 8 },
      ],
    ],
    [
      "changed-props の import がコメントの中だけ",
      POSTGRES,
      source(
        `// ${IMPORT_CHANGED_PROPS}`,
        "class A {",
        "  async save(x: X) {}",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 3 }],
    ],
    [
      "changed-props を import type だけで読む（関数を呼べない）",
      POSTGRES,
      source(
        'import type { changedProps } from "../../../shared/infra/changed-props";',
        "class A {",
        "  async save(x: X) {}",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 3 }],
    ],
    [
      "名前が同じ別のモジュール（./changed-props / shared/infra/changed-props-x）",
      POSTGRES,
      source(
        'import { changedProps } from "./changed-props";',
        'import { diff } from "../../../shared/infra/changed-props-x";',
        "class A {",
        "  async save(x: X) {}",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 4 }],
    ],
    [
      "Entity が static reconstruct( を持つのに get origin() が無い",
      ENTITY,
      source(
        "export class X {",
        "  static reconstruct(values: XProps): X {",
        "    return new X(values);",
        "  }",
        "}",
      ),
      [{ rule: "entity-with-reconstruct-has-origin", line: 2 }],
    ],
    [
      "get origin() がコメントの中だけ・getter でない origin のフィールド",
      ENTITY,
      source(
        "export class X {",
        "  // get origin() は持たない",
        "  readonly origin?: XProps;",
        "  public static reconstruct(values: XProps): X {",
        "    return new X(values);",
        "  }",
        "}",
      ),
      [{ rule: "entity-with-reconstruct-has-origin", line: 4 }],
    ],
    [
      "domain の下の入れ子の Entity",
      "apps/backend/features/x/domain/nested/y.ts",
      source("export class Y {", "  static reconstruct(v: V) {}", "}"),
      [{ rule: "entity-with-reconstruct-has-origin", line: 2 }],
    ],
    [
      "db.delete(todoStatusChanges)（insert のみの表の DELETE）",
      POSTGRES,
      source("await this.db.delete(todoStatusChanges);"),
      [{ rule: "no-update-delete-on-append-only-tables", line: 1 }],
    ],
    [
      "tx.update(todoStatusChanges)（トランザクションの中の UPDATE）",
      POSTGRES,
      source(
        "await this.db.transaction(async (tx) => {",
        "  await tx.update(todoStatusChanges).set({ completed: true });",
        "});",
      ),
      [{ rule: "no-update-delete-on-append-only-tables", line: 2 }],
    ],
    [
      "改行を挟んだ .delete( と表の名前（chain の次の行で .delete(、その次の行に表。行は delete の行）",
      POSTGRES,
      source(
        "await this.db",
        "  .delete(",
        "    todoStatusChanges",
        "  )",
        "  .where(eq(todoStatusChanges.todoId, id));",
      ),
      [{ rule: "no-update-delete-on-append-only-tables", line: 2 }],
    ],
    [
      "空白を挟んだ . update ( orderEvents )（*Events の表）",
      POSTGRES,
      source("q . update ( orderEvents ).set(row);"),
      [{ rule: "no-update-delete-on-append-only-tables", line: 1 }],
    ],
    [
      "メンバーの参照（schema.todoStatusChanges）",
      POSTGRES,
      source("await db.delete(schema.todoStatusChanges);"),
      [{ rule: "no-update-delete-on-append-only-tables", line: 1 }],
    ],
    [
      "1 行に 2 つ・複数の行（行の順に、見つけた数だけ返す）",
      POSTGRES,
      source(
        "await db.update(aChanges).set(r); await db.delete(bEvents);",
        "await db.delete(todos);",
        "await db.delete(cChanges);",
      ),
      [
        { rule: "no-update-delete-on-append-only-tables", line: 1 },
        { rule: "no-update-delete-on-append-only-tables", line: 1 },
        { rule: "no-update-delete-on-append-only-tables", line: 3 },
      ],
    ],
    [
      "1 つのファイルに upsert と import の無い save（行の順に返す）",
      POSTGRES,
      source(
        "class A {",
        "  async save(x: X) {",
        "    await q.onConflictDoUpdate({});",
        "  }",
        "}",
      ),
      [
        { rule: "save-uses-changed-props", line: 2 },
        { rule: "no-upsert", line: 3 },
      ],
    ],
  ])("%s は違反", (_name, path, text, expected) => {
    expect(findPersistenceViolations(path, text)).toEqual(expected);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（apps/backend の下のテスト以外の .ts の見つけ方）が漏れれば見逃す。一時ディレクトリに
//   架空のツリーを置き、本番と同じ collectPersistenceViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("backend のソースの列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "persistence-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const saveMethod = source("class A {", "  async save(x: X) {}", "}");
  const reconstructOnly = source(
    "export class Y {",
    "  static reconstruct(v: V) {}",
    "}",
  );

  it("apps/backend の下のテスト以外の .ts を対象にし、違反を「規則: パス:行」で返す", () => {
    const root = fixture({
      [POSTGRES]: source(IMPORT_CHANGED_PROPS, saveMethod),
      "apps/backend/features/y/infra/y-repository.postgres.ts": source(
        saveMethod,
        "q.onConflictDoUpdate({});",
      ),
      "apps/backend/features/y/infra/y-reader.postgres.ts": source(
        "export class YReader {}",
        "await this.db.delete(yChanges);",
      ),
      [IN_MEMORY]: source(saveMethod, "q.onConflictDoNothing();"),
      "apps/backend/shared/infra/z.ts": source("", "q.onConflictDoNothing();"),
      [ENTITY]: source(
        "export class X {",
        "  get origin() {}",
        "  static reconstruct(v: V) {}",
        "}",
      ),
      "apps/backend/features/y/domain/y.ts": reconstructOnly,
      "apps/backend/features/y/domain/y-repository.ts": source(
        "export interface YRepository {}",
      ),
      // 対象外: テスト、features でない domain の reconstruct、.ts でないファイル、backend の外、node_modules の中。
      "apps/backend/features/y/infra/y-repository.postgres.test.ts": source(
        saveMethod,
        "q.onConflictDoUpdate({});",
        "await this.db.delete(yChanges);",
      ),
      "apps/backend/features/y/infra/y-repository.in-memory.ts": source(
        "this.yEvents.delete(id);",
        "q.update(yEvents);",
      ),
      "apps/backend/features/y/domain/y.test.ts": reconstructOnly,
      "apps/backend/shared/domain/w.ts": reconstructOnly,
      "apps/backend/shared/drizzle/0000_x.sql":
        "INSERT ... ON CONFLICT DO UPDATE;",
      "apps/frontend_customer/features/x/x.ts": source(
        "q.onConflictDoUpdate({});",
      ),
      "apps/backend/node_modules/x/x.postgres.ts": saveMethod,
    });
    expect({
      files: listBackendSources(root),
      violations: collectPersistenceViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/x/domain/x.ts",
        "apps/backend/features/x/infra/x-repository.in-memory.ts",
        "apps/backend/features/x/infra/x-repository.postgres.ts",
        "apps/backend/features/y/domain/y-repository.ts",
        "apps/backend/features/y/domain/y.ts",
        "apps/backend/features/y/infra/y-reader.postgres.ts",
        "apps/backend/features/y/infra/y-repository.in-memory.ts",
        "apps/backend/features/y/infra/y-repository.postgres.ts",
        "apps/backend/shared/domain/w.ts",
        "apps/backend/shared/infra/z.ts",
      ],
      violations: [
        "no-upsert: apps/backend/features/x/infra/x-repository.in-memory.ts:4",
        "entity-with-reconstruct-has-origin: apps/backend/features/y/domain/y.ts:2",
        "no-update-delete-on-append-only-tables: apps/backend/features/y/infra/y-reader.postgres.ts:2",
        "save-uses-changed-props: apps/backend/features/y/infra/y-repository.postgres.ts:2",
        "no-upsert: apps/backend/features/y/infra/y-repository.postgres.ts:4",
        "no-upsert: apps/backend/shared/infra/z.ts:2",
      ],
    });
  });

  it("apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listBackendSources(root),
      violations: collectPersistenceViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("永続化（実ファイル）", () => {
  it("upsert を使わず、*.postgres.ts の save は changed-props を import し、reconstruct を持つ Entity は origin を持ち、insert のみの表を update / delete しない", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    const files = listBackendSources(repoRoot);
    expect(files).toContain(
      "apps/backend/features/todo/infra/todo-repository.postgres.ts",
    );
    expect(files).toContain("apps/backend/features/todo/domain/todo.ts");
    expect(collectPersistenceViolations(repoRoot)).toEqual([]);
  });
});
