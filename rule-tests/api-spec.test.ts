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
import { containsForbiddenWord } from "./feature-business-language";

// API 仕様テスト（Issue #219。.claude/rules/testing.md の「API 仕様テスト（api-specs）」、ADR
//   docs/adr/quality/20260930-api-spec-in-feature.md）の置き場所と形を、ファイルの一覧とソースで機械的に検査するテスト。
// API 仕様テスト = API 1 つ（apps/backend/features/<feature>/internal/presentation/<api>.api.ts）の振る舞いを、人が読む仕様として
//   Gherkin の <api>.feature に業務の言葉で書き、step の実装（<api>.api-spec.test.ts）が実 Postgres の上で本番の組み立てを通して
//   確かめるテスト。`*` の 1 行 = 1 つの振る舞い = 1 つのテスト（vitest-cucumber は step 1 つを Vitest の test 1 つにする）。
// 違反にするもの:
//   - api-spec-placement: apps/backend/api-specs/ の下には、<feature>/ の直下の <api>.feature・<api>.api-spec.test.ts・support.ts
//     （補助。名前は固定）だけを置く。api-specs/ の直下のファイル・<feature>/ の下のサブディレクトリの中のファイル・ほかの名前
//     （helper.ts・README.md・x.test.ts・.tsx・support.test.ts）は違反。apps/ の下のほかの場所（features/<f>/・api-journeys/・
//     frontend など）に *.api-spec.test.* を置くのも違反。
//     WHY 置き場所を 1 か所にする: 人が読む API 仕様を feature ごとに 1 つのディレクトリで一覧でき、test-support/database（実 DB）の
//       import の例外（rule-tests/test-doubles.test.ts の db-tests-in-infra-only）もこの 1 か所に絞れる。
//     WHY 補助は support.ts の 1 つに固定する: step の実装が共有する組み立て・DB の読み出しの置き場所を決め、api-specs/ を別の用途の
//       置き場所にさせない（Issue #219 の判断。test-support/ はテストダブルと DB 基盤の置き場所で、API 仕様だけの補助は置かない）。
//     WHY api-specs/ の外の .feature はここで見ない: rule-tests/api-journey.test.ts の api-journey-placement が止める（api-specs/ の下の
//       .feature だけを例外にしている）。
//   - api-spec-pair: apps/backend/features/<feature>/internal/presentation/<api>.api.ts の 1 つごとに、
//     apps/backend/api-specs/<feature>/<api>.feature と <api>.api-spec.test.ts の両方が要る（無いほうを api ファイルの違反にする）。
//     api-specs/ の <api>.feature・<api>.api-spec.test.ts に対の api ファイルが無ければ、そのファイルを違反にする（feature の
//     ディレクトリ名の違い・api の名前の違いも）。置き場所の違反のファイルは見ない。
//     WHY: 人が読む仕様を API ごとに漏れなく持つ（Issue #219。API を足したら仕様も足す）。.feature だけでは何も実行されず、step の
//       ファイルだけでは読む仕様が無い。api の無い仕様は、消した・改名した API の仕様が残ったもの。
//     限界: step のファイルが loadFeature に渡すパスが対の .feature かは見ない。presentation の下のサブディレクトリの api ファイルと、
//       apps/backend/shared/presentation/ の api ファイルは対の対象外（今は無い）。
//   以下は .feature（api-specs/<feature>/ の直下の *.feature）の中身の規則。行ごとに見る（行は 1 始まり）:
//   - api-spec-scenario-heading: `Scenario:` の見出し（`:` の後ろの前後の空白を除いた文字）が SCENARIO_HEADINGS（レスポンス /
//     ソート / 検索 / 記録 / 副作用 / 異常系）のどれでもなければ違反。同じ見出しの 2 つ目以降も違反（1 つの .feature に 1 回）。
//     WHY: API ごとに同じ観点の見出しで振る舞いを分けると、読む人がどの API でも同じ場所を拾い読みでき、観点の抜けも見出しで分かる。
//       見出しは読み取り（レスポンス / ソート / 検索 / 異常系）と書き込み（レスポンス / 記録 / 副作用 / 異常系）の観点（ユーザー判断、
//       2026-09-30 の work-logs）。該当の無い見出しは書かずに省く（見出しの有無・読み取りと書き込みの別は見ない）。
//   - api-spec-keyword: `Scenario Outline:` / `Scenario Template:` / `Rule:` / `Background:` / `Example:` / `Examples:` /
//     `Scenarios:` の行と、`# language:` の行は違反。
//     WHY: 形を「Feature の下に固定の見出しの Scenario と `*` の step」の 1 通りにし、見出しの一覧の検査を逃れる書き方（Example は
//       Scenario の別名）を止める。Background（共通の前提）と Outline（例の表）は、`*` の 1 行で前提から確かめまで完結させる形と
//       合わない。`# language:` はキーワードを別の言語に変え、この検査がキーワードを見分けられなくなる。
//   - api-spec-step-star: step が `*` 以外のキーワード（`Given` / `When` / `Then` / `And` / `But` で始まる行）なら違反。`*` の行が
//     1 つも無い Scenario も違反（行は Scenario の行）。
//     WHY: `*` の 1 行 = 1 つの振る舞い = 1 つのテストにし、Given / When / Then は step の実装の中で完結させる（ユーザー判断）。
//       step ごとに前提から確かめまで閉じるので、step の順に依存しない（Stryker の test ごとの絞り込みとも噛み合う見込み。
//       ADR docs/adr/quality/20260930-api-spec-in-feature.md）。`*` の無い Scenario は何も確かめない。
//   - api-spec-business-language: `#` のコメント行・空行・`Feature:` と `Scenario:` の見出しの行を除くすべての行（`*` の step・
//     説明の行・表の行・ほかのキーワードの行）に、FORBIDDEN_WORDS_IN_FEATURE（rule-tests/feature-business-language.ts。API ジャーニーの
//     api-journey-business-language と共有）の禁止語のどれかが含まれると違反（1 行 1 件）。3 桁の数（1xx〜5xx）の扱いも共有する。
//     WHY: .feature は業務の仕様として開発者でない人も読む（API ジャーニーと同じ。Issue #217）。
//     WHY Scenario の見出しを見ない: 見出しは固定の一覧（api-spec-scenario-heading）で、一覧の「レスポンス」が禁止語に当たる。
//     WHY Feature の見出しを見ない: Issue #219 の指定（対象は Feature / Scenario の見出し以外）。
//   以下は step の実装（api-specs/<feature>/ の直下の <api>.api-spec.test.ts）の中身の規則:
//   - api-spec-no-vi: `vitest` から `vi`（と同じものの別名 `vitest`）を import しない。別名・名前空間・既定の import・dynamic
//     `import("vitest")` も違反。`import type` と inline の `type` は通す（api-journey-no-vi と同じ判定）。
//     WHY: 仕様は本番と同じ部品のつながりで確かめる。テストダブル（vi.mock・spyOn・fake timers）は差し替えた部分を確かめなくする。
//   - api-spec-no-in-memory: *.in-memory（InMemory の Repository）を import しない（`import type`・`import()`・`export … from` も）。
//     WHY: 実 DB で本番の組み立てを通すのが API 仕様の目的（Issue #219。InMemory は presentation の単体テストの道具）。
//   - api-spec-uses-real-database: apps/backend/test-support/database（createTestDatabase）を値として import する。
//     WHY: 実 Postgres の上で確かめる。型だけの import（TestDatabase）では DB を用意しない。
//   - api-spec-uses-own-api: 対の api（apps/backend/features/<feature>/internal/presentation/<api>.api。ファイルの置き場所の <feature> と
//     名前の <api>）を静的な import で参照する（`import type`・inline の type だけでもよい。dynamic `import()`・`export … from` は数えない）。
//     ほかの api を足して import するのは可。
//     WHY: step のファイルと仕様の対象の API の対応を import で確かめる。組み立ては support.ts に任せてよい（Issue #219 の判断）ので、
//       型（応答の型）だけの参照も認める。本番の組み立てを通すことは、api-spec-uses-real-database・api-spec-no-in-memory と、次の
//       api-spec-support-assembles-apis で担保する。
//   以下は補助（api-specs/<feature>/ の直下の support.ts）の中身の規則:
//   - api-spec-support-assembles-apis: 自 feature の api（apps/backend/features/<feature>/internal/presentation/<名前>.api）を少なくとも
//     1 つ値として import する（`import type`・inline の type だけ・dynamic `import()`・`export … from` は数えない）。
//     WHY: step のファイルは組み立てを support.ts に任せ、api を型だけで参照してよい。support.ts が本番の api ファイル（Api のクラス）を
//       値で使わなければ、仕様が本番の組み立てを通さない（Api のクラスを通さず command を直接呼ぶ）形でも通ってしまう。
// コメントの扱い: .ts は行コメントとブロックコメントの中を見ない（文字列は残す。architecture.test.ts の stripComments と同じ）。
// 限界（字句の推定。rule-tests/api-journey.test.ts と同じ方式）:
//   - .feature: 行ごとに見るので、docstring（`"""`）の中も行の種類を区別しない（中の `#` の行はコメント、`Given` で始まる行は
//     step として扱う）。Feature の見出しの有無・Scenario の数（0 でも通る）・`*` の文が振る舞い 1 つかは見ない。禁止語は一覧の語だけ
//     （複数形・全角の英数字・一覧に無い技術の言葉は見ない）。
//   - step の実装: vi の import を require・変数を渡す `import(x)`・vitest のサブパスや別のモジュールの再公開で行うのは見ない。
//     `*` の step ごとに前提から確かめまで完結しているか・DB の行を確かめているかは見ない（reviewer が見る）。
//   - support.ts は api の値の import だけを見る（vi・InMemory の import は見ない。Issue #219 の指定は step のファイル）。値で import した
//     api のクラスを実際に組み立てに使っているか・どの api を step に渡しているかは見ない。step のファイルの api の import は型だけでも
//     通るので、step が対の api を実際に呼んでいるかは見ない（reviewer が見る）。step のファイルが support.ts 経由で
//     test-support/database を使っても、step のファイル自身に値の import が無ければ違反になる（直接 import する）。
// WHY 文字列で判定する（AST にしない）: 見るのはパス・行の先頭のキーワード・import の参照先だけで、正規表現で足りる
//   （rule-tests/api-journey.test.ts と同じ）。

