// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはファイルの一覧とソースを文字列として読むだけで
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
import { afterAll, describe, expect, it } from "vitest";

// ジャーニーテスト（Issue #187。.claude/rules/testing.md の「ジャーニーテスト」、ADR docs/adr/quality/20260930-backend-journey-tests.md）の
//   置き場所と形を、ファイルの一覧とソースで機械的に検査するテスト。
// ジャーニーテスト = 実 Postgres の上で、複数の API の handler（XxxApi.handle）を業務ユースケースに沿って順に呼ぶテスト。
// 違反にするもの:
//   - journey-placement: apps/backend/journeys/ の下には、直下の *.journey.test.ts だけを置く。サブディレクトリの中のファイル・
//     テスト以外のファイル（補助の .ts・.md も）・名前に .journey の無いテスト（x.test.ts）・.tsx は違反。apps/ の下のほかの場所
//     （features/x/journeys/ など）に *.journey.test.* を置くのも違反。
//     WHY 置き場所を 1 か所にする: ジャーニーは feature をまたぐ業務の流れを置く場所で、features/<f>/ の下では feature をまたげない。
//       直下のジャーニーだけにすると、test-support/database の import の例外（rule-tests/test-doubles.test.ts の db-tests-in-infra-only）も
//       この 1 か所に絞れる。共通の補助が要るようになったら apps/backend/test-support/ に置く（journeys/ に置かない）。
//     WHY テスト以外のソースも止める（architecture.test.ts の backend-placement でも止まるが、ここでも見る）: .md など
//       ソースでないファイルは backend-placement の対象外で、journeys/ を別の用途の置き場所にさせないため。
//   以下はジャーニー（apps/backend/journeys/ の直下の *.journey.test.ts）の中身の規則:
//   - journey-no-in-memory: *.in-memory（InMemory の Repository）を import しない（`import type` も・`import()` も・`export … from` も）。
//     WHY: ジャーニーは本番と同じ部品（Postgres の Repository）で API のつながりを確かめる。InMemory で組むと単体テストと同じになる。
//     WHY import type も違反: 型だけでも InMemory で組み立てる形の入口になる。ジャーニーに InMemory の型が要る場面は無い。
//   - journey-no-mock: `vi.mock(` / `vi.doMock(` を使わない（引数によらない。@repo/shared/now も違反）。
//     WHY: 差し替えた部分のつながりを確かめなくなる。時計も差し替えず、実時計のままで成り立つ流れを書く（作成順は
//       todo-lifecycle.journey.test.ts の waitUntilAfter のように実時計が進むのを待つ）。
//   - journey-uses-multiple-apis: 異なる *.api モジュール（presentation の api ファイル）を 2 つ以上、値として import する。
//     WHY: 1 つの API だけなら presentation の単体テスト（*.api.test.ts）の範囲で、ジャーニー（複数の API の流れ）ではない。
//     数え方: 参照先を解決したパス（拡張子なし）で数える（`./x.api` と `./x.api.ts` は 1 つ）。`import type` と、すべてに inline の
//       type が付いたもの（`{ type A }`）は数えない（handler を呼べない）。
//   - journey-uses-real-database: apps/backend/test-support/database（createTestDatabase）を値として import する。
//     WHY: 実 DB で流れを確かめるのがジャーニーの目的。型だけの import（TestDatabase）では実 DB を用意しない。
// コメントの扱い: 行コメントとブロックコメントの中は見ない（文字列は残す。architecture.test.ts の stripComments と同じ）。
//   コメントの中の `vi.mock(` や import は違反にも、必須の import にも数えない。文字列の中の `vi.mock(` は違反と数える（安全側）。
// 限界: `vi` を別名で import する・`vi["mock"]` と書く・require で読む・変数を渡す `import(x)` は見ない。
//   「業務ユースケースに沿っているか」「応答で確かめているか（SQL で覗いていないか）」は見ない（reviewer が見る）。
// WHY 文字列で判定する（AST にしない）: 見るのはパスと import の参照先と `vi.mock(` だけで、正規表現で足りる
//   （rule-tests/test-doubles.test.ts と同じ）。

type JourneyRuleId =
  | "journey-placement"
  | "journey-no-in-memory"
  | "journey-no-mock"
  | "journey-uses-multiple-apis"
  | "journey-uses-real-database";

