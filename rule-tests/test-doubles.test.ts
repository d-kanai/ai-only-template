// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはテストファイルのソースを文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
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
import { dirname, join, posix } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// テストダブルの方針（.claude/rules/testing.md の「テストダブル」。Issue #166 / #177、ユーザー判断 2026-09-30）を、
// テストファイルのソースで機械的に検査するテスト。
// 違反にするもの:
//   - vi-mock-only-now: apps/backend/ のテスト（*.test.ts(x)）の `vi.mock(` で、第 1 引数が文字列 "@repo/shared/now"
//     （' でも可）でないもの。第 2 引数（`{ spy: true }` など）は問わない。`vi.doMock(` は引数によらず違反。
//     例外の書き方: 呼び出しの行の直前に続く `//` のコメント行（空行を挟まない）のどれかが「// WHY モック: <理由>」なら通す
//       （rule-tests/schema.test.ts の `// WHY 長さ:`・rule-tests/api-request.test.ts の `// WHY 任意:` と同じ仕組み）。
//       理由が空・見出しが違う・空行を挟む・同じ行の末尾・ブロックコメントは認めない。
//     WHY 例外を認める: InMemory で起こせない検証（api ファイルの結線が getDatabase().db を共有することを、Repository を
//       受け取った db を記録するサブクラスに差し替えて確かめる route-handlers-share-database.test.ts など）がある。
//       例外は呼び出しごとに理由を書かせ、黙ってモックが増えないようにする。
//     WHY 見出しを `WHY モック:` だけにする: 別の理由の WHY コメントが直前にあるだけで黙って通らないようにする。
//     WHY: backend のテストは InMemory の Repository と本物の下の層で層をつないだまま検証し、差し替えるのは時計（now）だけ。
//       モックは「こう呼ばれるはず」を書き込むので、実装とずれても緑のまま。
//     WHY vi.doMock も違反: 時計の差し替えは vi.mock（巻き上げ）で足りる。対象外にすると、doMock で任意のモジュールを
//       WHY 無しで差し替えられる抜け道になる。
//     WHY 文字列リテラルだけ許す: `vi.mock(import("@repo/shared/now"))` やテンプレートリテラルは今使っておらず、
//       書き方を 1 つにしておけば判定が単純で見逃しが無い（安全側で違反）。
//   - db-tests-in-infra-only: apps/backend/test-support/database（実 Postgres。createTestDatabase。Issue #181 で
//     apps/backend/shared/infra/database.test-support から移した）を import する（`from` / `import "…"` / `import("…")`。
//     `import type` も）のは、apps/backend/**/infra/ の直下のテスト、apps/backend/test-support/ の直下のテスト（test-support 自身のテスト）、
//     apps/backend/journeys/ の直下のジャーニーテスト（*.journey.test.ts。Issue #187）、vitest.global-setup.ts だけ。
//     application / presentation / domain のテスト・frontend のテストからの import は違反。
//     参照先は書き方によらず解決して比べる（相対パスは参照元のディレクトリから、`@repo/backend/…` は apps/backend/、`@/…` は
//     apps/frontend_customer/。拡張子は除く）。WHY: 書き方（`../../../test-support/database`・`@repo/backend/test-support/database`・
//     `./database`）の文字列で比べると、置き場所が同じでも書き方を変えるだけで素通りする。
//     WHY: DB ありのテストは infra に分け、ユースケースと HTTP のテストは DB に接続しない（ユーザー判断 2026-09-30）。
//     WHY ジャーニーテストは許す（Issue #187）: 複数の API を実 Postgres の上で業務の流れに沿って順に呼ぶテストの種類で、
//       層ごとの単体テスト（DB に接続しない）とは置き場所（apps/backend/journeys/）で分けている。形（*.journey.test.ts だけ・
//       InMemory と vi.mock の禁止・API 2 つ以上・test-support/database の import）は rule-tests/journey.test.ts が見る。
//     WHY import type も違反: 型だけでも DB の準備を前提にしたテストの形が application / presentation に入り込む入口になる。
// 検査の対象: apps/ の下のテストファイル（*.test.ts / *.test.tsx）と、リポジトリ直下の vitest.global-setup.ts。
//   apps/shared（`vi.mock("./now")`）と frontend（`vi.mock("@/features/.../api/...")`）の vi.mock は vi-mock-only-now の対象外。
// コメントと文字列の扱い（限界）: 各行の `//` 以降を落としてから探す（「// vi.mock(…) は使わない」を違反と数えない）。
//   文字列の中身は解釈しない。そのため、文字列の中の `//`（`"http://…"`）の後ろは見逃し、文字列の中の `vi.mock(` は違反と数える。
//   ブロックコメント（`/* vi.mock("x") */`）の中も違反と数える（安全側）。`vi` を別名で import する・`vi["mock"]` と書く・
//   require で読むのは見ない。
// 判定の粒度の限界:
//   - test-support/database を `vi.importActual(…)` / `require(…)` / テンプレートリテラルの `import(`…`)` で読む書き方、
//     ディレクトリの index（`test-support/database/index`）、tsconfig の paths の別名は見ない。
//   - `const m = vi.mock; m(…)` / `vi.mock.call(…)` / `vi?.mock(` / `vi.mock?.(` のような呼び方は見ない。
//   - 同じ行に呼び出しが 2 つあると、直前の 1 つの `// WHY モック:` で両方とも通る（WHY は行単位で見る）。
// WHY 文字列で判定する（AST にしない）: 見るのは `vi.mock(` の第 1 引数と import の参照先の文字列だけで、行単位の正規表現で足りる。