type ApiSpecRuleId =
  | "api-spec-placement"
  | "api-spec-pair"
  | "api-spec-scenario-heading"
  | "api-spec-keyword"
  | "api-spec-step-star"
  | "api-spec-business-language"
  | "api-spec-no-vi"
  | "api-spec-no-in-memory"
  | "api-spec-uses-real-database"
  | "api-spec-uses-own-api"
  | "api-spec-support-assembles-apis";

// line: ソースの中の位置で決まる違反だけ持つ（1 始まり）。note: 対の違反で、無いファイル（対の相手）を示す。
type ApiSpecViolation = { rule: ApiSpecRuleId; line?: number; note?: string };

const API_SPECS_DIR = "apps/backend/api-specs/";

// Scenario の見出しの固定の一覧（api-spec-scenario-heading）。WHY は冒頭の説明。
const SCENARIO_HEADINGS: readonly string[] = [
  "レスポンス",
  "ソート",
  "検索",
  "記録",
  "副作用",
  "異常系",
];

// API 仕様の .feature か（api-specs/<feature>/ の直下の *.feature）。
function isSpecFeatureFile(path: string): boolean {
  return /^apps\/backend\/api-specs\/[^/]+\/[^/]+\.feature$/.test(path);
}

// API 仕様の step の実装か（api-specs/<feature>/ の直下の *.api-spec.test.ts）。
function isSpecStepFile(path: string): boolean {
  return /^apps\/backend\/api-specs\/[^/]+\/[^/]+\.api-spec\.test\.ts$/.test(
    path,
  );
}

// API 仕様の補助か（api-specs/<feature>/ の直下の support.ts）。
function isSpecSupportFile(path: string): boolean {
  return /^apps\/backend\/api-specs\/[^/]+\/support\.ts$/.test(path);
}

// api-specs/ の外で、置いてあれば置き場所の違反になる名前。WHY 拡張子を広く取る: .tsx・.js で外に置いても見つける。
const OUTSIDE_API_SPEC_FILE = /\.api-spec\.test\.[cm]?[jt]sx?$/;

// path（リポジトリ相対、/ 区切り）が置き場所の規則に違反するか。
function isMisplacedApiSpecFile(path: string): boolean {
  if (path.startsWith(API_SPECS_DIR)) {
    return (
      !isSpecFeatureFile(path) &&
      !isSpecStepFile(path) &&
      !isSpecSupportFile(path)
    );
  }
  return OUTSIDE_API_SPEC_FILE.test(path);
}

// 仕様を要る api ファイル（features/<feature>/internal/presentation/ の直下の <api>.api.ts）。1: feature、2: api の名前。
const API_FILE =
  /^apps\/backend\/features\/([^/]+)\/internal\/presentation\/([^/]+)\.api\.ts$/;

// 対の違反（api-spec-pair）。files は同じ列挙（listApiSpecTargets）の結果。
// api ファイルには .feature と step の両方が要り、api-specs/ の .feature・step には api ファイルが要る。
function findPairViolations(
  path: string,
  files: ReadonlySet<string>,
): ApiSpecViolation[] {
  const api = API_FILE.exec(path);
  if (api !== null) {
    const base = `${API_SPECS_DIR}${api[1]}/${api[2]}`;
    return [`${base}.feature`, `${base}.api-spec.test.ts`]
      .filter((spec) => !files.has(spec))
      .map((spec) => ({ rule: "api-spec-pair", note: `${spec} が無い` }));
  }
  const spec =
    /^apps\/backend\/api-specs\/([^/]+)\/([^/]+?)(?:\.feature|\.api-spec\.test\.ts)$/.exec(
      path,
    );
  if (spec === null || !(isSpecFeatureFile(path) || isSpecStepFile(path))) {
    return [];
  }
  const apiPath = `apps/backend/features/${spec[1]}/internal/presentation/${spec[2]}.api.ts`;
  return files.has(apiPath)
    ? []
    : [{ rule: "api-spec-pair", note: `対の ${apiPath} が無い` }];
}