// line: ソースの中の位置で決まる違反だけ持つ（1 始まり）。ファイル全体で決まる違反（置き場所・必須の import）は持たない。
type JourneyViolation = { rule: JourneyRuleId; line?: number };

const JOURNEYS_DIR = "apps/backend/journeys/";

// ジャーニーのファイルか（apps/backend/journeys/ の直下の *.journey.test.ts）。
function isJourneyFile(path: string): boolean {
  return /^apps\/backend\/journeys\/[^/]+\.journey\.test\.ts$/.test(path);
}

// path（リポジトリ相対、/ 区切り）が置き場所の規則に違反するか。
function isMisplacedJourneyFile(path: string): boolean {
  if (path.startsWith(JOURNEYS_DIR)) {
    return !isJourneyFile(path);
  }
  // WHY 拡張子を広く取る: .tsx・.js などで journeys/ の外に置いても、置き場所の違反として見つける。
  return /\.journey\.test\.[cm]?[jt]sx?$/.test(path);
}

// コメントを消す（文字列は残す。改行は残して行番号を変えない）。architecture.test.ts の stripComments と同じ正規表現。
// WHY 文字列を先に一致させる: 文字列の中の "//"（"http://localhost" など）をコメントの開始と誤認しない。
function stripComments(source: string): string {
  const stringOrComment =
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(stringOrComment, (match, literal?: string) =>
    literal === undefined ? match.replace(/[^\n]/g, " ") : literal,
  );
}

// import の種類。value: 値の名前を 1 つ以上取る静的な import（handler を呼べる）。type: `import type` か、すべてに inline の type。
//   other: 副作用だけの import・dynamic import()・export … from（参照はするが、値の名前を手元に取らない静的な import ではない）。
type ImportKind = "value" | "type" | "other";