type RuleId = "vi-mock-only-now" | "db-tests-in-infra-only";

type TestDoubleViolation = { rule: RuleId; line: number };

// 各行の `//` 以降を落とす（行の数と位置は変えない。行番号を元のソースと合わせるため）。
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.split("//")[0] ?? "")
    .join("\n");
}

// code[index] がある行（1 始まり）。
function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// 呼び出しの行（0 始まり）の直前に続く `//` の行に「// WHY モック: <理由>」があるか。lines は元のソース（コメント付き）の行。
function hasWhyAbove(lines: string[], lineIndex: number): boolean {
  const why = /^\/\/\s*WHY モック:\s*\S/;
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed.startsWith("//")) return false;
    if (why.test(trimmed)) return true;
  }
  return false;
}

function findViMockViolations(
  code: string,
  lines: string[],
): TestDoubleViolation[] {
  // WHY 許可する参照先はここに 1 つだけ: 時計（apps/shared/now.ts）が backend のテストで唯一差し替えてよい依存。
  const allowed = "@repo/shared/now";
  return [...code.matchAll(/\bvi\s*\.\s*(mock|doMock)\s*\(/g)].flatMap(
    (call) => {
      const [whole, kind] = call;
      if (kind === "mock") {
        // 第 1 引数の文字列（' か "）。改行を挟んだ複数行の呼び出しも読む。
        const first = /^\s*(["'])([^"'\n]*)\1\s*[,)]/.exec(
          code.slice(call.index + whole.length),
        );
        if (first?.[2] === allowed) return [];
      }
      const line = lineAt(code, call.index);
      return hasWhyAbove(lines, line - 1)
        ? []
        : [{ rule: "vi-mock-only-now", line }];
    },
  );
}

// 実 Postgres のテスト用の DB を用意するモジュール（リポジトリ相対、拡張子なし）。
const TEST_DATABASE_MODULE = "apps/backend/test-support/database";

// test-support/database を import してよいファイルか。
// WHY infra の直下のテストだけ: 実 Postgres のテストは Repository（*.postgres.ts）と database.ts の隣に置く（testing.md の表）。
//   features/<f>/infra と shared/infra の 2 か所だけを許し、infra の下の入れ子、名前が infra の feature の別の層
//   （features/infra/application/）、別の層の下の infra/（features/x/application/infra/）は通さない。
// WHY apps/backend/test-support/ の直下のテストも許す: test-support/database.ts 自身のテスト（database.test.ts）が、テスト用の
//   スキーマの作成と後始末を実 Postgres で確かめる。
// WHY apps/backend/journeys/ の直下の *.journey.test.ts も許す（Issue #187）: ジャーニーテストは実 Postgres で API の流れを確かめる。
//   名前に .journey の無いテスト（journeys/x.test.ts）と、feature の下の journeys/（features/x/journeys/）は通さない。
//   置き場所を apps/backend/journeys/ の 1 か所にそろえ、そこに置けるのがジャーニーだけであることは rule-tests/journey.test.ts が見る。
function mayImportTestDatabase(path: string): boolean {
  return (
    path === "vitest.global-setup.ts" ||
    /^apps\/backend\/(?:(?:features\/[^/]+|shared)\/infra|test-support)\/[^/]+\.test\.tsx?$/.test(
      path,
    ) ||
    /^apps\/backend\/journeys\/[^/]+\.journey\.test\.ts$/.test(path)
  );
}

// 参照先をリポジトリ相対のパス（拡張子なし）にする。自前のコードでない参照（パッケージ）は undefined。
// WHY `@/` も解決する: frontend の paths（`@/*` → apps/frontend_customer/*）で `@/../backend/…` と書けば backend を指せる。
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const aliases: [string, string][] = [
    ["@repo/backend/", "apps/backend"],
    ["@/", "apps/frontend_customer"],
  ];
  const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
  const resolved = specifier.startsWith(".")
    ? posix.join(posix.dirname(from), specifier)
    : alias === undefined
      ? undefined
      : posix.join(alias[1], specifier.slice(alias[0].length));
  return resolved?.replace(/\.[cm]?[jt]sx?$/, "");
}

function findTestDatabaseImportViolations(
  path: string,
  code: string,
): TestDoubleViolation[] {
  // `from "…"`（import / import type / export … from）、`import "…"`、`import("…")` の参照先。
  const specifiers = code.matchAll(
    /(?:\bfrom|\bimport)\s*\(?\s*(["'])([^"'\n]+)\1/g,
  );
  return [...specifiers].flatMap((match) =>
    // WHY 解決したパスの完全一致で比べる: `database-x`・`test-support/database/x`・別の場所の `test-support/database` は別のモジュール。
    //   拡張子付きも同じもの。
    resolveSpecifier(path, match[2] ?? "") === TEST_DATABASE_MODULE
      ? [
          {
            rule: "db-tests-in-infra-only" as const,
            line: lineAt(code, match.index),
          },
        ]
      : [],
  );
}

// path はリポジトリ相対の / 区切り。規則ごとに対象のパスを絞り、違反を行の順に返す。
function findTestDoubleViolations(
  path: string,
  source: string,
): TestDoubleViolation[] {
  const code = stripLineComments(source);
  const violations = [
    ...(/^apps\/backend\/.+\.test\.tsx?$/.test(path)
      ? findViMockViolations(code, source.split("\n"))
      : []),
    ...(mayImportTestDatabase(path)
      ? []
      : findTestDatabaseImportViolations(path, code)),
  ];
  return violations.sort((a, b) => a.line - b.line);
}

// root の下を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリ（.next など）に入らない: 依存やビルド結果のテストは検査の対象ではなく、たどると遅い。
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

// 検査の対象: apps/ の下の *.test.ts / *.test.tsx と、リポジトリ直下の vitest.global-setup.ts（あれば）。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
// WHY vitest.global-setup.ts を含める: test-support/database を import してよい唯一のテスト以外のファイルで、
//   列挙に入れておかないと fixture と実リポジトリで「許可」が効いていることを確かめられない。
function listTestDoubleTargets(root: string): string[] {
  const tests = walk(root, "apps").filter((path) => /\.test\.tsx?$/.test(path));
  const globalSetup = existsSync(join(root, "vitest.global-setup.ts"))
    ? ["vitest.global-setup.ts"]
    : [];
  return [...tests, ...globalSetup].sort();
}

// 違反を「<規則>: <パス>:<行>」で返す。
function collectTestDoubleViolations(root: string): string[] {
  return listTestDoubleTargets(root).flatMap((path) =>
    findTestDoubleViolations(path, readFileSync(join(root, path), "utf8")).map(
      ({ rule, line }) => `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const DOMAIN_TEST = "apps/backend/features/x/domain/x.test.ts";
const APPLICATION_TEST =
  "apps/backend/features/x/application/x.command.test.ts";
const PRESENTATION_TEST = "apps/backend/features/x/presentation/x.api.test.ts";
const INFRA_TEST =
  "apps/backend/features/x/infra/x-repository.postgres.test.ts";
const SHARED_INFRA_TEST = "apps/backend/shared/infra/database.test.ts";
const TEST_SUPPORT = "../../../test-support/database";
const JOURNEY_TEST = "apps/backend/journeys/x.journey.test.ts";

describe("テストダブルの判定（findTestDoubleViolations）: must pass", () => {
  it.each([
    [
      'backend のテストの vi.mock("@repo/shared/now")',
      DOMAIN_TEST,
      source('import { vi } from "vitest";', 'vi.mock("@repo/shared/now");'),
    ],
    [
      'backend のテストの vi.mock("@repo/shared/now", { spy: true })',
      INFRA_TEST,
      source('vi.mock("@repo/shared/now", { spy: true });'),
    ],
    [
      "' で囲んだ vi.mock('@repo/shared/now')",
      APPLICATION_TEST,
      source("vi.mock('@repo/shared/now');"),
    ],
    [
      '複数行の vi.mock("@repo/shared/now", { spy: true })',
      PRESENTATION_TEST,
      source("vi.mock(", '  "@repo/shared/now",', "  { spy: true },", ");"),
    ],
    [
      "コメントの中の vi.mock( / vi.doMock(",
      APPLICATION_TEST,
      source(
        '// vi.mock("../infra/x-repository.postgres") は使わない。',
        'const a = 1; // vi.doMock("./x") も使わない',
      ),
    ],
    [
      "vi.mocked / vi.spyOn / vi.fn（vi.mock ではない）",
      APPLICATION_TEST,
      source(
        "vi.mocked(now).mockReturnValue(date);",
        'vi.spyOn(console, "error");',
        "const f = vi.fn();",
      ),
    ],
    [
      "vi.doMock の直前の行に // WHY モック: がある（複数行の WHY のコメントの途中）",
      PRESENTATION_TEST,
      source(
        "  // Repository を、受け取った db を記録するサブクラスに差し替える。",
        "  // WHY モック: api ファイルは Repository の実体を export しないので、サブクラスに差し替えて結線を確かめる。",
        "  //   Repository の振る舞いは確かめない。",
        '  vi.doMock("../infra/x-repository.postgres", async (importOriginal) => {',
        "  });",
      ),
    ],
    [
      "vi.mock（now 以外）の直前の行に // WHY モック: がある",
      APPLICATION_TEST,
      source(
        "// WHY モック: InMemory で起こせない失敗の経路。",
        'vi.mock("../infra/x-repository.postgres");',
      ),
    ],
    [
      "vi.doUnmock / vi.unmock（差し替えを戻すだけ）",
      PRESENTATION_TEST,
      source(
        'vi.doUnmock("../infra/x-repository.postgres");',
        'vi.unmock("../infra/x-repository.postgres");',
      ),
    ],
    [
      'apps/shared のテストの vi.mock("./now")（vi-mock-only-now は backend だけ）',
      "apps/shared/logger.test.ts",
      source('vi.mock("./now");'),
    ],
    [
      "frontend のテストの vi.mock（api/ の境界。vi-mock-only-now は backend だけ）",
      "apps/frontend_customer/features/x/screens/x-screen/x-screen.test.tsx",
      source('vi.mock("@/features/x/api/x-api");'),
    ],
    [
      "backend のテストでないファイルの vi.mock（対象外）",
      "apps/backend/features/x/domain/x.ts",
      source('vi.mock("./y");'),
    ],
    [
      "features/<f>/infra のテストから test-support/database を import",
      INFRA_TEST,
      source(
        "import {",
        "  createTestDatabase,",
        "  type TestDatabase,",
        `} from "${TEST_SUPPORT}";`,
      ),
    ],
    [
      "shared/infra のテストから ../../test-support/database を import",
      SHARED_INFRA_TEST,
      source(
        'import { createTestDatabase } from "../../test-support/database";',
      ),
    ],
    [
      "infra のテストから @repo/backend/test-support/database（拡張子付き）を import",
      INFRA_TEST,
      source(
        'import { createTestDatabase } from "@repo/backend/test-support/database.ts";',
      ),
    ],
    [
      "test-support 自身のテストから ./database を import",
      "apps/backend/test-support/database.test.ts",
      source('import { createTestDatabase } from "./database";'),
    ],
    [
      "apps/backend/journeys/ のジャーニーテストから ../test-support/database を import",
      JOURNEY_TEST,
      source(
        "import {",
        "  createTestDatabase,",
        "  type TestDatabase,",
        '} from "../test-support/database";',
      ),
    ],
    [
      "vitest.global-setup.ts から test-support/database を import",
      "vitest.global-setup.ts",
      source(
        'import { cleanupTestSchemas } from "./apps/backend/test-support/database";',
      ),
    ],
    [
      "application のテストのコメントの中の test-support/database の import",
      APPLICATION_TEST,
      source(`// import { createTestDatabase } from "${TEST_SUPPORT}";`),
    ],
    [
      "application のテストから名前・場所の一部が同じ別のモジュール（shared/infra/database・database-x・database/x・別の場所の test-support/database・パッケージ・以前の置き場所）",
      APPLICATION_TEST,
      source(
        'import { getDatabase } from "../../../shared/infra/database";',
        'import { a } from "../../../test-support/database-x";',
        'import { b } from "../../../test-support/database/x";',
        'import { c } from "./test-support/database";',
        'import { d } from "test-support/database";',
        'import { e } from "@repo/backend-extra/test-support/database";',
        'import { f } from "../../../shared/infra/database.test-support";',
      ),
    ],
  ])("%s は違反なし", (_name, path, text) => {
    expect(findTestDoubleViolations(path, text)).toEqual([]);
  });
});

describe("テストダブルの判定（findTestDoubleViolations）: must reject", () => {
  it.each<[string, string, string, TestDoubleViolation[]]>([
    [
      "application のテストで Postgres の Repository を vi.mock",
      APPLICATION_TEST,
      source(
        'import { vi } from "vitest";',
        'vi.mock("../infra/x-repository.postgres");',
      ),
      [{ rule: "vi-mock-only-now", line: 2 }],
    ],
    [
      "presentation のテストで @repo/shared/logger を vi.mock（now 以外の apps/shared）",
      PRESENTATION_TEST,
      source('vi.mock("@repo/shared/logger");'),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      'backend のテストで apps/shared の中の書き方 vi.mock("./now")',
      DOMAIN_TEST,
      source('vi.mock("./now");'),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      "前方一致だけが同じ別のモジュール（@repo/shared/now-x）",
      DOMAIN_TEST,
      source('vi.mock("@repo/shared/now-x");'),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      '文字列リテラルでない第 1 引数（vi.mock(import("@repo/shared/now"))）',
      DOMAIN_TEST,
      source('vi.mock(import("@repo/shared/now"));'),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      "テンプレートリテラルの第 1 引数",
      DOMAIN_TEST,
      source("vi.mock(`@repo/shared/now`);"),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      "vi.doMock は @repo/shared/now でも違反",
      DOMAIN_TEST,
      source('vi.doMock("@repo/shared/now");'),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      "空白を挟んだ vi . mock (",
      INFRA_TEST,
      source('vi . mock ( "../x" );'),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      "複数行の vi.mock（vi.mock( の行を報告する）",
      APPLICATION_TEST,
      source(
        "const a = 1;",
        "vi.mock(",
        '  "../infra/x-repository.postgres",',
        ");",
      ),
      [{ rule: "vi-mock-only-now", line: 2 }],
    ],
    [
      "shared/infra のテストで外部のパッケージ（pg）を vi.mock",
      SHARED_INFRA_TEST,
      source('vi.mock("pg");'),
      [{ rule: "vi-mock-only-now", line: 1 }],
    ],
    [
      "WHY の見出しが別の規則（任意）",
      APPLICATION_TEST,
      source(
        "// WHY 任意: InMemory で起こせない。",
        'vi.mock("../infra/x-repository.postgres");',
      ),
      [{ rule: "vi-mock-only-now", line: 2 }],
    ],
    [
      "WHY モック: の理由が空",
      APPLICATION_TEST,
      source("// WHY モック:", 'vi.mock("../infra/x-repository.postgres");'),
      [{ rule: "vi-mock-only-now", line: 2 }],
    ],
    [
      "WHY のコメントと vi.doMock( の行の間に空行がある",
      PRESENTATION_TEST,
      source(
        "// WHY モック: サブクラスに差し替えて結線を確かめる。",
        "",
        'vi.doMock("../infra/x-repository.postgres");',
      ),
      [{ rule: "vi-mock-only-now", line: 3 }],
    ],
    [
      "WHY が同じ行の末尾・ブロックコメント",
      APPLICATION_TEST,
      source(
        'vi.mock("../x"); // WHY モック: 同じ行の末尾',
        "/* WHY モック: ブロックコメント */",
        'vi.mock("../y");',
      ),
      [
        { rule: "vi-mock-only-now", line: 1 },
        { rule: "vi-mock-only-now", line: 3 },
      ],
    ],
    [
      "WHY は直後の 1 つの呼び出しだけに効く",
      APPLICATION_TEST,
      source(
        "// WHY モック: InMemory で起こせない失敗の経路。",
        'vi.mock("../x");',
        'vi.mock("../y");',
      ),
      [{ rule: "vi-mock-only-now", line: 3 }],
    ],
    [
      "application のテストから test-support/database を import（値）",
      APPLICATION_TEST,
      source(`import { createTestDatabase } from "${TEST_SUPPORT}";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "presentation のテストから import type",
      PRESENTATION_TEST,
      source(`import type { TestDatabase } from "${TEST_SUPPORT}";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "domain のテストから拡張子付き（.ts）で import",
      DOMAIN_TEST,
      source(`import { createTestDatabase } from "${TEST_SUPPORT}.ts";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "application のテストから dynamic import() と副作用の import",
      APPLICATION_TEST,
      source(
        `const m = await import("${TEST_SUPPORT}");`,
        `import "${TEST_SUPPORT}";`,
      ),
      [
        { rule: "db-tests-in-infra-only", line: 1 },
        { rule: "db-tests-in-infra-only", line: 2 },
      ],
    ],
    [
      "application のテストから export … from",
      APPLICATION_TEST,
      source(`export { createTestDatabase } from "${TEST_SUPPORT}";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "複数行の import（from の行を報告する）",
      APPLICATION_TEST,
      source(
        "import {",
        "  createTestDatabase,",
        "  type TestDatabase,",
        `} from "${TEST_SUPPORT}";`,
      ),
      [{ rule: "db-tests-in-infra-only", line: 4 }],
    ],
    [
      "application のテストから @repo/backend/test-support/database を import",
      APPLICATION_TEST,
      source(
        'import { createTestDatabase } from "@repo/backend/test-support/database";',
      ),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "frontend のテストから相対パスと @/../backend/ で import",
      "apps/frontend_customer/features/x/x.hook.test.ts",
      source(
        'import { createTestDatabase } from "../../../backend/test-support/database";',
        'import { a } from "@/../backend/test-support/database";',
      ),
      [
        { rule: "db-tests-in-infra-only", line: 1 },
        { rule: "db-tests-in-infra-only", line: 2 },
      ],
    ],
    [
      "test-support の下の入れ子のテストから import（test-support の直下だけ）",
      "apps/backend/test-support/nested/x.test.ts",
      source('import { createTestDatabase } from "../database";'),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "infra の下の入れ子のテストから import（infra の直下だけ）",
      "apps/backend/features/x/infra/nested/x.test.ts",
      source(`import { createTestDatabase } from "../${TEST_SUPPORT}";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "名前が infra の feature の application のテストから import",
      "apps/backend/features/infra/application/x.test.ts",
      source(`import { createTestDatabase } from "${TEST_SUPPORT}";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "別の層の下の infra/ のテストから import（features/x/application/infra/）",
      "apps/backend/features/x/application/infra/x.test.ts",
      source(`import { createTestDatabase } from "../${TEST_SUPPORT}";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "apps/backend/journeys/ の .journey の無いテストから import",
      "apps/backend/journeys/x.test.ts",
      source('import { createTestDatabase } from "../test-support/database";'),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "feature の下の journeys/ のジャーニーテストから import（apps/backend/journeys/ の直下だけ）",
      "apps/backend/features/x/journeys/x.journey.test.ts",
      source(`import { createTestDatabase } from "${TEST_SUPPORT}";`),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "apps/backend/journeys/ の下の入れ子のジャーニーテストから import",
      "apps/backend/journeys/nested/x.journey.test.ts",
      source(
        'import { createTestDatabase } from "../../test-support/database";',
      ),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "vitest.global-setup.ts と名前だけ違う別のファイル（.mts）から import",
      "vitest.global-setup.mts",
      source(
        'import { cleanupTestSchemas } from "./apps/backend/test-support/database";',
      ),
      [{ rule: "db-tests-in-infra-only", line: 1 }],
    ],
    [
      "1 つのファイルに両方の違反（行の順に返す）",
      APPLICATION_TEST,
      source(
        `import { createTestDatabase } from "${TEST_SUPPORT}";`,
        'vi.mock("../infra/x-repository.postgres");',
      ),
      [
        { rule: "db-tests-in-infra-only", line: 1 },
        { rule: "vi-mock-only-now", line: 2 },
      ],
    ],
  ])("%s は違反", (_name, path, text, expected) => {
    expect(findTestDoubleViolations(path, text)).toEqual(expected);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（テストファイルと vitest.global-setup.ts の見つけ方）が漏れれば見逃す。一時ディレクトリに
//   架空のツリーを置き、本番と同じ collectTestDoubleViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("テストファイルの列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "test-doubles-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const importTestSupport = `import { createTestDatabase } from "${TEST_SUPPORT}";`;

  it("apps/ のテストと vitest.global-setup.ts を対象にし、違反を「規則: パス:行」で返す", () => {
    const root = fixture({
      [DOMAIN_TEST]: source('vi.mock("@repo/shared/now");'),
      [APPLICATION_TEST]: source(
        importTestSupport,
        'vi.mock("../infra/x-repository.postgres");',
      ),
      [PRESENTATION_TEST]: source(
        'vi.mock("@repo/shared/now", { spy: true });',
        `import type { TestDatabase } from "${TEST_SUPPORT}";`,
        "// WHY モック: サブクラスに差し替えて結線を確かめる。",
        'vi.doMock("../infra/x-repository.postgres");',
        'vi.doMock("../infra/x-repository.postgres");',
      ),
      [INFRA_TEST]: source(
        importTestSupport,
        'vi.mock("@repo/shared/now", { spy: true });',
      ),
      [SHARED_INFRA_TEST]: source(
        'import { createTestDatabase } from "../../test-support/database";',
      ),
      "apps/backend/test-support/database.test.ts": source(
        'import { createTestDatabase } from "./database";',
      ),
      "apps/backend/features/x/domain/y.test.ts": source(
        "",
        'vi.doMock("@repo/shared/now");',
      ),
      "vitest.global-setup.ts": source(
        'import { cleanupTestSchemas } from "./apps/backend/test-support/database";',
      ),
      [JOURNEY_TEST]: source(
        'import { createTestDatabase } from "../test-support/database";',
      ),
      "apps/backend/journeys/y.test.ts": source(
        'import { createTestDatabase } from "../test-support/database";',
      ),
      "apps/frontend_customer/features/x/x.hook.test.ts": source(
        'vi.mock("@/features/x/api/x-api");',
      ),
      "apps/frontend_customer/features/x/x-screen.test.tsx": source(
        'import { a } from "../../../backend/test-support/database";',
      ),
      "apps/shared/logger.test.ts": source('vi.mock("./now");'),
      // 対象外: テストでないファイル（backend のソース・テスト基盤・spec）、node_modules と . で始まるディレクトリの中。
      "apps/backend/features/x/domain/x.ts": source(
        'vi.mock("./y");',
        importTestSupport,
      ),
      "apps/backend/test-support/database.ts": source('vi.mock("pg");'),
      "apps/e2e/x.spec.ts": source('vi.mock("./y");'),
      "apps/backend/node_modules/x/x.test.ts": source('vi.mock("./y");'),
      "apps/frontend_customer/.next/x.test.ts": source(importTestSupport),
    });
    expect({
      files: listTestDoubleTargets(root),
      violations: collectTestDoubleViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/x/application/x.command.test.ts",
        "apps/backend/features/x/domain/x.test.ts",
        "apps/backend/features/x/domain/y.test.ts",
        "apps/backend/features/x/infra/x-repository.postgres.test.ts",
        "apps/backend/features/x/presentation/x.api.test.ts",
        "apps/backend/journeys/x.journey.test.ts",
        "apps/backend/journeys/y.test.ts",
        "apps/backend/shared/infra/database.test.ts",
        "apps/backend/test-support/database.test.ts",
        "apps/frontend_customer/features/x/x-screen.test.tsx",
        "apps/frontend_customer/features/x/x.hook.test.ts",
        "apps/shared/logger.test.ts",
        "vitest.global-setup.ts",
      ],
      violations: [
        "db-tests-in-infra-only: apps/backend/features/x/application/x.command.test.ts:1",
        "vi-mock-only-now: apps/backend/features/x/application/x.command.test.ts:2",
        "vi-mock-only-now: apps/backend/features/x/domain/y.test.ts:2",
        "db-tests-in-infra-only: apps/backend/features/x/presentation/x.api.test.ts:2",
        "vi-mock-only-now: apps/backend/features/x/presentation/x.api.test.ts:5",
        "db-tests-in-infra-only: apps/backend/journeys/y.test.ts:1",
        "db-tests-in-infra-only: apps/frontend_customer/features/x/x-screen.test.tsx:1",
      ],
    });
  });

  it("apps/ も vitest.global-setup.ts も無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listTestDoubleTargets(root),
      violations: collectTestDoubleViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("テストダブル（実ファイル）", () => {
  it("backend のテストの vi.mock は @repo/shared/now だけ、test-support/database の import は infra のテスト・test-support のテスト・ジャーニーテスト・global-setup だけ", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    const files = listTestDoubleTargets(repoRoot);
    expect(files).toContain("apps/backend/features/todo/domain/todo.test.ts");
    expect(files).toContain(
      "apps/backend/features/todo/infra/todo-repository.postgres.test.ts",
    );
    expect(files).toContain("vitest.global-setup.ts");
    expect(files).toContain("apps/backend/test-support/database.test.ts");
    expect(files).toContain(
      "apps/backend/journeys/todo-lifecycle.journey.test.ts",
    );
    expect(collectTestDoubleViolations(repoRoot)).toEqual([]);
  });
});