// .feature の 1 行の種類。skip: コメント・空行・Feature の見出し（どの規則も見ない）。language: `# language:` の行。
//   scenario: `Scenario:` の見出し。keyword: 使わないキーワード（Outline・Rule・Background など）。keyword-step: `*` 以外の step。
//   star: `*` の step。text: それ以外（説明の行・表の行・docstring）。
type FeatureLineKind =
  | "skip"
  | "language"
  | "scenario"
  | "keyword"
  | "keyword-step"
  | "star"
  | "text";

function featureLineKind(line: string): FeatureLineKind {
  // WHY 行頭（字下げの後）の # だけをコメントにする: Gherkin のコメントは行全体だけで、行の途中の # は文の一部。
  if (/^\s*#\s*language\s*:/i.test(line)) {
    return "language";
  }
  if (/^\s*(?:#|$)/.test(line) || /^\s*Feature\s*:/.test(line)) {
    return "skip";
  }
  if (/^\s*Scenario\s*:/.test(line)) {
    return "scenario";
  }
  if (
    /^\s*(?:Scenario Outline|Scenario Template|Rule|Background|Examples?|Scenarios)\s*:/.test(
      line,
    )
  ) {
    return "keyword";
  }
  if (/^\s*(?:Given|When|Then|And|But)(?:\s|$)/.test(line)) {
    return "keyword-step";
  }
  return /^\s*\*(?:\s|$)/.test(line) ? "star" : "text";
}

// 1 行の種類ごとの違反（`*` の数えと Scenario の区切りは呼び出し側）。
const RULE_OF_LINE_KIND: Partial<Record<FeatureLineKind, ApiSpecRuleId>> = {
  language: "api-spec-keyword",
  keyword: "api-spec-keyword",
  "keyword-step": "api-spec-step-star",
};

// 禁止語を見ない行の種類（api-spec-business-language）。
const LINE_KINDS_WITHOUT_WORDING: ReadonlySet<FeatureLineKind> = new Set([
  "skip",
  "language",
  "scenario",
]);

// `Scenario:` の見出しの違反（api-spec-scenario-heading）。seen に見出しを足す（同じ見出しの 2 つ目以降を違反にするため）。
function headingViolations(
  line: string,
  lineNumber: number,
  seen: Set<string>,
): ApiSpecViolation[] {
  const name = line.slice(line.indexOf(":") + 1).trim();
  const violates = !SCENARIO_HEADINGS.includes(name) || seen.has(name);
  seen.add(name);
  return violates
    ? [{ rule: "api-spec-scenario-heading", line: lineNumber }]
    : [];
}

// .feature の中身の違反（行の順。同じ行なら見出し・キーワード・step・言葉の順）。
function findFeatureContentViolations(source: string): ApiSpecViolation[] {
  // WHY \r?\n で分ける: CRLF のファイルを \n だけで分けると行末に \r が残り、見出しが一覧と一致しなくなる。
  const lines = source.split(/\r?\n/);
  const violations: ApiSpecViolation[] = [];
  const seenHeadings = new Set<string>();
  // 今いる Scenario（行と `*` の数）。Scenario の外（Feature の直下・Background などの後）は undefined。
  let scenario: { line: number; stars: number } | undefined;
  const closeScenario = () => {
    if (scenario !== undefined && scenario.stars === 0) {
      violations.push({ rule: "api-spec-step-star", line: scenario.line });
    }
    scenario = undefined;
  };
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const kind = featureLineKind(line);
    if (kind === "scenario" || kind === "keyword") {
      closeScenario();
    }
    const rule = RULE_OF_LINE_KIND[kind];
    if (rule !== undefined) {
      violations.push({ rule, line: lineNumber });
    }
    if (kind === "scenario") {
      scenario = { line: lineNumber, stars: 0 };
      violations.push(...headingViolations(line, lineNumber, seenHeadings));
    }
    if (kind === "star" && scenario !== undefined) {
      scenario.stars += 1;
    }
    // WHY Scenario の見出し・language の行を見ない: 見出しは固定の一覧（レスポンスが禁止語に当たる）、language はコメント。
    if (!LINE_KINDS_WITHOUT_WORDING.has(kind) && containsForbiddenWord(line)) {
      violations.push({ rule: "api-spec-business-language", line: lineNumber });
    }
  });
  closeScenario();
  // WHY 並べ直す: `*` の無い Scenario の違反は、次の Scenario（かファイル末尾）で分かるので後から積まれる。
  return violations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
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

// import の種類（api-journey.test.ts と同じ）。value: 値の名前を 1 つ以上取る静的な import。type: `import type` か、すべてに
//   inline の type。dynamic: dynamic import()。other: 副作用だけの import・export … from。
type ImportKind = "value" | "type" | "dynamic" | "other";

type ImportRef = {
  specifier: string;
  kind: ImportKind;
  clause: string;
  line: number;
};

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// `{ type A, type B }` のように、すべてに inline の type が付いているか（architecture.test.ts の isInlineTypeOnly と同じ）。
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