type ImportRef = { specifier: string; kind: ImportKind; line: number };

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// `{ type A, type B }` のように、名前の並びだけで、すべてに inline の type が付いているか（architecture.test.ts の isInlineTypeOnly と同じ）。
function isInlineTypeOnly(clause: string): boolean {
  const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (braces === null) {
    return false;
  }
  const names = (braces[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

// ソース（コメントを消したもの）の import / export … from / import "…" / import("…") の参照先。
// 正規表現の WHY（<句> の文字を限定する・文の先頭に限る）は architecture.test.ts の IMPORT_EXPORT_FROM のコメント。
function extractImports(code: string): ImportRef[] {
  const staticImports = [
    ...code.matchAll(
      /(?:^|;)\s*(import|export)\s+(type\s+)?((?:(?!^\s*(?:import|export)\b)[\w\s{},*$])*?)\s*\bfrom\s*(["'])([^"'\n]+)\4/gm,
    ),
  ].map((match): ImportRef => {
    const [whole, keyword, typeKeyword, clause, , specifier = ""] = match;
    const kind: ImportKind =
      keyword === "export"
        ? "other"
        : typeKeyword !== undefined || isInlineTypeOnly(clause ?? "")
          ? "type"
          : "value";
    return {
      specifier,
      kind,
      // WHY 参照先の位置で行を数える: 一致は前の空行（\s*）から始まることがあり、先頭の位置では import の行とずれる。
      line: lineAt(code, match.index + whole.lastIndexOf(specifier)),
    };
  });
  const otherImports = [
    ...code.matchAll(/\bimport\s*(["'])([^"'\n]+)\1/g),
    ...code.matchAll(/\bimport\s*\(\s*(["'`])([^"'`$\n]+)\1\s*[,)]/g),
  ].map(
    (match): ImportRef => ({
      specifier: match[2] ?? "",
      kind: "other",
      line: lineAt(code, match.index),
    }),
  );
  return [...staticImports, ...otherImports];
}

// 参照先の最後の要素から拡張子を除いた名前（"../x/todo-repository.in-memory.ts" → "todo-repository.in-memory"）。
function moduleBaseName(specifier: string): string {
  return (specifier.split("/").pop() ?? "").replace(/\.[cm]?[jt]sx?$/, "");
}

// 参照先をリポジトリ相対のパス（拡張子なし）にする。自前のコードでない参照（パッケージ）は undefined。
// WHY 解決して比べる: `../test-support/database` と `@repo/backend/test-support/database` は同じモジュール。書き方の文字列で
//   比べると、書き方を変えるだけで必須の import を満たせなくなり、同じ api を別の書き方で 2 回 import して 2 つと数えてしまう。
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const alias = "@repo/backend/";
  const resolved = specifier.startsWith(".")
    ? posix.join(posix.dirname(from), specifier)
    : specifier.startsWith(alias)
      ? posix.join("apps/backend", specifier.slice(alias.length))
      : undefined;
  return resolved?.replace(/\.[cm]?[jt]sx?$/, "");
}

// 実 Postgres のテスト用の DB を用意するモジュール（リポジトリ相対、拡張子なし）。
const TEST_DATABASE_MODULE = "apps/backend/test-support/database";

// ジャーニー（isJourneyFile のファイル）の中身の違反。行のあるものを行の順に、その後にファイル全体の違反を返す。
function findJourneyContentViolations(
  path: string,
  source: string,
): JourneyViolation[] {
  const code = stripComments(source);
  const imports = extractImports(code);
  const inMemory = imports
    .filter((ref) => /\.in-memory$/.test(moduleBaseName(ref.specifier)))
    .map(
      (ref): JourneyViolation => ({
        rule: "journey-no-in-memory",
        line: ref.line,
      }),
    );
  const mocks = [...code.matchAll(/\bvi\s*\.\s*(?:mock|doMock)\s*\(/g)].map(
    (call): JourneyViolation => ({
      rule: "journey-no-mock",
      line: lineAt(code, call.index),
    }),
  );
  const valueModules = imports
    .filter((ref) => ref.kind === "value")
    .map((ref) => resolveSpecifier(path, ref.specifier));
  const apis = new Set(
    valueModules.filter(
      (module) => module !== undefined && /\.api$/.test(posix.basename(module)),
    ),
  );
  const fileLevel: JourneyViolation[] = [
    ...(apis.size >= 2
      ? []
      : [{ rule: "journey-uses-multiple-apis" as const }]),
    ...(valueModules.includes(TEST_DATABASE_MODULE)
      ? []
      : [{ rule: "journey-uses-real-database" as const }]),
  ];
  const lineLevel = [...inMemory, ...mocks].sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0),
  );
  return [...lineLevel, ...fileLevel];
}

// path の違反。置き場所が違えば置き場所の違反だけを返し（中身は見ない）、ジャーニーなら中身を見る。対象外のファイルは []。
function findJourneyViolations(
  path: string,
  source: string,
): JourneyViolation[] {
  if (isMisplacedJourneyFile(path)) {
    return [{ rule: "journey-placement" }];
  }
  return isJourneyFile(path) ? findJourneyContentViolations(path, source) : [];
}

// root の下の dir を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリ（.next など）に入らない: 依存やビルド結果は検査の対象ではなく、たどると遅い
//   （rule-tests/test-doubles.test.ts の walk と同じ）。
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

// 検査の対象: apps/ の下のファイルのうち、apps/backend/journeys/ の下にあるものと、名前が *.journey.test.* のもの。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listJourneyTargets(root: string): string[] {
  return walk(root, "apps")
    .filter(
      (path) =>
        path.startsWith(JOURNEYS_DIR) ||
        /\.journey\.test\.[cm]?[jt]sx?$/.test(path),
    )
    .sort();
}

// 違反を「<規則>: <パス>」か「<規則>: <パス>:<行>」で返す。
function collectJourneyViolations(root: string): string[] {
  return listJourneyTargets(root).flatMap((path) =>
    findJourneyViolations(path, readFileSync(join(root, path), "utf8")).map(
      ({ rule, line }) =>
        line === undefined ? `${rule}: ${path}` : `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const JOURNEY = "apps/backend/journeys/x.journey.test.ts";
const CREATE_API = "../features/x/presentation/create-x.api";
const LIST_API = "../features/x/presentation/list-x.api";
// ジャーニーの必須の import（実 DB と 2 つの api）。must reject の例は、これに違反を 1 つ足すか、どれかを欠く。
const DATABASE_IMPORT =
  'import { createTestDatabase } from "../test-support/database";';
const CREATE_API_IMPORT = `import { CreateXApi } from "${CREATE_API}";`;
const LIST_API_IMPORT = `import { ListXApi } from "${LIST_API}";`;
const REQUIRED_IMPORTS = [DATABASE_IMPORT, CREATE_API_IMPORT, LIST_API_IMPORT];

describe("ジャーニーの置き場所（isMisplacedJourneyFile）", () => {
  it.each([
    ["apps/backend/journeys/ の直下の *.journey.test.ts", JOURNEY],
    [
      "apps/backend/ の層の下の普通のテスト",
      "apps/backend/features/x/presentation/x.api.test.ts",
    ],
    ["apps/backend/ のソース", "apps/backend/features/x/domain/x.ts"],
    [
      "名前に journey を含むが *.journey.test.* ではないファイル",
      "apps/backend/features/journey/domain/journey.test.ts",
    ],
  ])("%s は違反なし", (_name, path) => {
    expect(isMisplacedJourneyFile(path)).toBe(false);
  });

  it.each([
    ["journeys/ の .journey の無いテスト", "apps/backend/journeys/x.test.ts"],
    ["journeys/ のテスト以外のソース", "apps/backend/journeys/helper.ts"],
    ["journeys/ の .md", "apps/backend/journeys/README.md"],
    [
      "journeys/ のサブディレクトリの中のジャーニー",
      "apps/backend/journeys/todo/x.journey.test.ts",
    ],
    [
      "journeys/ の .tsx のジャーニー",
      "apps/backend/journeys/x.journey.test.tsx",
    ],
    [
      "feature の下の journeys/ のジャーニー",
      "apps/backend/features/x/journeys/x.journey.test.ts",
    ],
    [
      "apps/backend/ の直下以外の journeys/（shared/journeys/）",
      "apps/backend/shared/journeys/x.journey.test.ts",
    ],
    [
      "frontend のジャーニー",
      "apps/frontend_customer/features/x/x.journey.test.tsx",
    ],
  ])("%s は違反", (_name, path) => {
    expect(isMisplacedJourneyFile(path)).toBe(true);
  });
});

describe("ジャーニーの中身（findJourneyViolations）: must pass", () => {
  it.each([
    ["実 DB と 2 つの api を値で import", source(...REQUIRED_IMPORTS)],
    [
      "複数行の import・type の混じった import・@repo/backend/ の書き方",
      source(
        "import {",
        "  createTestDatabase,",
        "  type TestDatabase,",
        '} from "@repo/backend/test-support/database";',
        "import {",
        "  CreateXApi,",
        "  type CreateXResponse,",
        `} from "${CREATE_API}";`,
        'import { ListXApi } from "@repo/backend/features/x/presentation/list-x.api.ts";',
      ),
    ],
    [
      "別の feature の api を 1 つずつ（feature をまたぐ流れ）",
      source(
        DATABASE_IMPORT,
        'import { CreateXApi } from "../features/x/presentation/create-x.api";',
        'import { CreateYApi } from "../features/y/presentation/create-y.api";',
      ),
    ],
    [
      "Postgres の Repository・command / query を import（InMemory ではない）",
      source(
        ...REQUIRED_IMPORTS,
        'import { PostgresXRepository } from "../features/x/infra/x-repository.postgres";',
        'import { CreateXCommand } from "../features/x/application/create-x.command";',
      ),
    ],
    [
      "コメントの中の vi.mock( / vi.doMock( / InMemory の import（行コメントとブロックコメント）",
      source(
        ...REQUIRED_IMPORTS,
        '// vi.mock("@repo/shared/now") は使わない。',
        '/* vi.doMock("./x"); import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory"; */',
        'const url = "http://localhost"; // import "../features/x/infra/x-repository.in-memory";',
      ),
    ],
    [
      "vi.spyOn / vi.fn / vi.mocked（vi.mock ではない）",
      source(
        ...REQUIRED_IMPORTS,
        'vi.spyOn(console, "error");',
        "const f = vi.fn();",
      ),
    ],
    [
      "名前の一部だけが in-memory のモジュール（in-memory-x・x.in-memory-y）",
      source(
        ...REQUIRED_IMPORTS,
        'import { a } from "./in-memory-x";',
        'import { b } from "./x.in-memory-y";',
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findJourneyViolations(JOURNEY, text)).toEqual([]);
  });

  it("ジャーニーでないファイル（層の下のテスト）は中身を見ない", () => {
    expect(
      findJourneyViolations(
        "apps/backend/features/x/presentation/x.api.test.ts",
        source('vi.mock("./x");'),
      ),
    ).toEqual([]);
  });
});

describe("ジャーニーの中身（findJourneyViolations）: must reject", () => {
  it.each<[string, string, JourneyViolation[]]>([
    [
      "InMemory の Repository を値で import",
      source(
        ...REQUIRED_IMPORTS,
        'import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
      ),
      [{ rule: "journey-no-in-memory", line: 4 }],
    ],
    [
      "InMemory を import type で（型だけでも違反）",
      source(
        ...REQUIRED_IMPORTS,
        'import type { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
      ),
      [{ rule: "journey-no-in-memory", line: 4 }],
    ],
    [
      "InMemory を inline の type・拡張子付き・@repo/backend/ で",
      source(
        ...REQUIRED_IMPORTS,
        'import { type InMemoryXRepository } from "@repo/backend/features/x/infra/x-repository.in-memory.ts";',
      ),
      [{ rule: "journey-no-in-memory", line: 4 }],
    ],
    [
      "InMemory を dynamic import()・副作用の import・export … from（複数行）",
      source(
        ...REQUIRED_IMPORTS,
        'const m = await import("../features/x/infra/x-repository.in-memory");',
        'import "../features/x/infra/x-repository.in-memory";',
        "export {",
        "  InMemoryXRepository,",
        '} from "../features/x/infra/x-repository.in-memory";',
      ),
      [
        { rule: "journey-no-in-memory", line: 4 },
        { rule: "journey-no-in-memory", line: 5 },
        { rule: "journey-no-in-memory", line: 8 },
      ],
    ],
    [
      'vi.mock("@repo/shared/now")（時計も差し替えない）',
      source(
        ...REQUIRED_IMPORTS,
        'vi.mock("@repo/shared/now", { spy: true });',
      ),
      [{ rule: "journey-no-mock", line: 4 }],
    ],
    [
      "WHY モック: が付いた vi.doMock と、空白を挟んだ vi . mock (",
      source(
        ...REQUIRED_IMPORTS,
        "// WHY モック: ジャーニーでは例外を認めない。",
        'vi.doMock("../features/x/infra/x-repository.postgres");',
        'vi . mock ( "./x" );',
      ),
      [
        { rule: "journey-no-mock", line: 5 },
        { rule: "journey-no-mock", line: 6 },
      ],
    ],
    [
      "文字列の中の vi.mock(（安全側で違反）",
      source(...REQUIRED_IMPORTS, 'const s = "vi.mock(";'),
      [{ rule: "journey-no-mock", line: 4 }],
    ],
    [
      "api を 1 つだけ import",
      source(DATABASE_IMPORT, CREATE_API_IMPORT),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "同じ api を書き方を変えて 2 回（相対・拡張子付き・@repo/backend/）",
      source(
        DATABASE_IMPORT,
        `import { CreateXApi } from "${CREATE_API}";`,
        `import { type CreateXResponse } from "${CREATE_API}.ts";`,
        'import { CreateXApi as Api } from "@repo/backend/features/x/presentation/create-x.api";',
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "2 つ目の api が import type・inline の type だけ",
      source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        `import type { ListXResponse } from "${LIST_API}";`,
        'import { type GetXResponse } from "../features/x/presentation/get-x.api";',
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "2 つ目の api が副作用の import・dynamic import()・export … from",
      source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        `import "${LIST_API}";`,
        `const m = await import("${LIST_API}");`,
        `export { ListXApi } from "${LIST_API}";`,
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "api の単体テストや名前の一部だけが api のモジュール（x.api.test・x.api-helper・api）",
      source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        'import { a } from "../features/x/presentation/list-x.api.test";',
        'import { b } from "../features/x/presentation/x.api-helper";',
        'import { c } from "../features/x/presentation/api";',
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "api をコメントの中でだけ import",
      source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        `// import { ListXApi } from "${LIST_API}";`,
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "test-support/database を import しない",
      source(CREATE_API_IMPORT, LIST_API_IMPORT),
      [{ rule: "journey-uses-real-database" }],
    ],
    [
      "test-support/database を import type だけ",
      source(
        'import type { TestDatabase } from "../test-support/database";',
        CREATE_API_IMPORT,
        LIST_API_IMPORT,
      ),
      [{ rule: "journey-uses-real-database" }],
    ],
    [
      "名前・場所の一部だけが同じ別のモジュール（shared/infra/database・database-x・別の場所の test-support/database）",
      source(
        'import { getDatabase } from "../shared/infra/database";',
        'import { a } from "../test-support/database-x";',
        'import { b } from "./test-support/database";',
        CREATE_API_IMPORT,
        LIST_API_IMPORT,
      ),
      [{ rule: "journey-uses-real-database" }],
    ],
    [
      "空のファイル（すべての必須を欠く）",
      "",
      [
        { rule: "journey-uses-multiple-apis" },
        { rule: "journey-uses-real-database" },
      ],
    ],
    [
      "違反が重なる（行のある違反を行の順に、その後にファイル全体の違反）",
      source(
        'vi.mock("./x");',
        'import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
        CREATE_API_IMPORT,
      ),
      [
        { rule: "journey-no-mock", line: 1 },
        { rule: "journey-no-in-memory", line: 2 },
        { rule: "journey-uses-multiple-apis" },
        { rule: "journey-uses-real-database" },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findJourneyViolations(JOURNEY, text)).toEqual(expected);
  });

  it("置き場所が違えば置き場所の違反だけを返す（中身は見ない）", () => {
    expect(
      findJourneyViolations(
        "apps/backend/journeys/x.test.ts",
        'vi.mock("./x");',
      ),
    ).toEqual([{ rule: "journey-placement" }]);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（journeys/ の下と *.journey.test.* の見つけ方）が漏れれば見逃す。一時ディレクトリに架空の
//   ツリーを置き、本番と同じ collectJourneyViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("ジャーニーの列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "journey-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  it("journeys/ の下と *.journey.test.* を対象にし、違反を「規則: パス(:行)」で返す", () => {
    const root = fixture({
      [JOURNEY]: source(...REQUIRED_IMPORTS),
      "apps/backend/journeys/mock.journey.test.ts": source(
        ...REQUIRED_IMPORTS,
        'vi.mock("@repo/shared/now");',
      ),
      "apps/backend/journeys/single-api.journey.test.ts": source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        'import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
      ),
      "apps/backend/journeys/x.test.ts": source(...REQUIRED_IMPORTS),
      "apps/backend/journeys/helper.ts": "export const a = 1;\n",
      "apps/backend/journeys/nested/y.journey.test.ts": source(
        ...REQUIRED_IMPORTS,
      ),
      "apps/backend/features/x/journeys/x.journey.test.ts": source(
        ...REQUIRED_IMPORTS,
      ),
      // 対象外: 層の下のテスト（vi.mock があってもジャーニーではない）、node_modules と . で始まるディレクトリの中。
      "apps/backend/features/x/presentation/x.api.test.ts":
        source('vi.mock("./x");'),
      "apps/backend/node_modules/x/x.journey.test.ts": "",
      "apps/frontend_customer/.next/x.journey.test.ts": "",
    });
    expect({
      files: listJourneyTargets(root),
      violations: collectJourneyViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/x/journeys/x.journey.test.ts",
        "apps/backend/journeys/helper.ts",
        "apps/backend/journeys/mock.journey.test.ts",
        "apps/backend/journeys/nested/y.journey.test.ts",
        "apps/backend/journeys/single-api.journey.test.ts",
        "apps/backend/journeys/x.journey.test.ts",
        "apps/backend/journeys/x.test.ts",
      ],
      violations: [
        "journey-placement: apps/backend/features/x/journeys/x.journey.test.ts",
        "journey-placement: apps/backend/journeys/helper.ts",
        "journey-no-mock: apps/backend/journeys/mock.journey.test.ts:4",
        "journey-placement: apps/backend/journeys/nested/y.journey.test.ts",
        "journey-no-in-memory: apps/backend/journeys/single-api.journey.test.ts:3",
        "journey-uses-multiple-apis: apps/backend/journeys/single-api.journey.test.ts",
        "journey-placement: apps/backend/journeys/x.test.ts",
      ],
    });
  });

  it("apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listJourneyTargets(root),
      violations: collectJourneyViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("ジャーニー（実ファイル）", () => {
  it("apps/backend/journeys/ には *.journey.test.ts だけがあり、各ジャーニーは InMemory と vi.mock を使わず、実 DB と 2 つ以上の API を使う", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listJourneyTargets(repoRoot)).toContain(
      "apps/backend/journeys/todo-lifecycle.journey.test.ts",
    );
    expect(collectJourneyViolations(repoRoot)).toEqual([]);
  });
});