// ソース（コメントを消したもの）の import / export … from / import "…" / import("…") の参照先（api-journey.test.ts と同じ）。
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
      clause: clause ?? "",
      // WHY 参照先の位置で行を数える: 一致は前の空行（\s*）から始まることがあり、先頭の位置では import の行とずれる。
      line: lineAt(code, match.index + whole.lastIndexOf(specifier)),
    };
  });
  const otherImports = (pattern: RegExp, kind: ImportKind) =>
    [...code.matchAll(pattern)].map(
      (match): ImportRef => ({
        specifier: match[2] ?? "",
        kind,
        clause: "",
        line: lineAt(code, match.index),
      }),
    );
  return [
    ...staticImports,
    ...otherImports(/\bimport\s*(["'])([^"'\n]+)\1/g, "other"),
    ...otherImports(/\bimport\s*\(\s*(["'`])([^"'`$\n]+)\1\s*[,)]/g, "dynamic"),
  ];
}

// 参照先の最後の要素から拡張子を除いた名前（"../x/todo-repository.in-memory.ts" → "todo-repository.in-memory"）。
function moduleBaseName(specifier: string): string {
  return (specifier.split("/").pop() ?? "").replace(/\.[cm]?[jt]sx?$/, "");
}

// 参照先をリポジトリ相対のパス（拡張子なし）にする。自前のコードでない参照（パッケージ）は undefined。
// WHY 解決して比べる: `../../test-support/database` と `@repo/backend/test-support/database` は同じモジュール。
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const alias = "@repo/backend/";
  const resolved = specifier.startsWith(".")
    ? posix.join(posix.dirname(from), specifier)
    : specifier.startsWith(alias)
      ? posix.join("apps/backend", specifier.slice(alias.length))
      : undefined;
  return resolved?.replace(/\.[cm]?[jt]sx?$/, "");
}

// vitest の import が vi に届くか（api-journey.test.ts の reachesVi と同じ。WHY もそちら）。
function reachesVi(ref: ImportRef): boolean {
  if (ref.kind === "dynamic") {
    return true;
  }
  if (ref.kind !== "value") {
    return false;
  }
  const braces = /\{([\s\S]*)\}/.exec(ref.clause);
  const outsideBraces = ref.clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "");
  const names = (braces?.[1] ?? "").split(",").map((name) => name.trim());
  return (
    outsideBraces.trim() !== "" ||
    names.some((name) => /^(?:vi|vitest)(?:\s+as\s+[\w$]+)?$/.test(name))
  );
}

// 実 Postgres のテスト用の DB を用意するモジュール（リポジトリ相対、拡張子なし）。
const TEST_DATABASE_MODULE = "apps/backend/test-support/database";

// step の実装（isSpecStepFile のファイル）の中身の違反。行のあるものを行の順に、その後にファイル全体の違反を返す。
function findStepContentViolations(
  path: string,
  source: string,
): ApiSpecViolation[] {
  const imports = extractImports(stripComments(source));
  const lineLevel = imports
    .flatMap((ref): ApiSpecViolation[] => [
      ...(/\.in-memory$/.test(moduleBaseName(ref.specifier))
        ? [{ rule: "api-spec-no-in-memory" as const, line: ref.line }]
        : []),
      ...(ref.specifier === "vitest" && reachesVi(ref)
        ? [{ rule: "api-spec-no-vi" as const, line: ref.line }]
        : []),
    ])
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const valueModules = imports
    .filter((ref) => ref.kind === "value")
    .map((ref) => resolveSpecifier(path, ref.specifier));
  const [, feature, api] =
    /^apps\/backend\/api-specs\/([^/]+)\/([^/]+)\.api-spec\.test\.ts$/.exec(
      path,
    ) ?? [];
  const ownApi = `apps/backend/features/${feature}/internal/presentation/${api}.api`;
  // WHY 型だけの import も数える: 対の API との対応を見る規則で、組み立ては support.ts に任せてよい（冒頭の説明）。
  const staticModules = imports
    .filter((ref) => ref.kind === "value" || ref.kind === "type")
    .map((ref) => resolveSpecifier(path, ref.specifier));
  return [
    ...lineLevel,
    ...(valueModules.includes(TEST_DATABASE_MODULE)
      ? []
      : [{ rule: "api-spec-uses-real-database" as const }]),
    ...(staticModules.includes(ownApi)
      ? []
      : [{ rule: "api-spec-uses-own-api" as const }]),
  ];
}

// 補助（isSpecSupportFile のファイル）の中身の違反。自 feature の api を 1 つも値で import しなければ違反（ファイル全体）。
function findSupportContentViolations(
  path: string,
  source: string,
): ApiSpecViolation[] {
  const presentation = `apps/backend/features/${path.split("/")[3]}/internal/presentation/`;
  // WHY 前方一致と残りの名前で見る（feature の名前を正規表現に埋め込まない）: 名前の中の文字を正規表現として解釈させない。
  const isOwnApi = (module: string | undefined) =>
    module?.startsWith(presentation) === true &&
    /^[^/]+\.api$/.test(module.slice(presentation.length));
  const assembles = extractImports(stripComments(source))
    .filter((ref) => ref.kind === "value")
    .some((ref) => isOwnApi(resolveSpecifier(path, ref.specifier)));
  return assembles ? [] : [{ rule: "api-spec-support-assembles-apis" }];
}

// path の違反。置き場所が違えば置き場所の違反だけを返し（中身は見ない）、.feature・step・support.ts なら中身を見る。ほかは []。
function findApiSpecViolations(
  path: string,
  source: string,
): ApiSpecViolation[] {
  if (isMisplacedApiSpecFile(path)) {
    return [{ rule: "api-spec-placement" }];
  }
  if (isSpecFeatureFile(path)) {
    return findFeatureContentViolations(source);
  }
  if (isSpecSupportFile(path)) {
    return findSupportContentViolations(path, source);
  }
  return isSpecStepFile(path) ? findStepContentViolations(path, source) : [];
}

// root の下の dir を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリ（.next など）に入らない: 依存やビルド結果は検査の対象ではなく、たどると遅い
//   （rule-tests/api-journey.test.ts の walk と同じ）。
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

// 検査の対象: apps/ の下のファイルのうち、apps/backend/api-specs/ の下のもの、外に置くと違反になる名前（OUTSIDE_API_SPEC_FILE）の
//   もの、仕様を要る api ファイル（API_FILE）。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listApiSpecTargets(root: string): string[] {
  return walk(root, "apps")
    .filter(
      (path) =>
        path.startsWith(API_SPECS_DIR) ||
        OUTSIDE_API_SPEC_FILE.test(path) ||
        API_FILE.test(path),
    )
    .sort();
}

// 違反を「<規則>: <パス>」「<規則>: <パス>:<行>」「<規則>: <パス>（<無いファイル>）」で返す。
function collectApiSpecViolations(root: string): string[] {
  const paths = listApiSpecTargets(root);
  const files = new Set(paths);
  return paths.flatMap((path) =>
    [
      ...findApiSpecViolations(path, readFileSync(join(root, path), "utf8")),
      ...findPairViolations(path, files),
    ].map(({ rule, line, note }) =>
      line !== undefined
        ? `${rule}: ${path}:${line}`
        : note !== undefined
          ? `${rule}: ${path}（${note}）`
          : `${rule}: ${path}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const FEATURE = "apps/backend/api-specs/x/create-x.feature";
const STEPS = "apps/backend/api-specs/x/create-x.api-spec.test.ts";
const SUPPORT = "apps/backend/api-specs/x/support.ts";
const API = "apps/backend/features/x/internal/presentation/create-x.api.ts";
// step の実装の必須の import（実 DB と対の api）。must reject の例は、これに違反を 1 つ足すか、どれかを欠く。
const DATABASE_IMPORT =
  'import { createTestDatabase } from "../../test-support/database";';
const OWN_API_IMPORT =
  'import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";';
const REQUIRED_IMPORTS = [DATABASE_IMPORT, OWN_API_IMPORT];

describe("API 仕様の置き場所（isMisplacedApiSpecFile）", () => {
  it.each([
    ["api-specs/<feature>/ の直下の <api>.feature", FEATURE],
    ["api-specs/<feature>/ の直下の <api>.api-spec.test.ts", STEPS],
    ["api-specs/<feature>/ の直下の support.ts", SUPPORT],
    ["presentation の api ファイル", API],
    [
      "presentation の単体テスト",
      "apps/backend/features/x/internal/presentation/create-x.api.test.ts",
    ],
    [
      "API ジャーニー（api-spec の名前でない）",
      "apps/backend/api-journeys/x.api-journey.test.ts",
    ],
    [
      "名前に api-spec を含むがテストでないファイル（api-specs/ の外）",
      "apps/backend/features/x/internal/domain/x.api-spec.ts",
    ],
  ])("%s は違反なし", (_name, path) => {
    expect(isMisplacedApiSpecFile(path)).toBe(false);
  });

  it.each([
    ["api-specs/ の直下の .feature", "apps/backend/api-specs/x.feature"],
    ["api-specs/ の直下の step", "apps/backend/api-specs/x.api-spec.test.ts"],
    ["api-specs/ の直下の support.ts", "apps/backend/api-specs/support.ts"],
    [
      "<feature>/ の下のサブディレクトリの .feature",
      "apps/backend/api-specs/x/nested/create-x.feature",
    ],
    [
      "<feature>/ の下のサブディレクトリの step",
      "apps/backend/api-specs/x/nested/create-x.api-spec.test.ts",
    ],
    [
      "<feature>/ の下のサブディレクトリの support.ts",
      "apps/backend/api-specs/x/nested/support.ts",
    ],
    ["support.ts 以外の補助の .ts", "apps/backend/api-specs/x/helper.ts"],
    ["名前の違う補助（Support.ts）", "apps/backend/api-specs/x/Support.ts"],
    ["support の .tsx", "apps/backend/api-specs/x/support.tsx"],
    ["support のテスト", "apps/backend/api-specs/x/support.test.ts"],
    ["api-specs/ の .md", "apps/backend/api-specs/x/README.md"],
    [".api-spec の無いテスト", "apps/backend/api-specs/x/create-x.test.ts"],
    [".tsx の step", "apps/backend/api-specs/x/create-x.api-spec.test.tsx"],
    [
      ".feature の後ろに拡張子を足したもの（.feature.md）",
      "apps/backend/api-specs/x/create-x.feature.md",
    ],
    [
      "api-specs/ の下の API ジャーニー",
      "apps/backend/api-specs/x/x.api-journey.test.ts",
    ],
    [
      "presentation の隣の step",
      "apps/backend/features/x/internal/presentation/create-x.api-spec.test.ts",
    ],
    [
      "api-journeys/ の step",
      "apps/backend/api-journeys/create-x.api-spec.test.ts",
    ],
    [
      "api-specs の前方一致だけの別ディレクトリの step",
      "apps/backend/api-specs-x/x/create-x.api-spec.test.ts",
    ],
    [
      "frontend の step（.tsx）",
      "apps/frontend_customer/features/x/x.api-spec.test.tsx",
    ],
    ["E2E の step（.js）", "apps/e2e/x.api-spec.test.js"],
  ])("%s は違反", (_name, path) => {
    expect(isMisplacedApiSpecFile(path)).toBe(true);
  });
});

describe("api ファイルと API 仕様の対（findPairViolations）", () => {
  const files = (...paths: string[]) => new Set(paths);

  it.each([
    [
      "api と .feature と step の 3 つがそろう（api）",
      API,
      files(API, FEATURE, STEPS),
    ],
    [
      "api と .feature と step の 3 つがそろう（.feature）",
      FEATURE,
      files(API, FEATURE, STEPS),
    ],
    [
      "api と .feature と step の 3 つがそろう（step）",
      STEPS,
      files(API, FEATURE, STEPS),
    ],
    ["support.ts は対を要らない", SUPPORT, files(SUPPORT)],
    [
      "presentation の単体テストは api ファイルではない",
      "apps/backend/features/x/internal/presentation/create-x.api.test.ts",
      files(),
    ],
    [
      "presentation の外の .api.ts（shared/presentation）は対の対象外",
      "apps/backend/shared/presentation/x.api.ts",
      files(),
    ],
    [
      "置き場所の違反の .feature は見ない",
      "apps/backend/api-specs/x/nested/create-x.feature",
      files(),
    ],
  ])("%s は違反なし", (_name, path, set) => {
    expect(findPairViolations(path, set)).toEqual([]);
  });

  it.each([
    [
      "api に .feature と step の両方が無い（2 件）",
      API,
      files(API),
      [
        { rule: "api-spec-pair", note: `${FEATURE} が無い` },
        { rule: "api-spec-pair", note: `${STEPS} が無い` },
      ],
    ],
    [
      "api に step が無い（.feature だけ）",
      API,
      files(API, FEATURE),
      [{ rule: "api-spec-pair", note: `${STEPS} が無い` }],
    ],
    [
      "api に .feature が無い（step だけ）",
      API,
      files(API, STEPS),
      [{ rule: "api-spec-pair", note: `${FEATURE} が無い` }],
    ],
    [
      "api の無い .feature",
      FEATURE,
      files(FEATURE, STEPS),
      [{ rule: "api-spec-pair", note: `対の ${API} が無い` }],
    ],
    [
      "api の無い step",
      STEPS,
      files(FEATURE, STEPS),
      [{ rule: "api-spec-pair", note: `対の ${API} が無い` }],
    ],
    [
      "別の feature のディレクトリに置いた .feature（api は features/x）",
      "apps/backend/api-specs/y/create-x.feature",
      files(API, "apps/backend/api-specs/y/create-x.feature"),
      [
        {
          rule: "api-spec-pair",
          note: "対の apps/backend/features/y/internal/presentation/create-x.api.ts が無い",
        },
      ],
    ],
    [
      "api と名前の違う step（create-xs）",
      "apps/backend/api-specs/x/create-xs.api-spec.test.ts",
      files(API, "apps/backend/api-specs/x/create-xs.api-spec.test.ts"),
      [
        {
          rule: "api-spec-pair",
          note: "対の apps/backend/features/x/internal/presentation/create-xs.api.ts が無い",
        },
      ],
    ],
  ])("%s は違反", (_name, path, set, expected) => {
    expect(findPairViolations(path, set)).toEqual(expected);
  });
});

describe(".feature の中身（findApiSpecViolations）: must pass", () => {
  it.each([
    [
      "固定の見出し 6 つの Scenario と `*` の step（見出しの レスポンス は禁止語でも可）",
      source(
        "Feature: Todo を作る",
        "",
        "  Scenario: レスポンス",
        '    * タイトル "牛乳を買う" で作ると、未完了の Todo が作られる',
        "",
        "  Scenario: ソート",
        "    * 作った順に並ぶ",
        "  Scenario: 検索",
        "    * 完了したものだけを選べる",
        "  Scenario: 記録",
        "    * 作ったことが履歴に残る",
        "    * 作った人が履歴に残る",
        "  Scenario: 副作用",
        "    * ほかの Todo は変わらない",
        "  Scenario: 異常系",
        "    * タイトルが空なら、空という理由で拒否される",
      ),
    ],
    [
      "# のコメント行（字下げも）・空行・Feature の見出しは禁止語があっても見ない",
      source(
        "# step の実装は DB の todos を SQL で読み、状態 201 と Problem Details の JSON を確かめる。",
        "Feature: POST /api/todos の API 仕様",
        "  Scenario: レスポンス",
        "    # 返り値の id・title・completed は step の実装が見る。",
        "",
        "    * Todo が作られる",
      ),
    ],
    [
      "3 桁の数の後ろが「文字」「件」「行」・Scenario の見出しの前後の空白・`*` の直後の改行",
      source(
        "Feature: x",
        "  Scenario:   異常系   ",
        "    * 101 文字のタイトルは長すぎると伝えられる",
        "    * 200件まで並ぶ",
        "    *",
      ),
    ],
    [
      "説明の行・表の行（禁止語なし）",
      source(
        "Feature: x",
        "  Todo を作る。",
        "  Scenario: レスポンス",
        "    Todo の作り方の説明。",
        "    * Todo が作られる",
        "      | タイトル |",
        "      | 牛乳を買う |",
      ),
    ],
    ["Scenario の無い .feature（Feature だけ）", "Feature: x\n"],
    [
      "改行が CRLF（見出しの行末の \\r を一覧との違いにしない）",
      [
        "Feature: x",
        "  Scenario: レスポンス",
        "    * Todo が作られる",
        "",
      ].join("\r\n"),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(FEATURE, text)).toEqual([]);
  });
});

describe(".feature の中身（findApiSpecViolations）: must reject", () => {
  it.each([
    [
      "一覧に無い見出し（一覧）・一覧の語に文字を足した見出し・空の見出し",
      source(
        "Feature: x",
        "  Scenario: 一覧",
        "    * a",
        "  Scenario: レスポンス（一覧）",
        "    * b",
        "  Scenario:",
        "    * c",
      ),
      [
        { rule: "api-spec-scenario-heading", line: 2 },
        { rule: "api-spec-scenario-heading", line: 4 },
        { rule: "api-spec-scenario-heading", line: 6 },
      ],
    ],
    [
      "同じ見出しの 2 つ目",
      source(
        "Feature: x",
        "  Scenario: 異常系",
        "    * a",
        "  Scenario: 異常系",
        "    * b",
      ),
      [{ rule: "api-spec-scenario-heading", line: 4 }],
    ],
    [
      "Scenario Outline / Scenario Template / Rule / Background / Example / Examples / Scenarios と # language:",
      source(
        "# language: ja",
        "Feature: x",
        "  Background: 前提",
        "  Rule: 規則",
        "  Scenario Outline: 例",
        "    Examples: 表",
        "  Scenario Template: 例",
        "    Scenarios: 表",
        "  Example: 例",
      ),
      [
        { rule: "api-spec-keyword", line: 1 },
        { rule: "api-spec-keyword", line: 3 },
        { rule: "api-spec-keyword", line: 4 },
        { rule: "api-spec-keyword", line: 5 },
        { rule: "api-spec-keyword", line: 6 },
        { rule: "api-spec-keyword", line: 7 },
        { rule: "api-spec-keyword", line: 8 },
        { rule: "api-spec-keyword", line: 9 },
      ],
    ],
    [
      "Given / When / Then / And / But の step（`*` と並べても、字下げが無くても）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "    * a",
        "    Given b",
        "    When c",
        "Then d",
        "    And e",
        "    But f",
      ),
      [
        { rule: "api-spec-step-star", line: 4 },
        { rule: "api-spec-step-star", line: 5 },
        { rule: "api-spec-step-star", line: 6 },
        { rule: "api-spec-step-star", line: 7 },
        { rule: "api-spec-step-star", line: 8 },
      ],
    ],
    [
      "`*` の無い Scenario（コメント・説明だけ、Given だけ、ファイル末尾の Scenario）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "    # * コメントの中の *",
        "    説明だけ",
        "  Scenario: 記録",
        "    Given a",
        "  Scenario: 異常系",
      ),
      [
        { rule: "api-spec-step-star", line: 2 },
        { rule: "api-spec-step-star", line: 5 },
        { rule: "api-spec-step-star", line: 6 },
        { rule: "api-spec-step-star", line: 7 },
      ],
    ],
    [
      "Scenario の外の `*` は Scenario の `*` に数えない（Background の後の `*`）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "  Background: 前提",
        "    * a",
      ),
      [
        { rule: "api-spec-step-star", line: 2 },
        { rule: "api-spec-keyword", line: 3 },
      ],
    ],
    [
      "`*` の step・説明の行・表の行の禁止語（DB・状態コードの 3 桁・id。大文字小文字を区別しない）",
      source(
        "Feature: x",
        "  Todo を Db に書く。",
        "  Scenario: レスポンス",
        "    * 201 で返る",
        "      | id |",
        "    * 状態 404 になる",
      ),
      [
        { rule: "api-spec-business-language", line: 2 },
        { rule: "api-spec-business-language", line: 4 },
        { rule: "api-spec-business-language", line: 5 },
        { rule: "api-spec-business-language", line: 6 },
      ],
    ],
    [
      "見出し以外のキーワードの行・Given の行も禁止語を見る（同じ行なら規則の順）",
      source(
        "Feature: x",
        "  Rule: レスポンス",
        "  Scenario: 記録",
        "    * a",
        "    Given DB が空",
      ),
      [
        { rule: "api-spec-keyword", line: 2 },
        { rule: "api-spec-business-language", line: 2 },
        { rule: "api-spec-step-star", line: 5 },
        { rule: "api-spec-business-language", line: 5 },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findApiSpecViolations(FEATURE, text)).toEqual(expected);
  });
});

describe("step の実装の中身（findApiSpecViolations）: must pass", () => {
  it.each([
    ["実 DB と対の api を値で import", source(...REQUIRED_IMPORTS)],
    [
      "複数行の import・type の混じった import・@repo/backend/ の書き方・拡張子付き",
      source(
        "import {",
        "  createTestDatabase,",
        "  type TestDatabase,",
        '} from "@repo/backend/test-support/database";',
        "import {",
        "  CreateXApi,",
        "  type CreateXResponse,",
        '} from "@repo/backend/features/x/internal/presentation/create-x.api.ts";',
      ),
    ],
    [
      "ほかの api・Postgres の Repository・support.ts・vitest-cucumber を足して import",
      source(
        ...REQUIRED_IMPORTS,
        'import { ListXApi } from "../../features/x/internal/presentation/list-x.api";',
        'import { PostgresXRepository } from "../../features/x/internal/infra/x-repository.postgres";',
        'import { createApi } from "./support";',
        'import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";',
      ),
    ],
    [
      "vitest から vi 以外と、型だけ（import type・inline の type）を import",
      source(
        ...REQUIRED_IMPORTS,
        'import { afterAll, beforeAll, expect } from "vitest";',
        'import type { Mock } from "vitest";',
        'import type * as V from "vitest";',
        'import { type MockInstance, type vi } from "vitest";',
      ),
    ],
    [
      "コメントの中の vi・InMemory の import",
      source(
        ...REQUIRED_IMPORTS,
        '// import { vi } from "vitest";',
        '/* import { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory"; */',
      ),
    ],
    [
      "対の api を型だけで import（import type・inline の type だけ。組み立ては support.ts）",
      source(
        DATABASE_IMPORT,
        'import type { CreateXResponse } from "../../features/x/internal/presentation/create-x.api";',
      ),
    ],
    [
      "対の api を inline の type だけで import（@repo/backend/ の書き方）",
      source(
        DATABASE_IMPORT,
        'import { type CreateXResponse } from "@repo/backend/features/x/internal/presentation/create-x.api";',
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
    expect(findApiSpecViolations(STEPS, text)).toEqual([]);
  });

  it("api ファイルは中身を見ない", () => {
    expect(
      findApiSpecViolations(API, source('import { vi } from "vitest";')),
    ).toEqual([]);
  });
});

describe("step の実装の中身（findApiSpecViolations）: must reject", () => {
  it.each([
    [
      "vitest から vi・vi の別名・vitest（vi の別名）・名前空間・既定の import・dynamic import()",
      source(
        ...REQUIRED_IMPORTS,
        'import { expect, vi } from "vitest";',
        'import { vi as v } from "vitest";',
        'import { vitest } from "vitest";',
        'import * as V from "vitest";',
        'import V2 from "vitest";',
        'const m = await import("vitest");',
      ),
      [3, 4, 5, 6, 7, 8].map((line) => ({ rule: "api-spec-no-vi", line })),
    ],
    [
      "*.in-memory の値の import・import type・dynamic import()・export … from・拡張子付き",
      source(
        ...REQUIRED_IMPORTS,
        'import { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory";',
        'import type { InMemoryXRepository as T } from "../../test-support/x/x-repository.in-memory";',
        'const m = await import("../../test-support/x/x-repository.in-memory");',
        'export { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory.ts";',
      ),
      [3, 4, 5, 6].map((line) => ({ rule: "api-spec-no-in-memory", line })),
    ],
    [
      "test-support/database の import が無い",
      source(OWN_API_IMPORT),
      [{ rule: "api-spec-uses-real-database" }],
    ],
    [
      "test-support/database を型だけで import（import type・inline の type だけ）",
      source(
        OWN_API_IMPORT,
        'import type { TestDatabase } from "../../test-support/database";',
        'import { type TestDatabase as D } from "../../test-support/database";',
      ),
      [{ rule: "api-spec-uses-real-database" }],
    ],
    [
      "名前・場所の一部だけが同じ別のモジュール（database-x・別の場所の test-support/database）",
      source(
        OWN_API_IMPORT,
        'import { a } from "../../test-support/database-x";',
        'import { b } from "./test-support/database";',
      ),
      [{ rule: "api-spec-uses-real-database" }],
    ],
    [
      "対の api の import が無い（ほかの api だけ）",
      source(
        DATABASE_IMPORT,
        'import { ListXApi } from "../../features/x/internal/presentation/list-x.api";',
      ),
      [{ rule: "api-spec-uses-own-api" }],
    ],
    [
      "別の feature の同じ名前の api・api でない同じ名前のモジュール・dynamic import()・export … from・コメントの中の import",
      source(
        DATABASE_IMPORT,
        'import { CreateXApi as Y } from "../../features/y/internal/presentation/create-x.api";',
        'import { a } from "../../features/x/internal/application/create-x.command";',
        'const m = await import("../../features/x/internal/presentation/create-x.api");',
        'export type { CreateXResponse } from "../../features/x/internal/presentation/create-x.api";',
        '// import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
      ),
      [{ rule: "api-spec-uses-own-api" }],
    ],
    [
      "import が何も無い（ファイル全体の違反 2 つ）",
      source("const a = 1;"),
      [
        { rule: "api-spec-uses-real-database" },
        { rule: "api-spec-uses-own-api" },
      ],
    ],
    [
      "vi と InMemory と必須の欠け（行の順、その後にファイル全体の違反）",
      source(
        'import { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory";',
        'import { vi } from "vitest";',
      ),
      [
        { rule: "api-spec-no-in-memory", line: 1 },
        { rule: "api-spec-no-vi", line: 2 },
        { rule: "api-spec-uses-real-database" },
        { rule: "api-spec-uses-own-api" },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findApiSpecViolations(STEPS, text)).toEqual(expected);
  });

  it("置き場所が違えば置き場所の違反だけを返す（中身は見ない）", () => {
    expect(
      findApiSpecViolations(
        "apps/backend/api-specs/x/nested/create-x.feature",
        source("Feature: DB", "  Scenario: 一覧", "    Given 状態 201"),
      ),
    ).toEqual([{ rule: "api-spec-placement" }]);
  });
});

describe("補助 support.ts の中身（findApiSpecViolations）", () => {
  it.each([
    [
      "自 feature の api を 1 つ値で import（vi・drizzle など api 以外の import もあってよい。vi は見ない）",
      source(
        'import { vi } from "vitest";',
        'import { sql } from "drizzle-orm";',
        'import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
      ),
    ],
    [
      "複数の api・type の混じった import・@repo/backend/ の書き方・拡張子付き",
      source(
        "import {",
        "  CreateXApi,",
        "  type CreateXResponse,",
        '} from "@repo/backend/features/x/internal/presentation/create-x.api.ts";',
        'import { ListXApi } from "../../features/x/internal/presentation/list-x.api";',
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(SUPPORT, text)).toEqual([]);
  });

  it.each([
    ["import が何も無い", source("export const a = 1;")],
    [
      "api を型だけで import（import type・inline の type だけ）",
      source(
        'import type { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
        'import { type ListXApi } from "../../features/x/internal/presentation/list-x.api";',
      ),
    ],
    [
      "別の feature の api・presentation の api でないモジュール・入れ子の api・api のテスト・前方一致だけの別 feature",
      source(
        'import { CreateYApi } from "../../features/y/internal/presentation/create-y.api";',
        'import { a } from "../../features/x/internal/presentation/x-schema";',
        'import { b } from "../../features/x/internal/application/create-x.command";',
        'import { c } from "../../features/x/internal/presentation/nested/create-x.api";',
        'import { d } from "../../features/x/internal/presentation/create-x.api.test";',
        'import { e } from "../../features/x-extra/internal/presentation/create-x.api";',
      ),
    ],
    [
      "dynamic import()・export … from・コメントの中の import",
      source(
        'const m = await import("../../features/x/internal/presentation/create-x.api");',
        'export { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
        '// import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
      ),
    ],
  ])("%s は違反", (_name, text) => {
    expect(findApiSpecViolations(SUPPORT, text)).toEqual([
      { rule: "api-spec-support-assembles-apis" },
    ]);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（api-specs/ の下・外の *.api-spec.test.*・api ファイルの見つけ方）が漏れれば見逃す。一時
//   ディレクトリに架空のツリーを置き、本番と同じ collectApiSpecViolations に通して、違反の集合を丸ごと比較する。
describe("API 仕様の列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "api-spec-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const presentation = "apps/backend/features/x/internal/presentation";
  const specs = "apps/backend/api-specs/x";
  const goodFeature = source(
    "Feature: x",
    "  Scenario: レスポンス",
    "    * 作られる",
  );
  // api-specs/x/<name>.api-spec.test.ts の必須の import（実 DB と対の api）。
  const stepsFor = (name: string, ...extra: string[]) =>
    source(
      DATABASE_IMPORT,
      `import type { A } from "../../features/x/internal/presentation/${name}.api";`,
      ...extra,
    );

  it("api-specs/ の下・外の *.api-spec.test.*・api ファイルを対象にし、違反を「規則: パス(:行)（無いファイル）」で返す", () => {
    const root = fixture({
      // 対がそろい、中身も違反なし（support.ts も）。
      [`${presentation}/create-x.api.ts`]: "export class CreateXApi {}\n",
      [`${specs}/create-x.feature`]: goodFeature,
      [`${specs}/create-x.api-spec.test.ts`]: stepsFor("create-x"),
      [`${specs}/support.ts`]: source(
        'import { vi } from "vitest";',
        `import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";`,
      ),
      // 補助の違反: 自 feature の api を型だけで import（組み立てていない）。
      "apps/backend/api-specs/y/support.ts": source(
        'import type { CreateYApi } from "../../features/y/internal/presentation/create-y.api";',
      ),
      // 対がそろうが、.feature と step の中身が違反。
      [`${presentation}/list-x.api.ts`]: "export class ListXApi {}\n",
      [`${specs}/list-x.feature`]: source(
        "Feature: x",
        "  Scenario: 一覧",
        "    Given DB が空",
      ),
      [`${specs}/list-x.api-spec.test.ts`]: stepsFor(
        "list-x",
        'import { vi } from "vitest";',
      ),
      // 対の違反: api だけ（.feature と step が無い）、.feature だけ、api の無い step。
      [`${presentation}/delete-x.api.ts`]: "export class DeleteXApi {}\n",
      [`${presentation}/get-x.api.ts`]: "export class GetXApi {}\n",
      [`${specs}/get-x.feature`]: goodFeature,
      [`${specs}/rename-x.api-spec.test.ts`]: stepsFor("rename-x"),
      // 置き場所の違反: 補助の別名・サブディレクトリ・直下・外の step。
      [`${specs}/helper.ts`]: "export const a = 1;\n",
      [`${specs}/nested/create-x.feature`]: "Feature: DB\n",
      "apps/backend/api-specs/support.ts": "export const a = 1;\n",
      [`${presentation}/create-x.api-spec.test.ts`]: "",
      "apps/frontend_customer/x.api-spec.test.tsx": "",
      // 対象外: presentation の単体テスト・api-journeys・node_modules と . で始まるディレクトリの中。
      [`${presentation}/create-x.api.test.ts`]:
        'import { vi } from "vitest";\n',
      "apps/backend/api-journeys/x.feature": "Feature: DB\n",
      "apps/backend/node_modules/x/x.api-spec.test.ts": "",
      "apps/frontend_customer/.next/x.api-spec.test.ts": "",
    });
    expect({
      files: listApiSpecTargets(root),
      violations: collectApiSpecViolations(root),
    }).toEqual({
      files: [
        "apps/backend/api-specs/support.ts",
        "apps/backend/api-specs/x/create-x.api-spec.test.ts",
        "apps/backend/api-specs/x/create-x.feature",
        "apps/backend/api-specs/x/get-x.feature",
        "apps/backend/api-specs/x/helper.ts",
        "apps/backend/api-specs/x/list-x.api-spec.test.ts",
        "apps/backend/api-specs/x/list-x.feature",
        "apps/backend/api-specs/x/nested/create-x.feature",
        "apps/backend/api-specs/x/rename-x.api-spec.test.ts",
        "apps/backend/api-specs/x/support.ts",
        "apps/backend/api-specs/y/support.ts",
        "apps/backend/features/x/internal/presentation/create-x.api-spec.test.ts",
        "apps/backend/features/x/internal/presentation/create-x.api.ts",
        "apps/backend/features/x/internal/presentation/delete-x.api.ts",
        "apps/backend/features/x/internal/presentation/get-x.api.ts",
        "apps/backend/features/x/internal/presentation/list-x.api.ts",
        "apps/frontend_customer/x.api-spec.test.tsx",
      ],
      violations: [
        "api-spec-placement: apps/backend/api-specs/support.ts",
        "api-spec-placement: apps/backend/api-specs/x/helper.ts",
        "api-spec-no-vi: apps/backend/api-specs/x/list-x.api-spec.test.ts:3",
        "api-spec-scenario-heading: apps/backend/api-specs/x/list-x.feature:2",
        "api-spec-step-star: apps/backend/api-specs/x/list-x.feature:2",
        "api-spec-step-star: apps/backend/api-specs/x/list-x.feature:3",
        "api-spec-business-language: apps/backend/api-specs/x/list-x.feature:3",
        "api-spec-placement: apps/backend/api-specs/x/nested/create-x.feature",
        "api-spec-pair: apps/backend/api-specs/x/rename-x.api-spec.test.ts（対の apps/backend/features/x/internal/presentation/rename-x.api.ts が無い）",
        "api-spec-support-assembles-apis: apps/backend/api-specs/y/support.ts",
        "api-spec-placement: apps/backend/features/x/internal/presentation/create-x.api-spec.test.ts",
        "api-spec-pair: apps/backend/features/x/internal/presentation/delete-x.api.ts（apps/backend/api-specs/x/delete-x.feature が無い）",
        "api-spec-pair: apps/backend/features/x/internal/presentation/delete-x.api.ts（apps/backend/api-specs/x/delete-x.api-spec.test.ts が無い）",
        "api-spec-pair: apps/backend/features/x/internal/presentation/get-x.api.ts（apps/backend/api-specs/x/get-x.api-spec.test.ts が無い）",
        "api-spec-placement: apps/frontend_customer/x.api-spec.test.tsx",
      ],
    });
  });

  it("apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listApiSpecTargets(root),
      violations: collectApiSpecViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("API 仕様（実ファイル）", () => {
  it("presentation の api ファイルごとに apps/backend/api-specs/<feature>/ に <api>.feature と <api>.api-spec.test.ts があり、.feature は固定の見出しの Scenario と `*` の step を業務の言葉だけで書き、step の実装は vi と InMemory を使わず、実 DB を使って対の api を参照し、support.ts が api を値で組み立てる", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listApiSpecTargets(repoRoot)).toEqual(
      expect.arrayContaining([
        "apps/backend/features/todo/internal/presentation/list-todos.api.ts",
        "apps/backend/api-specs/todo/list-todos.feature",
        "apps/backend/api-specs/todo/list-todos.api-spec.test.ts",
      ]),
    );
    expect(collectApiSpecViolations(repoRoot)).toEqual([]);
  });
});
