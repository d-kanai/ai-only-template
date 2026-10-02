// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはソースを文字列として読むだけで DOM を使わないため、
//   jsdom の初期化を省き、ブラウザ相当の globals が Node の API と混ざる余地をなくすため node 環境で動かす。
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import {
  isArrowFunction,
  isAsExpression,
  isCallExpression,
  isClassLikeDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isJsxAttribute,
  isJsxExpression,
  isJsxText,
  isMethodDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTemplateExpression,
  isTypeAssertion,
  isVariableStatement,
  type JsxAttribute,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { expect } from "vitest";
import { casesByName } from "./case-table";

// ディレクトリ構成ルール（.claude/rules/backend.md・frontend.md。規則の一覧は .claude/rules/architecture-check.md）の依存の向きを、仕様として機械的に検査するテスト。
// 対象は「依存の向き（全体）」「画面側とサーバ側の境界」「backend の 4 層の依存してよい先」、apps/frontend_customer と apps/backend の
// 境界（Issue #68。backend → frontend の禁止、backend の中は相対パスだけ、frontend などから backend へは "@repo/backend/..." の
// 書き方だけ、apps/backend/package.json の exports の過不足）、frontend と backend で共通の apps/shared（Issue #90。置き場所、
// "@repo/shared/..." の書き方、画面側から参照しない、apps/shared/package.json の exports の過不足）と、環境変数の直参照の禁止
// （.claude/rules/env.md の「環境変数」。規則 env-direct-access）、現在時刻を apps/shared/now.ts の外で読むことの禁止
// （規則 now-single-source）、画面と backend のハードコードの文言の禁止（Issue #116 の i18n。
// 規則 frontend-hardcoded-text・server-hardcoded-text。これだけは正規表現ではなく構文木で見る。WHY は該当の節）、画面・部品の辞書
// （*.messages.ts）を同じディレクトリのファイルだけが参照すること（Issue #125。規則 messages-colocation）、backend のモジュールの境界
// （Issue #208。他のモジュールの internal/ を参照しない・他のモジュールの expose/ は presentation からだけ・expose/ が参照してよい先。
// 規則 module-internal・module-expose-only-from-presentation・expose-imports）。
//
// WHY 自前のテストにする（Biome の noRestrictedImports を使わない）:
//   「features/<f>/api/ から backend へは import type だけ許す」を表現できない。Biome 2.5.13 の noRestrictedImports は
//   型だけの import（import type）も同じく違反にすることを実測した（Issue #47 の調査）。また、パスの制限を
//   「どのディレクトリからの import か」で変えるには feature ごと・層ごとに overrides を書く必要があり、feature を
//   足すたびに biome.json を直すことになる。ここでは参照元のパスから feature 名・層を取り出して、規則を 1 か所で書く。
//
// WHY 依存を増やさず正規表現で抽出する: 検査に必要なのは import / export の参照先と「型だけか」の 2 つで、
//   TypeScript の構文木までは要らない。dependency-cruiser は 18.4.0 の supportedTranspilers.typescript が <7.0.0 で、
//   本リポジトリの TypeScript 7.0.2 に対応していない（ADR docs/adr/quality/20260928-dependency-direction-checked-by-own-test.md の「採用しなかった案」）。
//   抽出の限界は stripComments / extractImports の WHY に書き、仕様を下の step と fixture テストで固定する。
// 仕様（Scenario と `*` の step）は architecture.feature に、step の実装はこのファイルの describeFeature に分けた（Issue #282）。

const repoRoot = join(import.meta.dirname, "..");

// 検査の対象（.claude/rules/architecture-check.md の「対象と抽出」。Issue #68 で apps/frontend_customer と apps/backend に分けた）。
//   apps/frontend_customer と apps/backend（と Issue #90 の apps/shared）の全体（再帰）。除くのは依存と生成物のディレクトリ（EXCLUDED_DIRS）だけ。
// WHY 全体を再帰する（app/・features/・shared/ だけにしない）: 以前は app/・features/・shared/ と直下のファイルだけを見ていたため、
//   apps/frontend_customer/lib/db.ts のような場所のファイルは、backend の container を値で import しても検査に出なかった（Issue #68 の
//   reviewer が実測）。全体を列挙したうえで、置き場所の規則（FRONTEND_PLACEMENT / BACKEND_PLACEMENT）で、どの規則もかからない
//   場所にファイルを置くこと自体を違反にする。
const FRONTEND_ROOT = "apps/frontend_customer";
const BACKEND_ROOT = "apps/backend";
// E2E の workspace パッケージ @repo/e2e（Issue #84 で e2e/ から移した）。依存の向きの規則（frontend / backend の中の規則）と
//   置き場所の規則の対象ではなく、backend を使う側（frontend-to-backend-specifier・backend-exports）と環境変数の直参照
//   （env-direct-access）の対象。
const E2E_ROOT = "apps/e2e";
// frontend と backend で共通の基盤の workspace パッケージ @repo/shared（Issue #90。env.ts と logger.ts を apps/backend/shared/infra/
//   から移した）。置き場所の規則（SHARED_PLACEMENT）、"@repo/shared/..." の書き方（frontend-to-shared-specifier）、画面側から
//   参照しない（screen-to-shared）、exports（SHARED_EXPORTS）、環境変数の直参照・console の例外（env.ts・logger.ts）の対象。
const SHARED_ROOT = "apps/shared";
// apps/shared が使ってよい（node: 以外の）パッケージ。規則 shared-self-contained の許可（名前の完全一致。サブパスは含めない）。
// WHY zod（Issue #216）: logger のスキーマ（apps/shared/log-event.ts）。足すときは Issue で決め、.claude/rules/shared.md と同じ変更で直す。
const SHARED_ALLOWED_PACKAGES = new Set(["zod"]);

// WHY テストを対象外にする: テストは組み立てのために規則の外側を参照する（例: presentation のテストが
//   test-support の InMemory リポジトリを new して query / command のコンストラクタに渡す。.claude/rules/testing.md の「置き方と環境」）。
//   規則は本番のコードの依存の向きを縛るもので、テストの組み立てまで縛ると正当なテストが書けなくなる。
// WHY .js / .jsx / .mjs / .cjs と .mts / .cts も対象にする: tsconfig.json が allowJs: true で、include が **/*.ts / **/*.tsx /
//   **/*.mts を含み、JS のファイルや ESM / CJS を明示した拡張子のファイルも同じビルドに入り、同じ規則の対象になるため。
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/;
// E2E のテスト（Playwright の *.spec.ts。testMatch の既定 **/*.@(spec|test).?(c|m)[jt]s?(x) のうち spec の側。apps/e2e/playwright.config.ts）。
//   Vitest のテスト（TEST_FILE）ではないので、多くの規則では検査の対象のまま。規則 class-based だけが除く（WHY は CLASS_BASED）。
const E2E_SPEC_FILE = /\.spec\.(?:[cm]?[jt]s|[jt]sx)$/;

type ImportStatement = {
  // import / export の from に書かれた文字列そのもの（"@repo/backend/..."、"../x"、"next/link" など）。
  specifier: string;
  // 型だけの参照か（import type / export type / すべての名前に inline の type が付いた import）。
  typeOnly: boolean;
  // re-export（export ... from）か。export ... from のときだけ true を持つ（import・副作用だけの import・dynamic import は
  //   持たない。持たないときは false と同じ）。規則 messages-colocation が、辞書の中継（barrel）を止めるのに使う（Issue #125）。
  // WHY 省略できる形にする: re-export を見る規則は messages-colocation だけで、import の例（抽出・正規化の仕様のテスト）の
  //   形を変えずに足すため。
  reExport?: boolean;
  // 定数だけの値の import か（Issue #144）。`import { A_B, type C } from "x"` のように、名前の並び（{}）だけで、inline の type の
  //   付かない名前が 1 つ以上あり、そのすべての元の名前（as の前）が UPPER_SNAKE_CASE のときだけ true を持つ（isConstantsOnly）。
  //   規則 presentation が、自 feature の domain の定数（TODO_TITLE_MAX_LENGTH）だけを値で import させるのに使う。
  // WHY 省略できる形にする: reExport と同じ（この印を見る規則は presentation だけ）。
  constantsOnly?: boolean;
};

type Reference = {
  // 参照元のファイル（リポジトリ相対、"/" 区切り、拡張子つき）。
  from: string;
  // import / export の from に書かれた文字列そのもの。書き方（"@/"・"@repo/backend/"・相対パス）を検査する規則
  //   （backend-relative-only）で使う。
  specifier: string;
  // 参照先。自前のコードはリポジトリ相対のパス（拡張子なし）、パッケージは specifier のまま（"next/link" など）。
  to: string;
  // 自前のコード（"@/" か相対パスで書いた参照）か。パッケージ名と自前のディレクトリ名が重なっても取り違えないようにするため、
  //   パスの形ではなく書き方で区別する。
  own: boolean;
  typeOnly: boolean;
  // re-export（export ... from）か（ImportStatement の reExport をそのまま持つ）。
  reExport?: boolean;
  // 定数だけの値の import か（ImportStatement の constantsOnly をそのまま持つ）。
  constantsOnly?: boolean;
};

// 文字列リテラルかコメントのどちらかに一致する正規表現。左から順に一致を探すので、先に始まった方が優先される。
//   文字列の中の "//"（URL など）はコメントより先に文字列として一致するので消えない。
//   コメントの中の引用符はコメントとして一致するので、文字列の開始と誤認しない。
// WHY '' と "" は改行をまたがせない: JSX のテキスト（<p>Don't</p>）の閉じない ' が、以降の行を文字列として飲み込まないようにする。
//   閉じない ' は一致しないまま読み飛ばされる。
// 限界（仕様として受け入れる）: 正規表現リテラル（/"/ や /\/\// や /a\/*/）は文字列やコメントの開始と誤認しうる。
//   テンプレートリテラルの ${} の中にさらに ` がある入れ子は正しく区切れない。誤認の影響は 2 方向ある。
//   - コメントを残してしまう: コメント中の例示を参照として拾い、多く検出する（見逃しにはならない。失敗したときに出る
//     「ファイル → 参照先」を見て判断できる）。
//   - 消しすぎる: 正規表現リテラル中の /* をコメントの開始と見なすと、次の */ までを消し、その間にある本物の import を
//     見逃す。こちらは検査の抜けになるが、正規表現リテラルと import 文を近くに書くことはまれなため受け入れる。
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

function stripComments(source: string): string {
  // WHY コメントを改行だけ残して消す: コメント中の例示（「// 例: import { GET } from "@/backend/..."」）を参照として拾わないため。
  //   改行を残すのは、行の区切りを保ち、前後の文が 1 行につながって別の文に見えるのを防ぐため。
  return source.replace(STRING_OR_COMMENT, (match, literal?: string) =>
    literal === undefined ? match.replace(/[^\n]/g, " ") : literal,
  );
}

// `import <句> from "x"` / `export <句> from "x"`。<句> は識別子・空白・{} , * $ だけからなる（名前の並び）。
// WHY <句> の文字を限定する: `export const GET = ...;` や `export default function ...() {` のような、from を持たない
//   export 文から後ろの別の文の from まで一致を伸ばさないため。= ( ; . を含む時点で一致しなくなる。
// WHY 文の先頭（行頭か ; の直後）に限り、<句> が行頭の import / export をまたがないようにする: `export enum E { A }` のように
//   <句> の文字だけでできていてセミコロンの無い文があると、その直後の `import type { X } from "y"` まで 1 つの export 文と
//   見なし、先頭の type を見落として値の参照と誤判定するため。; の直後も文の先頭に含めるのは、`a(); import { b } from "c";`
//   のように 1 行に複数の文を書いた場合も拾うため（本リポジトリの Biome の format では起きないが、抽出の仕様として固定している）。
// グループ: 1 = import / export（re-export かの判定）、2 = 先頭の type、3 = <句>、4 = specifier。
const IMPORT_EXPORT_FROM =
  /(?:^|;)\s*(import|export)\s+(type\s+)?((?:(?!^\s*(?:import|export)\b)[\w\s{},*$])*?)\s*\bfrom\s*["']([^"']+)["']/gm;
// `import "x"`（副作用だけの import。CSS など）。
// WHY 名前付きキャプチャ（(?<name>...)）を使わない: tsconfig.json の target が ES2017 で、next build の型チェックが
//   「Named capturing groups are only available when targeting 'ES2018' or later」で失敗するため（実測）。
//   specifier のグループ番号を findValueImports に渡す。
const SIDE_EFFECT_IMPORT = /\bimport\s*["']([^"']+)["']/g;
// `import("x")` / `import(\`x\`)` / `import("x", { with: { type: "json" } })`（dynamic import）。
// WHY ${} の無いテンプレートリテラルも拾う: 中身は普通の文字列と同じで、参照先を静的に決められるため。
// WHY 第 2 引数（import attributes）があっても拾う: 引数の数で参照先は変わらないため、`,` でも `)` でも閉じてよい。
// 文字列以外（変数や ${} を含むテンプレートリテラル）を渡したものは、参照先を静的に決められないため拾わない。
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`])([^"'`$]+)\1\s*[,)]/g;

// `{ type A, type B }` のように、名前の並びだけで、すべてに inline の type が付いているか。
// WHY default import や `* as` が混じるものは型だけにしない: 値の import が含まれ、実行時に参照先のモジュールが読み込まれるため。
function isInlineTypeOnly(clause: string): boolean {
  const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (braces === null) {
    return false;
  }
  const names = (braces[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  // WHY 空の {} は型だけにしない: `import {} from "x"` は名前を取らないが、参照先のモジュールは実行時に読み込まれる。
  // WHY `type as <別名>` は型だけにしない（Issue #224 / #227。Codex のレビュー）: `type` という名前の値の export を別名で受ける形で、
  //   inline の type 修飾子（`type <名前>`）ではなく実行時の import になる。空白で分けた語で見る（`type` と `as` の間の空白が
  //   複数でも同じ。正規表現の `\s+` だと後戻りで負の先読みが通ってしまう）。`type as as x`（`as` という名前の型の別名）と
  //   `type as`（`as` という名前の型）は型だけ。
  return names.length > 0 && names.every(isInlineTypeName);
}

function isInlineTypeName(name: string): boolean {
  const words = name.split(/\s+/);
  const valueNamedType = words.length === 3 && words[1] === "as";
  return words[0] === "type" && words.length >= 2 && !valueNamedType;
}

// 定数の名前の形（UPPER_SNAKE_CASE）。英大文字で始まり、英大文字・数字・_ だけ。
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

// `{ A_B, type C, D as e }` のように、名前の並びだけで、値の名前（inline の type の付かない名前）が 1 つ以上あり、
//   そのすべての元の名前（as の前）が定数の形か。
// WHY 元の名前で見る: 参照先が export している名前が規則の対象で、手元の別名（as の後ろ）は何でも付けられる。
// WHY default import・`* as` が混じるものは定数だけにしない: 名前（手元の束縛）から、参照先の何を使うかが分からない。
// 限界（仕様として受け入れる）: 名前が定数の形でも、中身が定数（プリミティブの値）かは見ない。UPPER_SNAKE_CASE で関数や
//   オブジェクトを export すれば通る（見逃す方向）。名前の規約（.claude/rules/backend.md）とレビューで止める。
function isConstantsOnly(clause: string): boolean {
  const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (braces === null) {
    return false;
  }
  const valueNames = (braces[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && !/^type\s/.test(name));
  return (
    valueNames.length > 0 &&
    valueNames.every((name) =>
      CONSTANT_NAME.test(name.split(/\s+as\s+/)[0] ?? ""),
    )
  );
}

type Located = ImportStatement & { index: number };

function findFromStatements(code: string): Located[] {
  return [...code.matchAll(IMPORT_EXPORT_FROM)].map((match) => ({
    index: match.index,
    specifier: match[4] ?? "",
    typeOnly: match[2] !== undefined || isInlineTypeOnly(match[3] ?? ""),
    // WHY import のときは reExport を持たせない（false も入れない）: ImportStatement の reExport の WHY と同じ。
    ...(match[1] === "export" && { reExport: true }),
    // WHY import の値の参照だけ: re-export は presentation から domain の値を外へ出すので定数でも許さない。import type は
    //   型だけの参照（typeOnly）で足りる。
    ...(match[1] === "import" &&
      match[2] === undefined &&
      isConstantsOnly(match[3] ?? "") && { constantsOnly: true }),
  }));
}

function findValueImports(
  code: string,
  pattern: RegExp,
  specifierGroup: number,
): Located[] {
  return [...code.matchAll(pattern)].map((match) => ({
    index: match.index,
    specifier: match[specifierGroup] ?? "",
    typeOnly: false,
  }));
}

// 文字列リテラルの範囲（[開始, 終了)）。stripComments の後のコードに使うので、一致するのは文字列だけになる。
function stringRanges(code: string): [number, number][] {
  return [...code.matchAll(STRING_OR_COMMENT)]
    .filter((match) => match[1] !== undefined)
    .map((match) => [match.index, match.index + match[0].length]);
}

function isInsideString(ranges: [number, number][], index: number): boolean {
  return ranges.some(([start, end]) => start <= index && index < end);
}

// ソースから import / re-export / dynamic import の参照を、書かれた順に取り出す。
// WHY 一致の始まりが文字列リテラルの中にあるものを捨てる: 'import("@/backend/x")' やテンプレートリテラルの中の行頭の
//   `import { a } from "..."` のような、コードの例を文字列で持つだけのものを参照と誤認しないため。本物の import の
//   specifier（"x"）も文字列だが、一致の始まり（import / export、行頭、; の位置）は文字列の外にあるので残る。
// 限界（仕様として受け入れる）:
//   - テンプレートリテラルの ${} の中に書いた import("x") は、文字列の中とみなして拾わない（見逃す方向）。
//   - ${} を含むテンプレートリテラルを渡した import(`@/backend/${name}`) は、参照先を静的に決められないので拾わない
//     （見逃す方向。DYNAMIC_IMPORT が specifier に $ を許さない）。
//   - `}` の直後に同じ行で続けた `export { x } from "y"`（`function f() {} export { x } from "y"`）は、文の先頭（行頭か ;
//     の直後）でないため拾わない（見逃す方向）。Biome の format は文ごとに改行するので、本リポジトリのコードでは起きない。
//   - 型の位置の `import("x").T`（`let a: import("x").T`）は dynamic import と同じ形なので、値の参照として拾う（型だけの
//     参照を値と数えるので、多く検出する方向）。
//   - `require()` と `import x = require()` は拾わない（本リポジトリは ESM だけ）。
function extractImports(source: string): ImportStatement[] {
  const code = stripComments(source);
  const ranges = stringRanges(code);
  return [
    ...findFromStatements(code),
    ...findValueImports(code, SIDE_EFFECT_IMPORT, 1),
    // DYNAMIC_IMPORT のグループ 1 は開き引用符（閉じ側の \1 で同じ種類にそろえるため）、グループ 2 が specifier。
    ...findValueImports(code, DYNAMIC_IMPORT, 2),
  ]
    .filter(({ index }) => !isInsideString(ranges, index))
    .sort((a, b) => a.index - b.index)
    .map(({ index: _index, ...statement }) => statement);
}

// WHY 拡張子を外す: 参照先の規則（`backend/features/<f>/internal/presentation/*.api` など）を拡張子なしの形で 1 通りに書くため。
//   import には通常拡張子を書かないが、書いた場合（"./x.ts"）も同じ参照として扱う。
const CODE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

// frontend から backend を指す書き方（Issue #68）。段階 2 では apps/backend が workspace パッケージ @repo/backend になり、
//   node_modules/@repo/backend（apps/backend への symlink）と apps/backend/package.json の exports で解決する。
const BACKEND_PACKAGE = "@repo/backend";

// frontend・backend・e2e・リポジトリ直下から apps/shared を指す書き方（Issue #90）。@repo/backend と同じく、node_modules/@repo/shared
//   （apps/shared への symlink）と apps/shared/package.json の exports で解決する。
const SHARED_PACKAGE = "@repo/shared";

// packageName と packageName/x だけ（"@repo/backend-extra" のような前方一致だけが同じ別パッケージは含めない）。
function isPackageSpecifier(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isBackendPackage(specifier: string): boolean {
  return isPackageSpecifier(specifier, BACKEND_PACKAGE);
}

function isSharedPackage(specifier: string): boolean {
  return isPackageSpecifier(specifier, SHARED_PACKAGE);
}

// 自前の workspace パッケージの名前と、そのディレクトリ（toReference で "<名前>/x" を "<ディレクトリ>/x" にする）。
const WORKSPACE_PACKAGES = [
  { packageName: BACKEND_PACKAGE, root: BACKEND_ROOT },
  { packageName: SHARED_PACKAGE, root: SHARED_ROOT },
];

// 参照先を、規則で比べる形にそろえる。
//   "@/x" → "apps/frontend_customer/x"（tsconfig の paths で "@/*" は apps/frontend_customer/*。backend のファイルに書いても、Next の
//     Turbopack は frontend の tsconfig の paths を当てるので apps/frontend_customer を指す。Issue #68 の researcher の実測）
//   "@repo/backend/x" → "apps/backend/x"、"@repo/shared/x" → "apps/shared/x"（各 package.json の exports は、キーのパスに .ts を
//     付けたファイルを指すことを BACKEND_EXPORTS / SHARED_EXPORTS で検査しているので、キーのパスがそのまま参照先になる）
//   相対パス → 参照元のファイルの位置から解決したリポジトリ相対のパス
//   それ以外 → パッケージ（specifier のまま）
// WHY "@/" と "@repo/backend/"・"@repo/shared/" の後ろも posix.normalize で ".." を解決する: "@/../backend/x" は tsconfig の
//   paths で apps/frontend_customer/../backend/x、つまり apps/backend/x に解決される。".." を残すと apps/frontend_customer の下の参照に見え、
//   backend への参照を検査する規則（frontend-to-backend-specifier など）を素通りする。
function toReference(
  from: string,
  { specifier, typeOnly, reExport, constantsOnly }: ImportStatement,
): Reference {
  const own = { from, specifier, own: true, typeOnly, reExport, constantsOnly };
  if (specifier.startsWith("@/")) {
    return {
      ...own,
      to: posix
        .normalize(`${FRONTEND_ROOT}/${specifier.slice(2)}`)
        .replace(CODE_EXTENSION, ""),
    };
  }
  const workspacePackage = WORKSPACE_PACKAGES.find(({ packageName }) =>
    isPackageSpecifier(specifier, packageName),
  );
  if (workspacePackage !== undefined) {
    return {
      ...own,
      to: posix
        .normalize(
          `${workspacePackage.root}${specifier.slice(workspacePackage.packageName.length)}`,
        )
        .replace(CODE_EXTENSION, ""),
    };
  }
  if (specifier.startsWith(".")) {
    // WHY posix で文字列として解決する: from がリポジトリ相対の "/" 区切りなので、ルートの場所（本番のリポジトリ直下か、
    //   fixture の一時ディレクトリか）に関係なく同じ結果になる。
    const to = posix
      .join(posix.dirname(from), specifier)
      .replace(CODE_EXTENSION, "");
    return { ...own, to };
  }
  return {
    from,
    specifier,
    to: specifier,
    own: false,
    typeOnly,
    reExport,
    constantsOnly,
  };
}

function isSourceNonTest(path: string): boolean {
  return SOURCE_FILE.test(path) && !TEST_FILE.test(path);
}

// 列挙から除くディレクトリ（どの階層にあっても、その中に入らない。walkFiles が中に入る前に飛ばす。Issue #142）。
//   node_modules: 依存（workspace パッケージ化した段階 2 では apps/*/node_modules/ ができる）。pnpm の相対パスの symlink を含む。
//   .next: next build / next dev の生成物（apps/frontend_customer/.next/。数千件の JS）。next build の .next/standalone/ には
//     pnpm の node_modules の形（相対パスの symlink）が複製され、循環する symlink を含みうる（Issue #130 / #142）。
//   .features-gen: playwright-bdd の bddgen が apps/e2e の .feature から生成する Playwright のテスト（apps/e2e/.features-gen/*.spec.js。
//     Issue #279。.gitignore 済み）。自分たちが書くコードではなく、.feature と step（apps/e2e/spec/*.steps.ts）が検査の対象。
// WHY 名前を列挙する（"." で始まるディレクトリをまとめて除かない）: まとめて除くと apps/backend/.lib/x.ts のような自前のコードが
//   検査を素通りする（Issue #68 の reviewer 指摘）。既知の生成物・依存だけを除き、それ以外の "." のディレクトリは通常どおり
//   検査して、置き場所の規則で違反にする。生成物のディレクトリが増えたらここに足す。
const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".features-gen"]);

type ReadDirectory = (absolutePath: string) => Dirent[];

const readDirectory: ReadDirectory = (absolutePath) =>
  readdirSync(absolutePath, { withFileTypes: true });

// symlink は先がディレクトリならディレクトリとして扱う（先が無い symlink はファイルとして返す）。
// WHY 循環しても無限には再帰しない: 循環する symlink をたどり続けると、パスに含まれる symlink が 40 段を超えたところで
//   statSync が ELOOP を投げ、列挙が例外で止まる（throwIfNoEntry: false が握りつぶすのは ENOENT だけ。reviewer の実測
//   2026-09-29、Issue #142 の「ファイルの列挙」のテストで固定）。以前の列挙（readdirSync の recursive: true）は ELOOP を黙って
//   握りつぶし、途中までの一覧を返していた。
function isDirectoryEntry(absolutePath: string, entry: Dirent): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  return (
    entry.isSymbolicLink() &&
    (statSync(absolutePath, { throwIfNoEntry: false })?.isDirectory() ?? false)
  );
}

// dir の下のファイル（再帰。ディレクトリ以外のすべて）を、リポジトリ相対の "/" 区切りのパスで返す。dir は "" 以外。
// WHY 自前で再帰する（readdirSync の recursive: true を使わない。Issue #130 / #142）: recursive: true は symlink の先の
//   ディレクトリにも入り（Node 24.21.0）、除外のディレクトリ（EXCLUDED_DIRS）を列挙の後で除くしかない。next build の
//   .next/standalone/ は pnpm の symlink を複製するため、その中を列挙するだけで heap を使い切った（#130 で 463 秒かけて OOM、
//   #137 で手元の node_modules/node_modules の自己参照 symlink が複製されて SIGABRT。詳細は「ファイルの列挙」のテスト）。
//   除外のディレクトリは中に入る前に飛ばす（EXCLUDED_DIRS に足すだけでは直らない）。
// WHY 除外しないディレクトリの symlink はたどる: 以前の列挙（recursive: true）と同じ範囲を検査し、symlink で置いたディレクトリの
//   コードを素通りさせないため。
// WHY read を引数で受け取る: 除外のディレクトリを「読まない」ことは結果の一覧からは見えない（後で除いても同じ一覧になる）ので、
//   テストで読んだディレクトリを記録して確かめる。
function walkFiles(
  root: string,
  dir: string,
  read: ReadDirectory = readDirectory,
): string[] {
  const absoluteDir = join(root, dir);
  if (!existsSync(absoluteDir)) {
    return [];
  }
  return read(absoluteDir).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (!isDirectoryEntry(join(absoluteDir, entry.name), entry)) {
      return [path];
    }
    return EXCLUDED_DIRS.has(entry.name) ? [] : walkFiles(root, path, read);
  });
}

// WHY root を引数で受け取る: 本番の検査（リポジトリ直下）と、fixture の一時ディレクトリに置いた架空のツリーの検査で、
//   列挙 → 抽出 → 正規化 → 判定の同じ経路を通すため。
function listSourceFiles(root: string, dir: string): string[] {
  return walkFiles(root, dir).filter(isSourceNonTest);
}

// dir の直下のファイル（ディレクトリの中は見ない）。dir が "" ならリポジトリ直下。
function listDirectFiles(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) {
    return [];
  }
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => (dir === "" ? entry.name : `${dir}/${entry.name}`));
}

// apps/frontend_customer・apps/backend・apps/shared のソース（テスト以外）。
// WHY apps/shared も入れる（Issue #90）: apps/shared のファイルも参照元として規則にかけ（置き場所・exports の数え方など）、
//   環境変数の直参照・console の検査（env.ts・logger.ts が例外であることを含む）の対象にするため。
function listAllSourceFiles(root: string): string[] {
  return [
    ...listSourceFiles(root, FRONTEND_ROOT),
    ...listSourceFiles(root, BACKEND_ROOT),
    ...listSourceFiles(root, SHARED_ROOT),
  ];
}

function referencesOf(root: string, files: string[]): Reference[] {
  return files.flatMap((file) =>
    extractImports(readFileSync(join(root, file), "utf8")).map((statement) =>
      toReference(file, statement),
    ),
  );
}

// 参照を取り出すファイル。依存の向きの対象（listAllSourceFiles）に、apps/e2e/ のソース（apps/e2e/playwright.config.ts を含む）と
//   リポジトリ直下のファイル（vitest.global-setup.ts など。テストは除く）を足す。
// WHY apps/e2e/ とリポジトリ直下を足す: backend を @repo/backend として、apps/shared を @repo/shared として使う側
//   （frontend-to-backend-specifier・BACKEND_EXPORTS・frontend-to-shared-specifier・SHARED_EXPORTS）の検査の対象にするため
//   （Issue #68 の段階 2・Issue #90）。ほかの規則は参照元を apps/ の下に絞っているので、足しても影響しない。
// 限界: リポジトリ直下のほかのディレクトリ（scripts/ の .ts のテスト以外など）は見ない。今は該当するソースが無い
//   （scripts/ はシェルスクリプトとテストだけ）。そこに backend を参照するソースを置くなら、ここと fixture に足す。
function listReferencingFiles(root: string): string[] {
  return [
    ...listAllSourceFiles(root),
    ...listSourceFiles(root, E2E_ROOT),
    ...listDirectFiles(root, "").filter(isSourceNonTest),
  ];
}

function collectReferences(root: string): Reference[] {
  return referencesOf(root, listReferencingFiles(root));
}

// --- 規則で使う判定 ---

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function ownUnder(ref: Reference, dir: string): boolean {
  return ref.own && isUnder(ref.to, dir);
}

// "apps/frontend_customer/features/todo/..." → "todo"
function featureOf(path: string): string | undefined {
  return /^apps\/frontend_customer\/features\/([^/]+)\//.exec(path)?.[1];
}

type BackendLayer = "domain" | "application" | "presentation" | "infra";
// scope: 層を持つ feature のディレクトリ "features/<f>/internal"。
// WHY feature の名前ではなく "features/<f>/internal" で持つ（Issue #98・#208）: backend も frontend と同じく最初の階層を features/ と shared/ に
//   したので、features/shared/（shared という名前の feature）と backend/shared/ は別の場所になった。名前だけで持つと、
//   features/shared/ を backend/shared/ と取り違え、別 feature を「feature をまたぐもの」として許してしまう。
// WHY feature の 4 層は features/<f>/internal/ の下（Issue #208）: feature の直下を、他のモジュールへ公開する入口（expose/）と
//   feature の中だけで使う実装（internal/）に分けるため（モジュラーモノリス）。4 層は internal/ の中だけに置き、
//   features/<f>/<層>/（Issue #208 より前の置き場所）は層に属さない（置き場所の規則 BACKEND_PLACEMENT が違反にする）。
//   expose/ も層に属さない（層の規則の代わりに expose-imports がかかる）。
// WHY backend/shared/ は層を持たない（Issue #310。ユーザー判断）: 以前は backend/shared/ も domain / application / presentation /
//   infra に分け、feature の層ごとに使ってよい shared の層を決めていた。shared の中身はエラー・トランザクション・HTTP・Drizzle・
//   変更履歴のような横断の部品で、層で分けると 1 つの関心（例: トランザクションの port と Postgres の runner）が層をまたいで
//   散らばり、参照の例外（型だけ・名前で 1 ファイルだけ）が増えた。意味の単位（BACKEND_SHARED_UNITS）に分け、feature のどの層
//   からもどの単位も使ってよいことにした。
type BackendLocation = { scope: string; layer: BackendLayer };

// "apps/backend/features/todo/internal/presentation/..." → { scope: "features/todo/internal", layer: "presentation" }
// 層を持つのは features/<f>/internal/ の下だけ（Issue #98・#208・#310）。features/ を挟まない apps/backend/<x>/<層>/（Issue #98
//   より前の置き場所）と、internal/ を挟まない apps/backend/features/<f>/<層>/（Issue #208 より前の置き場所）は層に属さない
//   （置き場所の規則 BACKEND_PLACEMENT が違反にする）。backend/shared/ も層に属さない（Issue #310。単位で分ける）。
function backendLayerOf(path: string): BackendLocation | undefined {
  const match =
    /^apps\/backend\/(features\/[^/]+\/internal)\/(domain|application|presentation|infra)(?:\/|$)/.exec(
      path,
    );
  return match === null
    ? undefined
    : { scope: match[1] ?? "", layer: (match[2] ?? "") as BackendLayer };
}

const BACKEND_SHARED_ROOT = "apps/backend/shared";
// backend/shared/ の意味の単位（Issue #310。ユーザー判断）。apps/backend/shared/ のファイルはこのどれかのディレクトリの下だけに置く
//   （置き場所の規則 BACKEND_PLACEMENT）。feature の層と expose はどの単位も参照してよい。
//   error:       ErrorKey・DomainError・KeyedIssue・validate（domain の失敗の表し方と入力の検証）
//   transaction: トランザクションの印の型 Transaction と、張る口 TransactionRunner の port
//   http:        HTTP の境界（リクエストの本文・id の読み取り、Problem Details への変換と英語の detail）
//   drizzle:     Drizzle / Postgres の基盤（プール・runner の実装・Writer・列の分類・差分）と drizzle-kit の設定・マイグレーション
//   change-log:  変更履歴（change_logs の表と書き込み、操作の種類）
// WHY 一覧に固定する: 単位を自由に足せると、shared/ が何でも置ける場所になり、feature のコードや層の関心が shared に集まる。
//   足すときはここと .claude/rules/architecture-check.md・.claude/rules/backend.md を同じ変更で直す（足すことをレビューに出す）。
const BACKEND_SHARED_UNITS = [
  "error",
  "transaction",
  "http",
  "drizzle",
  "change-log",
] as const;

// backend/shared の単位の下か（単位のディレクトリそのもの = index も含む）。前方一致だけが同じ別ディレクトリ（http-x）、
//   単位の外（shared の直下・一覧に無い単位・層に分けていたときの旧ディレクトリ）は含めない。
function isBackendSharedUnit(path: string): boolean {
  return BACKEND_SHARED_UNITS.some((unit) =>
    isUnder(path, `${BACKEND_SHARED_ROOT}/${unit}`),
  );
}

// backend のモジュール（Issue #208。モジュラーモノリス。1 つの feature = 1 つのモジュール）。
// "apps/backend/features/todo/..." → "todo"。features/ の下でなければ undefined（backend/shared・test-support・spec は
//   モジュールではない）。
function backendModuleOf(path: string): string | undefined {
  return /^apps\/backend\/features\/([^/]+)\//.exec(path)?.[1];
}

// 参照先が、あるモジュールの part（"internal" か "expose"）の下（part のディレクトリそのもの = index も含む）なら、そのモジュール名。
// "apps/backend/features/notification/expose/notifier" と "expose" → "notification"
// WHY 前方一致の境界を付ける（part の直後は "/" か末尾）: internal-x・exposed のような別ディレクトリを取り違えない。
function backendModulePartOf(
  path: string,
  part: "internal" | "expose",
): string | undefined {
  return new RegExp(`^apps/backend/features/([^/]+)/${part}(?:/|$)`).exec(
    path,
  )?.[1];
}

// 参照先が、参照元とは別のモジュールの part の下か。
function isOtherModulePart(
  ref: Reference,
  part: "internal" | "expose",
): boolean {
  const target = backendModulePartOf(ref.to, part);
  return (
    ref.own && target !== undefined && target !== backendModuleOf(ref.from)
  );
}

// モジュールの公開の入口（features/<f>/expose/ の下のファイル）か。
function isExposeFile(path: string): boolean {
  return /^apps\/backend\/features\/[^/]+\/expose\//.test(path);
}

// expose が参照してよい自前コード: 自モジュールの internal/ と expose/ の中、apps/backend/shared/ のどの単位も、apps/shared の
//   presentation が使えるモジュール（SHARED_MODULES_BY_LAYER.presentation。logger・now）と env。
// WHY 自モジュールの internal はどの層でも許す: expose はモジュールの公開 API の組み立ての場所（presentation の api ファイルと
//   同じ役割）で、application の command と infra の実装を組み立てて呼ぶ。
// WHY backend/shared と env を許す（Issue #208 のオーケストレータの判断）: 組み立てには、api ファイルと同じく
//   `new PostgresTodoRepository(AppDatabase.get().db)` のように backend/shared/drizzle/database が要る（将来 todo の expose が
//   internal を組み立てるとき）。env も組み立ての設定として許す。
// 禁止のまま: 他のモジュールの expose / internal、自モジュールの internal/・expose/ の外の features、test-support、画面側。
function exposeMayUse(ref: Reference): boolean {
  const moduleName = backendModuleOf(ref.from);
  return (
    isUnder(ref.to, `apps/backend/features/${moduleName}/internal`) ||
    isUnder(ref.to, `apps/backend/features/${moduleName}/expose`) ||
    isBackendSharedUnit(ref.to) ||
    SHARED_MODULES_BY_LAYER.presentation.has(ref.to) ||
    ref.to === SHARED_ENV_MODULE
  );
}

// "next/link" → "next"、"@scope/pkg/sub" → "@scope/pkg"
function packageName(specifier: string): string {
  const segments = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  return segments.slice(0, count).join("/");
}

// WHY サブパス（next/server、react/jsx-runtime など）もまとめて扱う: 同じフレームワークへの依存で、規則の意図（domain などを
//   フレームワークから切り離す）はサブパスでも同じため。
const FRAMEWORK_PACKAGES = new Set(["next", "react", "react-dom"]);

function usesFramework(ref: Reference): boolean {
  return !ref.own && FRAMEWORK_PACKAGES.has(packageName(ref.to));
}

// DB（永続化）のパッケージ。domain / application からは参照しない（規則 core-to-persistence）。
// WHY パッケージ名で比べる（サブパスもまとめて扱う）: drizzle-orm/pg-core・drizzle-orm/node-postgres も同じ DB への依存で、
//   前方一致の文字列比較にすると pg-format のような別パッケージまで巻き込むため。
// WHY drizzle-orm と pg だけ: 今のリポジトリで使っている DB のパッケージがこの 2 つ（Issue #57）。DB のパッケージを足したら
//   ここにも足す（drizzle-kit は開発時のツールで、アプリのコードからは import しない）。
const PERSISTENCE_PACKAGES = new Set(["drizzle-orm", "pg"]);

function usesPersistence(ref: Reference): boolean {
  return !ref.own && PERSISTENCE_PACKAGES.has(packageName(ref.to));
}

// backend の api ファイル（1 API = 1 ファイル `apps/backend/features/<f>/internal/presentation/<verb>-<noun>.api.ts`。
//   backend/shared の HTTP の境界 `apps/backend/shared/http/` の直下の *.api も同じ形として扱う。Issue #98 より前は
//   `apps/backend/<x>/presentation/`、Issue #208 より前は `apps/backend/features/<f>/presentation/`、Issue #310 より前は shared 側が
//   `apps/backend/shared/presentation/` で、同じ範囲。旧パスは許さない）。
const PRESENTATION_API =
  /^apps\/backend\/(?:features\/[^/]+\/internal\/presentation|shared\/http)\/[^/]+\.api$/;

// feature の公開 API（`apps/frontend_customer/features/<f>/index.ts`）。"…/features/todo" と "…/features/todo/index" のどちらの
//   書き方も同じファイルを指す。
const FEATURE_INDEX = /^apps\/frontend_customer\/features\/[^/]+(?:\/index)?$/;

function isFeatureApi(path: string): boolean {
  return /^apps\/frontend_customer\/features\/[^/]+\/api\//.test(path);
}

// apps/frontend_customer 直下のファイル（next.config.ts・instrumentation.ts・instrumentation-node.ts・proxy.ts）。
function isFrontendRootFile(path: string): boolean {
  return /^apps\/frontend_customer\/[^/]+$/.test(path);
}

// 画面・部品の辞書（*.messages.ts。Issue #125）。参照先（拡張子を除いたパス）の名前が ".messages" で終わるもの。
// WHY 拡張子を問わない: toReference が参照先の拡張子を除くので、"./x.messages" と "./x.messages.ts" は同じ参照先になる。
//   辞書の本体が .ts でなくても（規則 frontend-hardcoded-text の例外は .ts だけ）、参照の向きは同じ規則で見る。
const MESSAGES_MODULE = /\.messages$/;
// 共通の辞書（API のエラー ErrorKey と error.*）。apps/frontend_customer のどこから参照してもよい唯一の辞書。
const COMMON_MESSAGES_MODULE =
  "apps/frontend_customer/shared/i18n/common.messages";

// 環境変数の唯一の入口（Issue #59）とサーバ側のログの唯一の出口（Issue #85）。Issue #90 で apps/backend/shared/infra/ から
//   apps/shared/ に移した（frontend 直下の instrumentation-node.ts・proxy.ts、backend、apps/e2e/、リポジトリ直下が共通で使うため。
//   以前は frontend 直下から backend を参照する frontend-root-to-backend の例外だった）。
const SHARED_ENV_MODULE = `${SHARED_ROOT}/env`;
const SHARED_LOGGER_MODULE = `${SHARED_ROOT}/logger`;
// 現在時刻の唯一の出口（規則 now-single-source）。
const SHARED_NOW_MODULE = `${SHARED_ROOT}/now`;

// backend の層ごとに、参照してよい apps/shared のモジュール（Issue #90。移す前に backend/shared/infra にあったときと同じ範囲）。
// WHY domain / application には許さない: env・logger は外の世界（環境変数・stdout）に触る基盤で、移す前も infra 層にあった。
//   domain / application から使うと、層の規則で infra を参照させなかった意味が無くなる。
// WHY presentation には logger だけ許す: presentation の infra は組み立てに使う Postgres の Repository の実装と
//   backend/shared/drizzle/database だけ（下の presentationAllows）だが、想定外の例外をログに残すのは HTTP の境界
//   （ProblemResponse.from）の仕事で、ログの出口をコンストラクタで渡すと全 API の組み立てに logger が入る。logger は状態を持たず、差し替えずにテストできる（console を spy する）ので、直接 import させる（Issue #85）。
//   env は infra（接続先・プールの設定）だけが使う。
// WHY now はすべての層に許す: now() は現在時刻の Date を返すだけで、環境変数・出力・DB に触らない。Entity の生成ルール
//   （Todo.create の作成日時）は domain に置くので、domain から現在時刻を読めないと時刻を引数で受け取る形になり、
//   生成ルールが呼び出し側に漏れる。テストは vi.mock でこのモジュールを差し替えて時刻を決める。
const SHARED_MODULES_BY_LAYER: Record<BackendLayer, ReadonlySet<string>> = {
  domain: new Set([SHARED_NOW_MODULE]),
  application: new Set([SHARED_NOW_MODULE]),
  presentation: new Set([SHARED_LOGGER_MODULE, SHARED_NOW_MODULE]),
  infra: new Set([SHARED_ENV_MODULE, SHARED_LOGGER_MODULE, SHARED_NOW_MODULE]),
};

// features/<f>/api/ から、同じ feature の api ファイル（backend/features/<f>/internal/presentation/*.api）への参照か。
// frontend-to-backend-specifier の例外（Issue #68 の段階 2。オーケストレータの判断）: リポジトリ直下の vitest.global-setup.ts
//   （テスト基盤）だけは、apps/backend/test-support/database を相対パスで参照してよい（Issue #181 で
//   apps/backend/shared/drizzle/database.test-support から移した）。
// WHY: test-support/database はテストのための処理（前の実行が残したテスト用スキーマの後始末）で、パッケージの公開面（exports。
//   frontend / e2e / 設定が使うアプリの入口だけ、というユーザー判断）に含めない（rule-tests/test-support.test.ts が exports に
//   test-support を載せることを止める）。exports に無いので @repo/backend では解決できず、相対パスで読むしかない。例外はファイルと
//   参照先の組で絞り、ほかのファイルからの test-support、global-setup からほかの backend のファイル（env など）への相対参照は
//   違反のままにする。
const TEST_INFRA_RELATIVE_EXCEPTION = {
  from: "vitest.global-setup.ts",
  to: "apps/backend/test-support/database",
};

function isTestInfraRelativeException(ref: Reference): boolean {
  return (
    ref.from === TEST_INFRA_RELATIVE_EXCEPTION.from &&
    ref.to === TEST_INFRA_RELATIVE_EXCEPTION.to
  );
}

function isOwnFeatureApiFile(ref: Reference): boolean {
  return (
    PRESENTATION_API.test(ref.to) &&
    backendLayerOf(ref.to)?.scope === `features/${featureOf(ref.from)}/internal`
  );
}

// 参照元の層ごとに、自 feature の中で参照してよい層（.claude/rules/backend.md の 4 層の表）。
// WHY 許可の一覧で書く: 禁止の一覧だと、書き忘れた参照先（他 feature の層、画面側の shared/ など）が黙って通る。
//   許可の一覧なら、ここに無い自前コードはすべて違反になる。
// backend/shared はここでは見ない（Issue #310。どの層もどの単位も使ってよい。backendMayUse の isBackendSharedUnit）。
const LAYERS_MAY_USE: Record<BackendLayer, ReadonlySet<BackendLayer>> = {
  domain: new Set(["domain"]),
  application: new Set(["domain", "application"]),
  // presentation の infra は自 feature の Postgres の Repository の実装だけ、feature の domain は型と定数だけ
  //   （presentationAllows で絞る）。
  presentation: new Set(["domain", "application", "presentation", "infra"]),
  // Repository の実装が同じ infra の schema を使うので、infra 同士の参照も許す。
  // WHY application を許さない（Issue #220）: Issue #123 でコンテナを廃止してから、infra が自 feature の application を参照する
  //   本番のコードは 0 件だった。infra が application を知ると、command（ユースケース）の都合が永続化の実装に入り込む。
  //   infra が実装する port（TransactionRunner）は backend/shared/transaction にあり、shared なので許される（Issue #310）。
  infra: new Set(["domain", "infra"]),
};

// 自 feature の infra の Postgres の Repository の実装（`<名前>-repository.postgres`。1 階層だけ）か。
// WHY ファイル名の形で絞る: Issue #123 でコンテナを廃止し、api ファイルが `new XxxQuery(new PostgresTodoRepository(AppDatabase.get().db))`
//   と組み立てる。組み立てに要るのは Postgres の実装だけで、InMemory の実装（`*.in-memory`。テスト用）や schema を本番の
//   presentation から使わせない。名前の前方一致だけが同じ別ファイル（`*.postgres-helper`）、テスト（`*.postgres.test`）、
//   深い階層も許さない。
function isOwnPostgresRepository(
  ref: Reference,
  self: BackendLocation,
): boolean {
  const infraDir = `apps/backend/${self.scope}/infra/`;
  return (
    ref.to.startsWith(infraDir) &&
    /^[^/]+-repository\.postgres$/.test(ref.to.slice(infraDir.length))
  );
}

// presentation 固有の絞り込み（自 feature の中の参照だけ。backend/shared は backendMayUse が先に許す）。
//   - infra は、自 feature の Postgres の Repository の実装（`*-repository.postgres`）だけ（Issue #123。api ファイルがモジュールの
//     最下部で本番の handler を組み立てる）。プール（backend/shared/drizzle/database）と runner（backend/shared/drizzle/
//     transaction.postgres。Issue #215）は shared なので、Issue #310 からは名前で絞らずに許す。
//     ログの出口 apps/shared/logger は backend の外なので、ここではなく SHARED_MODULES_BY_LAYER で許す（Issue #90）。
//   - feature の domain は import type と、定数（UPPER_SNAKE_CASE の名前）だけの値の import だけ（「domain（Entity の型の参照と
//     定数のみ）」）。Entity の生成や操作は application を通す。
//     WHY 定数を許す（Issue #144。ユーザー判断）: リクエストのスキーマが domain と同じ規則（title の上限の文字数）を重ねるとき、
//     数値を 2 か所に書かずに domain の定数（TODO_TITLE_MAX_LENGTH）を参照させる。関数・Entity は値で使わせない。
//     backend/shared/error（DomainError・KeyedIssue.of）はエラーの変換（instanceof）とキーの付与に値として使うが、shared なので
//     この絞り込みにはかからない。
function presentationAllows(
  ref: Reference,
  self: BackendLocation,
  target: BackendLocation,
): boolean {
  if (target.layer === "infra") {
    return isOwnPostgresRepository(ref, self);
  }
  if (target.layer === "domain") {
    return ref.typeOnly || ref.constantsOnly === true;
  }
  return true;
}

// feature の層にあるファイルから、自前コードへの参照が許可の一覧に入っているか。
// 許すのは、backend/shared のどの単位と、自 feature の参照元の層が参照してよい層と、参照元の層が使ってよい apps/shared の
// モジュール（SHARED_MODULES_BY_LAYER）だけ。他 feature のどの層も、画面側（features/ app/ shared/）も、層に属さない場所
// （test-support・backend/shared の単位の外）も許さない。
function backendMayUse(ref: Reference): boolean {
  const self = backendLayerOf(ref.from);
  if (self === undefined) {
    return false;
  }
  if (isUnder(ref.to, SHARED_ROOT)) {
    return SHARED_MODULES_BY_LAYER[self.layer].has(ref.to);
  }
  // Issue #310（ユーザー判断）: feature のどの層からも backend/shared のどの単位を参照してもよい（値・型・re-export のどれも）。
  //   以前は shared も層に分け、feature の層ごとに使ってよい shared の層を決め、トランザクションの port（shared/application/
  //   transaction）は型だけ（Issue #224・#230）、presentation から shared の infra は database と transaction.postgres だけ
  //   （Issue #123・#215）に絞っていた。shared は feature をまたぐ部品の置き場所で、どの単位も feature より下にある（shared から
  //   features を参照しないことは backend-shared が見る）ので、層の向きは崩れない。domain・application が DB のパッケージを
  //   直接 import しないことは core-to-persistence が見る（shared を経由した参照は縛らない）。
  if (isBackendSharedUnit(ref.to)) {
    return true;
  }
  // Issue #208: feature の presentation（組み立ての場所）は、他のモジュールの公開の入口（expose）を使える。expose は層に属さない
  //   ので、ここで先に許す。ほかの層・自モジュールの expose は下の層の判定で違反になる（参照先が層に属さない）。
  //   境界の意味（他のモジュールは expose だけ・expose は presentation から）は module-internal と
  //   module-expose-only-from-presentation の規則が名前付きで見る。
  if (self.layer === "presentation" && isOtherModulePart(ref, "expose")) {
    return true;
  }
  const target = backendLayerOf(ref.to);
  if (target === undefined) {
    return false;
  }
  return (
    target.scope === self.scope &&
    LAYERS_MAY_USE[self.layer].has(target.layer) &&
    (self.layer !== "presentation" || presentationAllows(ref, self, target))
  );
}

// backend の各層の規則の本体。パッケージは next / react / react-dom 以外を許し、自前コードは許可の一覧で縛る。
// WHY node:* などのパッケージは next・react 以外許す: Entity の id の生成（node:crypto の randomUUID）などに使い、
//   フレームワークや永続化の都合ではないため。
function violatesBackendLayer(ref: Reference): boolean {
  return usesFramework(ref) || (ref.own && !backendMayUse(ref));
}

// 規則の識別子。規則ごとの判定テスト（RULE_EXAMPLES）から規則を引くために使う。
type RuleId =
  | "frontend-to-backend-specifier"
  | "frontend-to-shared-specifier"
  | "backend-to-frontend"
  | "backend-relative-only"
  | "frontend-root-to-backend"
  | "screen-to-backend"
  | "screen-to-shared"
  | "feature-api-to-backend"
  | "feature-to-feature"
  | "screen-to-app"
  | "shared-to-features"
  | "domain"
  | "application"
  | "core-to-persistence"
  | "presentation"
  | "infra"
  | "backend-shared"
  | "app"
  | "app-api"
  | "shared-self-contained"
  | "messages-colocation"
  | "module-internal"
  | "module-expose-only-from-presentation"
  | "expose-imports";

type Rule = {
  id: RuleId;
  // テスト名（step の文。ruleStepText で「*」を言い換える）。.claude/rules/architecture-check.md の規則の文に対応する仕様文。
  name: string;
  appliesTo: (from: string) => boolean;
  isViolation: (ref: Reference) => boolean;
};

// 1 規則 = 1 テスト。規則を足す・変えるときは .claude/rules/architecture-check.md と合わせてここと RULE_EXAMPLES（判定の例）を直す。
const RULES: Rule[] = [
  {
    // 「frontend（と apps/e2e/・リポジトリ直下の設定ファイル）から backend への参照は "@repo/backend/..." だけ」（Issue #68 の段階 2）。
    // WHY 相対パス（"../backend/..."）と "@/../backend/..." を禁止する: apps/backend/package.json の exports（公開する入口）を
    //   通らずに backend の中のファイルを指せてしまい、exports を明示した意味がなくなる。後で backend を別パッケージ・別プロセスに
    //   分けたときも、相対パスの参照は壊れる。書き方を 1 つにそろえ、公開の過不足は BACKEND_EXPORTS で検査する。
    //   段階 1 の限界（参照先で判定するので、相対パスでも許される場所なら違反にしない）を、この規則で解消する。
    // WHY 参照先が backend のものだけを見る: apps/frontend_customer の中の参照（"@/..." や "./x"）はこの規則の対象外。
    // WHY apps/e2e/ とリポジトリ直下も対象にする: apps/e2e/playwright.config.ts・apps/e2e/support/database.ts・vitest.global-setup.ts も env.ts などを
    //   使う。相対パスを許すと、exports に無いファイルを使っていても気づけない。
    id: "frontend-to-backend-specifier",
    name: 'apps/frontend_customer/・apps/e2e/・リポジトリ直下のファイルから apps/backend/ への参照は "@repo/backend/..." の書き方だけ（相対パスや "@/../backend/" を使わない。例外は vitest.global-setup.ts → test-support/database の相対パスだけ）',
    appliesTo: (from) =>
      isUnder(from, FRONTEND_ROOT) ||
      isUnder(from, E2E_ROOT) ||
      !from.includes("/"),
    isViolation: (ref) =>
      ownUnder(ref, BACKEND_ROOT) &&
      !isBackendPackage(ref.specifier) &&
      !isTestInfraRelativeException(ref),
  },
  {
    // 「frontend（と apps/e2e/・リポジトリ直下の設定ファイル）から apps/shared への参照は "@repo/shared/..." だけ」（Issue #90）。
    // WHY frontend-to-backend-specifier を広げずに別の規則にする: 1 規則 = 1 テストで、失敗したときにどちらのパッケージの境界が
    //   破れたかがテスト名で分かり、fault injection も規則ごとに独立に行える。backend 側だけにある例外
    //   （vitest.global-setup.ts → test-support/database の相対パス）を apps/shared に持ち込まないためでもある。
    // WHY 相対パスを禁止する: frontend-to-backend-specifier と同じく、apps/shared/package.json の exports（公開する入口）を通らずに
    //   apps/shared の中のファイルを指せてしまい、公開の過不足（SHARED_EXPORTS）を検査できなくなる。
    // WHY backend は対象にしない: backend の中の書き方は backend-relative-only が 1 つの規則で見る（backend の中は相対パス、
    //   apps/shared へは "@repo/shared/..." だけ）。ここで backend も見ると、同じ参照が 2 つの規則で重ねて出る。
    id: "frontend-to-shared-specifier",
    name: 'apps/frontend_customer/・apps/e2e/・リポジトリ直下のファイルから apps/shared/ への参照は "@repo/shared/..." の書き方だけ（相対パスや "@/../shared/" を使わない）',
    appliesTo: (from) =>
      isUnder(from, FRONTEND_ROOT) ||
      isUnder(from, E2E_ROOT) ||
      !from.includes("/"),
    isViolation: (ref) =>
      ownUnder(ref, SHARED_ROOT) && !isSharedPackage(ref.specifier),
  },
  {
    // 「backend → frontend は禁止」（Issue #68）。backend は Next / React・画面側に依存しない pure な TypeScript にし、
    //   後で別プロセスに分けるときに frontend を持ち出さずに済むようにする。
    // WHY 4 層の規則と別に持つ: 4 層の規則は層の下のファイルにしかかからない。apps/backend/shared/drizzle/drizzle.config.ts のような
    //   層に属さない（置き場所の規則で例外にした）ファイルからの参照も止める。
    id: "backend-to-frontend",
    name: "apps/backend/ は apps/frontend_customer/ を参照しない",
    appliesTo: (from) => isUnder(from, BACKEND_ROOT),
    isViolation: (ref) => ownUnder(ref, FRONTEND_ROOT),
  },
  {
    // 「backend の内部 import はすべて相対パス」（Issue #68）。
    // WHY "@/" を使わない: Next（Turbopack）は backend のファイルの "@/" にも frontend の tsconfig の paths を当て、
    //   apps/frontend_customer の中を探してビルドが失敗する（researcher の実測）。
    // WHY "@repo/backend/" も使わない: workspace パッケージ化（段階 2）で exports を明示し、公開するのは frontend が使う
    //   入口だけにする（ユーザー判断）。自パッケージ名の参照は exports を通るので、公開していない内部のファイルを
    //   指せなくなる。相対パスなら exports に関係なく解決する。
    // WHY 参照先ではなく書き方（specifier）で判定する: "@repo/backend/x" と "../x" は同じファイルを指し、参照先では区別できない。
    // WHY apps/shared へは "@repo/shared/..." だけ（Issue #90。features/<f>/internal/<層>/ からの相対パスの "../../../../../shared/env" も違反）: apps/shared は別の
    //   workspace パッケージで、backend の中ではない。apps/backend/package.json に "@repo/shared": "workspace:*" を置き、
    //   exports（apps/shared/package.json）を通して使う。exports を経由しない参照を許すと、apps/shared の公開範囲（exports。
    //   SHARED_EXPORTS）が意味を持たなくなる（frontend・e2e の frontend-to-shared-specifier と同じ扱い。オーケストレータの判断）。
    //   どの層から何を使ってよいかは層の規則（SHARED_MODULES_BY_LAYER）が見る。
    id: "backend-relative-only",
    name: 'apps/backend/ の中の自前コードへの import は相対パスだけで（"@/" と "@repo/backend/" を使わない）、apps/shared へは "@repo/shared/..." だけ（相対パスは使わない）',
    appliesTo: (from) => isUnder(from, BACKEND_ROOT),
    isViolation: (ref) =>
      ref.specifier.startsWith("@/") ||
      isBackendPackage(ref.specifier) ||
      (ownUnder(ref, SHARED_ROOT) && !isSharedPackage(ref.specifier)),
  },
  {
    // 「frontend から backend への参照は app/api（値）と features/*/api（型）だけ」（Issue #68）。apps/frontend_customer 直下のファイルは
    //   backend を参照しない。
    // WHY 直下のファイルに規則を置く: 置かないと、next.config.ts などから backend の何を参照しても検査を素通りする。
    // WHY 例外を持たない（Issue #90）: 以前は instrumentation-node.ts の起動時の検証（env。Issue #59）と proxy.ts・
    //   instrumentation-node.ts のログ（logger。Issue #85）のために backend/shared/infra の env・logger だけを許していた。
    //   env・logger は frontend と backend で共通のものなので apps/shared（@repo/shared）に移し、直下のファイルは
    //   "@repo/shared/..." で使う（frontend-to-shared-specifier）。
    id: "frontend-root-to-backend",
    name: "apps/frontend_customer/ 直下のファイルは apps/backend/ を参照しない（env・logger は apps/shared から使う）",
    appliesTo: isFrontendRootFile,
    isViolation: (ref) => ownUnder(ref, BACKEND_ROOT),
  },
  {
    // 「`features/<feature>/` の `api/` 以外は backend を参照せず、`api/` が re-export した型を使う」
    // WHY 画面側の shared/ も含める: 画面側で backend を参照してよいのは features/<f>/api/ だけ（「画面側とサーバ側の境界」）で、
    //   shared/ から参照すると境界が api/ の 1 か所に集まらなくなるため。
    id: "screen-to-backend",
    name: "apps/frontend_customer/features/<f>/ の api/ 以外と apps/frontend_customer/shared/ は apps/backend/ を参照しない",
    appliesTo: (from) =>
      (isUnder(from, "apps/frontend_customer/features") &&
        !isFeatureApi(from)) ||
      isUnder(from, "apps/frontend_customer/shared"),
    isViolation: (ref) => ownUnder(ref, BACKEND_ROOT),
  },
  {
    // 「apps/frontend_customer の app/・features/・shared/ は apps/shared を参照しない」（Issue #90）。apps/shared を使ってよいのは
    //   frontend では直下のサーバ側のファイル（instrumentation-node.ts・proxy.ts）だけ。
    // WHY: apps/shared の env（process.env を読み、.env をファイルから読み込む）と logger（stdout への出力）はサーバ側の基盤で、
    //   画面のコード（Client Component から読み込まれうる）に入れると、ブラウザのバンドルに Node の API や環境変数の読み込みが
    //   入る。画面側のログは出さない（.claude/rules/frontend.md）。
    // WHY 画面側の shared/ も含める: screen-to-backend と同じく、shared/ は features から使われる画面側の部品で、Client Component
    //   からも読み込まれるため。app/api/ も含める（app-api が api ファイル以外を止めるので重ねて検出するが、範囲を app/ 全体で書く）。
    // WHY now（現在時刻の出口）も画面側には許さない: 画面は今、現在時刻を読まない。使う必要が出たときに、画面の時刻を
    //   サーバと同じ出口にするか（ブラウザのバンドルに apps/shared を入れてよいか）を決めて、この規則を緩める。
    id: "screen-to-shared",
    name: "apps/frontend_customer の app/・features/・shared/ は apps/shared/ を参照しない（env・logger をブラウザのバンドルに持ち込まない）",
    appliesTo: (from) =>
      isUnder(from, "apps/frontend_customer/app") ||
      isUnder(from, "apps/frontend_customer/features") ||
      isUnder(from, "apps/frontend_customer/shared"),
    isViolation: (ref) => ownUnder(ref, SHARED_ROOT),
  },
  {
    // 「画面側で backend を参照してよいのは `features/<feature>/api/` だけ。参照先は
    //   `backend/features/<feature>/internal/presentation/<name>.api.ts` と `backend/shared/http/` で、いずれも `import type` のみ」
    // WHY backend/shared は http/ だけ（Issue #310 で shared/presentation/ から読み替えた）: 画面が知ってよいのは HTTP の契約
    //   （Problem Details の形など）だけで、エラー・トランザクション・Drizzle などの中身は画面の関心ではない。
    // WHY 型だけに限る: import type はビルド時に消えるので、サーバ専用のコードが画面のバンドルに入らない。
    // WHY 自 feature の api ファイルに限る: 別 feature の API の契約を使うなら、その feature の api/ を通すべきで、
    //   feature 同士は index 経由でしか参照しない（規則 feature-to-feature）方針と揃えるため。
    id: "feature-api-to-backend",
    name: "apps/frontend_customer/features/<f>/api/ から apps/backend/ への参照は型だけで、参照先は自 feature の apps/backend/features/<f>/internal/presentation/*.api か apps/backend/shared/http/ だけ",
    appliesTo: isFeatureApi,
    isViolation: (ref) =>
      ownUnder(ref, BACKEND_ROOT) &&
      !(
        ref.typeOnly &&
        (isOwnFeatureApiFile(ref) ||
          isUnder(ref.to, `${BACKEND_SHARED_ROOT}/http`))
      ),
  },
  {
    // 「feature 同士は原則 import しない。必要なときは相手の `index.ts` だけを import する」
    id: "feature-to-feature",
    name: "別の feature を参照するときは apps/frontend_customer/features/<other>（index）だけ",
    appliesTo: (from) => featureOf(from) !== undefined,
    isViolation: (ref) =>
      ownUnder(ref, "apps/frontend_customer/features") &&
      featureOf(`${ref.to}/`) !== featureOf(ref.from) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「画面側: `app → features → shared`」。app/ はルーティングで、features / shared から参照すると向きが逆になる。
    id: "screen-to-app",
    name: "apps/frontend_customer の features/ と shared/ は app/ を参照しない",
    appliesTo: (from) =>
      isUnder(from, "apps/frontend_customer/features") ||
      isUnder(from, "apps/frontend_customer/shared"),
    isViolation: (ref) => ownUnder(ref, "apps/frontend_customer/app"),
  },
  {
    // 「`shared/` は `features/` を import しない（逆向きの依存を作らない）」
    id: "shared-to-features",
    name: "apps/frontend_customer/shared/ は features/ を参照しない",
    appliesTo: (from) => isUnder(from, "apps/frontend_customer/shared"),
    isViolation: (ref) => ownUnder(ref, "apps/frontend_customer/features"),
  },
  {
    // 「domain は Next・React・DB に依存させない」「依存してよい先は backend/shared だけ」
    //   自 feature の domain/ の中の参照（Repository の interface が Entity を参照するなど）は許す。
    //   backend/shared はどの単位も許す（Issue #310。ユーザー判断。Issue #230 までは shared の domain と、トランザクションの印の型を
    //   型だけに限っていた）。DB のパッケージの直接の参照は core-to-persistence が止める。
    id: "domain",
    name: "apps/backend/features/<f>/internal/domain/ が参照してよい自前コードは自 feature の domain/ と apps/backend/shared/ の単位（error・transaction・http・drizzle・change-log のどれも）と apps/shared/ の now だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "domain",
    isViolation: violatesBackendLayer,
  },
  {
    // 「domain は Next・React・DB に依存させない」。application も DB に直接依存させない（Repository の interface 越しに使う）。
    // WHY 層の許可の一覧（domain / application の規則）と別の規則にする: 許可の一覧はパッケージを next / react / react-dom 以外
    //   すべて許すので、DB のパッケージはそこでは止まらない。DB への依存は infra に閉じ込める（schema.ts・Repository の実装・
    //   database.ts）という別の観点なので、1 規則 = 1 テストで独立に検査する。
    // WHY backend/shared は対象にしない（Issue #310。ユーザー判断）: shared は層を持たない意味の単位（drizzle/ は DB の基盤そのもの）
    //   になった。feature の domain・application が shared を経由して DB に触れることは縛らず、パッケージを直接 import することだけを
    //   止める（Issue #230 までは shared の domain / application も対象だった）。
    // 型だけの参照（import type）も違反にする: 型でも DB の形が domain に入り込み、DB を差し替えると domain を直すことになる。
    id: "core-to-persistence",
    name: "apps/backend/features/<f>/internal/ の domain/・application/ は DB のパッケージ（drizzle-orm とそのサブパス、pg）を直接参照しない（型だけでも。apps/backend/shared/ を経由した参照は縛らない）",
    appliesTo: (from) => {
      const layer = backendLayerOf(from)?.layer;
      return layer === "domain" || layer === "application";
    },
    isViolation: usesPersistence,
  },
  {
    // 「application の依存してよい先は domain と backend/shared」「依存の向き: presentation → application → domain」
    //   同じ application の中の参照（ユースケースの共通処理など）は許す。backend/shared はどの単位も許す（Issue #310）。
    id: "application",
    name: "apps/backend/features/<f>/internal/application/ が参照してよい自前コードは自 feature の domain/・application/ と apps/backend/shared/ の単位（どれも）と apps/shared/ の now だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "application",
    isViolation: violatesBackendLayer,
  },
  {
    // 「presentation の依存してよい先: application、domain（Entity の型の参照と定数のみ。定数は Issue #144）、自 feature の infra の Postgres の
    //   Repository の実装（api ファイルが本番の handler を組み立てる。Issue #123）、backend/shared のどの単位（プール・runner も。Issue #310）、
    //   他のモジュールの expose（Issue #208）、apps/shared の logger・now（Issue #85・#90）」
    //   同じ presentation の中の参照（api ファイル間の re-export など）は許す。
    // WHY next も禁止する: api ファイルは Web 標準の Request / Response で書き、Next を起動せずにテストできるようにしているため
    //   （.claude/rules/testing.md の「置き方と環境」）。
    id: "presentation",
    name: "apps/backend/features/<f>/internal/presentation/ が参照してよい自前コードは自 feature の application/・domain/（型と UPPER_SNAKE_CASE の定数だけ）・presentation/・infra/*-repository.postgres と apps/backend/shared/ の単位（どれも）と他のモジュールの expose/ と apps/shared/ の logger・now だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "presentation",
    isViolation: violatesBackendLayer,
  },
  {
    // 「infra: Repository の実装、Drizzle のスキーマ」「依存してよい先: domain（interface を実装する）」。Repository の実装が同じ
    //   infra の schema を使うので、infra/ の中の参照も許す。自 feature の application は許さない（Issue #220）。
    //   backend/shared はどの単位も許す（Issue #310。プール・Writer・変更履歴・トランザクションの port。Issue #224 までは port を
    //   型だけに限っていた）。
    id: "infra",
    name: "apps/backend/features/<f>/internal/infra/ が参照してよい自前コードは自 feature の domain/・infra/ と apps/backend/shared/ の単位（どれも）と apps/shared/ の env・logger・now だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "infra",
    isViolation: violatesBackendLayer,
  },
  {
    // 「backend/shared/: feature をまたいで使う型や処理」。各 feature が shared に依存するので、逆向きにすると循環する。
    //   画面側の shared/ も含め、backend/shared/ の外の自前コードは参照しない。
    // WHY apps/shared は許す（Issue #90）: frontend と backend で共通の基盤（env・logger・now）で、feature ではないので循環しない。
    // WHY shared の中は単位をまたいで自由に参照してよい（Issue #310。ユーザー判断）: 以前は shared も 4 層に分けて層の規則を
    //   当てていたが、単位（error・transaction・http・drizzle・change-log）は層ではなく関心の分け方で、向きを決める理由が無い。
    //   apps/shared のモジュールも単位ごとには縛らない。
    id: "backend-shared",
    name: "apps/backend/shared/ が参照してよい自前コードは apps/backend/shared/ の中と apps/shared/ だけで、next・react も参照しない",
    appliesTo: (from) => isUnder(from, BACKEND_SHARED_ROOT),
    isViolation: (ref) =>
      usesFramework(ref) ||
      (ref.own &&
        !isUnder(ref.to, BACKEND_SHARED_ROOT) &&
        !isUnder(ref.to, SHARED_ROOT)),
  },
  {
    // 「`app/` はルーティングだけ。`page.tsx` は screen を返すだけ」「feature の外から import してよいのは index.ts だけ」
    // WHY 自前のコード（features/ backend/ shared/）への参照だけを検査する: 画面の組み立ては feature の公開 API に閉じ込め、
    //   app/ から feature の内部や backend を直接使ってロジックを書くのを防ぐため。
    // WHY shared/ は許す: 画面側の依存の向き `app → features → shared` の連鎖として、app/ から shared/ を参照するのは
    //   向きに沿っている（オーケストレータの判断。Issue #47）。
    // WHY パッケージと app/ の中の相対参照は検査しない: レイアウトが next/font や他のパッケージを使うこと、Next の慣例どおり
    //   import "./globals.css" のように app/ のファイルを読むことはルーティングの範囲で正当で、許可の一覧で縛ると
    //   追加のたびに規則を直すことになる（オーケストレータの判断。Issue #47）。
    id: "app",
    name: "apps/frontend_customer/app/（app/api 以外）が features/・apps/backend/・shared/ を参照するときは features/<f>（index）か shared/ だけ",
    appliesTo: (from) =>
      isUnder(from, "apps/frontend_customer/app") &&
      !isUnder(from, "apps/frontend_customer/app/api"),
    isViolation: (ref) =>
      (ownUnder(ref, "apps/frontend_customer/features") ||
        ownUnder(ref, BACKEND_ROOT)) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「`app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ」
    //   backend/shared の api ファイルは HTTP の境界 shared/http/ の直下（Issue #310 で shared/presentation/ から読み替えた）。
    id: "app-api",
    name: "apps/frontend_customer/app/api/ は apps/backend/features/<f>/internal/presentation/*.api（と apps/backend/shared/http/*.api）だけを参照する",
    appliesTo: (from) => isUnder(from, "apps/frontend_customer/app/api"),
    isViolation: (ref) => !(ref.own && PRESENTATION_API.test(ref.to)),
  },
  {
    // 「apps/shared の中は同じディレクトリのファイルだけを読み、ほかのパッケージ（backend・frontend）、React・Next・DB を参照しない」
    //   （.claude/rules/shared.md。Issue #90 の reviewer 指摘: 文書だけの規則で、logger.ts に backend の container・react・
    //   drizzle-orm の import を足しても architecture / tsc / biome のどれも止まらなかった）。
    // WHY: apps/shared は frontend 直下（Next の起動時・Proxy）と backend の両方が読み込む基盤。ここから backend や画面側を
    //   参照すると、frontend 直下から backend を参照させない規則（frontend-root-to-backend）や層の規則を、apps/shared を経由して
    //   すり抜けられる。フレームワーク・DB に依存すると、env・logger を使うすべての場所にその依存が入る。
    // WHY パッケージは node: の付いた Node の組み込みと、名前で許した zod だけ（"apps/shared/package.json の dependencies に無いものは
    //   違反" にしない）: dependencies を読んで許す形にすると、依存を足すだけで何でも通り、置いてよいものの判断（shared.md）が
    //   レビューに出ない。パッケージを足すときは Issue で決めて、ここの許可（SHARED_ALLOWED_PACKAGES）を同じ変更で広げる。
    //   "fs" のような node: の付かない組み込みの名前は、パッケージ名と区別できないので不可。
    // WHY zod を許す（Issue #216）: logger（logger.ts）が種類ごとの行の形を zod のスキーマ（log-event.ts）で parse し、一覧に無いキーを
    //   落とし、個人情報を *** にする。backend も同じ版の zod を使う（入力検証。.claude/rules/dependencies.md）。
    // WHY "zod" の 1 つだけ（サブパスの "zod/v4"・"zod/mini" を許さない）: 書き方を 1 つにし、別の入口（別の API）が混ざらないようにする。
    // WHY FRAMEWORK_PACKAGES・PERSISTENCE_PACKAGES も明示して書く: 下の「node: 以外は違反」だけでも止まるが、将来パッケージの許可を
    //   広げたときにも React・Next・DB だけは止め続けるため。
    id: "shared-self-contained",
    name: "apps/shared/ の中は apps/shared/ の自前コードと Node の組み込み（node:）と zod だけを参照する（backend・frontend、next・react、DB、ほかのパッケージを参照しない）",
    appliesTo: (from) => isUnder(from, SHARED_ROOT),
    isViolation: (ref) =>
      ref.own
        ? !isUnder(ref.to, SHARED_ROOT)
        : usesFramework(ref) ||
          usesPersistence(ref) ||
          !(
            ref.specifier.startsWith("node:") ||
            SHARED_ALLOWED_PACKAGES.has(ref.specifier)
          ),
  },
  {
    // 「画面・部品の辞書（<name>.messages.ts）は、その画面・部品の隣に置き、同じディレクトリのファイルだけが使う」（Issue #125。
    //   .claude/rules/frontend.md の「i18n」）。共通の辞書 apps/frontend_customer/shared/i18n/common.messages だけは apps/frontend_customer のどこからでも使える。
    // WHY 同じディレクトリに限る: 別の画面の辞書を借りると、その画面を消す・言い回しを変えるときに、関係の無い画面の表示まで
    //   変わる。辞書を画面のディレクトリに閉じ込め、画面をディレクトリごと消せるようにする（screens/<name>-screen/ の方針と同じ）。
    //   複数の画面で使う文言は、共通の辞書に置くか、それぞれの辞書に書く。
    // WHY 場所（参照先のディレクトリ）で判定する（書き方 "./" に限らない）: "@/features/.../todo-screen.messages" と
    //   "./todo-screen.messages" は同じファイルを指し、書き方の規則は別の関心（今は無い）。子・親のディレクトリも「別の場所」とする。
    // WHY 参照元を apps/frontend_customer に限らない: apps/e2e/ やリポジトリ直下から辞書を import すると、E2E が文言ではなく辞書の値で
    //   探すことになり、画面に出る文言を確かめなくなる。共通の辞書も apps/frontend_customer の外からは不可。
    //   テストは対象外（列挙がテストを除く）。画面のテストが部品の辞書で期待値を作る（tJa(todoItemMessages, ...)）のは許す。
    // WHY re-export（export ... from）は同じディレクトリでも、共通の辞書でも違反にする（Issue #125 の reviewer 指摘）: 同じ
    //   ディレクトリの中継のファイル（zz-barrel.ts の export { x } from "./x.messages"）を別のディレクトリから import すると、
    //   参照先が *.messages ではないので、この規則を素通りして辞書を別のディレクトリから使えてしまう。辞書を使うファイルは
    //   辞書を直接 import すればよく、中継する理由が無い。共通の辞書も中継させない（apps/e2e/ が中継のファイルから使えてしまう）。
    // 限界: import してから別の文で export する（import { x } from "./x.messages"; export { x };）中継は、export 文に from が
    //   無いので拾わない（見逃す方向。参照の抽出は from のある文だけを見る）。
    id: "messages-colocation",
    name: "*.messages（画面・部品の辞書）を参照してよいのは同じディレクトリのファイルだけ（apps/frontend_customer/shared/i18n/common.messages は apps/frontend_customer/ のどこからでも可）。re-export（export ... from）はどこからでも不可",
    appliesTo: () => true,
    isViolation: (ref) =>
      ref.own &&
      MESSAGES_MODULE.test(ref.to) &&
      (ref.reExport === true ||
        (posix.dirname(ref.to) !== posix.dirname(ref.from) &&
          !(
            ref.to === COMMON_MESSAGES_MODULE &&
            isUnder(ref.from, FRONTEND_ROOT)
          ))),
  },
  {
    // 「他のモジュールの internal/ は参照しない」（Issue #208。モジュラーモノリス。.claude/rules/backend.md の「モジュールの境界」）。
    //   backend の feature を 1 つのモジュールとし、直下を公開の入口 expose/ と中身 internal/ に分ける。
    // WHY: internal はモジュールの中身で、他のモジュールが依存すると、中身を変えるたびに他のモジュールが壊れ、境界が無くなる。
    //   他のモジュールが使えるのは expose/ だけにし、公開するものをディレクトリで決める。
    // WHY 型だけ・re-export も違反: 型でも中身の形に依存し、re-export は中継のファイルで境界をすり抜ける入口になる。
    // WHY 参照元を apps/backend/features/ の下に限る: frontend の app/api は exports を通して internal/presentation の api ファイルを
    //   指し（app-api・backend-exports が見る）、apps/backend/test-support/ は InMemory の実装のために internal を直接使う。
    //   backend/shared から feature への参照は backend-shared が止める。
    // WHY 層の規則と重ねて検出する: 層の規則（domain / application / presentation / infra）も別 feature の層を許さないが、
    //   expose/ のファイルは層に属さないので層の規則がかからない。境界の違反を名前付きの 1 つの規則でも見る。
    id: "module-internal",
    name: "apps/backend/features/<a>/ の下のファイルは、他のモジュール（apps/backend/features/<b>/、b ≠ a）の internal/ を参照しない（型だけ・re-export も）",
    appliesTo: (from) => backendModuleOf(from) !== undefined,
    isViolation: (ref) => isOtherModulePart(ref, "internal"),
  },
  {
    // 「他のモジュールの expose/ を参照してよいのは、自モジュールの internal/presentation/ だけ」（Issue #208）。
    // WHY: presentation は api ファイルが本番の handler を組み立てる場所で、他のモジュールの機能もそこで取り出して、application の
    //   command / query にコンストラクタでインスタンスとして渡す（Issue #123 のコンストラクタ注入。Issue #262 で関数からクラスに）。application・domain・infra が他の
    //   モジュールを直接 import すると、ユースケースのテストで差し替えられず、モジュール間の依存がコードのあちこちに散らばる。
    // WHY expose から他のモジュールの expose も違反（expose-imports と重ねて検出する）: モジュール間の呼び出しの鎖が expose の中に
    //   隠れ、組み立ての場所（presentation）で見えなくなる。
    // 自モジュールの expose を internal から使うのは、この規則ではなく層の規則が止める（参照先が層に属さない。循環になる）。
    id: "module-expose-only-from-presentation",
    name: "他のモジュールの apps/backend/features/<b>/expose/ を参照してよいのは、apps/backend/features/<a>/internal/presentation/ の下のファイルだけ（application・domain・infra・expose からは不可）",
    appliesTo: (from) => {
      const moduleName = backendModuleOf(from);
      return (
        moduleName !== undefined &&
        !isUnder(
          from,
          `apps/backend/features/${moduleName}/internal/presentation`,
        )
      );
    },
    isViolation: (ref) => isOtherModulePart(ref, "expose"),
  },
  {
    // 「expose/ が参照してよいのは、自モジュールの internal/・expose/、apps/backend/shared/、apps/shared の env・logger・now だけ」
    //   （Issue #208）。パッケージは next / react / react-dom 以外（層の規則と同じ）。
    // WHY: expose は他のモジュールへの公開の入口で、presentation と同じく自モジュールの command と infra を組み立てて呼ぶ。
    //   expose/ は 4 層のどれにも属さないので、層の規則（許可の一覧）がかからない。ここで許可の一覧を持たないと、expose から
    //   何を参照しても素通りする。許可の範囲と WHY は exposeMayUse。
    id: "expose-imports",
    name: "apps/backend/features/<f>/expose/ が参照してよい自前コードは、自モジュールの internal/・expose/、apps/backend/shared/、apps/shared/ の env・logger・now だけで（他のモジュールは不可）、next・react も参照しない",
    appliesTo: isExposeFile,
    isViolation: (ref) => usesFramework(ref) || (ref.own && !exposeMayUse(ref)),
  },
];

// backend のソースファイルは、apps/backend/features/<f>/internal/ の 4 層（domain / application / presentation / infra）のどれかの下か、
// apps/backend/shared/ の単位（BACKEND_SHARED_UNITS。Issue #310）のどれかの下か、モジュールの公開の入口
// apps/backend/features/<f>/expose/ の直下（Issue #208）に置く。
// （テストファイル・package.json・tsconfig.json・生成したマイグレーションの *.sql / meta/*.json はソースではないので、この規則は見ない。
//   列挙は listReferencingFiles のソースだけ。）
// WHY 置き場所そのものを規則にする: 層に属さない場所（backend/features/todo/lib/ や backend/features/todo/ 直下）のファイルは、
//   どの層の規則もかからず、そこから何を参照しても検査を素通りする。層を決めて置かせることで、すべての backend のコードに
//   依存の向きの検査がかかるようにする。
// WHY 最初の階層を features/ と shared/ に固定する（Issue #98。ユーザー判断）: frontend（apps/frontend_customer/features/ と shared/）と
//   同じ構成にし、feature を足すときの置き場所をそろえる。以前は feature（todo/）が apps/backend 直下に shared/ と並び、直下に
//   何を置いても「feature」として層の規則にかかっていた。今は features/ を挟まない apps/backend/<x>/<層>/ は違反（層に属さない）。
//   features/ 直下のファイル（features/x.ts）も層に属さないので違反。
// WHY feature の 4 層を internal/ の下に限る（Issue #208）: feature の直下は、他のモジュールへ公開する入口（expose/）と中だけで
//   使う実装（internal/）の 2 つに分ける。internal/ を挟まない features/<f>/<層>/（Issue #208 より前の置き場所）を許すと、
//   公開の入口と内部の実装の区別がディレクトリで付かなくなるので違反にする。
// WHY backend/shared/ は単位の一覧に固定する（直下・一覧に無い単位を許さない。Issue #310 で層から単位に変えた）: 何でも置ける
//   場所にすると、feature のコードや層の関心が shared に集まる。単位の意味と WHY は BACKEND_SHARED_UNITS。
//   以前は backend/shared/ も 4 層に分け、drizzle-kit の設定 shared/drizzle/drizzle.config.<拡張子> だけを層の外の例外にしていた
//   （Issue #98）。drizzle/ が単位になったので、drizzle.config.ts は drizzle/ の中の普通のソースとして置け、例外は無くした。
//   依存の規則は backend-to-frontend・backend-relative-only・backend-shared がかかる（feature のコードを import せず、schema は
//   glob の文字列で指す）。
// 決定と採用しなかった案は ADR docs/adr/architecture/20260929-backend-features-and-shared-directories.md。
// WHY 直下の test-support/ も許す（Issue #181。ユーザー判断「test-support が build に入らないルールは頑張って」）: テストだけが使う
//   コード（TestDatabase.create など）の置き場所で、層のコードではない。shared の単位の下（以前の shared/infra/）に置くと本番のコードと見分けが付かず、
//   .dockerignore の 1 行（**/test-support）でイメージから外せない。層の規則は当てない（どの層でもない）が、本番のコードから
//   参照しないこと・イメージに入らないことは rule-tests/test-support.test.ts が見る（層のファイルから参照すると層の規則にもかかる）。
//   直下だけに許し、features/<f>/test-support/ や shared/test-support/ は違反のままにする（置き場所を 1 か所にそろえる）。
const BACKEND_TEST_SUPPORT_DIR = /^apps\/backend\/test-support\//;
// Issue #219: API 仕様（apps/backend/spec/api/<feature>/ の <api>.feature と <api>.api-spec.test.ts）の step が共有する補助。
// WHY support.ts だけを許す: API 仕様の組み立て（本番と同じ Repository → command / query → Api）と DB の読み出しを step の間で
//   共有する置き場所で、テストだけが使う（層のコードではない）。名前を support.ts の 1 つに固定し（rule-tests/api-spec.test.ts の
//   api-spec-placement と同じ）、spec/api/ を層に属さないコードの置き場所にさせない。spec/api/ の直下・入れ子・ほかの名前は違反。
// WHY test-support/ に置かない: test-support/ はテストダブル・DB 基盤・テストデータビルダー（Issue #240）の置き場所で、API 仕様だけの補助を混ぜない（Issue #219 の判断）。
const BACKEND_API_SPECS_SUPPORT =
  /^apps\/backend\/spec\/api\/[^/]+\/support\.ts$/;
// Issue #208: モジュールの公開の入口。features/<f>/expose/ の直下のファイルだけ（下にディレクトリを作らない）。
// WHY 直下だけ: expose は他のモジュールへ公開するものの一覧で、1 階層で見渡せるようにする（中身は internal/ に置く）。
//   深くしたくなったら、この規則を変える。
const BACKEND_EXPOSE_FILE = /^apps\/backend\/features\/[^/]+\/expose\/[^/]+$/;
const BACKEND_LAYER_DIR =
  /^apps\/backend\/features\/[^/]+\/internal\/(?:domain|application|presentation|infra)\//;

// backend/shared の単位の下のファイルか（単位のディレクトリの中だけ。単位と同じ名前のファイル shared/drizzle.ts は含めない）。
function isInBackendSharedUnitDir(file: string): boolean {
  return BACKEND_SHARED_UNITS.some((unit) =>
    file.startsWith(`${BACKEND_SHARED_ROOT}/${unit}/`),
  );
}

const BACKEND_PLACEMENT = {
  id: "backend-placement",
  name: "apps/backend/ のソースファイルは apps/backend/features/<f>/internal/ の domain/・application/・presentation/・infra/ のどれかの下か、apps/backend/shared/ の error/・transaction/・http/・drizzle/・change-log/ のどれかの下か、モジュールの公開の入口 apps/backend/features/<f>/expose/ の直下か、テストだけが使う apps/backend/test-support/ の下か、API 仕様の補助 apps/backend/spec/api/<feature>/support.ts に置く",
  isMisplaced: (file: string) =>
    isUnder(file, BACKEND_ROOT) &&
    !BACKEND_LAYER_DIR.test(file) &&
    !isInBackendSharedUnitDir(file) &&
    !BACKEND_EXPOSE_FILE.test(file) &&
    !BACKEND_TEST_SUPPORT_DIR.test(file) &&
    !BACKEND_API_SPECS_SUPPORT.test(file),
};

// frontend のソースファイルは、apps/frontend_customer の app/・features/・shared/ の下か、直下の決まった名前のファイルだけに置く
// （Issue #68 の reviewer 指摘）。
// WHY 置き場所を規則にする: 依存の規則は app/・features/・shared/ と直下のファイル（frontend-root-to-backend）にしかかからない。
//   apps/frontend_customer/lib/ のような場所のファイルは、backend の container を値で import してもどの規則にもかからず素通りする。
// WHY 直下は名前で許す: Next の設定（next.config.ts）と規約ファイル（instrumentation.ts・proxy.ts）、その Node.js 用の処理
//   （instrumentation-node.ts）、Next が生成する型の宣言（next-env.d.ts。.gitignore 済みだが手元にはある）だけが直下に要る。
//   proxy.ts（リクエストログ。Issue #80）は Next の規約で app/ と同じ階層（プロジェクトのルート）に置く（Next.js 16.3.6 同梱
//   node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md の「Convention」）。旧名の middleware.ts
//   は Next 16 で非推奨なので許さない。中身は薄くし、1 行の組み立ては shared/request-log/ に置く（shared/ は置き場所の規則の中）。
//   名前を決めずに直下を許すと、層に属さないコードの置き場所になる。直下のファイルが backend を参照するときは
//   frontend-root-to-backend が見る。
// WHY test-support/ も許す（Issue #181）: テストだけが使うコード（翻訳の期待値を作る tJa など）の置き場所。backend の
//   test-support/ と同じく、本番のコードから参照しないこと・イメージに入らないことは rule-tests/test-support.test.ts が見る。
const FRONTEND_SOURCE_DIR =
  /^apps\/frontend_customer\/(?:app|features|shared|test-support)\//;
const FRONTEND_ROOT_FILES = new Set([
  "apps/frontend_customer/next.config.ts",
  "apps/frontend_customer/instrumentation.ts",
  "apps/frontend_customer/instrumentation-node.ts",
  "apps/frontend_customer/proxy.ts",
  "apps/frontend_customer/next-env.d.ts",
]);

const FRONTEND_PLACEMENT = {
  id: "frontend-placement",
  name: "apps/frontend_customer/ のソースファイルは app/・features/・shared/・test-support/ の下か、直下の next.config.ts・instrumentation.ts・instrumentation-node.ts・proxy.ts・next-env.d.ts だけに置く",
  isMisplaced: (file: string) =>
    isUnder(file, FRONTEND_ROOT) &&
    !FRONTEND_SOURCE_DIR.test(file) &&
    !FRONTEND_ROOT_FILES.has(file),
};

// 置き場所の規則（参照ではなくファイルの場所で決まる）。collectViolations で使う。
const PLACEMENT_RULES = [BACKEND_PLACEMENT, FRONTEND_PLACEMENT];

// apps/shared（@repo/shared。Issue #90）に置いてよいのは、名前を決めたファイルだけ（env.ts・logger.ts・now.ts とそのテスト、
//   logger の event.name の一覧と種類ごとのスキーマ・マスクの印の log-event.ts（Issue #209・#216）とそのテスト、package.json・tsconfig.json）。
// WHY log-event.test.ts を置く（Issue #216 で足した）: Issue #209 では型と定数だけのファイルでテストを置かなかったが、#216 で
//   マスクの印（sensitive / freeText）と正規表現が入り、その仕様を隣のテストに置く。行の丸ごとの形は logger.test.ts が固定する。
// WHY 何でも置ける場所にしない: 「frontend と backend の両方で使う」ものは多く、共通の置き場所を自由にすると、feature の
//   コードや DB・React に依存するコードが集まり、層の規則（backend の 4 層・画面側の境界）の外で依存が育つ。
//   置いてよいのは横断的な基盤（環境変数の入口・ログの出口・現在時刻の出口）だけにし、足すときはこの一覧・exports（SHARED_EXPORTS）・
//   .claude/rules/shared.md を同じ変更で直す（足すことを規則の変更としてレビューに出す）。
// WHY ソース以外（.md・.json・テスト）も含めてすべてのファイルを見る（BACKEND_PLACEMENT / FRONTEND_PLACEMENT はソースだけ）:
//   置いてよいものを名前で決めているので、テストだけ・説明だけのファイルも一覧の外なら違反にし、置き場所の意図を 1 か所で持つ。
//   除くのは依存と生成物のディレクトリ（EXCLUDED_DIRS。pnpm が作る apps/shared/node_modules/ など）だけ。
const SHARED_FILES = new Set(
  [
    "env.ts",
    "env.test.ts",
    "logger.ts",
    "logger.test.ts",
    "log-event.ts",
    // Issue #216: log-event.ts に種類ごとのスキーマとマスクの印（正規表現）が入り、その仕様を隣のテストに置く。
    "log-event.test.ts",
    "now.ts",
    "now.test.ts",
    "package.json",
    "tsconfig.json",
  ].map((name) => `${SHARED_ROOT}/${name}`),
);

const SHARED_PLACEMENT = {
  id: "shared-placement",
  name: "apps/shared/ に置いてよいのは env.ts・logger.ts・log-event.ts・now.ts とそのテスト（env.test.ts・logger.test.ts・log-event.test.ts・now.test.ts）、package.json・tsconfig.json だけ",
  isMisplaced: (file: string) =>
    isUnder(file, SHARED_ROOT) && !SHARED_FILES.has(file),
};

// dir の下のすべてのファイル（再帰。ソース以外も含む。依存と生成物のディレクトリの中は除く）。SHARED_PLACEMENT で使う。
// 以前（Issue #142 より前）との差: 以前は通常ファイル（Dirent の isFile()）だけを返し、ファイルを指す symlink は数えなかった。
//   今は walkFiles と同じくディレクトリ以外をすべて返すので、ファイルへの symlink（と先の無い symlink）も返す。
// WHY 差を許す: apps/shared/ に symlink で置いたファイルも「置いたもの」であり、一覧（SHARED_FILES）の外なら違反にするのが
//   置き場所の規則の意図に合う（今の apps/shared/ に symlink は無く、本番の結果は変わらない）。
function listAllFiles(root: string, dir: string): string[] {
  return walkFiles(root, dir);
}

// --- 環境変数の直参照（規則 env-direct-access。.claude/rules/env.md の「環境変数」） ---
// process.env を読んでよいのは apps/shared/env.ts だけ（Issue #90 で apps/backend/shared/infra/ から移した）。ほかは env.ts の env / toolEnv を使う。
// WHY 参照（import）の規則と別に持つ: 参照先ではなくソースの中身（process.env という式）で決まり、対象のファイルも違う
//   （apps/e2e/ とルート直下の設定ファイルも含める）ため。置き場所の規則（BACKEND_PLACEMENT / FRONTEND_PLACEMENT）と同じく、RULES の外に置く。
// WHY Biome の style/noProcessEnv と二重に検査する: Biome は biome.json の overrides で対象外を決めるので、overrides の
//   書き換え（対象外のパスを広げる、ルールを off にする）で黙って効かなくなる。ここでは対象と例外（env.ts だけ）を
//   テストとして固定し、どちらか片方が壊れても、もう片方で止まるようにする。
// 限界（仕様として受け入れる。下の「環境変数の直参照の抽出」のテストで固定している）:
//   - 分割代入（const { env } = process）、別名（const p = process; p.env）、Reflect.get(process, "env")、
//     node:process の default import（import proc from "node:process"; proc.env）は拾わない（見逃す方向）。
//     式の流れを追うには構文解析が要るため。Biome の noProcessEnv（2.5.13）もこの 4 つは検出しない（2026-09-28 実測）ので、
//     どちらの検査でも見逃す。レビューで見る。
//   - テンプレートリテラルの ${} の中の process.env は、文字列の中とみなして拾わない（見逃す方向。extractImports と同じ）。
//     これと import { env } from "node:process" は Biome の noProcessEnv だけが検出する（2026-09-28 実測）。
//   - 逆に、global.process.env と (process).env はこちらだけが検出する（Biome の noProcessEnv は検出しない。2026-09-28 実測）。

// 検査の対象にするディレクトリ。依存の向きの対象（apps/frontend_customer・apps/backend・apps/shared）に、E2E（apps/e2e/）を足す。
// WHY apps/e2e/ を含める: E2E の補助（apps/e2e/support/database.ts）と設定（apps/e2e/playwright.config.ts）は接続先やフラグを読むので、
//   既定値や直参照が入り込みやすい。
// WHY apps/shared を含める（Issue #90）: 例外の env.ts がここにあり、同じ場所のほかのファイル（env-helper.ts など）は違反にするため。
const ENV_CHECK_DIRS = [FRONTEND_ROOT, BACKEND_ROOT, SHARED_ROOT, E2E_ROOT];

const ENV_DIRECT_ACCESS = {
  id: "env-direct-access",
  name: "process.env を直接読んでよいのは apps/shared/env.ts だけ（例外は apps/frontend_customer/instrumentation.ts の NEXT_RUNTIME だけ。apps/frontend_customer・apps/backend・apps/shared・apps/e2e/ とルート直下の設定ファイルが対象。テストは除く）",
  // 何を読んでもよいファイル（環境変数の唯一の入口）。
  allowedFile: `${SHARED_ENV_MODULE}.ts`,
  // ファイルごとに、読んでよい変数だけを許す例外。
  // WHY instrumentation.ts の NEXT_RUNTIME: Next.js がビルド時に値を埋め込む規約の変数で、Edge 向けのビルドから Node.js 専用の
  //   import を消すために process.env.NEXT_RUNTIME の形で書く必要がある（Next.js 16.3.6 同梱ドキュメント
  //   01-app/02-guides/instrumentation.md の「Importing runtime-specific code」。WHY の詳細は instrumentation.ts）。
  //   ファイルごと許すと、同じファイルに別の変数の直参照が入っても通るので、変数の名前まで絞る。
  allowedVariables: {
    "apps/frontend_customer/instrumentation.ts": ["NEXT_RUNTIME"],
  } as Record<string, string[]>,
  // 対象のファイルか。ENV_CHECK_DIRS の下か、ルート直下（"/" を含まない）の、テストでない TS / JS。
  // WHY ルート直下の設定ファイルを含める: vitest.global-setup.ts・vitest.config.mts などは、接続先やフラグを読むので、
  //   既定値や直参照が入り込みやすい。ルート直下のテスト（rule-tests/ の architecture.test.ts など）は除く。apps の設定ファイル
  //   （apps/frontend_customer/next.config.ts、apps/backend/shared/drizzle/drizzle.config.ts）は ENV_CHECK_DIRS の下として対象になる。
  // どのファイルを列挙するか（apps/frontend_customer の .next/ を除くなど）は listEnvCheckedFiles が決める。
  appliesTo: (file: string) =>
    isSourceNonTest(file) &&
    (!file.includes("/") || ENV_CHECK_DIRS.some((dir) => isUnder(file, dir))),
};

// process.env / process?.env / process["env"] / process['env'] / process[`env`]。空白や改行を挟んでもよい。
// \bprocess なので globalThis.process.env / global.process.env も拾い、processEnv のような別の識別子や myprocess.env は拾わない。
// 括弧で囲んだ (process).env / ( process )["env"] も拾う（括弧の中は空白だけを許す）。
// 続けて .NAME / ?.NAME と書いた変数の名前をグループ 2 で取る（例外の変数を絞るため）。["NAME"] の形や、
// process.env をそのまま渡す書き方では名前を取らない（例外に当たらず、違反になる）。
const PROCESS_ENV =
  /(?:\bprocess|\(\s*process\s*\))\s*(?:\??\.\s*env\b|(?:\?\.)?\s*\[\s*(["'`])env\1\s*\])(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?/g;

type EnvAccess = { line: number; variable: string | undefined };

// source の中の process.env の参照を、書かれた順に「行番号（1 始まり）と読んだ変数の名前」で返す。
// コメントの中と文字列リテラルの中は拾わない（extractImports と同じ stripComments / stringRanges を使う）。
// stripComments はコメントを同じ長さの空白に置き換え、改行を残すので、位置から元の行番号を数えられる。
function findProcessEnvAccesses(source: string): EnvAccess[] {
  const code = stripComments(source);
  const ranges = stringRanges(code);
  return [...code.matchAll(PROCESS_ENV)]
    .filter((match) => !isInsideString(ranges, match.index))
    .map((match) => ({
      line: code.slice(0, match.index).split("\n").length,
      variable: match[2],
    }));
}

// file で、この参照が許されるか。env.ts は何でも、例外のファイルは決めた変数だけ。
function isAllowedEnvAccess(file: string, { variable }: EnvAccess): boolean {
  return (
    file === ENV_DIRECT_ACCESS.allowedFile ||
    (variable !== undefined &&
      (ENV_DIRECT_ACCESS.allowedVariables[file] ?? []).includes(variable))
  );
}

// 依存の向きの対象（listAllSourceFiles）に、apps/e2e/ とルート直下のファイル（ディレクトリの中は見ない。node_modules/ などは対象外）を足す。
function listEnvCheckedFiles(root: string): string[] {
  return [
    ...listAllSourceFiles(root),
    ...listSourceFiles(root, E2E_ROOT),
    ...listDirectFiles(root, ""),
  ].filter(ENV_DIRECT_ACCESS.appliesTo);
}

// 「ファイル:行」の一覧。許される参照（isAllowedEnvAccess）は除く。
function findEnvViolations(root: string): string[] {
  return listEnvCheckedFiles(root).flatMap((file) =>
    findProcessEnvAccesses(readFileSync(join(root, file), "utf8"))
      .filter((access) => !isAllowedEnvAccess(file, access))
      .map(({ line }) => `${file}:${line}`),
  );
}

// --- console の直接の呼び出し（規則 console-direct-access。.claude/rules/backend.md の「ログ」。Issue #85） ---
// console を書いてよいのは apps/shared/logger.ts（サーバ側のログの唯一の出口。Issue #90 で apps/backend/shared/infra/ から移した）だけ。ほかは logger を使う。
//   画面側のクライアントコード（features/ など）は logger も console も使わない（.claude/rules/frontend.md）。
// WHY Biome の suspicious/noConsole と二重に検査する: env-direct-access と同じ設計。Biome は biome.json の overrides で
//   対象外を決めるので、overrides の書き換え（対象外のパスを広げる、ルールを off にする）や allow の追加（console.error を
//   許すなど）で黙って効かなくなる。ここでは対象と例外（logger.ts だけ）をテストとして固定し、どちらか片方が壊れても、
//   もう片方で止まるようにする。
// WHY 呼び出し（console.log(...)）だけでなく、console という名前を書いた時点で違反にする: 別名（const c = console）・
//   分割代入（const { log } = console）・引数に渡す（run(console)）で、呼び出しの形を検査する仕組みをすり抜けられるため。
//   console という名前のプロパティ・キー（obj.console、{ console: 1 }）も拾うが、多く検出する方向で、失敗したときに出る
//   「ファイル:行」を見て判断できる（今のリポジトリには無い）。
// 限界（仕様として受け入れる。下の「console の参照の抽出」のテストで固定している）:
//   - node:console の import（import { log } from "node:console"、import c from "node:console"）は拾わない（見逃す方向。
//     console は文字列の中の参照先にしか書かれないため）。Biome の noConsole（2.5.13）も検出しない（2026-09-29 実測）ので、
//     どちらの検査でも見逃す。レビューで見る。
//   - テンプレートリテラルの ${} の中の console は、文字列の中とみなして拾わない（見逃す方向。extractImports と同じ）。
//     これは Biome の noConsole が検出する。
//   - 逆に、global.console・(console).log・別名・分割代入・引数に渡す console はこちらだけが検出する（Biome の noConsole は
//     検出しない。2026-09-29 実測）。決定は ADR docs/adr/architecture/20260929-logger-single-exit.md。

// 検査の対象にするディレクトリ。環境変数の直参照の対象（ENV_CHECK_DIRS）に scripts/ を足す。
// WHY scripts/ を含める: scripts/ の TS / JS（今はテストだけで、ソースは無い）はフックなどから動かすツールになり、
//   console で出力を書きたくなる場所なので、置いた時点で検査にかける。
const SCRIPTS_ROOT = "scripts";
const CONSOLE_CHECK_DIRS = [...ENV_CHECK_DIRS, SCRIPTS_ROOT];

const CONSOLE_DIRECT_ACCESS = {
  id: "console-direct-access",
  name: "console を直接書いてよいのは apps/shared/logger.ts だけ（apps/frontend_customer・apps/backend・apps/shared・apps/e2e/・scripts/ とルート直下の設定ファイルが対象。テストは除く）",
  // console を書いてよいファイル（ログの唯一の出口）。
  allowedFile: `${SHARED_LOGGER_MODULE}.ts`,
  // 対象のファイルか。CONSOLE_CHECK_DIRS の下か、ルート直下（"/" を含まない）の、テストでない TS / JS。
  // WHY テストを除く: テストは console を spy して出力を抑えたり、ログに残したことを確かめたりする
  //   （vi.spyOn(console, "error")）。Biome の overrides でもテストは off にしている。
  appliesTo: (file: string) =>
    isSourceNonTest(file) &&
    (!file.includes("/") ||
      CONSOLE_CHECK_DIRS.some((dir) => isUnder(file, dir))),
};

// console という識別子。\b なので globalThis.console / global.console も拾い、consoleLog のような別の識別子や myconsole は
// 拾わない。console_ のように続けて識別子の文字（\w と $）がある名前も拾わない。
const CONSOLE_REFERENCE = /\bconsole(?![\w$])/g;

// source の中の console の参照を、書かれた順に行番号（1 始まり）で返す。
// コメントの中と文字列リテラルの中は拾わない（findProcessEnvAccesses と同じ stripComments / stringRanges を使う）。
function findConsoleAccesses(source: string): number[] {
  const code = stripComments(source);
  const ranges = stringRanges(code);
  return [...code.matchAll(CONSOLE_REFERENCE)]
    .filter((match) => !isInsideString(ranges, match.index))
    .map((match) => code.slice(0, match.index).split("\n").length);
}

// 環境変数の直参照の対象（listReferencingFiles と同じ列挙）に、scripts/ のソースを足す。
function listConsoleCheckedFiles(root: string): string[] {
  return [
    ...listAllSourceFiles(root),
    ...listSourceFiles(root, E2E_ROOT),
    ...listSourceFiles(root, SCRIPTS_ROOT),
    ...listDirectFiles(root, ""),
  ].filter(CONSOLE_DIRECT_ACCESS.appliesTo);
}

// 「ファイル:行」の一覧。logger.ts は除く。
function findConsoleViolations(root: string): string[] {
  return listConsoleCheckedFiles(root)
    .filter((file) => file !== CONSOLE_DIRECT_ACCESS.allowedFile)
    .flatMap((file) =>
      findConsoleAccesses(readFileSync(join(root, file), "utf8")).map(
        (line) => `${file}:${line}`,
      ),
    );
}

// --- 現在時刻の読み取り（規則 now-single-source。.claude/rules/shared.md の now） ---
// 現在時刻を読んでよいのは apps/shared/now.ts だけ。ほかは now()（"@repo/shared/now"）を使う。
// WHY: 時刻を各所で直接読むと、時刻に依存する振る舞い（Entity の作成日時・一覧の並び順・ログの時刻）のテストが実行した
//   瞬間で結果を変え、決定的にならない。出口を 1 つにすれば、テストは vi.mock でそのモジュールを差し替えるだけで時刻を決められる。
// 違反にする書き方: 引数の無い new Date（new Date()・new Date( )・括弧なしの new Date・改行を挟むもの）、Date.now（呼ばずに
//   参照するだけでも。?.・["now"] も）、new を付けない Date()（現在時刻の文字列を返す）。globalThis.Date / global.Date を
//   経由するものも拾う。
// 通すもの: 引数のある new Date(x)（与えた値の解析で、現在時刻ではない）、Date.parse / Date.UTC、型の位置の Date、
//   DateTime・toDate・myDate のような別の識別子。
// WHY 対象を apps/frontend_customer・apps/backend・apps/shared のソースにする（テストとテストの補助 apps/<app>/test-support/ は除く）:
//   - テストとテストの補助は、期待値や時刻を決めるために Date を作る。本番の振る舞いに入らない。
//   - apps/e2e/ は別プロセスで動く本番ビルドを外から操作するので now を差し替えられず、現在時刻は一意なタイトルを作るためだけに使う。
//   - scripts/・リポジトリ直下の設定はアプリのコードではなく、時刻をテストで決める必要が無い。
// 限界（見逃す方向。「現在時刻の読み取りの抽出」のテストで固定）: 別名（const D = Date; new D()）、分割代入（const { now } = Date）、
//   括弧で囲んだ Date（new (Date)()）、空のスプレッド（new Date(...[])）、Reflect.construct(Date, [])、テンプレートリテラルの ${} の中。
//   performance.now()・process.hrtime() は経過時間の計測で時刻ではないので対象にしない。
// 限界（多く検出する方向）: Date という名前のメソッドの呼び出し（calendar.Date()）も new の無い Date() として数える（今のリポジトリには無い）。
const NOW_CHECK_DIRS = [FRONTEND_ROOT, BACKEND_ROOT, SHARED_ROOT];

// テストの補助（apps/backend/test-support/database.ts・apps/frontend_customer/test-support/i18n.tsx など）。アプリの直下の
//   test-support/ の下だけ（Issue #181 でファイル名の .test-support から置き場所に変えた）。
// WHY 名前の .test-support を補助として扱わない: 置き場所を test-support/ の 1 か所にそろえ（.dockerignore の **/test-support で
//   イメージから外れるのはそこだけ）、層の下に *.test-support.ts を置いて現在時刻を読んでも素通りしないようにする。
const TEST_SUPPORT_FILE = /^apps\/[^/]+\/test-support\//;

const NOW_SINGLE_SOURCE = {
  id: "now-single-source",
  name: "現在時刻（引数の無い new Date・Date.now・new の無い Date()）を読んでよいのは apps/shared/now.ts だけ（apps/frontend_customer・apps/backend・apps/shared が対象。テストとテストの補助は除く）",
  // 現在時刻を読んでよいファイル（現在時刻の唯一の出口）。
  allowedFile: `${SHARED_NOW_MODULE}.ts`,
  appliesTo: (file: string) =>
    isSourceNonTest(file) &&
    !TEST_SUPPORT_FILE.test(file) &&
    NOW_CHECK_DIRS.some((dir) => isUnder(file, dir)),
};

// 現在時刻を読む書き方（上の「違反にする書き方」）。1 つの書き方 = 1 つの選択肢で、どれに当たっても 1 件と数える。
//   1. new Date の後ろに「空白以外の文字を含む (」が無いもの。new globalThis.Date のような 1 段のプロパティ経由も含む。
//   2. Date.now / Date?.now / Date["now"]（と ?.[ ]）。\bDate なので globalThis.Date.now も拾い、Dates.now・myDate.now は拾わない。
//   3. new の付かない Date(。new Date(x) の Date( は後読みで除く。
const CURRENT_TIME_ACCESS = new RegExp(
  [
    String.raw`\bnew\s+(?:[\w$]+\s*\.\s*)?Date(?![\w$])(?!\s*\(\s*[^\s)])`,
    String.raw`\bDate\s*(?:\??\.\s*now(?![\w$])|(?:\?\.)?\s*\[\s*(["'\`])now\1\s*\])`,
    String.raw`(?<!\bnew\s+(?:[\w$]+\s*\.\s*)?)\bDate\s*\(`,
  ].join("|"),
  "g",
);

// source の中で現在時刻を読む箇所を、書かれた順に行番号（1 始まり）で返す。
// コメントの中と文字列リテラルの中は拾わない（findConsoleAccesses と同じ stripComments / stringRanges を使う）。
function findCurrentTimeAccesses(source: string): number[] {
  const code = stripComments(source);
  const ranges = stringRanges(code);
  return [...code.matchAll(CURRENT_TIME_ACCESS)]
    .filter((match) => !isInsideString(ranges, match.index))
    .map((match) => code.slice(0, match.index).split("\n").length);
}

function listNowCheckedFiles(root: string): string[] {
  return listAllSourceFiles(root).filter(NOW_SINGLE_SOURCE.appliesTo);
}

// 「ファイル:行」の一覧。now.ts は除く。
function findNowViolations(root: string): string[] {
  return listNowCheckedFiles(root)
    .filter((file) => file !== NOW_SINGLE_SOURCE.allowedFile)
    .flatMap((file) =>
      findCurrentTimeAccesses(readFileSync(join(root, file), "utf8")).map(
        (line) => `${file}:${line}`,
      ),
    );
}

// --- ハードコードの文言（規則 frontend-hardcoded-text・server-hardcoded-text。Issue #116 の i18n） ---
// 画面の文言は辞書（apps/frontend_customer の *.messages.ts。画面・部品の隣と shared/i18n/common.messages.ts）だけに置き、画面は t("key", params) で描く。
//   backend のエラーは ErrorKey（apps/backend/shared/error/error-key.ts）と params で表し、自然言語を持たない。
//   この 2 つを、文言が辞書の外に書かれた時点で止める（CLAUDE.md の原則 7。レビューの目視に頼らない）。
// 違反にするもの（frontend-hardcoded-text。apps/frontend_customer のテスト以外のソース。辞書 *.messages.ts は defineMessages(...) の
//   引数の中だけを除く）:
//   1. JSX のテキスト（<button>削除</button>、<h1>Todo</h1>）に空白以外の文字がある。ASCII の英語も違反にする。
//      WHY 英語も止める: 言語を切り替えても英語のまま残り、日本語だけを見る 3 では拾えないため。
//   2. 利用者に見える JSX 属性（VISIBLE_TEXT_ATTRIBUTES）の値が、文字列リテラル・テンプレートリテラルで、空白以外の文字を持つ
//      （aria-label="Delete"、aria-label={`「${todo.title}」を削除`}）。{t("...")} のような式は通す。
//      WHY 空白だけの値（alt=""）は通す: alt="" は装飾の画像であることを支援技術に伝える書き方で、文言ではない。
//        1 の JSX のテキストも空白だけ（改行とインデント）は通すので、同じ基準にそろえる。
//      WHY 埋め込み式だけのテンプレート（aria-label={`${title}`}）は通す: 書かれた文字が無く、辞書に移す文言が無い。
//   3. ファイルのどこであれ、文字列リテラル・テンプレートリテラル（型の位置の "..." も含む）に日本語（ひらがな・カタカナ・漢字）がある。
//      WHY: 1・2 の外（エラーメッセージ、変数に入れてから渡す文言、属性の一覧に無い props）に書いた日本語を拾うため。
// 違反にするもの（server-hardcoded-text。apps/backend と apps/shared のテスト以外のソース。例外なし）: 3 だけ。
//   WHY 例外を置かない: エラーは ErrorKey と params で表し、文言は画面側の辞書で組み立てる（DomainError に日本語を渡さない）。
//   WHY apps/shared も対象にする（Issue #116 の仕上げ）: env.ts のエラーと logger.ts のメッセージは運用者（開発者）向けで、
//     利用者に見せる文言は frontend の辞書、運用者向けの文言は英語、と決めたため。日本語が残ると 2 つの言語が混ざる。
//   WHY 1・2 を backend にかけない: backend は JSX を持たず（置き場所の規則と .claude/rules/backend.md）、ASCII の文字列は
//     ErrorKey・ログのメッセージ・SQL など文言ではないものが大半で、ASCII まで止めると誤検知が多い。
// WHY テストを除く: テストは画面に出た文言（「削除」のボタンがあること）を確かめるため、日本語を書く。
// WHY 正規表現ではなく構文木（AST）で見る: JSX のテキスト（<p>x</p>）と比較の式（a < b > c）、JSX の中の ' と文字列の区切り、
//   コメントと文字列の中の // や /* は、正規表現では取り違える（stripComments の限界）。文言の検査は、どこからどこまでが
//   JSX のテキスト・属性・文字列リテラルかを正しく切り出すことが本体なので、TypeScript のパーサの結果を使う。
//   コメントは構文木に現れないので、コメントの日本語は自然に対象外になる。エスケープ（"削"）も解釈した値で見る。
// WHY TypeScript 7 の typescript/unstable/sync（API）を使う（ts.createSourceFile ではない）: TypeScript 7.0.2（devDependency。
//   package.json で完全固定）は Go で書き直された版で、パッケージの "." は版の番号だけを返し、JS のパーサ
//   （ts.createSourceFile）を持たない。構文木は、同梱の tsgo をプロセスとして起動し、API（typescript/unstable/sync）で
//   受け取る（node_modules/typescript/package.json の exports と dist/api/sync/api.d.ts。2026-09-29 に実測）。
//   依存は足さない（Babel や oxc のパーサを足すと、版の管理とライセンスの確認が増える）。"unstable" の名前のとおり
//   TypeScript を上げると形が変わりうるが、版は完全固定なので、上げたときにこのテストの失敗で気づく。
// 限界（仕様として受け入れる。下の「ハードコードの文言の抽出」のテストで固定している）:
//   - ASCII の文字列を変数に入れてから JSX に渡す（const s = "Delete"; <p>{s}</p>）、JSX の子に式で書く（<p>{"Delete"}</p>）、
//     属性の一覧に無い props（<Dialog heading="Delete" />）、三項演算子の中（title={x ? "A" : "B"}）は拾わない（見逃す方向）。
//     日本語なら 3 で止まる。英語の文言は辞書（en.ts）に置く運用とレビューで見る。
//   - 一覧の属性に書いた値は、文言でなくても（title="-"、alt="logo.png" のような記号・ファイル名）違反になる（多く検出する方向）。
//     失敗したときに出る「ファイル:行」を見て、辞書に移すか判断する。

// 利用者に見える（画面に出る・読み上げられる）JSX 属性。値は辞書から t(...) で渡す。
// WHY この 6 つ: aria-label・aria-description は支援技術が読み上げ、placeholder・title・alt は画面やツールチップに出る。
//   label は <option label> と、自前のコンポーネントの props（<Field label="...">）で文言を渡す慣習の名前。
const VISIBLE_TEXT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "aria-label",
  "aria-description",
  "placeholder",
  "title",
  "alt",
  "label",
]);

// 画面の文言の辞書（apps/frontend_customer の *.messages.ts。画面・部品の隣の todo-screen.messages.ts と、共通の
//   shared/i18n/common.messages.ts。Issue #125）。ここの defineMessages(...) の引数の中だけは文言を書いてよい。
// WHY 名前（.messages.ts）で決める（ディレクトリで決めない）: 辞書は画面・部品の隣に置く（colocation）ので、場所は画面ごとに違う。
//   どこから参照してよいかは規則 messages-colocation が見る。
// WHY .ts だけ（.tsx を除かない）: 辞書は defineMessages({ ja, en }) のオブジェクトだけで JSX を持たない。.tsx にすると
//   JSX の文言まで例外になる。
// WHY ファイルごと除かず defineMessages(...) の引数の中だけにする（Issue #125 の reviewer 指摘）: 名前が *.messages.ts なら
//   中身を見ずに例外にしていたため、辞書のファイルに書いた const label = "削除" や createElement の文言が素通りした。
// 限界: 呼び出しの名前（defineMessages）だけで見る。どこから import したかは見ないので、辞書のファイルの中で同じ名前の別の
//   関数を定義して呼ぶと、その引数も例外になる（見逃す方向。辞書のファイルは defineMessages の 1 文だけを置く運用）。
const I18N_MESSAGES = /^apps\/frontend_customer\/.+\.messages\.ts$/;

// 日本語の文字。Unicode の Script（書記体系）で、ひらがな・カタカナ・漢字を見る（u フラグで \p{...} を使う）。
// WHY Script で見る（文字コードの範囲を書かない）: 範囲の書き間違い・漏れ（半角カナ・CJK 互換漢字など）を避けるため。
//   「」や 、。 などの記号（Script=Common）は含めない。記号だけの文字列は、日本語の文言としては書かれないため。
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const NON_WHITESPACE = /\S/;

// どの種類の文言を違反にするか。frontend は 1・2・3、サーバ側（backend・shared）は 3 だけ（上の説明の番号）。
type HardcodedTextChecks = {
  jsxText: boolean;
  visibleAttributes: ReadonlySet<string>;
  // 辞書のファイル（defineMessages(...) の引数の中を検査しないファイル）か。frontend は I18N_MESSAGES、サーバ側は無し。
  isDictionary: (file: string) => boolean;
};

// 辞書を定義する関数（apps/frontend_customer/shared/i18n/i18n.tsx の defineMessages）の名前。
const DEFINE_MESSAGES = "defineMessages";

const FRONTEND_HARDCODED_TEXT = {
  id: "frontend-hardcoded-text",
  name: "画面（apps/frontend_customer）に文言をハードコードしない: JSX のテキスト、利用者に見える属性（aria-label・placeholder・title・alt・label・aria-description）の文字列、日本語の文字列は違反（辞書 apps/frontend_customer/**/*.messages.ts の defineMessages(...) の引数の中とテストは除く）",
  roots: [FRONTEND_ROOT],
  appliesTo: (file: string) =>
    isSourceNonTest(file) && isUnder(file, FRONTEND_ROOT),
  checks: {
    jsxText: true,
    visibleAttributes: VISIBLE_TEXT_ATTRIBUTES,
    isDictionary: (file) => I18N_MESSAGES.test(file),
  } as HardcodedTextChecks,
};

const SERVER_HARDCODED_TEXT = {
  id: "server-hardcoded-text",
  name: "apps/backend と apps/shared の非テストコードは日本語のリテラルを持たない（エラーは ErrorKey と params で表し、運用者向けの文言は英語。テストは除く。例外なし）",
  roots: [BACKEND_ROOT, SHARED_ROOT],
  appliesTo: (file: string) =>
    isSourceNonTest(file) &&
    (isUnder(file, BACKEND_ROOT) || isUnder(file, SHARED_ROOT)),
  checks: {
    jsxText: false,
    visibleAttributes: new Set<string>(),
    isDictionary: () => false,
  } as HardcodedTextChecks,
};

const HARDCODED_TEXT_RULES = [FRONTEND_HARDCODED_TEXT, SERVER_HARDCODED_TEXT];
type HardcodedTextRule = (typeof HARDCODED_TEXT_RULES)[number];

// tsgo に渡す仮想のファイルシステムの根。実ディスクのパスと重ならない名前にする。
const VIRTUAL_ROOT = "/architecture-test-virtual";

// files（リポジトリ相対のパス → ソース）を 1 回の tsgo の起動でまとめて構文解析し、パスごとの構文木を返す。
// WHY 仮想のファイルシステム（createVirtualFileSystem）に置く: 実ファイルでも fixture でも、読んだ文字列をそのまま解析し、
//   tsconfig の include や node_modules の解決に左右されないため。tsconfig は files で対象を列挙し、
//   allowJs（.js / .mjs / .cjs / .jsx も解析する）と jsx（.tsx / .jsx の JSX を解析する）だけを指定する。
//   拡張子で JSX の有無が決まる（.ts の <x> は型アサーション）のは実際のビルドと同じ。
// WHY まとめて解析する: tsgo の起動に 100ms ほどかかる（2026-09-29 実測）。ファイルごとに起動すると遅い。
// WHY 見つからないファイルで例外にする: 黙って飛ばすと、そのファイルの文言が検査を素通りする。
// 注意: api.close() は tsgo のプロセスを kill する。tsgo の stderr は Vitest の出力にそのままつながっている
//   （typescript/dist/api/syncChannel.js の stdio: inherit）ので、終了の間合いによって "context canceled" が出ることがある
//   （2026-09-29 に 5 回中 2 回実測）。解析の結果とテストの成否には関係しない。
function parseSourceFiles(
  files: Record<string, string>,
): Map<string, SourceFile> {
  const paths = Object.keys(files);
  if (paths.length === 0) {
    return new Map();
  }
  const tsconfig = `${VIRTUAL_ROOT}/tsconfig.json`;
  const api = new API({
    cwd: VIRTUAL_ROOT,
    fs: createVirtualFileSystem({
      ...Object.fromEntries(
        paths.map((path) => [`${VIRTUAL_ROOT}/${path}`, files[path]]),
      ),
      [tsconfig]: JSON.stringify({
        compilerOptions: {
          allowJs: true,
          jsx: "preserve",
          noLib: true,
          types: [],
        },
        files: paths,
      }),
    }),
  });
  try {
    const [project] = api
      .updateSnapshot({ openProjects: [tsconfig] })
      .getProjects();
    return new Map(
      paths.map((path) => {
        const sourceFile = project?.program.getSourceFile(
          `${VIRTUAL_ROOT}/${path}`,
        );
        if (sourceFile === undefined) {
          throw new Error(`構文解析の結果に ${path} が無い`);
        }
        return [path, sourceFile];
      }),
    );
  } finally {
    api.close();
  }
}

// 文字列リテラル・テンプレートリテラルに書かれた文字（エスケープを解釈した値）。それ以外の節は undefined。
// テンプレートリテラルは、埋め込み式（${...}）の外の文字だけをつなぐ（埋め込み式の中の文字列は、その節として別に見る）。
function literalTextOf(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ].join("");
  }
  return undefined;
}

// JSX 属性の値のうち、文字列リテラル・テンプレートリテラルそのもの（title="x" と title={"x"} と title={`x`}）。
function attributeLiteralOf(attribute: JsxAttribute): Node | undefined {
  const value = attribute.initializer;
  const literal =
    value !== undefined && isJsxExpression(value) ? value.expression : value;
  return literal !== undefined && literalTextOf(literal) !== undefined
    ? literal
    : undefined;
}

// 節が書かれた行（1 始まり）。JSX のテキストは前後の改行・インデントも節に含むので、最初の空白以外の文字の行にする。
function lineOf(sourceFile: SourceFile, node: Node): number {
  const start = isJsxText(node)
    ? node.pos + node.text.search(NON_WHITESPACE)
    : node.getStart(sourceFile);
  return sourceFile.text.slice(0, start).split("\n").length;
}

// node が利用者に見える JSX 属性（checks.visibleAttributes）で、値が空白以外の文字を持つ文字列リテラル・テンプレートリテラル
//   なら、その値の節（上の説明の 2）。それ以外は undefined。
// WHY findHardcodedTexts から切り出す: 辞書の判定（defineMessages の引数）を足して、Biome の認知的複雑度の上限（15）を超えたため。
function visibleAttributeTextOf(
  node: Node,
  checks: HardcodedTextChecks,
): Node | undefined {
  if (
    !isJsxAttribute(node) ||
    !isIdentifier(node.name) ||
    !checks.visibleAttributes.has(node.name.text)
  ) {
    return undefined;
  }
  const literal = attributeLiteralOf(node);
  return literal !== undefined &&
    NON_WHITESPACE.test(literalTextOf(literal) ?? "")
    ? literal
    : undefined;
}

// defineMessages(...) の呼び出し（呼び出す関数が defineMessages という名前の識別子）か。
function isDefineMessagesCall(node: Node): boolean {
  return (
    isCallExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === DEFINE_MESSAGES
  );
}

// file（リポジトリ相対のパス。辞書かの判定に使う）の構文木 sourceFile の中のハードコードの文言を、書かれた順に行番号で返す
//   （1 つの節が 2 と 3 の両方に当たっても 1 件）。
// 構文木を forEachChild で再帰的にたどる（コメントは構文木に無いので見ない）。辞書のファイルでは、defineMessages(...) の
//   呼び出しの引数の中へは入らない（呼び出す関数の名前の節だけを見る）。
// WHY file を別に受け取る（sourceFile.fileName を使わない）: 判定の例は仮想のパス（example-<番号>/...）で解析するので、
//   sourceFile の名前はリポジトリ相対のパスと一致しない。
function findHardcodedTexts(
  file: string,
  sourceFile: SourceFile,
  checks: HardcodedTextChecks,
): number[] {
  const found = new Set<Node>();
  const dictionary = checks.isDictionary(file);
  const visit = (node: Node): void => {
    if (dictionary && isDefineMessagesCall(node)) {
      return;
    }
    if (checks.jsxText && isJsxText(node) && NON_WHITESPACE.test(node.text)) {
      found.add(node);
    }
    const attributeText = visibleAttributeTextOf(node, checks);
    if (attributeText !== undefined) {
      found.add(attributeText);
    }
    if (JAPANESE.test(literalTextOf(node) ?? "")) {
      found.add(node);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return [...found].map((node) => lineOf(sourceFile, node));
}

// 規則の対象のファイル（テスト以外のソース。辞書 *.messages.ts は対象に含め、defineMessages の引数の中だけを findHardcodedTexts が除く）。
function listHardcodedTextCheckedFiles(
  root: string,
  rule: HardcodedTextRule,
): string[] {
  return rule.roots
    .flatMap((ruleRoot) => listSourceFiles(root, ruleRoot))
    .filter(rule.appliesTo);
}

// 「ファイル:行」の一覧。
function findHardcodedTextViolations(
  root: string,
  rule: HardcodedTextRule,
): string[] {
  const files = listHardcodedTextCheckedFiles(root, rule);
  const sourceFiles = parseSourceFiles(
    Object.fromEntries(
      files.map((file) => [file, readFileSync(join(root, file), "utf8")]),
    ),
  );
  return files.flatMap((file) =>
    findHardcodedTexts(
      file,
      sourceFiles.get(file) as SourceFile,
      rule.checks,
    ).map((line) => `${file}:${line}`),
  );
}

// --- api の handle を ProblemResponse.wrap で包む（規則 presentation-with-problem-response。Issue #141） ---
// backend の api ファイルのクラスの handle（Route Handler）は、初期化子が ProblemResponse.wrap(...) の呼び出しのプロパティにする
//   （readonly handle = ProblemResponse.wrap(async (request[, ctx]) => { ... })）。
// WHY 規則にする: Next の Route Handler には共通の catch が無い（Proxy は handler の例外を捕まえず、onRequestError は記録だけ）。
//   包み忘れると、handler が投げた DomainError・InvalidRequestError も Problem Details ではない Next の素の 500 になり、
//   api のテストに 400 / 404 の経路が無ければ気づけない。以前は 5 本の api が try / catch を手書きしていた
//   （apps/backend/shared/http/problem.ts の ProblemResponse.wrap のコメント）。
// 違反にするもの（ファイル:行。行は handle のメンバーの行）:
//   - handle の初期化子が ProblemResponse.wrap(...) の呼び出しでない（素の async のアロー関数、try / catch を自分で書いたもの、
//     別の関数で包んだもの・ProblemResponse.wrap を別の関数で包み直したもの、呼び出さずに ProblemResponse.wrap を代入したもの、
//     problem.ProblemResponse.wrap(...) のような名前空間経由の呼び出し、ProblemResponse の別のメソッド（ProblemResponse.from(...)）、
//     別のクラスの wrap（Other.wrap(...)）、素の wrap(...)）。
//   - 初期化子が無い handle（コンストラクタで代入する）、メソッド・getter・setter の handle。
//     WHY: 包んでいるかを宣言の 1 か所で読めない。メソッドは this が外れる形でもある（.claude/rules/backend.md）。
//   - 名前は識別子と文字列リテラル（"handle"）で見る。static も、クラス式（const A = class { ... }）も、入れ子の関数の中のクラスも見る。
// WHY 呼び出す先を名前（ProblemResponse という識別子の wrap というプロパティ）だけで見る（import 元を確かめない）: 同じ名前の別の
//   クラス（ファイルの中で定義したもの、presentation の別モジュールから import したもの）の wrap で包むと通る（見逃す方向の限界。
//   レビューで見る）。逆に、別名で import したもの（import { ProblemResponse as P } の P.wrap）や型アサーションを付けたもの
//   （... as any）、ブラケット（ProblemResponse["wrap"](...)）は違反になる（多く検出する方向）。
// WHY クラスの static メソッド（ProblemResponse.wrap）にした（Issue #262）: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。以前は関数 withProblemResponse の識別子で見ていた。
// 対象: apps/backend の下の presentation/ の下と、backend/shared の HTTP の境界 shared/http/ の下（どちらも入れ子も。置き場所の
//   規則は presentation/nested/x.api.ts・shared/http/nested/x.api.ts を許す）の *.api.<拡張子>（8 つの拡張子。テストは除く）。
//   WHY 拡張子を .ts に限らない: .api.mts などにすると素通りするため。
//   WHY shared/http/ も対象（Issue #310）: backend/shared を層から意味の単位に分けたとき、shared/presentation/ は shared/http/ に
//   なった。app-api（PRESENTATION_API）は shared/http/ の *.api を api ファイルとして参照させるので、同じ範囲を包むことを求める。
// 限界（見逃す方向）: クラスの外の Route Handler（export async function GET、オブジェクトリテラルの handle）、handle 以外の
//   名前のメンバー、計算されたプロパティ名（["handle"]）、コンストラクタの引数プロパティは見ない。api ファイルは
//   クラス <Verb><Noun>Api と handle で書く規約（.claude/rules/backend.md）で、ほかの形はレビューで見る。
const PRESENTATION_WITH_PROBLEM_RESPONSE = {
  id: "presentation-with-problem-response",
  name: "apps/backend の presentation と shared/http の api ファイル（*.api.ts）のクラスの handle は ProblemResponse.wrap(...) の呼び出しで初期化する（try / catch の手書き・素の async・別の関数で包むのは違反。テストは除く）",
  appliesTo: (file: string) =>
    isSourceNonTest(file) &&
    /^apps\/backend\/(?:(?:.+\/)?presentation|shared\/http)\/(?:.+\/)?[^/]+\.api\.(?:[cm]?[jt]s|[jt]sx)$/.test(
      file,
    ),
};

// handle を包む static メソッド（apps/backend/shared/http/problem.ts の ProblemResponse.wrap）のクラス名とメソッド名。
// WHY 2 つに分ける: 初期化子の呼び出し先を `<クラス名>.<メソッド名>` の形（受け手が識別子のプロパティアクセス）で見るため。
const PROBLEM_RESPONSE_CLASS = "ProblemResponse";
const PROBLEM_RESPONSE_WRAP = "wrap";
const HANDLE_MEMBER = "handle";

// クラスのメンバー（プロパティ・メソッド・getter・setter）の名前。識別子と文字列リテラルの名前だけ（計算された名前などは undefined）。
function classMemberNameOf(member: Node): string | undefined {
  if (
    !isPropertyDeclaration(member) &&
    !isMethodDeclaration(member) &&
    !isGetAccessorDeclaration(member) &&
    !isSetAccessorDeclaration(member)
  ) {
    return undefined;
  }
  return isIdentifier(member.name)
    ? member.name.text
    : literalTextOf(member.name);
}

// member が「初期化子が ProblemResponse.wrap(...) の呼び出しのプロパティ」か。
function isWrappedByProblemResponse(member: Node): boolean {
  if (!isPropertyDeclaration(member) || member.initializer === undefined) {
    return false;
  }
  const initializer = member.initializer;
  if (!isCallExpression(initializer)) {
    return false;
  }
  const callee = initializer.expression;
  return (
    isPropertyAccessExpression(callee) &&
    isIdentifier(callee.expression) &&
    callee.expression.text === PROBLEM_RESPONSE_CLASS &&
    isIdentifier(callee.name) &&
    callee.name.text === PROBLEM_RESPONSE_WRAP
  );
}

// 構文木の中のクラス（宣言と式。入れ子も）の handle のうち、ProblemResponse.wrap(...) で初期化していないものを、書かれた順に行番号で返す。
function findUnwrappedHandles(sourceFile: SourceFile): number[] {
  const found: number[] = [];
  const visit = (node: Node): void => {
    if (isClassLikeDeclaration(node)) {
      for (const member of node.members) {
        if (
          classMemberNameOf(member) === HANDLE_MEMBER &&
          !isWrappedByProblemResponse(member)
        ) {
          found.push(lineOf(sourceFile, member));
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

function listProblemResponseCheckedFiles(root: string): string[] {
  return listSourceFiles(root, BACKEND_ROOT).filter(
    PRESENTATION_WITH_PROBLEM_RESPONSE.appliesTo,
  );
}

// 「ファイル:行」の一覧。
function findProblemResponseViolations(root: string): string[] {
  const files = listProblemResponseCheckedFiles(root);
  const sourceFiles = parseSourceFiles(
    Object.fromEntries(
      files.map((file) => [file, readFileSync(join(root, file), "utf8")]),
    ),
  );
  return files.flatMap((file) =>
    findUnwrappedHandles(sourceFiles.get(file) as SourceFile).map(
      (line) => `${file}:${line}`,
    ),
  );
}

// --- backend と apps/shared の本番コードとテストの補助、frontend の React 以外のモジュールはクラスを基本にする（規則 class-based。Issue #262） ---
// apps/backend と apps/shared の本番コード、テストの補助（apps/backend/test-support/・apps/backend/spec/ の support.ts・apps/e2e/ の
//   spec 以外）は、ファイルの最上位（モジュールの直下と namespace の中）に関数を置かない。補助の関数もクラスのメソッド（状態を
//   使わないものは static）にする。
// WHY 規則にする: ADR docs/adr/architecture/20261002-class-based-backend.md（daiki の判断 2026-10-02）で、関数を export せず、
//   ファイルの中だけの補助の関数も置かないと決めた。PR #264 / #266 / #267 で backend の移行を終え、本番コードの最上位の関数は 0 件に
//   なった。レビューだけでは、関数の import が戻る（依存がコンストラクタに出ず、差し替えに vi.mock が要る形に戻る）のを止められない。
// WHY apps/shared も対象にする（Issue #262。規則の名前を backend-class-based から class-based に変えた）: daiki が対象の範囲を
//   「すべて」と決めた（2026-10-02。ADR docs/adr/architecture/20261002-class-based-shared-and-test-support.md）。apps/shared は
//   backend と frontend 直下が import する基盤で、ここに関数が残ると backend の呼び出し側に関数の import が戻る。
// 違反にするもの（ファイル:行。行は宣言の書き出し）:
//   - function 宣言（export・export default・async・generator・オーバーロードの宣言・declare function も、1 つずつ）。
//   - 初期化子が関数（アロー関数・function 式）の変数（const / let / var、export も）。括弧・as・satisfies・! ・<T> で包んだものも。
//   - export default のアロー関数・function 式（export default async () => {}）。
// 許すもの: クラス（宣言・式）のメンバー（メソッド・アロー関数のクラスフィールド readonly handle = ProblemResponse.wrap(async ...)）、
//   メソッドや関数の中の関数、型・interface、関数でない値の変数（定数・オブジェクト・new X().handle のようなプロパティの参照）。
// 対象: apps/backend・apps/shared・apps/e2e の下と、apps/frontend_customer の features/・shared/・test-support/ の下（*.tsx・*.jsx・
//   *.hook.* を除く）のテスト以外のソース（8 つの拡張子）。テスト（*.test.*）と E2E のテスト（apps/e2e の *.spec.*。E2E_SPEC_FILE）は除く。
// WHY frontend の React 以外のモジュールも対象にする（daiki の判断 2026-10-02「クラス必須でルールにして」。ADR
//   docs/adr/architecture/20261002-class-based-frontend-modules.md）: API の呼び出し（features/<f>/api/）・ロケールの判定・日時の
//   表示・リクエストログの組み立て（shared/）は React も Next も関数の形を求めないので、backend と同じくクラスのメソッドにそろえる。
//   画面のテストの差し替えも vi.mocked(TodoApi.list) の形になり、apps/shared の vi.mocked(Clock.now) とそろう。
// WHY frontend の次は対象外にする（関数の形を外の仕様が求めるか、クラスにすると React の規則とぶつかるもの）:
//   - *.tsx・*.jsx（React の component。クラスの component は React の公式で非推奨の書き方）。JSX を含む補助（test-support/i18n.tsx の
//     JaLocale と同じファイルの tJa、shared/i18n/i18n.tsx の LocaleProvider と同じファイルの defineMessages など）もファイルごと外す。
//     WHY ファイルごと: 同じファイルの中で component と補助を見分けるには「JSX を返すか」を型で見る必要があり、今の判定（構文だけ）
//     では決まらない。
//   - *.hook.*（React の hook。hook は関数で呼ぶ規則（Rules of Hooks）で、use で始まる関数であることを React の lint も前提にする）。
//   - app/ の下（Next の規約のファイル。page.tsx・layout.tsx の default export の関数、app/api の route.ts の GET など。route.ts は
//     backend の handle を re-export するだけで関数を書かないが、規約のファイルとしてまとめて外す）。
//   - apps/frontend_customer 直下のファイル（proxy.ts の proxy、instrumentation.ts の register は Next が関数の export を求める。
//     instrumentation-node.ts は register が Node.js runtime でだけ dynamic import する本体で、Vitest のカバレッジの対象外
//     （vitest.config.mts）。形を変えても単体テストで確かめられないので、規約のファイルとまとめて外す。next.config.ts も規約のファイル）。
// WHY テストの補助（apps/backend/test-support/・apps/backend/spec/ の support.ts・apps/e2e/support/database.ts）も対象にする（Issue #262 の
//   2 つ目の PR。以前は除いていた）: daiki が対象の範囲を「すべて」と決め、テストの補助も移した（ADR
//   20261002-class-based-shared-and-test-support.md）。テストの組み立てを読むときも依存の形（クラスのメソッド）が本番とそろう。
// WHY テスト（*.test.*・*.spec.*）は除く: テストの本体は Vitest / Playwright の describe・it・test に関数を渡す形で、ファイルの中だけの
//   小さな補助の関数（step の中の組み立てなど）まで縛ると、テストの読みやすさを落とすだけで関数の import は増えない（ほかのファイルは
//   テストを import しない）。
// WHY リポジトリ直下の vitest.global-setup.ts は対象外のまま（apps/ の下でないので列挙に入らない）: Vitest の globalSetup は
//   setup を関数の default export で求める（中の処理は test-support の TestDatabase を呼ぶ）。
// WHY apps/e2e/playwright.config.ts は対象にする（例外にしない）: Playwright が求めるのは default export の設定オブジェクト
//   （defineConfig の戻り値）だけで、補助の関数の形は求めない。今も最上位は定数と default export だけで関数は無い
//   （drizzle.config.ts と同じ扱い）。
// WHY apps/backend/shared/drizzle/drizzle.config.ts も対象にする: drizzle-kit が求めるのは default export の設定オブジェクトだけで、
//   補助の関数の形は求めない。今もクラス DrizzleConfigPath の static メソッドで書いている（ファイルのコメント）ので、例外は要らない。
// 限界（見逃す方向）: 最上位の関数呼び出しの引数に書いた関数（即時実行の (() => {})()、z.object(...).refine((x) => ...)）、
//   オブジェクトリテラルのメソッド・関数のプロパティ（export const x = { f() {} }）、三項演算子などの式の中の関数
//   （const f = c ? () => 1 : () => 2）、別のファイルの関数の再代入（const f = other.f）は見ない（関数かは型を見ないと決まらない）。
//   最上位の文のブロックの中の関数（{ ... }・if・try・switch・for の中）も見ない（不自然な書き方なので再帰しない。reviewer の実測）。
//   レビューで見る。
const CLASS_BASED = {
  id: "class-based",
  name: "apps/backend と apps/shared の本番コードとテストの補助（apps/backend の test-support/・spec/ の support.ts、apps/e2e の *.spec.* 以外）と apps/frontend_customer の features/・shared/・test-support/ の React 以外のモジュール（*.tsx・*.jsx・*.hook.* 以外）はファイルの最上位に関数を置かない（テストと E2E の *.spec.*、frontend の app/ と直下のファイルは除く。function 宣言・関数を入れた変数・export default の関数は違反。クラスのメソッド・クラスフィールドのアロー関数・メソッドの中の関数は可）",
  appliesTo: (file: string) =>
    isSourceNonTest(file) &&
    (isUnder(file, BACKEND_ROOT) ||
      isUnder(file, SHARED_ROOT) ||
      (isUnder(file, E2E_ROOT) && !E2E_SPEC_FILE.test(file)) ||
      isFrontendNonReactModule(file)),
};

// frontend のうち規則 class-based の対象にするディレクトリ（WHY は CLASS_BASED の「frontend の次は対象外にする」）。
const CLASS_BASED_FRONTEND_DIRS = ["features", "shared", "test-support"].map(
  (dir) => `${FRONTEND_ROOT}/${dir}`,
);
// React の component（*.tsx・*.jsx）と hook（*.hook.<拡張子>）。
const REACT_COMPONENT_FILE = /\.[jt]sx$/;
const REACT_HOOK_FILE = /\.hook\.(?:[cm]?[jt]s|[jt]sx)$/;

function isFrontendNonReactModule(file: string): boolean {
  return (
    CLASS_BASED_FRONTEND_DIRS.some((dir) => isUnder(file, dir)) &&
    !REACT_COMPONENT_FILE.test(file) &&
    !REACT_HOOK_FILE.test(file)
  );
}

// 括弧・型アサーション（as / <T>）・satisfies・非 null アサーション（!）を外した式。
// WHY 外す: (() => 1)・(async () => 1) as F・function () {} satisfies F は、包んでも最上位の関数であることは変わらない。
function unwrapExpression(expression: Node): Node {
  if (
    isParenthesizedExpression(expression) ||
    isAsExpression(expression) ||
    isSatisfiesExpression(expression) ||
    isNonNullExpression(expression) ||
    isTypeAssertion(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function isFunctionValue(expression: Node | undefined): boolean {
  if (expression === undefined) {
    return false;
  }
  const unwrapped = unwrapExpression(expression);
  return isArrowFunction(unwrapped) || isFunctionExpression(unwrapped);
}

// 文の並び（ファイルの直下か namespace の中）の最上位の関数を、書かれた順に行番号で返す。
// WHY namespace（module）の中も見る: namespace の中の function もクラスの外の関数で、namespace で包めば素通りするのを防ぐ。
function topLevelFunctionLines(
  sourceFile: SourceFile,
  statements: readonly Node[],
): number[] {
  return statements.flatMap((statement): number[] => {
    if (isFunctionDeclaration(statement)) {
      return [lineOf(sourceFile, statement)];
    }
    if (isVariableStatement(statement)) {
      return statement.declarationList.declarations
        .filter((declaration) => isFunctionValue(declaration.initializer))
        .map((declaration) => lineOf(sourceFile, declaration));
    }
    if (
      isExportAssignment(statement) &&
      isFunctionValue(statement.expression)
    ) {
      return [lineOf(sourceFile, statement)];
    }
    if (isModuleDeclaration(statement)) {
      return namespaceFunctionLines(sourceFile, statement.body);
    }
    return [];
  });
}

// namespace の本体（入れ子の a.b.c は ModuleDeclaration が続く）の最上位の関数の行番号。
function namespaceFunctionLines(
  sourceFile: SourceFile,
  body: Node | undefined,
): number[] {
  if (body === undefined) {
    return [];
  }
  if (isModuleBlock(body)) {
    return topLevelFunctionLines(sourceFile, body.statements);
  }
  return isModuleDeclaration(body)
    ? namespaceFunctionLines(sourceFile, body.body)
    : [];
}

function findTopLevelFunctions(sourceFile: SourceFile): number[] {
  return topLevelFunctionLines(sourceFile, sourceFile.statements);
}

function listClassBasedCheckedFiles(root: string): string[] {
  return [
    ...listSourceFiles(root, BACKEND_ROOT),
    ...listSourceFiles(root, SHARED_ROOT),
    ...listSourceFiles(root, E2E_ROOT),
    ...listSourceFiles(root, FRONTEND_ROOT),
  ].filter(CLASS_BASED.appliesTo);
}

// 「ファイル:行」の一覧。
function findClassBasedViolations(root: string): string[] {
  const files = listClassBasedCheckedFiles(root);
  const sourceFiles = parseSourceFiles(
    Object.fromEntries(
      files.map((file) => [file, readFileSync(join(root, file), "utf8")]),
    ),
  );
  return files.flatMap((file) =>
    findTopLevelFunctions(sourceFiles.get(file) as SourceFile).map(
      (line) => `${file}:${line}`,
    ),
  );
}

// --- workspace パッケージの exports（規則 backend-exports。Issue #68 の段階 2。規則 shared-exports。Issue #90） ---
// exports は、@repo/backend・@repo/shared として外（そのパッケージのディレクトリの外）に公開するファイルの一覧。
//   ユーザー判断で、全ファイル（"./*"）ではなく、外が使う入口だけを明示する（.claude/rules/backend.md の「import の書き方と
//   公開の範囲（exports）」、.claude/rules/shared.md）。
// 検査すること（1 つでも破ると「<規則の id>: ...」の行を出す）:
//   (1) 外から "<パッケージ名>/<path>" で参照するものは、すべて exports のどれかのキーに当たる。
//       WHY: 当たらないと Next / Vitest / tsc の解決で失敗するが、その前に「どのファイルのどの参照か」を一覧で出す。
//       exports を足すときに、何を公開するかをこのテストの失敗で決めさせる。
//   (2) exports の各キーは、外から少なくとも 1 か所で参照されている。
//       WHY: 使わなくなった公開を残すと、公開の範囲が黙って広がったままになる（公開を最小に保つ）。
//   (3) キーは "./" で始まり、値はキーのパスに ".ts" を付けた文字列（"./x" → "./x.ts"、"./a/*.api" → "./a/*.api.ts"）。
//       WHY: 依存の向きの規則は "@repo/backend/x" を apps/backend/x として判定する（toReference）。キーと違うファイルを
//       指せると、規則が見ている参照先と、実際に読み込まれるファイルがずれる。条件付きの object（{ "import": ... }）も
//       条件ごとに別のファイルを指せるので使わない。
//   (4) キーが指すファイルが存在する（パターンなら、当たるファイルが 1 つ以上ある）。
// キーの照合は Node.js の exports の解決（packageExportsResolve）に合わせる: 完全一致を優先し、次に "*" を 1 つだけ含む
//   パターンのうち、"*" の前が最も長いもの（同じ長さならキーが長いもの）。"*" は 1 文字以上に当たり、"/" も含みうる。
// WHY パッケージの中の参照は対象外: backend の中は相対パスだけ（規則 backend-relative-only）で、exports を通らない。
//   apps/shared の中も、同じパッケージのファイルを自分の名前で指す理由が無い。
// WHY @repo/backend と @repo/shared で同じ関数を使う（Issue #90）: 公開の範囲の決め方（外が使う入口だけ）と検査の内容が同じで、
//   パッケージごとに書き写すと片方だけ直す（検査がずれる）ことになる。違うのはディレクトリとパッケージ名だけ。
type ExportedPackage = {
  id: string;
  name: string;
  // パッケージのディレクトリ（リポジトリ相対）と、import に書くパッケージ名。
  root: string;
  packageName: string;
};

const BACKEND_EXPORTS: ExportedPackage = {
  id: "backend-exports",
  name: 'apps/backend/package.json の exports は、外（apps/frontend_customer・apps/e2e/・リポジトリ直下）が "@repo/backend/..." で参照するものをすべて含み、参照されないキーを持たず、各キーはそのパスの .ts を指す',
  root: BACKEND_ROOT,
  packageName: BACKEND_PACKAGE,
};

// apps/shared/package.json の exports（Issue #90）。今のキーは "./env"・"./logger"・"./now" の 3 つ（1 ファイル = 1 キー。パターンを使わない
//   のは .claude/rules/shared.md の方針で、置き場所の規則 SHARED_PLACEMENT と合わせて公開するものを名前で決めるため）。
const SHARED_EXPORTS: ExportedPackage = {
  id: "shared-exports",
  name: 'apps/shared/package.json の exports は、外（apps/frontend_customer・apps/backend・apps/e2e/・リポジトリ直下）が "@repo/shared/..." で参照するものをすべて含み、参照されないキーを持たず、各キーはそのパスの .ts を指す',
  root: SHARED_ROOT,
  packageName: SHARED_PACKAGE,
};

const EXPORTED_PACKAGES = [BACKEND_EXPORTS, SHARED_EXPORTS];

type PackageExports = Record<string, unknown>;

function manifestOf(pkg: ExportedPackage): string {
  return `${pkg.root}/package.json`;
}

// WHY package.json が無い・exports が object でないときは空にする: 外からの "<パッケージ名>/..." の参照がすべて (1) の違反になり、
//   見逃す方向に倒れない。本番の検査では、exports を 1 件以上読めることを別に確かめる。
function readPackageExports(
  root: string,
  pkg: ExportedPackage,
): PackageExports {
  const path = join(root, manifestOf(pkg));
  if (!existsSync(path)) {
    return {};
  }
  const { exports } = JSON.parse(readFileSync(path, "utf8")) as {
    exports?: unknown;
  };
  return typeof exports === "object" && exports !== null
    ? (exports as PackageExports)
    : {};
}

// "@repo/backend/x" → "./x"、"@repo/backend" → "."（exports のキーと同じ形）
function exportSubpath(pkg: ExportedPackage, specifier: string): string {
  return `.${specifier.slice(pkg.packageName.length)}`;
}

// "*" を 1 つだけ含むパターンに当たるか。"*" は 1 文字以上（Node.js と同じく、長さがパターン以上のものだけ）。
function matchesPattern(path: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1 || pattern.lastIndexOf("*") !== star) {
    return false;
  }
  return (
    path.length >= pattern.length &&
    path.startsWith(pattern.slice(0, star)) &&
    path.endsWith(pattern.slice(star + 1))
  );
}

// subpath（"./x"）を解決する exports のキー。当たらなければ undefined。
function resolveExportKey(subpath: string, keys: string[]): string | undefined {
  if (!subpath.includes("*") && keys.includes(subpath)) {
    return subpath;
  }
  return keys
    .filter((key) => matchesPattern(subpath, key))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0];
}

// キーが指すはずのファイル（<パッケージのディレクトリ>/<キーのパス>.ts。パターンなら "*" を含む）が packageFiles にあるか。
function exportTargetExists(
  pkg: ExportedPackage,
  key: string,
  packageFiles: string[],
): boolean {
  const target = `${pkg.root}/${key.slice(2)}.ts`;
  return target.includes("*")
    ? packageFiles.some((file) => matchesPattern(file, target))
    : packageFiles.includes(target);
}

function exportEntryViolations(
  pkg: ExportedPackage,
  key: string,
  value: unknown,
  used: ReadonlySet<string>,
  packageFiles: string[],
): string[] {
  const entry = `${manifestOf(pkg)} の exports "${key}"`;
  return [
    ...(used.has(key) ? [] : [`${entry} はどこからも参照されていない`]),
    ...(key.startsWith("./") && value === `${key}.ts`
      ? []
      : [
          `${entry} の値 ${JSON.stringify(value)} は、キーのパスに .ts を付けたものではない`,
        ]),
    ...(exportTargetExists(pkg, key, packageFiles)
      ? []
      : [`${entry} が指すファイルが無い`]),
  ];
}

// exports の違反の一覧（(1) は「参照元 → specifier」、(2)〜(4) は「<パッケージ>/package.json の exports "キー" ...」）。
function findExportsViolations(
  pkg: ExportedPackage,
  exports: PackageExports,
  references: Reference[],
  packageFiles: string[],
): string[] {
  const keys = Object.keys(exports);
  const used = new Set<string>();
  const unexported: string[] = [];
  for (const ref of references) {
    if (
      isUnder(ref.from, pkg.root) ||
      !isPackageSpecifier(ref.specifier, pkg.packageName)
    ) {
      continue;
    }
    const key = resolveExportKey(exportSubpath(pkg, ref.specifier), keys);
    if (key === undefined) {
      unexported.push(`${ref.from} → ${ref.specifier}`);
    } else {
      used.add(key);
    }
  }
  return [
    ...unexported,
    ...Object.entries(exports).flatMap(([key, value]) =>
      exportEntryViolations(pkg, key, value, used, packageFiles),
    ),
  ];
}

// root のツリーで、pkg の exports の違反を検査する（本番の検査と fixture で同じ経路を通す）。
function findPackageExportsViolations(
  root: string,
  pkg: ExportedPackage,
  references: Reference[],
): string[] {
  return findExportsViolations(
    pkg,
    readPackageExports(root, pkg),
    references,
    listSourceFiles(root, pkg.root),
  );
}

function findViolations(references: Reference[], rule: Rule): string[] {
  return references
    .filter((ref) => rule.appliesTo(ref.from) && rule.isViolation(ref))
    .map((ref) => `${ref.from} → ${ref.to}`);
}

// root の下のツリー全体の違反を「<規則の id>: ファイル → 参照先」の一覧（並べ替え済み）で返す。
//   1 つの参照が複数の規則に違反するときは、規則ごとに 1 行ずつ出す。
//   置き場所の違反は「backend-placement: ファイル」「frontend-placement: ファイル」の 1 行で出す。
//   環境変数の直参照は「env-direct-access: ファイル:行」を参照ごとに 1 行で出す（同じファイルの複数の書き方を、
//   1 つずつ拾えているかまで比べるため）。console の直接の呼び出しも「console-direct-access: ファイル:行」で同じく出す。
//   現在時刻の読み取りも「now-single-source: ファイル:行」で同じく出す。
//   ハードコードの文言も「frontend-hardcoded-text: ファイル:行」「server-hardcoded-text: ファイル:行」を文言ごとに 1 行で出す。
//   ProblemResponse.wrap で包んでいない handle も「presentation-with-problem-response: ファイル:行」を handle ごとに 1 行で出す。
//   backend と apps/shared の本番コードとテストの補助の最上位の関数も「class-based: ファイル:行」を関数ごとに 1 行で出す。
//   exports の違反は「backend-exports: ...」「shared-exports: ...」の 1 行で出す（findExportsViolations）。
//   apps/shared の置き場所の違反は「shared-placement: ファイル」の 1 行で出す（ソース以外も含め、apps/shared の全ファイルを見る）。
// WHY 置き場所の規則も参照を取り出すファイル（listReferencingFiles。apps/e2e/ とリポジトリ直下を含む）全体にかける:
//   置き場所の規則は isMisplaced の中で apps/backend・apps/frontend_customer の下かを見るので、それ以外のファイルは違反にならない。
//   apps/e2e/ など対象外の場所のファイルも判定に通し、判定が対象を広げる壊れ方（apps/ の下をすべて frontend と見なすなど）を
//   fixture と実ファイルの検査で止める（Issue #84）。
function collectViolations(root: string): string[] {
  const files = listReferencingFiles(root);
  const references = referencesOf(root, files);
  return [
    ...RULES.flatMap((rule) =>
      findViolations(references, rule).map((line) => `${rule.id}: ${line}`),
    ),
    ...PLACEMENT_RULES.flatMap((placement) =>
      files
        .filter(placement.isMisplaced)
        .map((file) => `${placement.id}: ${file}`),
    ),
    ...findEnvViolations(root).map(
      (line) => `${ENV_DIRECT_ACCESS.id}: ${line}`,
    ),
    ...findConsoleViolations(root).map(
      (line) => `${CONSOLE_DIRECT_ACCESS.id}: ${line}`,
    ),
    ...findNowViolations(root).map(
      (line) => `${NOW_SINGLE_SOURCE.id}: ${line}`,
    ),
    ...HARDCODED_TEXT_RULES.flatMap((rule) =>
      findHardcodedTextViolations(root, rule).map(
        (line) => `${rule.id}: ${line}`,
      ),
    ),
    ...findProblemResponseViolations(root).map(
      (line) => `${PRESENTATION_WITH_PROBLEM_RESPONSE.id}: ${line}`,
    ),
    ...findClassBasedViolations(root).map(
      (line) => `${CLASS_BASED.id}: ${line}`,
    ),
    ...listAllFiles(root, SHARED_ROOT)
      .filter(SHARED_PLACEMENT.isMisplaced)
      .map((file) => `${SHARED_PLACEMENT.id}: ${file}`),
    ...EXPORTED_PACKAGES.flatMap((pkg) =>
      findPackageExportsViolations(root, pkg, references).map(
        (line) => `${pkg.id}: ${line}`,
      ),
    ),
  ].sort();
}

// --- 規則ごとの判定の仕様 ---
// 上の「依存の向き」のテストは今のコードに違反が無いことしか確かめないため、規則そのものが緩すぎても（常に違反なしと
// 判定しても）通ってしまう。規則ごとに「違反になる例」「ならない例」を架空の参照で固定し、規則の判定が仕様どおりかを確かめる。
// 例は [参照元のファイル, import に書く specifier, 値の参照か型だけの参照か re-export（export ... from。値の参照）か
//   定数だけの値の import（import { TODO_TITLE_MAX_LENGTH } from ... のように、値の名前がすべて UPPER_SNAKE_CASE。Issue #144）か]。

type Example = [
  from: string,
  specifier: string,
  kind: "value" | "type" | "re-export" | "constant",
];

const RULE_EXAMPLES: Record<
  RuleId,
  { violating: Example[]; allowed: Example[] }
> = {
  "frontend-to-backend-specifier": {
    violating: [
      [
        "apps/frontend_customer/app/api/todos/[id]/route.ts",
        "../../../../../backend/features/todo/internal/presentation/get-todo.api",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "../../../../backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "../backend/shared/infra/env",
        "value",
      ],
      // "@/" の後ろの ".." で apps/frontend_customer の外に出る書き方も、backend への参照として数える（toReference の normalize）。
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@/../backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/e2e/support/database.ts",
        "../../backend/shared/infra/env",
        "value",
      ],
      ["apps/e2e/playwright.config.ts", "../backend/shared/infra/env", "value"],
      // 例外（vitest.global-setup.ts → test-support/database）は、そのファイルとその参照先の組だけ。
      //   global-setup からでも env を相対パスで参照するのは違反。別のルート直下のファイルから test-support も違反。
      //   global-setup からでも test-support のほかのファイル・以前の置き場所（shared/drizzle/database.test-support）は違反。
      ["vitest.global-setup.ts", "./apps/backend/shared/infra/env", "value"],
      ["vitest.global-setup.ts", "./apps/backend/test-support/other", "value"],
      [
        "vitest.global-setup.ts",
        "./apps/backend/shared/drizzle/database.test-support",
        "value",
      ],
      ["vitest.config.mts", "./apps/backend/test-support/database", "value"],
      [
        "apps/e2e/support/database.ts",
        "../../backend/test-support/database",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "value",
      ],
      [
        "apps/e2e/x.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      ["vitest.config.mts", "@repo/backend/shared/http/problem", "type"],
      // 例外: テスト基盤の vitest.global-setup.ts だけは、test-support/database を相対パスで参照してよい。
      [
        "vitest.global-setup.ts",
        "./apps/backend/test-support/database",
        "value",
      ],
      // apps/frontend_customer の中の参照（相対パス・"@/"）は backend を指さないので対象外。
      ["apps/frontend_customer/app/page.tsx", "../features/todo", "value"],
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "@/features/todo/api/todo-api",
        "type",
      ],
      // 前方一致だけが同じ別ディレクトリ（apps/backend-x）は backend ではない。
      ["apps/frontend_customer/app/page.tsx", "../../backend-x/y", "value"],
      // backend の中の相対パスは、この規則の対象外（参照元が backend。backend-relative-only が見る）。
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "../../features/todo/internal/infra/schema",
        "value",
      ],
      // apps/shared への相対パスは、この規則の対象外（frontend-to-shared-specifier が見る。Issue #90）。
      ["apps/frontend_customer/proxy.ts", "../shared/logger", "value"],
    ],
  },
  "frontend-to-shared-specifier": {
    violating: [
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "../shared/env",
        "value",
      ],
      // "@/" の後ろの ".." で apps/frontend_customer の外に出る書き方も、apps/shared への参照として数える（toReference の normalize）。
      ["apps/frontend_customer/proxy.ts", "@/../shared/logger", "value"],
      ["apps/frontend_customer/proxy.ts", "../shared/now", "value"],
      ["apps/e2e/support/database.ts", "../../shared/env", "value"],
      ["apps/e2e/playwright.config.ts", "../shared/env.ts", "type"],
      ["vitest.global-setup.ts", "./apps/shared/env", "value"],
      // backend と違い、リポジトリ直下のテスト基盤にも相対パスの例外は無い。
      ["vitest.config.mts", "./apps/shared/logger", "value"],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        "../../../../shared/env",
        "type",
      ],
    ],
    allowed: [
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "@repo/shared/env",
        "value",
      ],
      ["apps/frontend_customer/proxy.ts", "@repo/shared/logger", "value"],
      ["apps/frontend_customer/proxy.ts", "@repo/shared/now", "value"],
      ["apps/e2e/playwright.config.ts", "@repo/shared/env", "value"],
      ["vitest.global-setup.ts", "@repo/shared/env", "value"],
      // 画面側の shared/（apps/frontend_customer/shared/）は apps/shared ではない。前方一致だけが同じ別ディレクトリ（apps/shared-x）も。
      [
        "apps/frontend_customer/proxy.ts",
        "@/shared/request-log/request-log",
        "value",
      ],
      ["apps/frontend_customer/app/page.tsx", "../../shared-x/y", "value"],
      // 前方一致だけが同じ別パッケージ（@repo/shared-extra）はパッケージの参照。
      ["apps/e2e/support/database.ts", "@repo/shared-extra/x", "value"],
      // backend は対象外（backend の中の書き方は backend-relative-only が見る。Issue #90）。
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "../../../shared/env",
        "value",
      ],
    ],
  },
  "backend-to-frontend": {
    violating: [
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@/features/todo",
        "value",
      ],
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "../../../frontend_customer/next.config",
        "value",
      ],
      [
        "apps/backend/shared/http/x.ts",
        "../../../frontend_customer/app/page",
        "type",
      ],
      ["apps/backend/features/todo/internal/domain/x.ts", "@/shared/x", "type"],
    ],
    allowed: [
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "@repo/shared/env",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../domain/todo",
        "value",
      ],
      // 前方一致だけが同じ別ディレクトリ（apps/frontend_customer-x）は frontend ではない。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../../frontend_customer-x/y",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "next/server",
        "value",
      ],
      // frontend から backend への参照は、この規則の対象外（参照元が backend のときだけ）。
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "value",
      ],
    ],
  },
  "backend-relative-only": {
    violating: [
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "@repo/backend/features/todo/internal/domain/todo",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
        "@repo/backend/shared/drizzle/database",
        "type",
      ],
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "@repo/backend/shared/infra/env",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "@repo/backend",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@/features/todo",
        "value",
      ],
      // "@/" で apps/shared を指す書き方も "@/" なので違反（Issue #90）。
      ["apps/backend/shared/drizzle/database.ts", "@/../shared/env", "value"],
      // 相対パスで apps/shared を指すのも違反（exports を経由しない。Issue #90）。
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "../../../shared/env",
        "value",
      ],
      [
        "apps/backend/shared/drizzle/database.ts",
        "../../../shared/logger",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../../shared/env.ts",
        "type",
      ],
    ],
    allowed: [
      ["apps/backend/features/todo/internal/domain/x.ts", "./todo", "value"],
      // apps/shared（別の workspace パッケージ）は "@repo/shared/..." で参照してよい（Issue #90）。
      ["apps/backend/shared/drizzle/database.ts", "@repo/shared/env", "value"],
      ["apps/backend/shared/http/problem.ts", "@repo/shared/logger", "value"],
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "@repo/shared/env",
        "value",
      ],
      // 前方一致だけが同じ別ディレクトリ（apps/shared-x）は apps/shared ではない（backend の外への相対パスの扱いは層の規則が見る）。
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "../../../shared-x/y",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/drizzle/database",
        "type",
      ],
      // 前方一致だけが同じ別パッケージ（@repo/backend-extra）はパッケージの参照。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@repo/backend-extra/x",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "drizzle-orm",
        "value",
      ],
      // frontend の "@/" と "@repo/backend/" は、この規則の対象外（参照元が backend のときだけ）。
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      ["apps/frontend_customer/app/page.tsx", "@/features/todo", "value"],
    ],
  },
  "frontend-root-to-backend": {
    violating: [
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "@repo/backend/shared/drizzle/database",
        "value",
      ],
      [
        "apps/frontend_customer/next.config.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend_customer/instrumentation.ts",
        "../backend/features/todo/internal/infra/todo-repository.postgres",
        "value",
      ],
      [
        "apps/frontend_customer/proxy.ts",
        "@repo/backend/features/todo/internal/infra/todo-repository.postgres",
        "value",
      ],
      // Issue #90 で例外を無くした: 以前許していた env・logger（backend/shared/infra）も、alias でも相対パスでも違反。
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "@repo/backend/shared/infra/env",
        "value",
      ],
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "../backend/shared/infra/env",
        "value",
      ],
      [
        "apps/frontend_customer/proxy.ts",
        "@repo/backend/shared/infra/logger",
        "value",
      ],
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "@repo/backend/shared/infra/logger",
        "type",
      ],
    ],
    allowed: [
      // env・logger は apps/shared から使う（Issue #90）。
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "@repo/shared/env",
        "value",
      ],
      ["apps/frontend_customer/proxy.ts", "@repo/shared/logger", "value"],
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/frontend_customer/instrumentation.ts",
        "./instrumentation-node",
        "value",
      ],
      ["apps/frontend_customer/next.config.ts", "next", "type"],
      // proxy.ts（リクエストログ。Issue #80）が frontend の shared/ を使うのは、backend の参照ではないので対象外。
      [
        "apps/frontend_customer/proxy.ts",
        "@/shared/request-log/request-log",
        "value",
      ],
      ["apps/frontend_customer/proxy.ts", "next/server", "type"],
      // 前方一致だけが同じ別パッケージ（@repo/backend-extra）はパッケージの参照。
      [
        "apps/frontend_customer/next.config.ts",
        "@repo/backend-extra/x",
        "value",
      ],
      // 直下でないファイルは、この規則の対象外（app/・features/ の規則で検査する）。
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "value",
      ],
    ],
  },
  "screen-to-backend": {
    violating: [
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/screens/s/s.hook.ts",
        "../../../../../backend/features/todo/internal/domain/todo",
        "value",
      ],
      [
        "apps/frontend_customer/shared/x.ts",
        "@repo/backend/shared/http/problem",
        "type",
      ],
    ],
    allowed: [
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "@/features/todo/api/todo-api",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      ["apps/frontend_customer/shared/x.ts", "react", "value"],
    ],
  },
  "screen-to-shared": {
    violating: [
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        "@repo/shared/logger",
        "value",
      ],
      // 型だけの参照も違反（apps/shared の型を画面側に持ち込む理由が無い。書き方を 1 つにする）。
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/shared/env",
        "type",
      ],
      ["apps/frontend_customer/app/page.tsx", "@repo/shared/env", "value"],
      // 現在時刻の出口（now）も画面側からは使わない（今は画面が現在時刻を読まない）。
      [
        "apps/frontend_customer/features/todo/components/todo-item.tsx",
        "@repo/shared/now",
        "value",
      ],
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/frontend_customer/shared/request-log/request-log.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/screens/s/s.hook.ts",
        "../../../../../shared/env",
        "value",
      ],
    ],
    allowed: [
      // frontend 直下のサーバ側のファイルは apps/shared を使ってよい（この規則の対象外）。
      [
        "apps/frontend_customer/instrumentation-node.ts",
        "@repo/shared/env",
        "value",
      ],
      ["apps/frontend_customer/proxy.ts", "@repo/shared/logger", "value"],
      ["apps/frontend_customer/proxy.ts", "@repo/shared/now", "value"],
      // 画面側の shared/（apps/frontend_customer/shared/）は apps/shared ではない。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        "@/shared/request-log/request-log",
        "value",
      ],
      // 前方一致だけが同じ別パッケージ（@repo/shared-extra）はパッケージの参照。
      ["apps/frontend_customer/app/page.tsx", "@repo/shared-extra/x", "value"],
      // backend は対象外（層の規則が見る）。
      ["apps/backend/shared/drizzle/database.ts", "@repo/shared/env", "value"],
    ],
  },
  "feature-api-to-backend": {
    violating: [
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "value",
      ],
      // Issue #144: 定数だけの import も値の参照（型だけではない）。定数の緩和は backend の presentation → 自 feature の domain だけ。
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "constant",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/internal/domain/todo",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/other/internal/presentation/list-others.api",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos",
        "type",
      ],
      // Issue #208: internal/ を挟まない旧パスの api ファイルは、自 feature の api ファイルではない。
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/presentation/list-todos.api",
        "type",
      ],
      // Issue #310: backend/shared で参照してよいのは http/（HTTP の境界。旧 presentation）だけ。ほかの単位、層に分けていたときの
      //   旧パス（shared/presentation/）、前方一致だけの別ディレクトリ（http-x）は不可（下位互換を残さない）。
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/shared/error/domain-error",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/shared/presentation/problem",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/shared/http-x/problem",
        "type",
      ],
      //   http/ でも値の参照は不可（型だけ）。
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/shared/http/problem",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "../../../../backend/features/todo/internal/presentation/get-todo.api",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "@repo/backend/shared/http/problem",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/api/todo-api.ts",
        "../../../../backend/shared/http/problem-detail.en",
        "type",
      ],
    ],
  },
  "feature-to-feature": {
    violating: [
      [
        "apps/frontend_customer/features/other/components/x.ts",
        "@/features/todo/components/todo-item",
        "value",
      ],
      [
        "apps/frontend_customer/features/other/components/x.ts",
        "../../todo/api/todo-api",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "@/features/todo-extra/components/y",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend_customer/features/other/components/x.ts",
        "@/features/todo",
        "value",
      ],
      [
        "apps/frontend_customer/features/other/components/x.ts",
        "@/features/todo/index",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx",
        "../../components/todo-item",
        "value",
      ],
    ],
  },
  "screen-to-app": {
    violating: [
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "@/app/page",
        "value",
      ],
      ["apps/frontend_customer/shared/x.ts", "@/app/layout", "type"],
      [
        "apps/frontend_customer/features/todo/screens/s/s.tsx",
        "../../../../app/api/todos/route",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "next/link",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "@/shared/x",
        "value",
      ],
      ["apps/frontend_customer/shared/x.ts", "./y", "value"],
    ],
  },
  "shared-to-features": {
    violating: [
      ["apps/frontend_customer/shared/x.ts", "@/features/todo", "value"],
      [
        "apps/frontend_customer/shared/ui/x.tsx",
        "../../features/todo/components/todo-item",
        "value",
      ],
      [
        "apps/frontend_customer/shared/x.ts",
        "@/features/todo/api/todo-api",
        "type",
      ],
    ],
    allowed: [
      ["apps/frontend_customer/shared/x.ts", "react", "value"],
      ["apps/frontend_customer/shared/ui/x.tsx", "../x", "value"],
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        "@/features/todo/api/todo-api",
        "value",
      ],
    ],
  },
  domain: {
    violating: [
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "next/server",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "react/jsx-runtime",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../application/create-todo.command",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../other/internal/domain/other",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "@/features/todo",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "@/shared/x",
        "value",
      ],
      // apps/shared の env・logger は domain から使わない（Issue #90。SHARED_MODULES_BY_LAYER）。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "@repo/shared/env",
        "type",
      ],
      // 許すのは now だけで、前方一致だけが同じ別のモジュール（now-helper）は不可。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "@repo/shared/now-helper",
        "value",
      ],
      // Issue #98: features/ の下の shared という名前の feature は backend/shared ではなく別の feature（internal/ の中の
      //   相対パス "../../../shared/..." は features/shared/ を指す。backend/shared は "../../../../shared/..."）。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../shared/internal/domain/domain-error",
        "value",
      ],
      // Issue #310: backend/shared で許すのは単位（BACKEND_SHARED_UNITS）の下だけ。層に分けていたときの旧パス
      //   （shared/domain/）、一覧に無い単位（shared/foo/）、単位の外（shared の直下）、前方一致だけの別ディレクトリ（shared-x）は不可。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/domain/domain-error",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/foo/x",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/x",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared-x/error/y",
        "value",
      ],
      // テストだけが使うコード（test-support）は層に属さない。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../test-support/database",
        "value",
      ],
      // Issue #98 より前の置き場所（features/ を挟まない apps/backend/todo/）は層に属さない。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../todo/domain/todo",
        "type",
      ],
      // Issue #208 より前の置き場所（internal/ を挟まない features/<f>/<層>/）も層に属さない（自 feature の domain と取り違えない）。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../domain/todo",
        "type",
      ],
    ],
    allowed: [
      ["apps/backend/features/todo/internal/domain/x.ts", "./todo", "value"],
      ["apps/backend/features/todo/internal/domain/x.ts", "./todo", "type"],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/error/domain-error",
        "value",
      ],
      // shared という名前の feature も、backend/shared を使ってよい（自 feature と backend/shared の区別は名前ではなく場所）。
      [
        "apps/backend/features/shared/internal/domain/x.ts",
        "../../../../shared/error/domain-error",
        "value",
      ],
      // Issue #310（ユーザー判断）: feature のどの層も backend/shared のどの単位も使ってよい。Issue #230 では
      //   shared の application（transaction）を型だけに限り、drizzle（旧 infra）・http（旧 presentation）は不可だった。
      [
        "apps/backend/features/todo/internal/domain/todo-repository.ts",
        "../../../../shared/transaction/transaction",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/transaction/transaction",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/transaction/transaction",
        "re-export",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/drizzle/database",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/http/problem",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/change-log/change-operation",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "node:crypto",
        "value",
      ],
      // 現在時刻の出口（now）は domain からも使う（Entity の生成ルールの作成日時）。
      [
        "apps/backend/features/todo/internal/domain/todo.ts",
        "@repo/shared/now",
        "value",
      ],
      // next / react / DB 以外のパッケージは使ってよい（Todo の不変条件を zod のスキーマで宣言する。Issue #88）。
      ["apps/backend/features/todo/internal/domain/x.ts", "zod", "value"],
    ],
  },
  "core-to-persistence": {
    violating: [
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "drizzle-orm",
        "type",
      ],
      ["apps/backend/features/todo/internal/domain/x.ts", "pg", "value"],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "drizzle-orm/pg-core",
        "value",
      ],
      ["apps/backend/features/todo/internal/application/x.ts", "pg", "type"],
      [
        "apps/backend/features/shared/internal/domain/x.ts",
        "drizzle-orm/node-postgres",
        "type",
      ],
    ],
    allowed: [
      // infra / presentation は対象外（infra は永続化の実装を持つ層）。
      [
        "apps/backend/features/todo/internal/infra/schema.ts",
        "drizzle-orm/pg-core",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "drizzle-orm",
        "type",
      ],
      // Issue #310: backend/shared は層を持たないので対象外（どの単位も）。feature の domain・application が shared を経由して
      //   DB を使うことは縛らない（パッケージの直接の参照だけを見る。ユーザー判断）。
      ["apps/backend/shared/drizzle/database.ts", "pg", "value"],
      ["apps/backend/shared/transaction/transaction.ts", "drizzle-orm", "type"],
      ["apps/backend/shared/error/x.ts", "drizzle-orm/pg-core", "value"],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/drizzle/database",
        "value",
      ],
      // 名前の前方一致だけが同じ別のパッケージは対象外（パッケージ名で比べる）。
      ["apps/backend/features/todo/internal/domain/x.ts", "pg-format", "value"],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "drizzle-orm-extra",
        "value",
      ],
      // 自前コードのパスに pg / drizzle-orm を含んでも、パッケージではない。
      ["apps/backend/features/todo/internal/domain/x.ts", "./pg", "value"],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "node:crypto",
        "value",
      ],
    ],
  },
  application: {
    violating: [
      // Issue #208: 他のモジュールの expose（層に属さない）。application にはインスタンスをコンストラクタで渡す
      //   （module-expose-only-from-presentation と重ねて検出する）。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../notification/expose/notifier",
        "value",
      ],
      // Issue #98: "../../../shared/..." は features/shared/（別の feature）を指す（domain の例と同じ。backend/shared は
      //   "../../../../shared/..."）。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../shared/internal/application/x",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../infra/todo-repository.postgres",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../presentation/list-todos.api",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "react",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "@/features/todo",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../other/internal/domain/other",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../other/internal/application/other.query",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../../../frontend_customer/shared/x",
        "value",
      ],
      // Issue #310: 層に分けていたときの旧パス（shared/application/）と一覧に無い単位は不可（下位互換を残さない）。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../../shared/application/transaction",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../../shared/infra/database",
        "value",
      ],
      // apps/shared の env・logger は application から使わない（Issue #90。SHARED_MODULES_BY_LAYER）。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "@repo/shared/env",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "@repo/shared/logger",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../domain/todo-repository",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../domain/todo",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "./other.command",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "node:crypto",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../../shared/error/domain-error",
        "value",
      ],
      // トランザクションを張る口（TransactionRunner）と印の型（Transaction）。Issue #220・#230。
      [
        "apps/backend/features/todo/internal/application/x.command.ts",
        "../../../../shared/transaction/transaction",
        "type",
      ],
      // Issue #310（ユーザー判断）: backend/shared のどの単位も使ってよい（Issue #215 では runner の実体 transaction.postgres は不可だった）。
      [
        "apps/backend/features/todo/internal/application/x.command.ts",
        "../../../../shared/drizzle/transaction.postgres",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../../shared/http/problem",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../../shared/change-log/change-log",
        "value",
      ],
      // 現在時刻の出口（now）はすべての層で使ってよい。
      [
        "apps/backend/features/todo/internal/application/x.command.ts",
        "@repo/shared/now",
        "value",
      ],
    ],
  },
  presentation: {
    violating: [
      // Issue #208: 自モジュールの expose は presentation からでも不可（expose は自モジュールの internal を使うので循環する）。
      //   expose の前方一致だけの別ディレクトリも層に属さない。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../expose/x",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../notification/expose-x/notifier",
        "value",
      ],
      // reviewer の指摘（Issue #98）: feature の名前が shared でも、自 feature の domain は型だけ（backend/shared と名前で
      //   取り違えない）。
      [
        "apps/backend/features/shared/internal/presentation/x.api.ts",
        "../domain/x",
        "value",
      ],
      // Issue #98: "../../../shared/..." は features/shared/（別の feature）を指す（backend/shared は "../../../../shared/..."）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../shared/internal/presentation/problem",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/todo-repository.in-memory",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/todo-repository.postgres-helper",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "next/server",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../domain/todo",
        "value",
      ],
      // Issue #144: 定数だけの値の import を許すのは、自 feature の domain からだけ。他 feature の domain、domain 以外の層
      //   （infra の schema）からは不可。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../other/internal/domain/other",
        "constant",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/schema",
        "constant",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../other/internal/infra/other-repository.postgres",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../other/internal/application/other.query",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../other/internal/domain/other",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "@/shared/x",
        "value",
      ],
      // Issue #310: 層に分けていたときの旧パス（shared/presentation/・shared/infra/）は単位ではないので不可（下位互換を残さない）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/presentation/problem",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/infra/todo-repository.postgres",
        "value",
      ],
      //   自 feature の infra でも、InMemory の実装（上の todo-repository.in-memory）・schema・前方一致だけが同じ別ファイル・
      //   テストファイル・深い階層・Repository の実装の形でない名前は不可。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/schema",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/schema",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/todo-repository.postgres.test",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/nested/todo-repository.postgres",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/repository.postgres",
        "value",
      ],
      //   テスト基盤（test-support。層に属さない。InMemory の runner も）は不可。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../test-support/transaction-runner.in-memory",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../test-support/database",
        "value",
      ],
      // 自 feature の infra は Repository の実装だけ。自 feature の infra の logger は不可（Issue #85・#90）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/logger",
        "value",
      ],
      // apps/shared で使ってよいのは logger と now だけ。env、前方一致だけが同じ別ファイル、パッケージ名だけ（apps/shared）は不可（Issue #90）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "@repo/shared/env",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "@repo/shared/logger-helper",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "@repo/shared",
        "value",
      ],
    ],
    allowed: [
      // リクエストの形を zod のスキーマで検査する（Issue #88）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "zod",
        "value",
      ],
      // Issue #123: api ファイルがモジュールの最下部で本番の handler を組み立てる（Postgres の Repository の実装とプール）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/todo-repository.postgres",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../infra/todo-repository.postgres",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/drizzle/database",
        "value",
      ],
      // Issue #215: command に渡すトランザクションの runner（PostgresTransactionRunner）の組み立て。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/drizzle/transaction.postgres",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/transaction/transaction",
        "type",
      ],
      // Issue #310（ユーザー判断）: backend/shared のどの単位のどのファイルも使ってよい（Issue #123・#215 では shared の infra を
      //   database と transaction.postgres だけに絞り、writer や前方一致だけの別ファイルは不可だった）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/drizzle/writer",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/drizzle/database-helper",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/change-log/change-log",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/error/domain-error",
        "value",
      ],
      //   feature の名前が shared でも、自 feature の infra の Repository の実装は可。
      [
        "apps/backend/features/shared/internal/presentation/x.api.ts",
        "../infra/shared-repository.postgres",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../application/list-todos.query",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../application/list-todos.query",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "./get-todo.api",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../shared/http/problem",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../domain/todo",
        "type",
      ],
      // Issue #144: 自 feature の domain の定数（UPPER_SNAKE_CASE の名前だけ）は値で import できる（リクエストのスキーマが
      //   domain と同じ上限 TODO_TITLE_MAX_LENGTH を参照する）。feature の名前が shared でも同じ。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../domain/todo",
        "constant",
      ],
      [
        "apps/backend/features/shared/internal/presentation/x.api.ts",
        "../domain/x",
        "constant",
      ],
      // ログの唯一の出口（Issue #85。Issue #90 で apps/shared に移した）。相対パスで書いても参照先は同じ（書き方は
      //   backend-relative-only が見る）。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "@repo/shared/now",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../../../shared/logger",
        "value",
      ],
      // Issue #208: 組み立ての場所として、他のモジュールの公開の入口（expose）を値でも型でも使える。
      [
        "apps/backend/features/todo/internal/presentation/change-todo-completion.api.ts",
        "../../../notification/expose/notifier",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/nested/x.api.ts",
        "../../../../notification/expose/notifier",
        "type",
      ],
    ],
  },
  infra: {
    violating: [
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../presentation/list-todos.api",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../other/internal/domain/other",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@/features/todo",
        "value",
      ],
      ["apps/backend/features/todo/internal/infra/x.ts", "@/shared/x", "value"],
      ["apps/backend/features/todo/internal/infra/x.ts", "@/app/page", "value"],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "next/server",
        "value",
      ],
      // apps/shared で使ってよいのは env・logger・now だけ。前方一致だけが同じ別ファイル、パッケージ名だけは不可（Issue #90）。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@repo/shared/env-helper",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@repo/shared",
        "value",
      ],
      // Issue #220: 自 feature の application（command）は不可（型だけでも）。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../application/create-todo.command",
        "type",
      ],
      // Issue #310: 層に分けていたときの旧パス（shared/application/・shared/infra/）は単位ではないので不可（下位互換を残さない）。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/application/transaction",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/infra/database",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../domain/todo",
        "value",
      ],
      // Issue #220: infra が実装する port（TransactionRunner）。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/transaction/transaction",
        "type",
      ],
      // Issue #310（ユーザー判断）: backend/shared のどの単位も、値でも re-export でも使ってよい（Issue #224 では port を型だけに
      //   限っていた）。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/transaction/transaction",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/transaction/transaction",
        "re-export",
      ],
      [
        "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
        "../../../../shared/drizzle/writer",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/http/problem",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/change-log/change-log.schema",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../shared/error/domain-error",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
        "./schema",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "node:crypto",
        "value",
      ],
      // 環境変数の入口とログの出口（Issue #90 で apps/shared に移した）。
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@repo/shared/env",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "@repo/shared/now",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../../../shared/env",
        "type",
      ],
    ],
  },
  "backend-shared": {
    violating: [
      // reviewer の指摘（Issue #98）: features/shared（shared という名前の feature）は backend/shared ではない。
      //   drizzle-kit の設定 shared/drizzle/drizzle.config.ts も、この規則で features/ への参照を止める（schema は glob の文字列で指す）。
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        "../../features/shared/internal/infra/schema",
        "value",
      ],
      [
        "apps/backend/shared/error/x.ts",
        "../../features/shared/internal/domain/x",
        "type",
      ],
      [
        "apps/backend/shared/http/x.ts",
        "../../features/todo/internal/domain/todo",
        "type",
      ],
      // Issue #144 の定数だけの import でも、backend/shared から feature は不可。
      [
        "apps/backend/shared/http/x.ts",
        "../../features/todo/internal/domain/todo",
        "constant",
      ],
      [
        "apps/backend/shared/drizzle/x.ts",
        "../../features/todo/internal/infra/todo-repository.postgres",
        "value",
      ],
      // Issue #208: feature の公開の入口（expose）も feature なので不可。
      [
        "apps/backend/shared/change-log/x.ts",
        "../../features/notification/expose/notifier",
        "value",
      ],
      // テストだけが使うコード（test-support）も backend/shared の外。
      [
        "apps/backend/shared/drizzle/x.ts",
        "../../test-support/database",
        "value",
      ],
      ["apps/backend/shared/http/x.ts", "@/features/todo", "value"],
      ["apps/backend/shared/x.ts", "@/app/page", "value"],
      ["apps/backend/shared/foo/x.ts", "@/shared/x", "value"],
      ["apps/backend/shared/http/x.ts", "next/server", "value"],
      ["apps/backend/shared/error/x.ts", "react", "type"],
      // 前方一致だけが同じ別ディレクトリ（apps/shared-x・apps/backend/shared-x）は apps/shared・backend/shared ではない（Issue #90）。
      ["apps/backend/shared/drizzle/x.ts", "../../../shared-x/y", "value"],
      ["apps/backend/shared/drizzle/x.ts", "../../shared-x/y", "value"],
    ],
    allowed: [
      // Issue #310: backend/shared の中は単位をまたいでどこでも参照してよい（層に分けていたときの向きの縛りは無くした）。
      ["apps/backend/shared/http/problem.ts", "../error/domain-error", "value"],
      ["apps/backend/shared/http/json-body.ts", "./problem", "value"],
      [
        "apps/backend/shared/drizzle/transaction.postgres.ts",
        "../transaction/transaction",
        "value",
      ],
      ["apps/backend/shared/error/x.ts", "../http/problem", "value"],
      [
        "apps/backend/shared/change-log/change-log.ts",
        "../drizzle/database",
        "type",
      ],
      ["apps/backend/shared/error/x.ts", "node:crypto", "value"],
      ["apps/backend/shared/http/x.ts", "some-package/sub", "value"],
      // DB のパッケージも単位を問わず使える（core-to-persistence は feature の domain・application だけ）。
      ["apps/backend/shared/transaction/x.ts", "drizzle-orm", "type"],
      // apps/shared（frontend と backend で共通の基盤。Issue #90）。単位ごとの縛りは無い（Issue #310）。
      ["apps/backend/shared/drizzle/database.ts", "@repo/shared/env", "value"],
      ["apps/backend/shared/http/problem.ts", "@repo/shared/logger", "value"],
      ["apps/backend/shared/error/x.ts", "@repo/shared/env", "value"],
    ],
  },
  app: {
    violating: [
      [
        "apps/frontend_customer/app/page.tsx",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "value",
      ],
      [
        "apps/frontend_customer/app/page.tsx",
        "@/features/todo/components/todo-item",
        "value",
      ],
      [
        "apps/frontend_customer/app/todo/[id]/page.tsx",
        "../../../features/todo/api/todo-api",
        "type",
      ],
    ],
    allowed: [
      ["apps/frontend_customer/app/page.tsx", "@/features/todo", "value"],
      [
        "apps/frontend_customer/app/todo/[id]/page.tsx",
        "../../../features/todo/index",
        "value",
      ],
      ["apps/frontend_customer/app/page.tsx", "@/shared/x", "value"],
      ["apps/frontend_customer/app/layout.tsx", "./globals.css", "value"],
      ["apps/frontend_customer/app/page.tsx", "react", "value"],
    ],
  },
  "shared-self-contained": {
    violating: [
      // apps/shared の外の自前コード（相対パス・"@repo/backend/"・"@/"・前方一致だけが同じ別ディレクトリ）。
      [
        "apps/shared/logger.ts",
        "../backend/features/todo/internal/infra/todo-repository.postgres",
        "value",
      ],
      [
        "apps/shared/logger.ts",
        "@repo/backend/features/todo/internal/infra/todo-repository.postgres",
        "value",
      ],
      ["apps/shared/env.ts", "@/features/todo", "type"],
      ["apps/shared/logger.ts", "../shared-x/y", "value"],
      // フレームワークと DB のパッケージ（サブパス・型だけも含む）。
      ["apps/shared/logger.ts", "react", "value"],
      ["apps/shared/env.ts", "next/server", "type"],
      ["apps/shared/env.ts", "drizzle-orm/pg-core", "type"],
      ["apps/shared/env.ts", "pg", "value"],
      // node: と zod 以外のパッケージ（"node:" の付かない組み込みの名前も不可）。zod もサブパスと、前方一致だけが同じ別の
      //   パッケージは不可（Issue #216）。
      ["apps/shared/env.ts", "fs", "value"],
      ["apps/shared/log-event.ts", "zod/v4", "value"],
      ["apps/shared/log-event.ts", "zod/mini", "type"],
      ["apps/shared/log-event.ts", "zodiac", "value"],
      ["apps/shared/log-event.ts", "zod-validation-error", "value"],
      ["apps/shared/log-event.ts", "@zod/core", "value"],
    ],
    allowed: [
      // 同じディレクトリのファイル（相対パス・自パッケージ名）と Node の組み込み（node:）。
      ["apps/shared/logger.ts", "./env", "type"],
      ["apps/shared/logger.ts", "@repo/shared/env", "value"],
      ["apps/shared/env.ts", "node:fs", "value"],
      ["apps/shared/env.ts", "node:crypto", "value"],
      // 名前で許したパッケージ（zod。Issue #216）。値・型だけのどちらも。
      ["apps/shared/log-event.ts", "zod", "value"],
      ["apps/shared/logger.ts", "zod", "type"],
      // apps/shared の外のファイルは、この規則の対象外。
      ["apps/backend/shared/drizzle/database.ts", "pg", "value"],
      ["apps/frontend_customer/app/page.tsx", "react", "value"],
      ["apps/shared-x/y.ts", "react", "value"],
    ],
  },
  "messages-colocation": {
    violating: [
      // 別のディレクトリ（隣の画面・components/・親・子）の *.messages を、相対パス・"@/"・拡張子つきで参照する。
      [
        "apps/frontend_customer/features/todo/screens/todo-detail-screen/todo-detail-screen.tsx",
        "../todo-screen/todo-screen.messages",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx",
        "@/features/todo/components/todo-item.messages",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item.tsx",
        "../screens/todo-screen/todo-screen.messages",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/index.ts",
        "./screens/todo-screen/todo-screen.messages",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/parts/header.tsx",
        "../todo-screen.messages",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx",
        "./parts/header.messages",
        "value",
      ],
      [
        "apps/frontend_customer/features/other/screens/x-screen/x-screen.tsx",
        "@/features/todo/screens/todo-screen/todo-screen.messages.ts",
        "value",
      ],
      // 共通の辞書と同じ名前でも、shared/i18n/ の外のものは例外にならない。
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx",
        "@/features/todo/common.messages",
        "value",
      ],
      // 共通の辞書でも、apps/frontend_customer の外（E2E）からは参照しない。
      [
        "apps/e2e/i18n.spec.ts",
        "../frontend_customer/shared/i18n/common.messages",
        "value",
      ],
      // re-export（export ... from）は、同じディレクトリでも、共通の辞書でも違反（Issue #125 の reviewer 指摘。中継のファイル
      //   を別のディレクトリから import すると、辞書を別のディレクトリから使えてしまう）。
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/zz-barrel.ts",
        "./todo-screen.messages",
        "re-export",
      ],
      [
        "apps/frontend_customer/features/todo/components/index.ts",
        "@/features/todo/components/todo-item.messages",
        "re-export",
      ],
      [
        "apps/frontend_customer/shared/i18n/index.ts",
        "./common.messages",
        "re-export",
      ],
      [
        "apps/frontend_customer/features/todo/api/api-error.ts",
        "@/shared/i18n/common.messages",
        "re-export",
      ],
    ],
    allowed: [
      // 同じディレクトリ（"./"・"@/"・拡張子つき・型だけ）。
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx",
        "./todo-screen.messages",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.hook.ts",
        "@/features/todo/screens/todo-screen/todo-screen.messages",
        "type",
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item.tsx",
        "./todo-item.messages.ts",
        "value",
      ],
      // 共通の辞書は apps/frontend_customer のどこからでも（"@/"・相対パス）。
      [
        "apps/frontend_customer/features/todo/api/api-error.ts",
        "@/shared/i18n/common.messages",
        "value",
      ],
      [
        "apps/frontend_customer/app/page.tsx",
        "../shared/i18n/common.messages",
        "value",
      ],
      // *.messages ではないもの（前方一致・名前の一部だけが同じ、パッケージ）。
      [
        "apps/frontend_customer/features/todo/components/todo-item.tsx",
        "../screens/todo-screen/todo-screen.messages-helper",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item.tsx",
        "@/shared/i18n/messages",
        "value",
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item.tsx",
        "some-lib/app.messages",
        "value",
      ],
      // *.messages ではないものの re-export（re-export を一律に止めるのではない）。
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/zz-barrel.ts",
        "./todo-screen.hook",
        "re-export",
      ],
      [
        "apps/frontend_customer/features/todo/index.ts",
        "./screens/todo-screen/todo-screen",
        "re-export",
      ],
    ],
  },
  // Issue #208: モジュール（backend の feature）の境界。
  "module-internal": {
    violating: [
      // 値・型・re-export のどれでも、どの層からでも、expose からでも。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../notification/internal/application/send-notification.command",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../notification/internal/domain/notification-sender",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../notification/internal/infra/notification-sender.log",
        "re-export",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../../todo/internal/domain/todo",
        "type",
      ],
      // internal/ そのもの（ディレクトリの index）も中身。
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../../todo/internal",
        "value",
      ],
      // モジュールは名前が完全に一致するものだけが自分（todo と todo-extra は別）。features/shared/ も 1 つのモジュール。
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../todo-extra/internal/domain/y",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../shared/internal/domain/x",
        "value",
      ],
    ],
    allowed: [
      // 自モジュールの internal（expose からも）。
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../internal/application/send-notification.command",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../application/x",
        "value",
      ],
      // 他のモジュールの expose は、この規則ではなく module-expose-only-from-presentation が見る。
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        "../../../notification/expose/notifier",
        "value",
      ],
      // 前方一致だけが同じ別ディレクトリ（internal-x）は internal ではない（置き場所・層の規則が見る）。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../notification/internal-x/y",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../../shared/error/domain-error",
        "value",
      ],
      // 参照元が apps/backend/features/ の外なら対象外（test-support は InMemory の実装のために internal を使う。backend/shared は
      //   backend-shared、frontend の app/api は exports と app-api が見る）。
      [
        "apps/backend/test-support/todo/x.ts",
        "../../features/todo/internal/domain/todo",
        "value",
      ],
      [
        "apps/backend/shared/drizzle/x.ts",
        "../../features/todo/internal/infra/schema",
        "value",
      ],
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "value",
      ],
    ],
  },
  "module-expose-only-from-presentation": {
    violating: [
      // presentation 以外の層から他のモジュールの expose（値・型・re-export）。
      [
        "apps/backend/features/todo/internal/application/x.command.ts",
        "../../../notification/expose/notifier",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/domain/x.ts",
        "../../../notification/expose/notifier",
        "type",
      ],
      [
        "apps/backend/features/todo/internal/infra/x.ts",
        "../../../notification/expose/notifier",
        "re-export",
      ],
      // expose から他のモジュールの expose（expose-imports と重ねて検出する）。
      [
        "apps/backend/features/notification/expose/x.ts",
        "../../todo/expose/y",
        "value",
      ],
      // expose/ そのもの（ディレクトリの index）も expose。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../notification/expose",
        "value",
      ],
      // presentation の前方一致だけが同じ別ディレクトリ（presentationx）は presentation ではない。
      [
        "apps/backend/features/todo/internal/presentationx/x.ts",
        "../../../notification/expose/notifier",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/backend/features/todo/internal/presentation/change-todo-completion.api.ts",
        "../../../notification/expose/notifier",
        "value",
      ],
      [
        "apps/backend/features/todo/internal/presentation/nested/x.api.ts",
        "../../../../notification/expose/notifier",
        "type",
      ],
      // 自モジュールの expose の中の参照。
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "./message",
        "type",
      ],
      // 自モジュールの expose を internal から使うのは、この規則ではなく層の規則が止める（参照先が層に属さない）。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../expose/x",
        "value",
      ],
      // expose の前方一致だけが同じ別ディレクトリ（exposed）は expose ではない（層の規則が止める）。
      [
        "apps/backend/features/todo/internal/application/x.ts",
        "../../../notification/exposed/x",
        "value",
      ],
      // 参照元が apps/backend/features/ の外なら対象外（backend/shared は backend-shared が止める）。
      [
        "apps/backend/shared/http/x.ts",
        "../../features/notification/expose/notifier",
        "value",
      ],
    ],
  },
  "expose-imports": {
    violating: [
      // 他のモジュールの expose と internal。
      [
        "apps/backend/features/notification/expose/x.ts",
        "../../todo/expose/y",
        "value",
      ],
      [
        "apps/backend/features/notification/expose/x.ts",
        "../../todo/internal/domain/todo",
        "type",
      ],
      // テストだけが使うコード（test-support）と、backend/shared の前方一致だけの別ディレクトリ（shared-x）。
      [
        "apps/backend/features/notification/expose/x.ts",
        "../../../test-support/database",
        "value",
      ],
      [
        "apps/backend/features/notification/expose/x.ts",
        "../../../shared-x/infra/y",
        "value",
      ],
      // フレームワークと画面側。
      [
        "apps/backend/features/notification/expose/x.ts",
        "next/server",
        "value",
      ],
      ["apps/backend/features/notification/expose/x.ts", "react", "type"],
      [
        "apps/backend/features/notification/expose/x.ts",
        "@/features/todo",
        "value",
      ],
      // 自モジュールでも internal/・expose/ の外（前方一致だけの internal-x も）。
      [
        "apps/backend/features/notification/expose/x.ts",
        "../lib/y",
        "re-export",
      ],
      [
        "apps/backend/features/notification/expose/x.ts",
        "../internal-x/application/y",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../internal/application/send-notification.command",
        "value",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../internal/infra/notification-sender.log",
        "value",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../internal/domain/notification-sender",
        "type",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "@repo/shared/now",
        "value",
      ],
      // 組み立ての場所として、backend/shared（database など。どの層も）と apps/shared の env も使える。
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../../../shared/drizzle/database",
        "value",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "../../../shared/error/domain-error",
        "type",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "@repo/shared/env",
        "value",
      ],
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "./message",
        "re-export",
      ],
      // フレームワーク以外のパッケージ（層の規則と同じ）。
      [
        "apps/backend/features/notification/expose/notifier.ts",
        "node:crypto",
        "value",
      ],
      // 参照元が expose/ の外なら対象外（層の規則が見る）。
      [
        "apps/backend/features/notification/internal/infra/x.ts",
        "@repo/shared/env",
        "value",
      ],
      [
        "apps/backend/features/notification/expose-x/x.ts",
        "next/server",
        "value",
      ],
    ],
  },
  "app-api": {
    violating: [
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/infra/todo-repository.postgres",
        "value",
      ],
      ["apps/frontend_customer/app/api/todos/route.ts", "next/server", "value"],
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos",
        "value",
      ],
      // Issue #208: internal/ を挟まない旧パスの api ファイルは参照先にしない。
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/presentation/list-todos.api",
        "value",
      ],
      // Issue #310: backend/shared の api ファイルは http/ の直下だけ。層に分けていたときの旧パス（shared/presentation/）、
      //   http/ の下の深い階層、api ファイルでない http/ のモジュールは不可。
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/shared/presentation/health.api",
        "value",
      ],
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/shared/http/nested/health.api",
        "value",
      ],
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/shared/http/problem",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/presentation/list-todos.api",
        "value",
      ],
      [
        "apps/frontend_customer/app/api/todos/[id]/route.ts",
        "../../../../../backend/features/todo/internal/presentation/get-todo.api",
        "value",
      ],
      [
        "apps/frontend_customer/app/api/todos/route.ts",
        "@repo/backend/features/todo/internal/presentation/create-todo.api",
        "type",
      ],
      [
        "apps/frontend_customer/app/api/health/route.ts",
        "@repo/backend/shared/http/health.api",
        "value",
      ],
    ],
  },
};

function judge(id: RuleId, [from, specifier, kind]: Example): boolean {
  const rule = RULES.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`規則 ${id} が RULES にない`);
  }
  const ref = toReference(from, {
    specifier,
    typeOnly: kind === "type",
    reExport: kind === "re-export",
    constantsOnly: kind === "constant",
  });
  return rule.appliesTo(ref.from) && rule.isViolation(ref);
}

// 置き場所の規則（BACKEND_PLACEMENT / FRONTEND_PLACEMENT）の判定例。参照ではなくファイルの置き場所で決まるので別に持つ。
const PLACEMENT_EXAMPLES: { misplaced: string[]; placed: string[] } = {
  misplaced: [
    "apps/backend/.lib/x.ts",
    "apps/backend/features/todo/p-root.ts",
    "apps/backend/features/todo/lib/x.ts",
    "apps/backend/shared/bad-root.ts",
    "apps/backend/x.ts",
    "apps/backend/features/todo/domainx/x.ts",
    // Issue #208: feature の 4 層は internal/ の下だけ。internal/ を挟まない層（Issue #208 より前の置き場所）、internal/ の直下、
    //   internal/ の下の層でないディレクトリ、前方一致だけが同じ別ディレクトリ（internal-x・domainx）は違反。
    "apps/backend/features/todo/domain/todo.ts",
    "apps/backend/features/todo/presentation/list-todos.api.ts",
    "apps/backend/features/todo/infra/schema.ts",
    "apps/backend/features/todo/internal/x.ts",
    "apps/backend/features/todo/internal/lib/x.ts",
    "apps/backend/features/todo/internal-x/domain/x.ts",
    "apps/backend/features/todo/internal/domainx/x.ts",
    // Issue #208: expose/ は features/<f>/ の直下だけで、置けるのは expose/ の直下のファイルだけ。expose/ の下のディレクトリ、
    //   前方一致だけが同じ別ディレクトリ（expose-x）、internal/ の下や backend/shared/ の下の expose/ は違反。
    "apps/backend/features/notification/expose/nested/x.ts",
    "apps/backend/features/notification/expose-x/x.ts",
    "apps/backend/features/notification/internal/expose/x.ts",
    "apps/backend/shared/expose/x.ts",
    "apps/backend/features/expose/x.ts",
    // Issue #98: 直下に置けるのは features/ と shared/ だけ。features/ 直下のファイルと、features/ を挟まない feature
    //   （Issue #98 より前の置き場所 apps/backend/todo/）は違反。
    "apps/backend/features/x.ts",
    "apps/backend/todo/domain/todo.ts",
    // 前方一致だけが同じ別ディレクトリ（features-x・shared-x）は features/・shared/ ではない。
    "apps/backend/features-x/todo/domain/x.ts",
    "apps/backend/shared-x/error/x.ts",
    // Issue #98: 直下の設定ファイルの例外は無くした（drizzle-kit の設定は shared/drizzle/ に置く）。
    "apps/backend/drizzle.config.ts",
    // Issue #310: backend/shared/ に置けるのは単位（BACKEND_SHARED_UNITS: error・transaction・http・drizzle・change-log）の下だけ。
    //   層に分けていたときの旧ディレクトリ（domain・application・presentation・infra）、一覧に無い単位、前方一致だけが同じ
    //   別ディレクトリ（http-x・errors）、単位と同じ名前のファイル（shared/drizzle.ts）は違反。
    "apps/backend/shared/domain/domain-error.ts",
    "apps/backend/shared/application/transaction.ts",
    "apps/backend/shared/presentation/problem.ts",
    "apps/backend/shared/infra/database.ts",
    "apps/backend/shared/foo/x.ts",
    "apps/backend/shared/http-x/x.ts",
    "apps/backend/shared/errors/x.ts",
    "apps/backend/shared/drizzle.ts",
    // reviewer の指摘（Issue #98）: features/shared/（shared という名前の feature）は backend/shared ではない（単位の名前の
    //   ディレクトリを置いても internal/ の外なので違反）。
    "apps/backend/features/shared/drizzle/drizzle.config.ts",
    "apps/backend/features/shared/error/x.ts",
    "apps/backend/features/shared/x.ts",
    // Issue #181: test-support/ は apps/backend の直下だけ。feature・shared の下（層の外）、前方一致・後方一致だけが同じ別ディレクトリ、
    //   同じ名前のファイルは違反。
    "apps/backend/features/todo/test-support/x.ts",
    "apps/backend/shared/test-support/x.ts",
    "apps/backend/test-support-x/x.ts",
    "apps/backend/my-test-support/x.ts",
    "apps/backend/test-support.ts",
    // Issue #219: API 仕様の補助は apps/backend/spec/api/<feature>/ の直下の support.ts だけ。spec/api/ の直下・ほかの名前・
    //   入れ子・前方一致だけが同じ別ディレクトリ・feature の下の spec/api/ は違反。
    "apps/backend/spec/api/x.ts",
    "apps/backend/spec/api/support.ts",
    "apps/backend/spec/api/todo/helper.ts",
    "apps/backend/spec/api/todo/support.mts",
    "apps/backend/spec/api/todo/nested/support.ts",
    "apps/backend/spec/api-x/todo/support.ts",
    "apps/backend/features/todo/spec/api/todo/support.ts",
  ],
  placed: [
    "apps/backend/features/todo/internal/domain/todo.ts",
    "apps/backend/shared/http/problem.ts",
    "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
    "apps/backend/features/todo/internal/presentation/nested/x.api.ts",
    // Issue #208: 他のモジュールへ公開する入口（features/<f>/expose/ の直下のファイル。8 つの拡張子のどれでも）。
    "apps/backend/features/notification/expose/notifier.ts",
    "apps/backend/features/todo/expose/x.mts",
    // feature の名前が shared でも、features/ の下なら feature（backend/shared ではない）。
    "apps/backend/features/shared/internal/domain/x.ts",
    // Issue #310: backend/shared の単位の下（入れ子も、8 つの拡張子のどれでも）。drizzle-kit の設定（drizzle.config.ts）も
    //   drizzle/ の中の普通のソースとして置ける（Issue #98 からの例外は不要になった）。
    "apps/backend/shared/error/domain-error.ts",
    "apps/backend/shared/transaction/transaction.ts",
    "apps/backend/shared/http/nested/x.mts",
    "apps/backend/shared/drizzle/database.ts",
    "apps/backend/shared/drizzle/drizzle.config.ts",
    "apps/backend/shared/drizzle/drizzle.config.mts",
    "apps/backend/shared/drizzle/migrations/meta/x.ts",
    "apps/backend/shared/change-log/change-log.schema.ts",
    // Issue #181: テストだけが使うコードの置き場所（直下の test-support/。入れ子も可）。
    "apps/backend/test-support/database.ts",
    "apps/backend/test-support/nested/x.mts",
    // Issue #219: API 仕様の step が共有する補助（apps/backend/spec/api/<feature>/support.ts）。
    "apps/backend/spec/api/todo/support.ts",
    "apps/frontend_customer/features/todo/lib/x.ts",
    // backend の規則の対象外（apps/e2e は E2E の workspace パッケージ @repo/e2e。Issue #84）。
    "apps/e2e/support/database.ts",
    "apps/e2e/playwright.config.ts",
    "apps/e2e/todo.spec.ts",
    // apps/shared（@repo/shared。Issue #90）も backend の規則の対象外（SHARED_PLACEMENT が見る）。
    "apps/shared/env.ts",
    "apps/shared/extra.ts",
  ],
};

const FRONTEND_PLACEMENT_EXAMPLES: { misplaced: string[]; placed: string[] } = {
  misplaced: [
    "apps/frontend_customer/lib/db.ts",
    "apps/frontend_customer/.lib/x.ts",
    "apps/frontend_customer/x.ts",
    "apps/frontend_customer/next.config.mjs",
    // 前方一致だけが同じ別ディレクトリ・別ファイル。
    "apps/frontend_customer/app-x/page.tsx",
    "apps/frontend_customer/featuresx/todo/x.ts",
    "apps/frontend_customer/instrumentation-node.helper.ts",
    "apps/frontend_customer/proxy.helper.ts",
    // proxy.ts の旧名（Next 16 で非推奨）と、proxy の別の拡張子（許すのは proxy.ts だけ）。
    "apps/frontend_customer/middleware.ts",
    "apps/frontend_customer/proxy.js",
    // 許可された名前でも、直下でなければ例外にしない。
    "apps/frontend_customer/lib/next.config.ts",
    "apps/frontend_customer/lib/proxy.ts",
    // Issue #181: test-support/ と前方一致・後方一致だけが同じ別ディレクトリ、同じ名前のファイル。
    "apps/frontend_customer/test-support-x/i18n.tsx",
    "apps/frontend_customer/my-test-support/i18n.tsx",
    "apps/frontend_customer/test-support.tsx",
  ],
  placed: [
    "apps/frontend_customer/app/page.tsx",
    "apps/frontend_customer/app/api/todos/route.ts",
    "apps/frontend_customer/features/todo/lib/x.ts",
    "apps/frontend_customer/shared/ui/button.tsx",
    // Issue #181: テストだけが使うコードの置き場所。
    "apps/frontend_customer/test-support/i18n.tsx",
    "apps/frontend_customer/test-support/nested/x.ts",
    "apps/frontend_customer/next.config.ts",
    "apps/frontend_customer/instrumentation.ts",
    "apps/frontend_customer/instrumentation-node.ts",
    "apps/frontend_customer/proxy.ts",
    "apps/frontend_customer/next-env.d.ts",
    // frontend の規則の対象外（apps/backend は BACKEND_PLACEMENT が見る）。
    "apps/backend/lib/x.ts",
    // apps/e2e（E2E の workspace パッケージ @repo/e2e。Issue #84）も frontend の規則の対象外。
    "apps/e2e/support/database.ts",
    "apps/e2e/playwright.config.ts",
    "apps/e2e/todo.spec.ts",
    // apps/shared（@repo/shared。Issue #90）も frontend の規則の対象外（SHARED_PLACEMENT が見る）。
    "apps/shared/logger.ts",
    "apps/shared/extra.ts",
  ],
};

// apps/shared の置き場所の規則（SHARED_PLACEMENT。Issue #90）の判定例。
const SHARED_PLACEMENT_EXAMPLES: { misplaced: string[]; placed: string[] } = {
  misplaced: [
    "apps/shared/extra.ts",
    // 名前の前方一致だけが同じ別ファイル、別の拡張子、許した名前でも直下でないもの。
    "apps/shared/env-helper.ts",
    "apps/shared/logger.tsx",
    "apps/shared/now-helper.ts",
    "apps/shared/now.test-support.ts",
    "apps/shared/log-events.ts",
    "apps/shared/log-events.test.ts",
    // Issue #181: backend・frontend の直下で許した test-support/ も、apps/shared では決めた名前の外。
    "apps/shared/test-support/now.ts",
    "apps/shared/env.js",
    "apps/shared/lib/env.ts",
    // ソース以外（説明・テストだけ・設定）も、決めた名前でなければ違反。
    "apps/shared/README.md",
    "apps/shared/extra.test.ts",
    "apps/shared/vitest.config.mts",
  ],
  placed: [
    "apps/shared/env.ts",
    "apps/shared/env.test.ts",
    "apps/shared/logger.ts",
    "apps/shared/logger.test.ts",
    "apps/shared/log-event.ts",
    // Issue #216: スキーマとマスクの印の仕様（Issue #209 では logger.test.ts に置き、一覧に無かった）。
    "apps/shared/log-event.test.ts",
    "apps/shared/now.ts",
    "apps/shared/now.test.ts",
    "apps/shared/package.json",
    "apps/shared/tsconfig.json",
    // apps/shared の外は対象外（前方一致だけが同じ別ディレクトリ・backend の shared/・画面側の shared/）。
    "apps/shared-x/extra.ts",
    "apps/backend/shared/drizzle/database.ts",
    "apps/frontend_customer/shared/request-log/request-log.ts",
    "apps/e2e/support/database.ts",
  ],
};

// 環境変数の直参照の規則（ENV_DIRECT_ACCESS）の判定例。参照ではなく [ファイル, ソース] で決まるので別に持つ。
const ENV_ACCESS_EXAMPLES: {
  violating: [file: string, source: string][];
  allowed: [file: string, source: string][];
} = {
  violating: [
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const url = process.env.DATABASE_URL;",
    ],
    ["apps/e2e/x.ts", 'const url = process["env"].DATABASE_URL;'],
    ["apps/e2e/playwright.config.ts", "const ci = !process . env . CI;"],
    [
      "apps/frontend_customer/features/todo/api/x.tsx",
      "const v = globalThis.process.env.X;",
    ],
    [
      "apps/backend/shared/drizzle/drizzle.config.ts",
      "const v = process\n  .env\n  .X;",
    ],
    ["apps/frontend_customer/app/page.jsx", "const v = process?.env.X;"],
    ["vitest.config.mts", "const v = process['env'];"],
    // env.ts と名前の前方一致だけが同じ別ファイル。
    ["apps/shared/env-helper.ts", "export const v = process.env;"],
    // Issue #90 で移す前の場所（apps/backend/shared/infra/env.ts）は、もう例外ではない。
    [
      "apps/backend/shared/infra/env.ts",
      "export const v = process.env.DATABASE_URL;",
    ],
    ["apps/shared/logger.ts", "const v = process.env.X;"],
    ["apps/frontend_customer/shared/x.cjs", "module.exports = process[`env`];"],
    // 括弧で囲んだ process と、global 経由。
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const v = (process).env.X;",
    ],
    ["apps/e2e/x.ts", 'const v = ( process )["env"];'],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const v = global.process.env.X;",
    ],
    // instrumentation.ts の例外は NEXT_RUNTIME だけで、ほかの変数・名前を取れない書き方・ほかのファイルは違反。
    [
      "apps/frontend_customer/instrumentation.ts",
      "const url = process.env.DATABASE_URL;",
    ],
    [
      "apps/frontend_customer/instrumentation.ts",
      "const r = process.env.NEXT_RUNTIME_X;",
    ],
    [
      "apps/frontend_customer/instrumentation.ts",
      'const r = process.env["NEXT_RUNTIME"];',
    ],
    ["apps/frontend_customer/instrumentation.ts", "const all = process.env;"],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const r = process.env.NEXT_RUNTIME;",
    ],
  ],
  allowed: [
    // 例外の env.ts（Issue #90 で apps/shared に移した）。
    [
      "apps/shared/env.ts",
      'process.loadEnvFile(".env");\nexport const env = readEnv(process.env);',
    ],
    // apps/shared のテスト。
    ["apps/shared/env.test.ts", "const path = process.env.PATH;"],
    // コメント・文字列の中。
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "// process.env.DATABASE_URL は読まない",
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "/* process.env */ export const a = 1;",
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      'const s = "process.env.DATABASE_URL";',
    ],
    // process.env ではない識別子・プロパティ。
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const processEnv = read(); processEnv.X;",
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const v = myprocess.env; process.envelope;",
    ],
    // テストと、対象外の場所のファイル。
    [
      "apps/backend/features/todo/internal/infra/x.test.ts",
      "const path = process.env.PATH;",
    ],
    ["architecture.test.ts", "const path = process.env.PATH;"],
    ["scripts/x.ts", "const path = process.env.PATH;"],
    ["README.md", "process.env.DATABASE_URL"],
    // instrumentation.ts の NEXT_RUNTIME（Next.js の規約。改行を挟んでも同じ）。
    [
      "apps/frontend_customer/instrumentation.ts",
      'if (process.env.NEXT_RUNTIME === "nodejs") { await import("./instrumentation-node"); }',
    ],
    [
      "apps/frontend_customer/instrumentation.ts",
      "const r = process\n  .env\n  ?.NEXT_RUNTIME;",
    ],
  ],
};

function judgeEnvAccess([file, source]: [string, string]): boolean {
  return (
    ENV_DIRECT_ACCESS.appliesTo(file) &&
    findProcessEnvAccesses(source).some(
      (access) => !isAllowedEnvAccess(file, access),
    )
  );
}

// console を直接書く規則（CONSOLE_DIRECT_ACCESS）の判定例。ENV_ACCESS_EXAMPLES と同じく [ファイル, ソース] で決まる。
const CONSOLE_ACCESS_EXAMPLES: {
  violating: [file: string, source: string][];
  allowed: [file: string, source: string][];
} = {
  violating: [
    // 書き方（メソッド・?.・[]・空白と改行・globalThis / global 経由・括弧）。
    [
      "apps/backend/features/todo/internal/presentation/x.api.ts",
      'console.log("x");',
    ],
    ["apps/backend/shared/http/x.ts", "console.error(error);"],
    ["apps/backend/shared/drizzle/database.ts", 'console.warn("retry");'],
    ["apps/backend/features/todo/internal/infra/x.ts", 'console?.info("x");'],
    ["apps/backend/features/todo/internal/infra/x.ts", 'console["log"]("x");'],
    ["apps/backend/features/todo/internal/infra/x.ts", "console\n  .log(1);"],
    ["apps/frontend_customer/proxy.ts", "globalThis.console.log(line);"],
    [
      "apps/frontend_customer/instrumentation-node.ts",
      "global.console.error(e);",
    ],
    [
      "apps/frontend_customer/features/todo/components/x.tsx",
      "(console).log(1);",
    ],
    // 呼び出し以外の参照（別名・分割代入・引数に渡す）も、console という名前を書いた時点で違反。
    ["apps/frontend_customer/app/page.tsx", "const c = console; c.log(1);"],
    ["apps/frontend_customer/shared/x.ts", "const { log } = console;"],
    ["apps/e2e/x.ts", "run(console);"],
    // apps/e2e/・scripts/・ルート直下の設定ファイル、拡張子。
    ["apps/e2e/request-log.spec.ts", "console.log(line);"],
    ["scripts/tool.ts", "console.log(1);"],
    ["scripts/hooks/tool.mjs", "console.log(1);"],
    ["vitest.config.mts", "console.log(1);"],
    ["stryker.config.mjs", "console.log(1);"],
    // logger.ts と名前の前方一致だけが同じ別ファイル・別の場所の logger.ts（Issue #90 で移す前の場所を含む）。
    ["apps/shared/logger-helper.ts", "console.log(1);"],
    ["apps/backend/shared/infra/logger.ts", "console.log(1);"],
    ["apps/backend/features/todo/internal/infra/logger.ts", "console.log(1);"],
    ["apps/shared/env.ts", "console.error(1);"],
  ],
  allowed: [
    // 例外の logger.ts（Issue #90 で apps/shared に移した）。
    [
      "apps/shared/logger.ts",
      "console.log(line); console.warn(line); console.error(line);",
    ],
    ["apps/shared/logger.test.ts", 'vi.spyOn(console, "log");'],
    // コメント・文字列の中。
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      '// console.log("x") は書かない',
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "/* console.error */ export const a = 1;",
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      'const s = "console.log(1)";',
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const t = `console.log`;",
    ],
    // console ではない識別子・プロパティ。
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "const consoleLog = read(); consoleLog.x;",
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "myconsole.log(1); console_.log(2);",
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      'logger.emit({ message: "x", event: { name: "server_error" } });',
    ],
    // テストと、対象外の場所・種類のファイル。
    ["apps/backend/features/todo/internal/infra/x.test.ts", "console.log(1);"],
    [
      "apps/frontend_customer/features/todo/components/x.test.tsx",
      "console.log(1);",
    ],
    ["scripts/hooks/guard-git.test.ts", "console.log(1);"],
    ["architecture.test.ts", "console.log(1);"],
    ["notes/x.ts", "console.log(1);"],
    ["README.md", "console.log(1);"],
    ["scripts/tool.sh", "console.log(1);"],
  ],
};

function judgeConsoleAccess([file, source]: [string, string]): boolean {
  return (
    CONSOLE_DIRECT_ACCESS.appliesTo(file) &&
    file !== CONSOLE_DIRECT_ACCESS.allowedFile &&
    findConsoleAccesses(source).length > 0
  );
}

// 現在時刻の読み取りの規則（NOW_SINGLE_SOURCE）の判定例。CONSOLE_ACCESS_EXAMPLES と同じく [ファイル, ソース] で決まる。
const NOW_ACCESS_EXAMPLES: {
  violating: [file: string, source: string][];
  allowed: [file: string, source: string][];
} = {
  violating: [
    // 書き方（引数なしの new Date・括弧なし・空白と改行だけの括弧・Date.now・?.・[]・new の無い Date()・globalThis 経由）。
    [
      "apps/backend/features/todo/internal/domain/todo.ts",
      "const d = new Date();",
    ],
    [
      "apps/backend/features/todo/internal/domain/todo.ts",
      "const d = new Date;",
    ],
    [
      "apps/backend/features/todo/internal/domain/todo.ts",
      "const d = new Date(  );",
    ],
    [
      "apps/backend/features/todo/internal/domain/todo.ts",
      "const d = new Date(\n);",
    ],
    [
      "apps/backend/features/todo/internal/application/x.command.ts",
      "Date.now();",
    ],
    [
      "apps/backend/features/todo/internal/application/x.command.ts",
      "Date?.now();",
    ],
    ["apps/backend/features/todo/internal/infra/x.ts", 'Date["now"]();'],
    ["apps/backend/features/todo/internal/infra/x.ts", "const f = Date.now;"],
    [
      "apps/backend/features/todo/internal/presentation/x.api.ts",
      "String(Date());",
    ],
    ["apps/backend/shared/drizzle/x.ts", "globalThis.Date.now();"],
    ["apps/backend/shared/error/x.ts", "new globalThis.Date();"],
    ["apps/backend/shared/http/x.ts", "new global.Date ( );"],
    // 場所（frontend 直下・画面側・apps/shared の now.ts 以外）と拡張子。
    ["apps/frontend_customer/proxy.ts", "receivedAt: new Date(),"],
    ["apps/frontend_customer/features/todo/components/x.tsx", "new Date();"],
    ["apps/frontend_customer/shared/x.mjs", "Date.now();"],
    ["apps/frontend_customer/app/page.tsx", "new Date();"],
    ["apps/shared/logger.ts", "const t = new Date().toISOString();"],
    // now.ts と名前が似た別ファイル・別の場所の now.ts・名前に test-support を含むが test-support/ の下ではないもの
    //   （以前の補助の目印 *.test-support.*、前方一致だけの test-support-x/、アプリの直下ではない test-support/。Issue #181）。
    ["apps/shared/now-helper.ts", "new Date();"],
    ["apps/shared/now.js", "new Date();"],
    ["apps/backend/shared/drizzle/now.ts", "new Date();"],
    ["apps/backend/shared/drizzle/test-support-clock.ts", "new Date();"],
    ["apps/backend/shared/drizzle/database.test-support.ts", "Date.now();"],
    ["apps/frontend_customer/shared/i18n/i18n.test-support.tsx", "new Date();"],
    ["apps/backend/test-support-x/x.ts", "new Date();"],
    [
      "apps/backend/features/todo/internal/infra/test-support/x.ts",
      "new Date();",
    ],
  ],
  allowed: [
    // 例外の now.ts。
    ["apps/shared/now.ts", "export function now() { return new Date(); }"],
    // now() を使う。
    ["apps/backend/features/todo/internal/domain/todo.ts", "createdAt: now(),"],
    ["apps/shared/logger.ts", "const t = now().toISOString();"],
    // 引数のある new Date（解析）、Date.parse / Date.UTC、型の位置の Date、改行を挟んだ引数。
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "createdAt: new Date(row.createdAt),",
    ],
    ["apps/frontend_customer/shared/i18n/format.ts", "format(new Date(iso));"],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      'new Date(\n  "2026-01-01",\n);',
    ],
    [
      "apps/backend/features/todo/internal/infra/x.ts",
      "Date.parse(s); Date.UTC(2026, 0);",
    ],
    [
      "apps/backend/features/todo/internal/domain/x.ts",
      "readonly createdAt: Date;",
    ],
    // 別の識別子。
    [
      "apps/backend/features/todo/internal/domain/x.ts",
      "new DateTime(); toDate(); myDate.now(); Dates.now();",
    ],
    // コメント・文字列の中。
    [
      "apps/backend/features/todo/internal/domain/x.ts",
      "// new Date() は書かない",
    ],
    [
      "apps/backend/features/todo/internal/domain/x.ts",
      "/* Date.now() */ export {};",
    ],
    [
      "apps/backend/features/todo/internal/domain/x.ts",
      'const s = "new Date()";',
    ],
    [
      "apps/backend/features/todo/internal/domain/x.ts",
      "const t = `Date.now()`;",
    ],
    // テスト・テストの補助・対象外の場所（apps/e2e/・scripts/・ルート直下）・TS / JS 以外。
    ["apps/backend/features/todo/internal/domain/todo.test.ts", "new Date();"],
    ["apps/shared/now.test.ts", "Date.now();"],
    ["apps/backend/test-support/database.ts", "const n = Date.now();"],
    ["apps/backend/test-support/nested/x.ts", "new Date();"],
    ["apps/frontend_customer/test-support/i18n.tsx", "new Date();"],
    ["apps/e2e/todo.spec.ts", "const runId = Date.now();"],
    ["apps/e2e/support/database.ts", "new Date();"],
    ["scripts/tool.ts", "Date.now();"],
    ["vitest.config.mts", "Date.now();"],
    ["apps/backend/features/todo/internal/domain/x.md", "new Date();"],
  ],
};

function judgeNowAccess([file, source]: [string, string]): boolean {
  return (
    NOW_SINGLE_SOURCE.appliesTo(file) &&
    file !== NOW_SINGLE_SOURCE.allowedFile &&
    findCurrentTimeAccesses(source).length > 0
  );
}

// ハードコードの文言の規則（FRONTEND_HARDCODED_TEXT・SERVER_HARDCODED_TEXT。Issue #116）の判定例。[ファイル, ソース] で決まる。
// WHY 架空のソースで固定する: 実リポジトリの検査は「今の画面に文言が無い」ことしか確かめず、判定が緩すぎても（常に違反なし）
//   通ってしまう。書き方（JSX のテキスト・属性・テンプレートリテラル・エスケープ・型の位置）と、通すもの（t(...)・className・
//   コメント・辞書・テスト）の境界を、規則ごとに例で持つ。
const HARDCODED_TEXT_EXAMPLES: Record<
  HardcodedTextRule["id"],
  {
    violating: [file: string, source: string][];
    allowed: [file: string, source: string][];
  }
> = {
  "frontend-hardcoded-text": {
    violating: [
      // 1. JSX のテキスト（日本語も英語も。改行を挟むもの、フラグメント、式と並ぶもの）。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        "export const C = () => <button>削除</button>;",
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        "export const C = () => <h1>Todo</h1>;",
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        "export const C = () => (\n  <p>\n    Loading...\n  </p>\n);",
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <>{t("todo.count")} items</>;',
      ],
      // 2. 利用者に見える属性の文字列リテラル・テンプレートリテラル（"x"・{"x"}・{`x`}・埋め込み式のあるもの）。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <button aria-label="Delete" />;',
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        `export const C = ({ todo }) => <button aria-label={\`Delete \${todo.title}\`} />;`,
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        `export const C = ({ todo }) => <button aria-label={\`「\${todo.title}」を削除\`} />;`,
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <input placeholder={"New todo"} />;',
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        "export const C = () => <a title={`Edit`} />;",
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <img alt="Logo" />;',
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <option label="Name" />;',
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <button aria-description="Removes the item" />;',
      ],
      // 3. どこであれ日本語の文字列（ひらがな・カタカナ・漢字、エスケープ、型の位置、テンプレートリテラルの埋め込み式の中）。
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        'export const f = () => { throw new Error("取得に失敗しました"); };',
      ],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        'export const s = "ありがとう";',
      ],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        'export const s = "タスク";',
      ],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        "export const s = `削除`;",
      ],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        'export const s = "\\u524a\\u9664";',
      ],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        'export type Label = "削除";',
      ],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        `export const s = (a) => \`\${a ? "はい" : "no"}\`;`,
      ],
      // 拡張子と場所（app/・直下のファイル・.jsx・.js）。
      [
        "apps/frontend_customer/app/page.tsx",
        "export default function Page() { return <main>Todo</main>; }",
      ],
      ["apps/frontend_customer/proxy.ts", 'export const m = "認証エラー";'],
      [
        "apps/frontend_customer/features/todo/components/x.jsx",
        "export const C = () => <p>Hello</p>;",
      ],
      [
        "apps/frontend_customer/shared/x.js",
        "export const C = () => <p>Hello</p>;",
      ],
      // 辞書の例外は *.messages.ts だけ（Issue #125 より前の messages/ja.ts、.tsx、名前の一部だけが同じもの、.messages の無いものは違反）。
      [
        "apps/frontend_customer/shared/i18n/messages/ja.ts",
        'export const ja = { "todo.item.delete": "削除" };',
      ],
      [
        "apps/frontend_customer/shared/i18n/ja.ts",
        'export const ja = { "todo.item.delete": "削除" };',
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item.messages.tsx",
        'export const m = { ja: { delete: "削除" } };',
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item-messages.ts",
        'export const m = { ja: { delete: "削除" } };',
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item.messages.helper.ts",
        'export const m = { ja: { delete: "削除" } };',
      ],
      // 辞書（*.messages.ts）でも、defineMessages(...) の引数の外は同じ検査（Issue #125 の reviewer 指摘）: トップレベルの
      //   文字列、defineMessages 以外の関数の引数、createElement の利用者向けの属性の日本語。共通の辞書も同じ。
      [
        "apps/frontend_customer/features/todo/components/todo-item.messages.ts",
        'export const label = "削除";',
      ],
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.messages.ts",
        'export const m = defineMessages({ ja: { a: "あ" }, en: { a: "A" } }); export const label = "削除";',
      ],
      [
        "apps/frontend_customer/features/todo/components/todo-item.messages.ts",
        'export const m = otherMessages({ ja: { delete: "削除" }, en: { delete: "Delete" } });',
      ],
      [
        "apps/frontend_customer/shared/i18n/common.messages.ts",
        'export const e = createElement("button", { "aria-label": "削除" });',
      ],
      [
        "apps/frontend_customer/shared/i18n/common.messages.ts",
        'export const m = defineMessages({ ja: { a: "あ" }, en: { a: "A" } }).ja.a + "件";',
      ],
      //   defineMessages の引数の例外は辞書（*.messages.ts）の中だけ。ほかのファイルで defineMessages を呼んでも違反。
      [
        "apps/frontend_customer/features/todo/components/x.ts",
        'export const m = defineMessages({ ja: { delete: "削除" }, en: { delete: "Delete" } });',
      ],
    ],
    allowed: [
      // 文言を t(...) で描く。キーや params の ASCII の文字列は文言ではない。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <button>{t("todo.item.delete")}</button>;',
      ],
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = ({ title }) => <button aria-label={t("todo.item.deleteLabel", { title })} />;',
      ],
      // 一覧に無い属性（className・data-testid・type・role・href・id）の ASCII の文字列。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => <li className="foo" data-testid="todo-item" role="listitem" id="a"><a href="/todo/1" type="button" /></li>;',
      ],
      // 一覧の属性でも、空白だけ（alt=""）と埋め込み式だけのテンプレート。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        `export const C = ({ title }) => <img alt="" title={\`\${title}\`} />;`,
      ],
      // JSX のテキストが改行とインデントだけ。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        'export const C = () => (\n  <div>\n    <p>{t("a")}</p>\n  </div>\n);',
      ],
      // コメント（// と /* */ と JSX の {/* */}）の日本語。
      [
        "apps/frontend_customer/features/todo/components/x.tsx",
        '// 削除のボタン\nexport const C = () => <p>{/* 削除 */}{t("a")}</p>; /* 日本語 */',
      ],
      // JSX ではない ASCII の文字列（layout.tsx の metadata・API のパス）と、比較の式（JSX と取り違えない）。
      [
        "apps/frontend_customer/app/layout.tsx",
        'export const metadata = { title: "ai-only-template" };',
      ],
      [
        "apps/frontend_customer/features/todo/api/x.ts",
        'export const url = "/api/todos"; export const f = (a, b, c, d) => a < b && c > d;',
      ],
      // 辞書（*.messages.ts。画面・部品の隣と、共通の shared/i18n/common.messages.ts）。
      [
        "apps/frontend_customer/features/todo/components/todo-item.messages.ts",
        'export const m = defineMessages({ ja: { delete: "削除", deleteAria: "「{title}」を削除" }, en: { delete: "Delete", deleteAria: "Delete {title}" } });',
      ],
      [
        "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.messages.ts",
        'export const m = defineMessages({ ja: { loading: "読み込み中…" }, en: { loading: "Loading…" } });',
      ],
      [
        "apps/frontend_customer/shared/i18n/common.messages.ts",
        'export const m = defineMessages({ ja: { "todo.notFound": "Todo（id: {id}）が見つかりません" }, en: { "todo.notFound": "Todo (id: {id}) was not found" } });',
      ],
      //   引数の外の import・コメント・ASCII の文字列（specifier）と、複数行に分けた defineMessages。
      [
        "apps/frontend_customer/features/todo/components/todo-item.messages.ts",
        'import { defineMessages } from "@/shared/i18n/i18n";\n// 部品の辞書\nexport const m = defineMessages({\n  ja: { delete: "削除" },\n  en: { delete: "Delete" },\n});',
      ],
      // テストと、対象外の場所・種類のファイル。
      [
        "apps/frontend_customer/features/todo/components/x.test.tsx",
        "render(<button>削除</button>);",
      ],
      [
        "apps/frontend_customer/shared/i18n/locale.test.ts",
        'expect(x).toBe("削除");',
      ],
      ["apps/e2e/todo.spec.ts", 'page.getByRole("button", { name: "削除" });'],
      [
        "apps/backend/features/todo/internal/presentation/x.ts",
        'export const s = "Delete";',
      ],
      ["README.md", "<p>削除</p>"],
    ],
  },
  "server-hardcoded-text": {
    violating: [
      // apps/shared（env.ts のエラーと logger.ts のメッセージ）も対象。
      [
        "apps/shared/env.ts",
        `export const m = (raw) => \`0 以上の整数で指定してください（値: \${raw}）\`;`,
      ],
      [
        "apps/shared/logger.ts",
        'export const m = "logger: event を JSON にできなかった";',
      ],
      [
        "apps/backend/features/todo/internal/domain/todo.ts",
        `export const e = (id) => new DomainError("not_found", \`Todo（id: \${id}）が見つかりません\`);`,
      ],
      [
        "apps/backend/features/todo/internal/presentation/x.api.ts",
        'export const s = z.string().min(1, { error: "タイトルを入力してください" });',
      ],
      ["apps/backend/shared/error/x.ts", 'export const s = "エラー";'],
      ["apps/backend/shared/drizzle/x.mts", "export const s = `保存`;"],
      [
        "apps/backend/shared/drizzle/drizzle.config.ts",
        'export const s = "\\u524a\\u9664";',
      ],
      ["apps/backend/shared/error/x.ts", 'export type M = "削除";'],
    ],
    allowed: [
      [
        "apps/backend/features/todo/internal/domain/todo.ts",
        'export const e = (id) => new DomainError("not_found", "todo.notFound", { id });',
      ],
      [
        "apps/backend/features/todo/internal/domain/todo.ts",
        "// 見つからないときは ErrorKey で表す\nexport const a = 1; /* 日本語 */",
      ],
      [
        "apps/backend/shared/http/x.ts",
        'logger.emit({ message: "request failed", event: { name: "server_error" } });',
      ],
      // backend は JSX のテキスト・属性を見ない（日本語だけを見る）。
      [
        "apps/backend/shared/http/x.tsx",
        'export const C = () => <p title="x">Delete</p>;',
      ],
      // テストと、対象外の場所のファイル（画面の辞書は frontend の規則の例外）。
      [
        "apps/backend/features/todo/internal/domain/todo.test.ts",
        'expect(e.message).toBe("見つかりません");',
      ],
      [
        "apps/frontend_customer/shared/i18n/common.messages.ts",
        'export const s = "削除";',
      ],
      ["apps/shared/logger.ts", 'export const s = "Delete";'],
      [
        "apps/shared/env.ts",
        `// 日本語のコメントは拾わない\nexport const m = (raw) => \`must be an integer >= 0 (got: \${raw})\`;`,
      ],
      ["apps/shared/env.test.ts", 'expect(m).toBe("設定されていません");'],
      ["README.md", "削除"],
    ],
  },
};

// 例をまとめて 1 回で構文解析し（parseSourceFiles。tsgo の起動を 1 回にする）、例ごとに違反か（true）を返す。
// 規則の対象外のファイル（README.md など）は解析せずに false にする（TS / JS 以外は解析できないため）。
// 同じファイル名の例が並ぶので、仮想のパスは例の番号のディレクトリの下に置く（拡張子は元のまま）。
function judgeHardcodedTexts(
  rule: HardcodedTextRule,
  examples: [file: string, source: string][],
): boolean[] {
  const virtualPath = (i: number, file: string) => `example-${i}/${file}`;
  const sourceFiles = parseSourceFiles(
    Object.fromEntries(
      examples.flatMap(([file, source], i) =>
        rule.appliesTo(file) ? [[virtualPath(i, file), source]] : [],
      ),
    ),
  );
  return examples.map(([file], i) => {
    const sourceFile = sourceFiles.get(virtualPath(i, file));
    return (
      sourceFile !== undefined &&
      findHardcodedTexts(file, sourceFile, rule.checks).length > 0
    );
  });
}

// 1 ファイルを解析して、文言の行番号を返す（抽出の仕様のテスト用）。
function hardcodedTextLinesOf(
  file: string,
  source: string,
  rule: HardcodedTextRule,
): number[] {
  return findHardcodedTexts(
    file,
    parseSourceFiles({ [file]: source }).get(file) as SourceFile,
    rule.checks,
  );
}

// ProblemResponse.wrap で包む規則（PRESENTATION_WITH_PROBLEM_RESPONSE。Issue #141）の判定例。[ファイル, ソース] で決まる。
// WHY 架空のソースで固定する: 実リポジトリの検査は「今の 5 本が包んでいる」ことしか確かめず、判定が緩すぎても（常に違反なし）
//   通ってしまう。包み忘れの書き方と、対象外のファイル・メンバーの境界を例で持つ。許可例には本物の 5 本も入れる（must pass）。
// 複数行のソースを 1 つの文字列にする（この下の判定例と、fixture のファイルの中身で使う）。
const lines = (...source: string[]) => source.join("\n");

const REAL_API_FILES = [
  "create-todo",
  "delete-todo",
  "get-todo",
  "list-todos",
  "rename-todo",
  "change-todo-completion",
].map(
  (name) => `apps/backend/features/todo/internal/presentation/${name}.api.ts`,
);

const API_FILE = "apps/backend/features/todo/internal/presentation/x.api.ts";
const IMPORT_WITH_PROBLEM_RESPONSE =
  'import { ProblemResponse } from "../../../../shared/http/problem";';

const PROBLEM_RESPONSE_EXAMPLES: {
  violating: [file: string, source: string][];
  allowed: [file: string, source: string][];
} = {
  violating: [
    // try / catch を自分で書いた handler（Issue #141 の前の 5 本の形）。
    [
      API_FILE,
      lines(
        'import { ProblemResponse } from "../../../../shared/http/problem";',
        "export class XApi {",
        "  readonly handle = async (request: Request): Promise<Response> => {",
        "    try {",
        "      return new Response(null);",
        "    } catch (error) {",
        "      return ProblemResponse.from(error, request);",
        "    }",
        "  };",
        "}",
      ),
    ],
    // 素の async。
    [
      API_FILE,
      "export class XApi { readonly handle = async (request: Request) => new Response(null); }",
    ],
    // ProblemResponse.wrap を import だけして使わない。
    [
      API_FILE,
      lines(
        IMPORT_WITH_PROBLEM_RESPONSE,
        "export class XApi { readonly handle = async (request: Request) => new Response(null); }",
      ),
    ],
    // 別の関数で包む・ProblemResponse.wrap を別の関数で包み直す・名前空間経由・呼び出さずに代入する。
    [
      API_FILE,
      "export class XApi { readonly handle = someOtherWrapper(async (request: Request) => new Response(null)); }",
    ],
    [
      API_FILE,
      "export class XApi { readonly handle = wrap(ProblemResponse.wrap(async (request: Request) => new Response(null))); }",
    ],
    [
      API_FILE,
      "export class XApi { readonly handle = problem.ProblemResponse.wrap(async (request: Request) => new Response(null)); }",
    ],
    [API_FILE, "export class XApi { readonly handle = ProblemResponse.wrap; }"],
    // ProblemResponse の別のメソッド、別のクラスの wrap、素の wrap、別名で import したクラスの wrap、ブラケット（Issue #262 で
    //   関数 withProblemResponse を ProblemResponse.wrap にしたときに足した境界）。
    [
      API_FILE,
      "export class XApi { readonly handle = ProblemResponse.from(async (request: Request) => new Response(null)); }",
    ],
    [
      API_FILE,
      "export class XApi { readonly handle = OtherResponse.wrap(async (request: Request) => new Response(null)); }",
    ],
    [
      API_FILE,
      "export class XApi { readonly handle = wrap(async (request: Request) => new Response(null)); }",
    ],
    [
      API_FILE,
      lines(
        'import { ProblemResponse as P } from "../../../../shared/http/problem";',
        "export class XApi { readonly handle = P.wrap(async (request: Request) => new Response(null)); }",
      ),
    ],
    [
      API_FILE,
      'export class XApi { readonly handle = ProblemResponse["wrap"](async (request: Request) => new Response(null)); }',
    ],
    // 初期化子が無い（コンストラクタで代入する）、メソッド、getter。
    [
      API_FILE,
      lines(
        "export class XApi {",
        "  readonly handle: (request: Request) => Promise<Response>;",
        "  constructor() {",
        "    this.handle = ProblemResponse.wrap(async (request: Request) => new Response(null));",
        "  }",
        "}",
      ),
    ],
    [
      API_FILE,
      "export class XApi { async handle(request: Request) { return new Response(null); } }",
    ],
    [
      API_FILE,
      "export class XApi { get handle() { return async (request: Request) => new Response(null); } }",
    ],
    // 名前が文字列リテラル、static、クラス式、関数の中のクラス。
    [
      API_FILE,
      'export class XApi { "handle" = async (request: Request) => new Response(null); }',
    ],
    [
      API_FILE,
      "export class XApi { static handle = async (request: Request) => new Response(null); }",
    ],
    [
      API_FILE,
      "export const XApi = class { handle = async (request: Request) => new Response(null); };",
    ],
    [
      API_FILE,
      "export function make() { return class { handle = async (request: Request) => new Response(null); }; }",
    ],
    // 1 つ目のクラスは包んでいても、2 つ目が包んでいない。
    [
      API_FILE,
      lines(
        IMPORT_WITH_PROBLEM_RESPONSE,
        "export class AApi { readonly handle = ProblemResponse.wrap(async (request: Request) => new Response(null)); }",
        "export class BApi { readonly handle = async (request: Request) => new Response(null); }",
      ),
    ],
    // 対象の場所の境界: backend/shared/http（Issue #310。旧 shared/presentation）とその入れ子、presentation の下の入れ子、.ts 以外の拡張子。
    [
      "apps/backend/shared/http/x.api.ts",
      "export class XApi { readonly handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/shared/http/nested/x.api.ts",
      "export class XApi { readonly handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/features/todo/internal/presentation/nested/x.api.ts",
      "export class XApi { readonly handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/features/todo/internal/presentation/x.api.mts",
      "export class XApi { readonly handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/features/todo/internal/presentation/x.api.js",
      "export class XApi { handle = async (request) => new Response(null); }",
    ],
  ],
  allowed: [
    // 本物の 5 本（動的セグメントの ctx を持つもの・持たないもの）。
    ...REAL_API_FILES.map((file): [string, string] => [
      file,
      readFileSync(join(repoRoot, file), "utf8"),
    ]),
    [
      API_FILE,
      lines(
        IMPORT_WITH_PROBLEM_RESPONSE,
        "export class XApi {",
        "  readonly handle = ProblemResponse.wrap(",
        "    async (request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {",
        "      await ctx.params;",
        "      return new Response(null);",
        "    },",
        "  );",
        "}",
      ),
    ],
    // 型引数を明示した呼び出しも、呼び出す関数は ProblemResponse.wrap。
    [
      API_FILE,
      "export class XApi { handle = ProblemResponse.wrap<[Request]>(async (request) => new Response(null)); }",
    ],
    // handle 以外の名前のメンバー、クラスの外（オブジェクトリテラル）、コメント・文字列の中は見ない。
    [
      API_FILE,
      "export class XApi { handler = async (request: Request) => new Response(null); private run = async () => 1; }",
    ],
    [
      API_FILE,
      "export const x = { handle: async (request: Request) => new Response(null) };",
    ],
    [
      API_FILE,
      lines(
        "// export class XApi { readonly handle = async (request: Request) => new Response(null); }",
        'export const s = "class A { handle = async () => 1 }";',
      ),
    ],
    // 対象外のファイル: api ファイルでない presentation のファイル、ほかの層、テスト、presentation で終わらないディレクトリ、画面側。
    [
      "apps/backend/shared/http/problem.ts",
      "export class X { handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/features/todo/internal/application/x.api.ts",
      "export class XApi { handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/features/todo/internal/presentation/x.api.test.ts",
      "export class XApi { handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/features/todo/internal/presentation-x/x.api.ts",
      "export class XApi { handle = async (request: Request) => new Response(null); }",
    ],
    //   Issue #310: backend/shared の http/ 以外の単位と、前方一致だけが同じ別ディレクトリ（http-x）。
    [
      "apps/backend/shared/error/x.api.ts",
      "export class XApi { handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/backend/shared/http-x/x.api.ts",
      "export class XApi { handle = async (request: Request) => new Response(null); }",
    ],
    [
      "apps/frontend_customer/features/todo/api/x.api.ts",
      "export class XApi { handle = async (request: Request) => new Response(null); }",
    ],
  ],
};

// 例をまとめて 1 回で構文解析し（tsgo の起動を 1 回にする）、例ごとに違反か（true）を返す。対象外のファイルは解析せずに false。
function judgeProblemResponses(examples: [string, string][]): boolean[] {
  const virtualPath = (i: number, file: string) => `example-${i}/${file}`;
  const sourceFiles = parseSourceFiles(
    Object.fromEntries(
      examples.flatMap(([file, source], i) =>
        PRESENTATION_WITH_PROBLEM_RESPONSE.appliesTo(file)
          ? [[virtualPath(i, file), source]]
          : [],
      ),
    ),
  );
  return examples.map(([file], i) => {
    const sourceFile = sourceFiles.get(virtualPath(i, file));
    return (
      sourceFile !== undefined && findUnwrappedHandles(sourceFile).length > 0
    );
  });
}

const SHARED_ERROR_FILE = "apps/backend/shared/error/x.ts";

// 規則 class-based の判定の例。違反例は 1 例 1 つの書き方にして、他の書き方の巻き添えで違反になっていないことを示す。
const CLASS_BASED_EXAMPLES: {
  violating: [file: string, source: string][];
  allowed: [file: string, source: string][];
} = {
  violating: [
    // 0: export する function 宣言（移行前の validate・writerOf の形）。
    [
      SHARED_ERROR_FILE,
      lines("export function f(): number {", "  return 1;", "}"),
    ],
    // 1: export しない function 宣言（ファイルの中だけの補助。移行前の toResponse の形）。
    [SHARED_ERROR_FILE, lines("function f(): number {", "  return 1;", "}")],
    // 2: async function。
    [
      SHARED_ERROR_FILE,
      lines("export async function f(): Promise<number> {", "  return 1;", "}"),
    ],
    // 3: generator。
    [
      SHARED_ERROR_FILE,
      lines("export function* f(): Generator<number> {", "  yield 1;", "}"),
    ],
    // 4: アロー関数の const。
    [
      SHARED_ERROR_FILE,
      lines("export const f = (x: number): number => x + 1;"),
    ],
    // 5: function 式の const（export しない）。
    [
      SHARED_ERROR_FILE,
      lines(
        "const f = function (x: number): number {",
        "  return x + 1;",
        "};",
      ),
    ],
    // 6: export default function（名前なし）。
    [
      SHARED_ERROR_FILE,
      lines("export default function (): number {", "  return 1;", "}"),
    ],
    // 7: オーバーロードの宣言（本体の無い宣言だけでも違反。declare function も同じ節）。
    [
      SHARED_ERROR_FILE,
      lines(
        "export function f(x: string): string;",
        "export declare function g(): void;",
      ),
    ],
    // 8: export default のアロー関数。
    [
      SHARED_ERROR_FILE,
      lines("export default async (): Promise<number> => 1;"),
    ],
    // 9: 括弧・as・satisfies で包んだアロー関数の let（包んでも関数）。
    [
      SHARED_ERROR_FILE,
      lines(
        "type F = () => number;",
        "export let f = ((() => 1) as F) satisfies F;",
      ),
    ],
    // 10: 1 つの文の 2 つ目の変数だけが関数。
    [
      SHARED_ERROR_FILE,
      lines("const a = 1, f = (): number => a;", "export { f };"),
    ],
    // 11: namespace（入れ子の a.b も）の中の function。
    [
      SHARED_ERROR_FILE,
      lines(
        "export namespace A.B {",
        "  export function f(): number {",
        "    return 1;",
        "  }",
        "}",
      ),
    ],
    // 12: drizzle-kit の設定も対象（例外にしない）。
    [
      "apps/backend/shared/drizzle/drizzle.config.ts",
      lines(
        "function path(): string {",
        '  return ".";',
        "}",
        "export default { out: path() };",
      ),
    ],
    // 13: 拡張子 .mts と、backend/shared の単位の入れ子のディレクトリ。
    [
      "apps/backend/shared/drizzle/nested/x.mts",
      lines("export function f(): number {", "  return 1;", "}"),
    ],
    // 14: モジュールの公開の入口 expose/。
    [
      "apps/backend/features/notification/expose/notify.ts",
      lines("export function notify(message: string): void {}"),
    ],
    // 15〜17: 名前の前方一致だけが同じ別ディレクトリ・直下でない test-support/（以前は直下の test-support/ と spec/ を除いていたときの境界。
    //   今はどれも apps/backend の下なので対象）。
    ["apps/backend/test-support-x/x.ts", lines("export function f(): void {}")],
    ["apps/backend/spec-x/x.ts", lines("export function f(): void {}")],
    [
      "apps/backend/features/todo/test-support/x.ts",
      lines("export function f(): void {}"),
    ],
    // 18: パスに test を含む本番のファイル（*.test.* ではない）。
    [
      "apps/backend/shared/drizzle/test-clock.ts",
      lines("export function f(): void {}"),
    ],
    // 19〜21: apps/shared の本番コード（Issue #262 で対象に広げた）。env.ts・now.ts の関数と、.mts・入れ子のディレクトリ。
    ["apps/shared/env.ts", lines("export function load(): void {}")],
    ["apps/shared/now.ts", lines("export const now = (): Date => new Date();")],
    [
      "apps/shared/nested/x.mts",
      lines("function f(): number {", "  return 1;", "}"),
    ],
    // 22〜27: テストの補助（Issue #262 の 2 つ目の PR で対象に広げた）。apps/backend/test-support/（直下と feature の下）、
    //   apps/backend/spec/ の support.ts、apps/e2e/ の spec 以外の補助（database.ts・入れ子・Playwright の設定）。
    [
      "apps/backend/test-support/builder.ts",
      lines("export function build(): void {}"),
    ],
    [
      "apps/backend/test-support/todo/todo-builder.ts",
      lines("function defaults(): number {", "  return 1;", "}"),
    ],
    [
      "apps/backend/spec/api/todo/support.ts",
      lines("export function given(): void {}"),
    ],
    [
      "apps/e2e/support/database.ts",
      lines("export async function resetTodos(): Promise<void> {}"),
    ],
    ["apps/e2e/nested/x.mts", lines("export const f = (): number => 1;")],
    [
      "apps/e2e/playwright.config.ts",
      lines(
        "function port(): number {",
        "  return 3100;",
        "}",
        "export default { port: port() };",
      ),
    ],
    // 28〜34: frontend の React 以外のモジュール（ADR 20261002-class-based-frontend-modules.md で対象に広げた）。features/<f>/api/・
    //   feature の直下・shared/ の入れ子・.mts と .js・辞書（*.messages.ts）・test-support/ の .ts・hook に似た名前（.hooks.ts）。
    [
      "apps/frontend_customer/features/todo/api/todo-api.ts",
      lines("export function listTodos(): void {}"),
    ],
    [
      "apps/frontend_customer/features/todo/x.ts",
      lines("export function f(): void {}"),
    ],
    [
      "apps/frontend_customer/shared/i18n/nested/x.mts",
      lines("export const f = (): number => 1;"),
    ],
    [
      "apps/frontend_customer/shared/request-log/x.js",
      lines("export default function () {}"),
    ],
    [
      "apps/frontend_customer/features/todo/components/todo-item.messages.ts",
      lines("const pick = (x: string): string => x;"),
    ],
    [
      "apps/frontend_customer/test-support/fetch.ts",
      lines("export async function stubFetch(): Promise<void> {}"),
    ],
    [
      "apps/frontend_customer/features/todo/hooks/todo.hooks.ts",
      lines("export function f(): void {}"),
    ],
  ],
  allowed: [
    // 0: static だけのクラス（状態の無い補助。biome の noStaticOnlyClass は apps/backend で off）。
    [
      SHARED_ERROR_FILE,
      lines(
        "export class Validate {",
        "  static of(x: number): number {",
        "    return x;",
        "  }",
        "  private static helper(): void {}",
        "}",
      ),
    ],
    // 1: 型と interface だけ（関数の型も値ではない）。
    [
      SHARED_ERROR_FILE,
      lines(
        "export type F = (x: number) => number;",
        "export interface Notifier {",
        "  notify(message: string): void;",
        "}",
      ),
    ],
    // 2: 定数のオブジェクト・関数でない値の変数。
    [
      SHARED_ERROR_FILE,
      lines(
        'export const KEYS = { a: "a", b: "b" } as const;',
        "export const LIMIT = 100;",
        "let count = 0;",
        "export { count };",
      ),
    ],
    // 3: クラスフィールドのアロー関数（readonly handle = ProblemResponse.wrap(async ...)）と素のアロー関数のフィールド。
    [
      "apps/backend/features/todo/internal/presentation/x.api.ts",
      lines(
        'import { ProblemResponse } from "../../../../shared/http/problem";',
        "export class XApi {",
        "  readonly handle = ProblemResponse.wrap(async (request: Request) => new Response(null));",
        "  private readonly toBody = (x: number): string => String(x);",
        "}",
        "export const GET = new XApi().handle;",
      ),
    ],
    // 4: メソッドの中の関数（function 宣言・アロー関数）。
    [
      SHARED_ERROR_FILE,
      lines(
        "export class A {",
        "  run(): number {",
        "    function inner(): number {",
        "      return 1;",
        "    }",
        "    const twice = (x: number) => x * 2;",
        "    return twice(inner());",
        "  }",
        "}",
      ),
    ],
    // 5: クラス式の const と、export default のクラス。
    [
      SHARED_ERROR_FILE,
      lines(
        "export const A = class {",
        "  static f(): number {",
        "    return 1;",
        "  }",
        "};",
        "export default class B {}",
      ),
    ],
    // 6: コメントと文字列の中の function。
    [
      SHARED_ERROR_FILE,
      lines(
        "// function f() {}",
        'export const S = "export function f() {}";',
        "/* const g = () => 1; */",
      ),
    ],
    // 7〜14: 対象外（テスト（test-support/・spec/ の中のテストも）・E2E のテスト *.spec.ts・リポジトリ直下の
    //   vitest.global-setup.ts・apps/shared のテスト・前方一致だけが同じ apps/shared-x と apps/e2e-x）。
    [
      "apps/backend/shared/error/x.test.ts",
      lines("function helper(): number {", "  return 1;", "}"),
    ],
    [
      "apps/backend/test-support/todo/todo-builder.test.ts",
      lines("function helper(): number {", "  return 1;", "}"),
    ],
    [
      "apps/backend/spec/api/todo/create-todo.api-spec.test.ts",
      lines("function given(): void {}"),
    ],
    [
      "apps/e2e/todo.spec.ts",
      lines("async function addTodo(): Promise<void> {}"),
    ],
    [
      "vitest.global-setup.ts",
      lines("export default async function setup(): Promise<void> {}"),
    ],
    ["apps/e2e-x/x.ts", lines("export function f(): void {}")],
    [
      "apps/shared/env.test.ts",
      lines("function helper(): number {", "  return 1;", "}"),
    ],
    ["apps/shared-x/x.ts", lines("export function f(): void {}")],
    // 15〜27: frontend の対象外（CLASS_BASED の「frontend の次は対象外にする」）。React の component（.tsx・.jsx）と hook
    //   （.hook.ts・.hook.tsx）、app/ の下（page.tsx・route.ts・.ts の補助）、直下のファイル（proxy.ts・instrumentation.ts・
    //   instrumentation-node.ts・next.config.ts）、frontend のテスト、前方一致だけが同じ別ディレクトリ（features-x/・apps/frontend_customer-x/）。
    [
      "apps/frontend_customer/features/todo/components/todo-item.tsx",
      lines("export function TodoItem() {", "  return null;", "}"),
    ],
    [
      "apps/frontend_customer/shared/ui/button.jsx",
      lines("export const Button = () => null;"),
    ],
    [
      "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.hook.ts",
      lines("export function useTodoScreen(): void {}"),
    ],
    [
      "apps/frontend_customer/shared/i18n/locale.hook.tsx",
      lines("export function useLocale(): void {}"),
    ],
    [
      "apps/frontend_customer/app/page.tsx",
      lines("export default function Page() {", "  return null;", "}"),
    ],
    [
      "apps/frontend_customer/app/api/todos/route.ts",
      lines(
        "export async function GET(): Promise<Response> {",
        "  return new Response(null);",
        "}",
      ),
    ],
    [
      "apps/frontend_customer/proxy.ts",
      lines(
        "export function proxy(): void {}",
        "function withLocale(): void {}",
      ),
    ],
    [
      "apps/frontend_customer/instrumentation.ts",
      lines("export async function register(): Promise<void> {}"),
    ],
    [
      "apps/frontend_customer/instrumentation-node.ts",
      lines("export async function verifyEnvAtStartup(): Promise<void> {}"),
    ],
    [
      "apps/frontend_customer/next.config.ts",
      lines("const f = (): number => 1;", "export default { x: f() };"),
    ],
    [
      "apps/frontend_customer/features/todo/api/todo-api.test.ts",
      lines("function jsonResponse(): void {}"),
    ],
    [
      "apps/frontend_customer/features-x/x.ts",
      lines("export function f(): void {}"),
    ],
    [
      "apps/frontend_customer-x/shared/x.ts",
      lines("export function f(): void {}"),
    ],
  ],
};

// 例をまとめて 1 回で構文解析し（tsgo の起動を 1 回にする）、例ごとに違反か（true）を返す。対象外のファイルは解析せずに false。
function judgeClassBased(examples: [string, string][]): boolean[] {
  const virtualPath = (i: number, file: string) => `example-${i}/${file}`;
  const sourceFiles = parseSourceFiles(
    Object.fromEntries(
      examples.flatMap(([file, source], i) =>
        CLASS_BASED.appliesTo(file) ? [[virtualPath(i, file), source]] : [],
      ),
    ),
  );
  return examples.map(([file], i) => {
    const sourceFile = sourceFiles.get(virtualPath(i, file));
    return (
      sourceFile !== undefined && findTopLevelFunctions(sourceFile).length > 0
    );
  });
}

// --- exports の判定（BACKEND_EXPORTS・SHARED_EXPORTS）の仕様 ---
// 参照 1 件ごとではなく、exports の中身と参照の集まりで決まるので、RULES の外で例を持つ。

const EXPORT_KEY_EXAMPLES: {
  keys: string[];
  resolved: [specifier: string, key: string][];
  unresolved: string[];
} = {
  keys: [
    "./features/todo/internal/presentation/*.api",
    "./features/todo/internal/presentation/*",
    "./shared/infra/env",
  ],
  resolved: [
    // "*" の前が同じ長さのパターンが 2 つ当たるときは、キーが長い方（Node.js の解決と同じ）。
    [
      "@repo/backend/features/todo/internal/presentation/list-todos.api",
      "./features/todo/internal/presentation/*.api",
    ],
    // "*" は "/" を含んでもよい。
    [
      "@repo/backend/features/todo/internal/presentation/nested/x.api",
      "./features/todo/internal/presentation/*.api",
    ],
    [
      "@repo/backend/features/todo/internal/presentation/list-todos",
      "./features/todo/internal/presentation/*",
    ],
    ["@repo/backend/shared/infra/env", "./shared/infra/env"],
  ],
  unresolved: [
    // 完全一致のキーの前方一致だけ・拡張子つきは当たらない。
    "@repo/backend/shared/infra/env-helper",
    "@repo/backend/shared/infra/env.ts",
    // "*" は 1 文字以上。
    "@repo/backend/features/todo/internal/presentation/",
    // パターンの "*" の前が一致しない（前方一致だけが同じ別ディレクトリ）。
    "@repo/backend/features/todo/presentationx/a.api",
    "@repo/backend/features/todo/internal/infra/todo-repository.postgres",
    // パッケージ名だけ（"."）はキーに無い。
    "@repo/backend",
  ],
};

// --- 抽出 → 正規化 → 判定を通した fixture テスト ---
// 上の「規則ごとの判定」は、正規化済みの参照 1 件を規則に渡すだけで、ファイルの列挙・import の抽出・相対パスの解決を
// 通らない。抽出の取りこぼし（書き方によって import を拾えない）は、規則が正しくても違反の見逃しになる。
// 一時ディレクトリに架空のツリーを作って実ファイルを置き、本番と同じ collectViolations に通して、検出される違反の
// 集合を丸ごと比較する（余分な検出も見逃しも失敗にする）。規則を足す・変えるときは、ここの must-reject / must-pass も直す。

function violationsOfFixture(files: Record<string, string>): string[] {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと、本番の検査（リポジトリ直下）や Biome・git の差分に混ざる。
  //   テストが途中で落ちても finally で消す。
  const root = mkdtempSync(join(tmpdir(), "architecture-test-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return collectViolations(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// must-reject: 依存の向きの 17 規則（RULES）それぞれについて、alias（@/・@repo/backend/）と相対パス、値の import / import type / inline の type /
// export { X } from / export type { X } from / dynamic import() / 副作用だけの import のうち規則に関係する形と、
// .ts / .tsx / .js / .jsx の各拡張子、境界ぎりぎりのケース（他 feature の深いパス、自 feature の禁止層、
// 名前の前方一致だけが同じ別ディレクトリ、next / react / react-dom のサブパス）を置く。
// あわせて、置き場所の規則（BACKEND_PLACEMENT / FRONTEND_PLACEMENT）、環境変数の直参照の規則（ENV_DIRECT_ACCESS）、
// exports の規則（BACKEND_EXPORTS。fixture の apps/backend/package.json）の違反も置く。
// console の直接の呼び出しの規則（CONSOLE_DIRECT_ACCESS。Issue #85）の違反も置く。
// 現在時刻の読み取りの規則（NOW_SINGLE_SOURCE）の違反も置く。
// apps/shared の規則（Issue #90。frontend-to-shared-specifier・screen-to-shared・SHARED_PLACEMENT・SHARED_EXPORTS と、層の規則の
// apps/shared の許可 SHARED_MODULES_BY_LAYER）の違反も置く。
// ハードコードの文言の規則（FRONTEND_HARDCODED_TEXT・SERVER_HARDCODED_TEXT。Issue #116）と、辞書の置き場所の規則
// （messages-colocation。Issue #125）の違反も置く。
// 規則は全部で 36（RULES の 24 + 置き場所 3 + 環境変数の直参照 + console + 現在時刻の読み取り + exports 2 + ハードコードの文言 2 + handle を ProblemResponse.wrap で包む 1 + 最上位の関数 1）。Issue #68 で RULES に 3 規則（backend-to-frontend・
// backend-relative-only・frontend-root-to-backend）を足し、段階 2 で frontend-to-backend-specifier と BACKEND_EXPORTS を足した。
// Issue #90 で frontend-to-shared-specifier・screen-to-shared・shared-self-contained・SHARED_PLACEMENT・SHARED_EXPORTS を足した。
// Issue #141 で presentation-with-problem-response（PRESENTATION_WITH_PROBLEM_RESPONSE）を足した。
// Issue #208 で module-internal・module-expose-only-from-presentation・expose-imports（モジュールの境界）を足した。
// Issue #262 で class-based（CLASS_BASED。最上位の関数）を足した。
const MUST_REJECT_FILES: Record<string, string> = {
  // class-based（Issue #262）: 最上位の関数（function 宣言・async・generator・オーバーロード・アロー関数と function 式の
  //   変数・export default のアロー関数・namespace の中）。クラスのメソッド・フィールド・メソッドの中の関数（8〜13 行目）は拾わない。
  //   .mts と expose/・drizzle-kit の設定も対象（前方一致だけが同じ別ディレクトリ test-support-x/ などは判定の例 CLASS_BASED_EXAMPLES）。
  "apps/backend/shared/error/bad-function.ts": lines(
    "export function a(x: string): string;",
    "export function a(x: unknown): unknown { return x; }",
    "async function b(): Promise<void> {}",
    "export function* c(): Generator<number> { yield 1; }",
    "export const d = (x: number): number => x;",
    "const e = function (): void {};",
    "export default async (): Promise<void> => {};",
    "export class Ok {",
    "  static f(): number { return 1; }",
    "  readonly g = (): number => 1;",
    "  h(): number { const inner = () => 1; return inner(); }",
    "}",
    "export const value = 1;",
    "export namespace N { export function i(): void {} }",
  ),
  "apps/backend/shared/drizzle/bad-function.mts": lines(
    "export default function (): void {}",
  ),
  "apps/backend/features/notification/expose/bad-notify.ts": lines(
    "export function notify(message: string): void {}",
  ),
  // drizzle-kit の設定は例外にしない（名前は下の backend-to-frontend の fixture と重ならないよう .mts。drizzle/ の中なので置き場所の
  //   違反にはならない）。
  "apps/backend/shared/drizzle/drizzle.config.mts": lines(
    'function path(): string { return "."; }',
    "export default { out: path() };",
  ),
  // presentation-with-problem-response（Issue #141）: handle を ProblemResponse.wrap で包まない（try / catch の手書き、素の async、
  //   import だけして使わない、別の関数で包む）。.mts と入れ子のディレクトリ・backend/shared/http（Issue #310。旧 shared/presentation）も対象。
  "apps/backend/features/todo/internal/presentation/bad-handle.api.ts": lines(
    'import { ProblemResponse} from "../../../../shared/http/problem";',
    "export class TryCatchApi {",
    "  readonly handle = async (request: Request): Promise<Response> => {",
    "    try {",
    "      return new Response(null);",
    "    } catch (error) {",
    "      return ProblemResponse.from(error, request);",
    "    }",
    "  };",
    "}",
    "export class RawApi {",
    "  readonly handle = async (request: Request) => new Response(null);",
    "}",
    "export class OtherWrapperApi {",
    "  readonly handle = someOtherWrapper(async (request: Request) => new Response(null));",
    "}",
    "export class WrappedApi {",
    "  readonly handle = ProblemResponse.wrap(async (request: Request) => new Response(null));",
    "}",
  ),
  "apps/backend/features/todo/internal/presentation/nested/bad-handle.api.mts":
    lines(
      "export class RawApi { handle = async (request: Request) => new Response(null); }",
    ),
  "apps/backend/shared/http/bad-handle.api.ts": lines(
    "export class RawApi { handle = async (request: Request) => new Response(null); }",
  ),
  // screen-to-backend: apps/frontend_customer/features/<f>/ の api/ 以外から backend への参照は、型でも相対でも違反。
  "apps/frontend_customer/features/todo/components/bad-backend.ts": lines(
    'import { GET } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
    'import type { Todo } from "../../../../backend/features/todo/internal/domain/todo";',
    'import { type GetTodoResponse } from "@repo/backend/features/todo/internal/presentation/get-todo.api";',
    'import * as updateApi from "@repo/backend/features/todo/internal/presentation/update-todo.api";',
    'import deleteApi from "../../../../backend/features/todo/internal/presentation/delete-todo.api";',
    'export { POST } from "@repo/backend/features/todo/internal/presentation/create-todo.api";',
    'export type { Problem } from "@repo/backend/shared/http/problem";',
    // セミコロンの無い文の直後の複数行の import type も拾う。
    "export enum Kind { A }",
    "import type {",
    "  PostgresTodoRepository,",
    '} from "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
    'const lazy = import("../../../../backend/shared/http/json-body");',
  ),
  // screen-to-backend / shared-to-features / screen-to-app: 画面側の shared/ から。
  "apps/frontend_customer/shared/bad-shared.tsx": lines(
    'import { GET } from "../../backend/features/todo/internal/presentation/list-todos.api";',
    'import type { DomainError } from "@repo/backend/shared/error/domain-error";',
    'import { TodoScreen } from "@/features/todo";',
    'import type { ListTodosResponse } from "../features/todo/api/todo-api";',
    'export { TodoItem } from "@/features/todo/components/todo-item";',
    'export { default } from "@/app/page";',
    'const layout = import("../app/layout");',
  ),
  // feature-api-to-backend: 値の参照、presentation 以外、他 feature、.api でないファイル、inline type の混在。
  "apps/frontend_customer/features/todo/api/bad-api.ts": lines(
    'import { ListTodosApi } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
    'import type { Todo } from "../../../../backend/features/todo/internal/domain/todo";',
    'import type { ListOthersResponse } from "@repo/backend/features/other/internal/presentation/list-others.api";',
    'import { type GetTodoResponse, GET } from "@repo/backend/features/todo/internal/presentation/get-todo.api";',
    'export { ProblemResponse } from "../../../../backend/shared/http/problem";',
    'import type { X } from "@repo/backend/features/todo/internal/presentation/list-todos";',
    'import type { DomainError } from "@repo/backend/shared/error/domain-error";',
    'const m = import("@repo/backend/features/todo/internal/presentation/update-todo.api");',
  ),
  // feature-to-feature: 別 feature の深いパスは、型でも re-export でも dynamic でも違反。
  "apps/frontend_customer/features/other/components/bad-feature.js": lines(
    'import { TodoItem } from "@/features/todo/components/todo-item";',
    'import { useTodoScreen } from "../../todo/screens/todo-screen/todo-screen.hook";',
    'export { fetchTodos } from "@/features/todo/api/todo-api";',
    'import type { ListTodosResponse } from "../../todo/api/todo-api";',
    'const c = import("@/features/todo/components");',
  ),
  // feature-to-feature: 名前の前方一致だけが同じ別 feature（todo と todo-extra）を同じ feature と誤認しない。
  "apps/frontend_customer/features/todo/components/bad-prefix.jsx": lines(
    'import { X } from "@/features/todo-extra/components/x";',
  ),
  // screen-to-app
  "apps/frontend_customer/features/todo/screens/s/bad-app.tsx": lines(
    'import Page from "@/app/page";',
    'import { GET } from "../../../../app/api/todos/route";',
    'export type { Metadata } from "@/app/layout";',
  ),
  // domain: フレームワークのサブパス、自 feature の外側の層、他 feature の domain、backend/shared の層に分けていたときの旧パス
  //   （Issue #310。単位ではない）、画面側。
  "apps/backend/features/todo/internal/domain/bad-domain.ts": lines(
    'import { NextResponse } from "next/server";',
    'import { jsx } from "react/jsx-runtime";',
    'import { createRoot } from "react-dom/client";',
    'import { CreateTodoCommand } from "../application/create-todo.command";',
    'import type { PostgresTodoRepository } from "../infra/todo-repository.postgres";',
    'import type { ListTodosResponse } from "../presentation/list-todos.api";',
    'import type { Other } from "../../../other/internal/domain/other";',
    'import { ProblemResponse } from "../../../../shared/presentation/problem";',
    'export type { ListTodosResponse as Dto } from "@/features/todo";',
    'const s = import("@/shared/x");',
    'import "@/app/globals.css";',
  ),
  // application
  "apps/backend/features/todo/internal/application/bad-application.ts": lines(
    'import { todoRepository } from "../infra/todo-repository.postgres";',
    'import type { ListTodosResponse } from "../presentation/list-todos.api";',
    'import { InvalidRequestError } from "../../../../shared/presentation/problem";',
    'import { useState } from "react";',
    'import { notFound } from "next/navigation";',
    'import { flushSync } from "react-dom";',
    'export { TodoItem } from "@/features/todo/components/todo-item";',
    'const r = import("../../../../../frontend_customer/app/page");',
  ),
  // presentation: Postgres の Repository の実装以外の infra（InMemory の実装、名前が Repository の実装で始まる別ファイルも）、
  //   domain の値の参照（inline type の混在、re-export）、フレームワーク、画面側、他 feature の infra。
  "apps/backend/features/todo/internal/presentation/bad-presentation.api.ts":
    lines(
      'import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";',
      'import { helper } from "../infra/todo-repository.postgres-helper";',
      'import { Todo } from "../domain/todo";',
      'import { TodoFactory, type TodoId } from "../domain/todo-factory";',
      'export { Todo as Entity } from "../domain/todo-entity";',
      // Issue #144: 自 feature の domain から値で import してよいのは定数（UPPER_SNAKE_CASE）だけ。関数、定数と値の混在、
      //   定数の re-export、定数の名前の別名を付けた関数、名前で中身が分からない default / * as は違反。
      'import { KeyedIssue } from "../domain/todo-keyed";',
      'import { TODO_MAX, Todo } from "../domain/todo-mixed";',
      'export { TODO_MAX } from "../domain/todo-constants";',
      'import { maxLength as TODO_MAX } from "../domain/todo-alias";',
      'import TODO_DEFAULT from "../domain/todo-default";',
      'import * as TODO from "../domain/todo-namespace";',
      'import { NextResponse } from "next/server";',
      'import { cache } from "react";',
      'export type { ListTodosResponse } from "@/features/todo/api/todo-api";',
      'const c = import("../../../other/internal/infra/other-repository.in-memory");',
      'import "../../../../../frontend_customer/app/globals.css";',
    ),
  // infra
  "apps/backend/features/todo/internal/infra/bad-infra.ts": lines(
    'import { ListTodosApi } from "../presentation/list-todos.api";',
    'import type { GetTodoResponse } from "../presentation/get-todo.api";',
    'import type { Other } from "../../../other/internal/domain/other";',
    'import { OtherQuery } from "../../../other/internal/application/other.query";',
    'import { TodoScreen } from "@/features/todo";',
    'import { x } from "@/shared/x";',
    'export { default } from "../../../../../frontend_customer/app/page";',
    'import { headers } from "next/headers";',
    'import { renderToString } from "react-dom/server";',
    'const c = import("../../../other/internal/infra/other-repository.postgres");',
  ),
  // backend-shared: backend/shared から features（domain・infra、定数だけの import も）と画面側。shared は層を持たないので
  //   層の規則は重ねてかからない（Issue #310。以前は shared/presentation/ にあり presentation の規則にも出ていた）。
  "apps/backend/shared/http/bad-backend-shared.ts": lines(
    'import type { Todo } from "../../features/todo/internal/domain/todo";',
    'import { todoRepository } from "../../features/todo/internal/infra/todo-repository.postgres";',
    'import { TodoFactory } from "../../features/todo/internal/domain/todo-factory";',
    'export { TodoScreen } from "@/features/todo";',
    'const p = import("@/app/page");',
    'import "../../features/todo/internal/infra/todo-repository.in-memory";',
    // Issue #144: 定数だけの import でも、backend/shared から feature の domain は不可。
    'import { TODO_MAX } from "../../features/todo/internal/domain/todo-constants";',
  ),
  // application: 他 feature の domain / application、画面側の shared/。
  "apps/backend/features/todo/internal/application/bad-application-2.ts": lines(
    'import type { Other } from "../../../other/internal/domain/other";',
    'import { x } from "../../../../../frontend_customer/shared/x";',
    'export { OtherQuery } from "../../../other/internal/application/other.query";',
  ),
  // presentation: 他 feature の Repository の実装 / application / domain は import type でも違反。画面側の shared/。
  "apps/backend/features/todo/internal/presentation/bad-presentation-2.api.ts":
    lines(
      'import type { OtherRepository } from "../../../other/internal/infra/other-repository.postgres";',
      'import type { OtherQuery } from "../../../other/internal/application/other.query";',
      'import type { Other } from "../../../other/internal/domain/other";',
      'import { x } from "@/shared/x";',
      // Issue #144: 定数だけの import でも、他 feature の domain は不可。
      'import { OTHER_MAX } from "../../../other/internal/domain/other-constants";',
    ),
  // backend-shared: backend/shared から画面側の shared/。
  "apps/backend/shared/error/bad-shared-screen.ts": lines(
    'import { x } from "@/shared/x";',
  ),
  // backend-placement: apps/backend/features/<f>/internal/ の 4 層・apps/backend/shared/ の単位の外のファイル（import の有無に関係なく違反）。
  "apps/backend/features/todo/p-root.ts": lines(
    'import { x } from "@/shared/x";',
  ),
  "apps/backend/features/todo/lib/x.ts": lines("export const x = 1;"),
  // Issue #208 モジュールの境界。application・domain・infra から他のモジュールの expose（値・型の re-export・dynamic import）。
  //   参照先が層に属さないので層の規則にもかかる（重ねて検出する）。
  "apps/backend/features/todo/internal/application/bad-module-expose.command.ts":
    lines('import { Notifier } from "../../../notification/expose/notifier";'),
  "apps/backend/features/todo/internal/domain/bad-module-expose.ts": lines(
    'export type { Notifier } from "../../../notification/expose/notifier";',
  ),
  "apps/backend/features/todo/internal/infra/bad-module-expose.ts": lines(
    'const n = import("../../../notification/expose/notifier");',
  ),
  // presentation から自モジュールの expose（層の規則 presentation だけにかかる。module-expose-only-from-presentation は他のモジュールだけ）。
  "apps/backend/features/todo/internal/presentation/bad-own-expose.api.ts":
    lines('import { x } from "../../expose/x";'),
  // module-internal: 他のモジュールの internal（型だけでも）。
  "apps/backend/features/todo/internal/application/bad-module-internal.command.ts":
    lines(
      'import type { NotificationSender } from "../../../notification/internal/domain/notification-sender";',
      'import { SendNotificationCommand } from "../../../notification/internal/application/send-notification.command";',
    ),
  // expose-imports: 他のモジュールの internal / expose、フレームワーク、自モジュールの internal/・expose/ の外。backend/shared と
  //   apps/shared の env、自モジュールの internal は通る（3・4 行目と最後の行。apps/shared の logger・now は must-pass の notifier.ts で
  //   見る。この fixture の apps/shared の exports には logger が無く、shared-exports にかかるため）。
  "apps/backend/features/notification/expose/bad-expose.ts": lines(
    'import type { Todo } from "../../todo/internal/domain/todo";',
    'import { x } from "../../todo/expose/x";',
    'import { AppDatabase } from "../../../shared/drizzle/database";',
    'import { env } from "@repo/shared/env";',
    'import { NextResponse } from "next/server";',
    'export { y } from "../lib/y";',
    'import { SendNotificationCommand } from "../internal/application/send-notification.command";',
  ),
  // backend-placement: expose/ の下のディレクトリと、expose の前方一致だけの別ディレクトリ。
  "apps/backend/features/notification/expose/nested/x.ts": lines(
    "export const x = 1;",
  ),
  "apps/backend/features/notification/expose-x/x.ts": lines(
    "export const x = 1;",
  ),
  "apps/backend/x.ts": lines("export const x = 1;"),
  //   Issue #98: features/ 直下のファイル、features/ を挟まない feature（以前の置き場所）。
  "apps/backend/features/x.ts": lines("export const x = 1;"),
  "apps/backend/todo/domain/old.ts": lines("export const x = 1;"),
  //   Issue #208: internal/ を挟まない feature の層（Issue #208 より前の置き場所）と、internal/ の直下のファイル。
  "apps/backend/features/todo/domain/old-layer.ts": lines(
    "export const x = 1;",
  ),
  "apps/backend/features/todo/internal/x.ts": lines("export const x = 1;"),
  //   Issue #310: backend/shared の層に分けていたときの旧ディレクトリと、一覧に無い単位。
  "apps/backend/shared/domain/old-layer.ts": lines("export const x = 1;"),
  "apps/backend/shared/foo/x.ts": lines("export const x = 1;"),
  // 前方一致の境界: backend/shared-x は backend/shared ではない（features/ の下でもないので層に属さず、置き場所の違反。
  //   backend/shared の規則はかからない）。
  "apps/backend/shared-x/domain/x.ts": lines(
    'import { TodoScreen } from "@/features/todo";',
  ),
  // 前方一致の境界: app/api-x は app/api ではない（app の規則がかかる）。
  "apps/frontend_customer/app/api-x/route.ts": lines(
    'export { GET } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
  ),
  // パスに test を含むがテストファイルではない本番のファイル。
  "apps/frontend_customer/features/todo/components/test-helper.tsx": lines(
    'import { Todo } from "@repo/backend/features/todo/internal/domain/todo";',
  ),
  // 拡張子 .mts / .cts / .mjs / .cjs と、テンプレートリテラル・第 2 引数つきの dynamic import。
  "apps/frontend_customer/features/todo/components/bad-ext.mts": lines(
    "const a = import(`@repo/backend/features/todo/internal/domain/todo`);",
    'const b = import("@repo/backend/features/todo/internal/infra/todo-repository.postgres", { with: { type: "json" } });',
  ),
  "apps/frontend_customer/features/todo/components/bad-ext.cts": lines(
    'import { GET } from "@repo/backend/features/todo/internal/presentation/get-todo.api";',
  ),
  "apps/frontend_customer/features/todo/components/bad-ext.mjs": lines(
    'export { x } from "../../../../backend/shared/http/problem";',
  ),
  "apps/frontend_customer/features/todo/components/bad-ext.cjs": lines(
    'import "@repo/backend/features/todo/internal/infra/todo-repository.in-memory";',
  ),
  // backend-shared / backend-placement: 単位に属さない backend/shared 直下のファイルから。
  "apps/backend/shared/bad-root.ts": lines(
    'import { CreateTodoCommand } from "../features/todo/internal/application/create-todo.command";',
  ),
  // app
  "apps/frontend_customer/app/bad-page.tsx": lines(
    'import { TodoItem } from "@/features/todo/components/todo-item";',
    'import { useTodoScreen } from "../features/todo/screens/todo-screen/todo-screen.hook";',
    'import type { ListTodosResponse } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
    'export { GET } from "../../backend/features/todo/internal/presentation/get-todo.api";',
    'const x = import("@/features/todo/api/todo-api");',
    'import { Y } from "@/features/todo-extra/components/y";',
  ),
  "apps/frontend_customer/app/todo/[id]/bad.jsx": lines(
    'import { TodoItem } from "../../../features/todo/components/todo-item";',
  ),
  // app-api: api ファイル以外（.api の付かない presentation、shared/http の api ファイルでないモジュールを含む）、パッケージ、画面側。
  "apps/frontend_customer/app/api/todos/bad-route.ts": lines(
    'export { GET } from "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
    'export { POST } from "../../../../backend/features/todo/internal/application/create-todo.command";',
    'import { NextResponse } from "next/server";',
    'import { TodoScreen } from "@/features/todo";',
    'export { PUT } from "@repo/backend/features/todo/internal/presentation/update-todo";',
    'export { DELETE } from "@repo/backend/shared/http/problem";',
    'const x = import("@/shared/x");',
  ),
  // Issue #57: feature の infra（スキーマ・Postgres の実装）とテスト基盤（test-support。層に属さない）への参照。
  //   infra は domain / application から参照できない。presentation から参照できるのは自 feature の Postgres の Repository の
  //   実装だけ（Issue #123）。schema は不可。backend/shared（drizzle/ のプール・runner・writer も）はどの層からも許す
  //   （Issue #310。許す例は MUST_PASS_FILES の good-shared-units-*）。
  "apps/backend/features/todo/internal/domain/bad-domain-infra.ts": lines(
    'import type { Database } from "../../../../shared/drizzle/database";',
    'import type { TestDatabase } from "../../../../test-support/database";',
  ),
  // Issue #310: backend/shared の層に分けていたときの旧パス（shared/application/）は単位ではないので違反（下位互換を残さない）。
  "apps/backend/features/todo/internal/domain/bad-domain-application.ts": lines(
    'import type { X } from "../../../../shared/application/x";',
  ),
  // Issue #220: infra は自 feature の application（command）を参照しない（型だけでも）。旧パスの shared/application/ も違反。
  "apps/backend/features/todo/internal/infra/bad-infra-application.ts": lines(
    'import type { CreateTodoCommand } from "../application/create-todo.command";',
    'import type { X } from "../../../../shared/application/x";',
  ),
  "apps/backend/features/todo/internal/presentation/bad-presentation-infra.api.ts":
    lines(
      // Issue #123: database と自 feature の Postgres の Repository の実装は許す（組み立てに使う）。schema とテスト基盤は違反。
      'import { AppDatabase } from "../../../../shared/drizzle/database";',
      'import { todos } from "../infra/schema";',
      'import { PostgresTodoRepository } from "../infra/todo-repository.postgres";',
      'import { cleanupTestSchemas } from "../../../../test-support/database";',
      // Issue #215: InMemory の runner（test-support）は違反。
      'import { InMemoryTransactionRunner } from "../../../../test-support/transaction-runner.in-memory";',
    ),
  // core-to-persistence: domain / application から DB のパッケージ（drizzle-orm とそのサブパス、pg）。型だけの参照・re-export・
  //   dynamic import も違反。名前の前方一致だけが同じ別パッケージ（pg-format）は対象外。
  "apps/backend/features/todo/internal/domain/bad-domain-db.ts": lines(
    'import type { PgTable } from "drizzle-orm/pg-core";',
    'import { eq } from "drizzle-orm";',
    'import type { Pool } from "pg";',
    'import format from "pg-format";',
  ),
  "apps/backend/features/todo/internal/application/bad-application-db.command.ts":
    lines(
      'import { sql } from "drizzle-orm";',
      'const lazy = import("drizzle-orm/node-postgres");',
      'export type { PoolConfig } from "pg";',
    ),
  //   backend/shared は feature の infra を参照できず、next も参照できない（backend-shared）。
  "apps/backend/shared/drizzle/bad-shared-infra.ts": lines(
    'import { todos } from "../../features/todo/internal/infra/schema";',
    'import { NextResponse } from "next/server";',
  ),
  // env-direct-access: env.ts 以外で process.env を読む。書き方ごとに 1 行ずつ置き、行番号で検出を比べる。
  //   コメント・文字列の中（7・8 行目）は拾わない。
  "apps/backend/features/todo/internal/infra/bad-env.ts": lines(
    "const a = process.env.DATABASE_URL;",
    "const b = process",
    "  .env.DATABASE_POOL_MAX;",
    'const c = process["env"].X;',
    "const d = globalThis.process.env.X;",
    "const e = process?.env.X;",
    "// process.env.COMMENT",
    'const f = "process.env.STRING";',
    //   instrumentation.ts 以外の NEXT_RUNTIME も違反（9 行目）。
    "const g = process.env.NEXT_RUNTIME;",
    //   括弧で囲んだ process（10 行目）。
    "const h = ( process ).env.X;",
  ),
  //   instrumentation.ts でも NEXT_RUNTIME 以外は違反（2 行目。1 行目の NEXT_RUNTIME は許す）。
  "apps/frontend_customer/instrumentation.ts": lines(
    'if (process.env.NEXT_RUNTIME === "nodejs") {}',
    "export const url = process.env.DATABASE_URL;",
  ),
  //   apps/e2e/ とルート直下の設定ファイル（.ts / .mjs / .cjs）、env.ts と名前の前方一致だけが同じ別ファイル。
  "apps/e2e/bad-env.ts": lines("export const url = process.env.DATABASE_URL;"),
  "bad.config.ts": lines("export const ci = !process['env'].CI;"),
  "bad.config.mjs": lines("export default { ci: process.env.CI };"),
  "bad.config.cjs": lines("module.exports = process . env;"),
  "apps/backend/shared/drizzle/env-helper.ts": lines(
    "export const e = process.env;",
  ),
  // console-direct-access（Issue #85）: logger.ts 以外で console を書く。書き方ごとに 1 行ずつ置き、行番号で検出を比べる。
  //   コメント・文字列の中（6・7 行目）は拾わない。別名に入れる（8 行目）のも違反。
  "apps/backend/features/todo/internal/presentation/bad-console.api.ts": lines(
    'console.log("x");',
    "console.error(error);",
    'globalThis.console.warn("w");',
    'console?.info("i");',
    'console["debug"]("d");',
    '// console.log("comment")',
    'const s = "console.log(string)";',
    "const c = console;",
    "( console ).log(1);",
  ),
  //   画面側のクライアントコード、apps/e2e/ の spec、scripts/、ルート直下の設定ファイル、logger.ts と名前の前方一致だけが同じ別ファイル。
  "apps/frontend_customer/features/todo/components/bad-console.tsx": lines(
    "export const C = () => { console.log(1); return null; };",
  ),
  "apps/e2e/bad-console.spec.ts": lines("console.log(line);"),
  "scripts/bad-console.ts": lines("console.log(1);"),
  "bad-console.config.mjs": lines("console.log(1);"),
  // WHY クラスのフィールドにする: 最上位のアロー関数は class-based にも当たり、console の違反だけを置けなくなる。
  "apps/backend/shared/drizzle/logger-helper.ts": lines(
    "export class L { static l = () => console.log(1); }",
  ),
  // frontend-hardcoded-text（Issue #116）: JSX のテキスト、利用者に見える属性の文字列、日本語の文字列。行番号で検出を比べる。
  //   2 行目・4 行目は 1 行に複数の属性（件数どおりに出る）。7 行目は属性と日本語の両方に当たるが 1 件。
  //   className・data-testid・alt=""（7 行目）、JSX のコメント（8 行目）、t(...)（9 行目）、コメント（12 行目）は拾わない。
  "apps/frontend_customer/features/todo/components/bad-text.tsx": lines(
    "export const BadText = ({ todo }) => (",
    '  <section aria-label="Todos" title={`Edit`}>',
    "    <h1>Todo</h1>",
    '    <button placeholder={"New"} alt="Logo" label="L" aria-description="D">',
    "      削除",
    "    </button>",
    `    <img aria-label={\`「\${todo.title}」を削除\`} className="foo" data-testid="x" alt="" />`,
    "    {/* 日本語のコメント */}",
    '    <p>{t("todo.item.delete")}</p>',
    "  </section>",
    ");",
    "// 日本語のコメント",
    'export const message = "保存しました";',
    `export const count = (n) => \`\${n}件\`;`,
  ),
  //   拡張子（.jsx）、JSX の無い .ts の日本語、辞書の例外の外（messages/ の下の階層、messages/ の外）。
  //   .ts の日本語は、最上位の関数にしない（class-based の巻き添えにしない。frontend の api/ も対象）ため、クラスの static フィールドにする。
  "apps/frontend_customer/features/todo/components/bad-text.jsx": lines(
    "export const C = () => <p>Hello</p>;",
  ),
  "apps/frontend_customer/features/todo/api/bad-text.ts": lines(
    'export class E { static e = () => { throw new Error("取得に失敗しました"); }; }',
  ),
  "apps/frontend_customer/shared/i18n/messages/nested/ja.ts": lines(
    'export const ja = { "todo.item.delete": "削除" };',
  ),
  "apps/frontend_customer/shared/i18n/ja.ts": lines(
    'export const ja = { "todo.item.delete": "削除" };',
  ),
  //   辞書の例外は *.messages.ts だけ（.tsx と、Issue #125 より前の置き場所 messages/ja.ts は違反）。
  "apps/frontend_customer/features/todo/components/bad-text.messages.tsx":
    lines('export const m = { ja: { delete: "削除" } };'),
  //   辞書（*.messages.ts）でも defineMessages(...) の引数の外は違反（Issue #125 の reviewer 指摘）。2 行目の引数の中は拾わない。
  "apps/frontend_customer/features/todo/components/bad-label.messages.ts":
    lines(
      'import { defineMessages } from "@/shared/i18n/i18n";',
      'export const m = defineMessages({ ja: { a: "あ" }, en: { a: "A" } });',
      'export const label = "削除";',
    ),
  "apps/frontend_customer/shared/i18n/messages/ja.ts": lines(
    'export const ja = { "todo.item.delete": "削除" };',
  ),
  // messages-colocation（Issue #125）: *.messages を別のディレクトリから参照する（相対パス・"@/"・import type・export from・
  //   dynamic import・拡張子つき）。共通の辞書と同じ名前でも shared/i18n/ の外のもの、E2E からの共通の辞書も違反。
  "apps/frontend_customer/features/todo/screens/todo-detail-screen/bad-import-messages.tsx":
    lines(
      'import { todoScreenMessages } from "../todo-screen/todo-screen.messages";',
      'import type { todoItemMessages } from "@/features/todo/components/todo-item.messages";',
      'export { commonMessages } from "@/features/todo/common.messages";',
      'const lazy = import("../todo-screen/parts/header.messages.ts");',
    ),
  "apps/frontend_customer/features/todo/bad-reexport-messages.ts": lines(
    'export { todoScreenMessages } from "./screens/todo-screen/todo-screen.messages";',
  ),
  //   中継（barrel）: 同じディレクトリの辞書の re-export（値・型）も違反（Issue #125 の reviewer 指摘）。中継のファイルを
  //   別のディレクトリから import する側（uses-barrel.tsx）は *.messages を参照しないので、この規則には出ない。
  "apps/frontend_customer/features/todo/screens/todo-screen/zz-barrel.ts":
    lines(
      'export { todoScreenMessages } from "./todo-screen.messages";',
      'export type { TodoScreenMessages } from "./todo-screen.messages.ts";',
    ),
  "apps/frontend_customer/features/todo/screens/todo-detail-screen/uses-barrel.tsx":
    lines('import { todoScreenMessages } from "../todo-screen/zz-barrel";'),
  "apps/e2e/bad-messages.spec.ts": lines(
    'import { commonMessages } from "../frontend_customer/shared/i18n/common.messages";',
  ),
  // server-hardcoded-text（Issue #116）: 日本語の文字列（テンプレートリテラル・zod の error）。コメント（3 行目）と ErrorKey（5 行目）は拾わない。
  //   最上位の関数にしない（class-based の巻き添えにしない）ため、クラスの static フィールドにする。
  "apps/backend/features/todo/internal/domain/bad-text.ts": lines(
    "export class NotFound { static of = (id) =>",
    `  new DomainError("not_found", \`Todo（id: \${id}）が見つかりません\`); }`,
    "// 日本語のコメントは拾わない",
    'export const title = z.string().min(1, { error: "タイトルを入力してください" });',
    'export const key = new DomainError("not_found", "todo.notFound", { id: 1 });',
  ),
  // Issue #68: backend-relative-only。層の規則では許される参照先（自 feature の domain・application、backend/shared）でも、
  //   "@repo/backend/" で書くと違反。import type・re-export・dynamic import・パッケージ名だけの import も同じ。
  //   パッケージ名だけの "@repo/backend" は apps/backend 直下を指し、層に属さないので application の規則にもかかる。
  "apps/backend/features/todo/internal/application/bad-alias.command.ts": lines(
    'import { Todo } from "@repo/backend/features/todo/internal/domain/todo";',
    'import type { TodoRepository } from "@repo/backend/features/todo/internal/domain/todo-repository";',
    'export { DomainError } from "@repo/backend/shared/error/domain-error";',
    'const q = import("@repo/backend/features/todo/internal/application/list-todos.query");',
    'import "@repo/backend";',
  ),
  // backend-to-frontend: drizzle-kit の設定ファイル（shared/drizzle/drizzle.config.ts）から frontend（相対パスと "@/"）。
  //   drizzle/ の中なので置き場所の違反にはならない（Issue #310）。backend/shared の中なので backend-shared にもかかる（Issue #98）。
  "apps/backend/shared/drizzle/drizzle.config.ts": lines(
    'import nextConfig from "../../../frontend_customer/next.config";',
    'import type { ListTodosResponse } from "@/features/todo/api/todo-api";',
    'export { TodoScreen } from "../../../frontend_customer/features/todo";',
  ),
  // backend-placement: drizzle.config.ts も置き場所の規則どおり（shared/drizzle/ の中は可）。feature の直下に置くと違反。
  "apps/backend/features/todo/drizzle.config.ts": lines("export default {};"),
  // frontend-root-to-backend: apps/frontend_customer 直下のファイルから、env 以外の backend（alias と相対、型、re-export、dynamic、
  //   名前の前方一致だけが同じ env-helper）。
  // 置き場所の規則（frontend-placement）で許される名前（next.config.ts）に置き、frontend-root-to-backend だけを確かめる。
  "apps/frontend_customer/next.config.ts": lines(
    'import { todoRepository } from "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
    'import type { Database } from "../backend/shared/drizzle/database";',
    'export { GET } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
    'const e = import("@repo/backend/shared/infra/env-helper");',
  ),
  // frontend-placement（reviewer 指摘。Issue #68）: apps/frontend_customer の app/・features/・shared/ の外と、直下の許可された名前
  //   以外のファイル。lib/ のファイルはどの依存の規則もかからないので、backend の container を値で import しても置き場所の
  //   違反だけが出る（置き場所の規則が無いと 0 件で素通りしていた）。"." で始まるディレクトリも検査する。
  "apps/frontend_customer/lib/db.ts": lines(
    'import { todoRepository } from "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
    "export const db = todoRepository;",
  ),
  "apps/frontend_customer/.lib/x.ts": lines("export const x = 1;"),
  "apps/frontend_customer/next.config.mjs": lines("export default {};"),
  // backend-placement: "." で始まるディレクトリ（apps/backend/.lib/）も検査し、4 層の外として違反にする（除外するのは
  //   node_modules と .next だけ）。"@/" で frontend を参照しているので、backend-to-frontend と backend-relative-only にもかかる。
  "apps/backend/.lib/x.ts": lines(
    'import { TodoScreen } from "@/features/todo";',
  ),
  // frontend-to-backend-specifier（Issue #68 の段階 2）: 参照先はほかの規則で許される（自 feature の api ファイルの型、
  //   app/api からの api ファイル、直下からの env）が、相対パスや "@/../backend/" で書いたもの。この規則だけにかかる。
  //   apps/e2e/ とリポジトリ直下のファイル（.ts / .mts）からの相対パスも同じ。
  "apps/frontend_customer/features/todo/api/bad-specifier.ts": lines(
    'import type { ListTodosResponse } from "../../../../backend/features/todo/internal/presentation/list-todos.api";',
    'export type { GetTodoResponse } from "@/../backend/features/todo/internal/presentation/get-todo.api";',
  ),
  "apps/frontend_customer/app/api/todos/[id]/bad-relative.ts": lines(
    'export { PUT } from "../../../../../backend/features/todo/internal/presentation/update-todo.api";',
  ),
  "apps/frontend_customer/instrumentation-node.ts": lines(
    'const env = import("../backend/shared/infra/env");',
  ),
  "apps/e2e/bad-relative.ts": lines(
    'import { env } from "../backend/shared/infra/env";',
  ),
  // 例外（vitest.global-setup.ts → test-support/database の相対パス）は名前まで一致したときだけ。.mts の別ファイルは違反。
  "vitest.global-setup.mts": lines(
    'import { cleanupTestSchemas } from "./apps/backend/test-support/database";',
  ),
  // vitest.global-setup.ts でも、test-support/database 以外（env）を相対パスで参照するのは違反（test-support/database の相対参照は許される）。
  "vitest.global-setup.ts": lines(
    'import { cleanupTestSchemas } from "./apps/backend/test-support/database";',
    'import { env } from "./apps/backend/shared/infra/env";',
  ),
  // backend-exports（Issue #68 の段階 2）: exports の過不足。
  //   "./features/todo/internal/presentation/*.api" は上の fixture の *.api への参照で使われ、bad-presentation.api.ts などに当たる（違反なし）。
  //   "./shared/http/problem" は使われるが、指すファイルが無い。"./features/todo/internal/domain/bad-domain" は使われない。
  //   "./mismatch" は使われるが、値が別のファイル（キーのパスのファイルも無い）。
  //   exports に無い参照（上の fixture の container・domain など）は、参照ごとに違反になる（下の MUST_REJECT_VIOLATIONS）。
  "apps/backend/package.json": JSON.stringify({
    name: "@repo/backend",
    exports: {
      "./features/todo/internal/presentation/*.api":
        "./features/todo/internal/presentation/*.api.ts",
      "./shared/http/problem": "./shared/http/problem.ts",
      "./features/todo/internal/domain/bad-domain":
        "./features/todo/internal/domain/bad-domain.ts",
      "./mismatch": "./features/todo/internal/domain/bad-domain.ts",
    },
  }),
  "apps/e2e/bad-exports.ts": lines(
    'import { x } from "@repo/backend/mismatch";',
    'import { todoRepository } from "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
    'import { env } from "@repo/backend";',
  ),
  // Issue #90: apps/shared（@repo/shared）。
  // screen-to-shared: 画面側（features/・app/・shared/）から apps/shared は、alias でも相対パスでも、型でも dynamic でも違反。
  //   相対パスのものは frontend-to-shared-specifier にもかかる。"@repo/shared/logger" は fixture の exports に無いので
  //   shared-exports にもかかる。
  "apps/frontend_customer/features/todo/components/bad-shared-base.tsx": lines(
    'import { logger } from "@repo/shared/logger";',
    'import type { Env } from "@repo/shared/env";',
    'const e = import("../../../../shared/env");',
  ),
  "apps/frontend_customer/app/bad-shared-page.tsx": lines(
    'import { env } from "@repo/shared/env";',
  ),
  "apps/frontend_customer/shared/bad-shared-base.ts": lines(
    'export { logger } from "@repo/shared/mismatch";',
  ),
  // frontend-to-shared-specifier: frontend 直下・apps/e2e/・リポジトリ直下から相対パス・"@/../shared/" で apps/shared を指す。
  //   参照先は許される（直下のサーバ側のファイルの env・logger）ので、この規則だけにかかる。
  "apps/frontend_customer/proxy.ts": lines(
    'import { logger } from "../shared/logger";',
    'import { env } from "@/../shared/env";',
  ),
  "apps/e2e/bad-shared.ts": lines('import { env } from "../shared/env";'),
  "bad-shared.config.mts": lines('import { env } from "./apps/shared/env";'),
  // shared-placement: 決めた名前以外のファイル（ソース・Markdown・テストだけのもの・入れ子のディレクトリの中）。
  //   入れ子の lib/logger.ts は例外の apps/shared/logger.ts ではないので、process.env と console も違反。
  "apps/shared/extra.ts": lines("export const x = 1;"),
  "apps/shared/README.md": "# shared",
  //   2 行目は server-hardcoded-text（apps/shared の日本語の文字列）の違反。
  "apps/shared/lib/logger.ts": lines(
    "console.log(process.env.X);",
    'export const m = "設定されていません";',
  ),
  "apps/shared/extra.test.ts": lines("console.log(1);"),
  // 例外の env.ts（process.env を読んでも違反にならない）と、shared-exports の違反を置いた package.json。
  //   "./env" は上の参照で使われ、ファイルもある（違反なし）。"./mismatch" は使われるが、値が別のファイルでキーのファイルも無い。
  //   "./unused" は使われず、ファイルも無い。
  //   shared-self-contained: apps/shared から外の自前コード（相対パス・"@/"）、フレームワーク・DB、node: 以外のパッケージ。
  //   class-based（Issue #262）: 最後の行の最上位の関数（apps/shared も対象）。
  "apps/shared/env.ts": lines(
    "export const env = process.env;",
    'import { todoRepository } from "../backend/features/todo/internal/infra/todo-repository.postgres";',
    'import { useState } from "react";',
    'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
    'export { TodoScreen } from "@/features/todo";',
    'const z = import("zod/v4");',
    'import { z as zod } from "zod";',
    'import { existsSync } from "node:fs";',
    'import { logger } from "./logger";',
    "export function load(): void {}",
  ),
  // class-based（Issue #262）: apps/shared の置いてよい名前のファイルの最上位の関数（置き場所の違反の巻き添えにしない）。
  //   クラスの static メソッド（2 行目）は拾わない。
  "apps/shared/log-event.ts": lines(
    "export const f = (x: number): number => x;",
    "export class LogSeverity { static of(): void {} }",
  ),
  "apps/shared/package.json": JSON.stringify({
    name: "@repo/shared",
    exports: {
      "./env": "./env.ts",
      "./mismatch": "./env.ts",
      "./unused": "./unused.ts",
    },
  }),
  // 層の規則の apps/shared の許可（SHARED_MODULES_BY_LAYER）: domain / application は使えない、presentation は logger だけ
  //   （Issue #90 で移す前の backend/shared/infra/logger も、もう使えない。Issue #310 で shared/infra/ は単位でもなくなった）、
  //   infra は env・logger だけ。
  "apps/backend/features/todo/internal/domain/bad-domain-shared.ts": lines(
    'import { logger } from "@repo/shared/logger";',
  ),
  "apps/backend/features/todo/internal/application/bad-application-shared.command.ts":
    lines('import { env } from "../../../../../shared/env";'),
  "apps/backend/features/todo/internal/presentation/bad-presentation-shared.api.ts":
    lines(
      'import { env } from "@repo/shared/env";',
      'import { logger } from "../../../../shared/infra/logger";',
    ),
  //   backend-relative-only: "@/" と相対パスで apps/shared を指すのは違反（"@repo/shared/..." だけを許す。Issue #90）。
  //   backend/shared は apps/shared のどのモジュールも使ってよい（Issue #310。backend-shared）ので、どの行も backend-relative-only
  //   だけにかかる（env-helper は shared-exports にもかかる）。
  "apps/backend/shared/drizzle/bad-shared-infra-base.ts": lines(
    'import { helper } from "@repo/shared/env-helper";',
    'import { env } from "@/../shared/env";',
    'import { logger } from "../../../shared/logger";',
  ),
  // now-single-source: now.ts 以外で現在時刻を読む。書き方ごとに 1 行ずつ置き、行番号で検出を比べる（11 行目の引数のある
  //   new Date と 12 行目のコメントは違反ではない）。画面側（.tsx・.mjs）、apps/shared の決めた名前以外のファイル（shared-placement
  //   にもかかる）、別の場所の now.ts、名前に test-support を含むがアプリの直下の test-support/ の下ではないファイル
  //   （以前の補助の目印 *.test-support.*。Issue #181）も置く。
  "apps/backend/features/todo/internal/domain/bad-now.ts": lines(
    "export const a = new Date();",
    "export const b = Date.now();",
    "export const c = new Date;",
    "export const d = globalThis.Date.now();",
    'export const e = Date["now"]();',
    "export const f = Date();",
    "export const g = new globalThis.Date( );",
    "export const h = Date?.now;",
    "export const i = new Date(",
    ");",
    'export const ok = new Date("2026-01-01T00:00:00.000Z");',
    "// new Date()",
  ),
  "apps/frontend_customer/features/todo/components/bad-now.tsx": lines(
    "export const t = new Date();",
  ),
  "apps/frontend_customer/shared/bad-now.mjs": lines(
    "export const n = Date.now();",
  ),
  "apps/shared/lib/clock.ts": lines("export const n = new Date();"),
  "apps/backend/shared/drizzle/now.ts": lines(
    "export class Clock { static now() { return new Date(); } }",
  ),
  "apps/backend/shared/drizzle/test-support-clock.ts": lines(
    "export const n = Date.now();",
  ),
  "apps/backend/shared/drizzle/old.test-support.ts": lines(
    "export const n = Date.now();",
  ),
  // class-based（Issue #262 の 2 つ目の PR）: テストの補助（test-support/・spec/ の support.ts・apps/e2e/ の spec 以外）の最上位の関数。
  "apps/backend/test-support/todo/bad-builder.ts": lines(
    "export function aThing(): void {}",
  ),
  "apps/backend/spec/api/todo/support.ts": lines(
    "export function given(): void {}",
  ),
  "apps/e2e/bad-helper.ts": lines(
    "export const reset = async (): Promise<void> => {};",
  ),
  // class-based（ADR 20261002-class-based-frontend-modules.md）: frontend の React 以外のモジュール（features/<f>/api/・shared/）の
  //   最上位の関数。同じディレクトリの component（.tsx）と hook（.hook.ts）の関数は対象外（拾わない）。
  "apps/frontend_customer/features/todo/api/bad-class-api.ts": lines(
    "export class TodoApi { static list(): void {} }",
    "export function listTodos(): void {}",
  ),
  "apps/frontend_customer/shared/i18n/bad-format.ts": lines(
    "export const formatDateTime = (iso: string): string => iso;",
  ),
  "apps/frontend_customer/features/todo/api/bad-api-view.tsx": lines(
    "export function View() { return null; }",
  ),
  "apps/frontend_customer/features/todo/api/bad-api.hook.ts": lines(
    "export function useApi(): void {}",
  ),
  // backend-placement / frontend-placement（Issue #181）: 直下の test-support/ と前方一致だけが同じ別ディレクトリ。
  "apps/backend/test-support-x/x.ts": lines("export const x = 1;"),
  "apps/frontend_customer/test-support-x/x.ts": lines("export const x = 1;"),
};

const MUST_REJECT_VIOLATIONS = [
  ...[1, 2, 3, 4, 5, 6, 7, 14].map(
    (line) => `class-based: apps/backend/shared/error/bad-function.ts:${line}`,
  ),
  "class-based: apps/backend/shared/drizzle/bad-function.mts:1",
  "class-based: apps/backend/features/notification/expose/bad-notify.ts:1",
  "class-based: apps/backend/shared/drizzle/drizzle.config.mts:1",
  "class-based: apps/shared/env.ts:10",
  "class-based: apps/shared/log-event.ts:1",
  "class-based: apps/backend/test-support/todo/bad-builder.ts:1",
  "class-based: apps/backend/spec/api/todo/support.ts:1",
  "class-based: apps/e2e/bad-helper.ts:1",
  "class-based: apps/frontend_customer/features/todo/api/bad-class-api.ts:2",
  "class-based: apps/frontend_customer/shared/i18n/bad-format.ts:1",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
    (line) =>
      `now-single-source: apps/backend/features/todo/internal/domain/bad-now.ts:${line}`,
  ),
  "now-single-source: apps/frontend_customer/features/todo/components/bad-now.tsx:1",
  "now-single-source: apps/frontend_customer/shared/bad-now.mjs:1",
  "now-single-source: apps/shared/lib/clock.ts:1",
  "shared-placement: apps/shared/lib/clock.ts",
  "now-single-source: apps/backend/shared/drizzle/now.ts:1",
  "now-single-source: apps/backend/shared/drizzle/test-support-clock.ts:1",
  "now-single-source: apps/backend/shared/drizzle/old.test-support.ts:1",
  "backend-placement: apps/backend/test-support-x/x.ts",
  "frontend-placement: apps/frontend_customer/test-support-x/x.ts",
  ...[3, 12, 15].map(
    (line) =>
      `presentation-with-problem-response: apps/backend/features/todo/internal/presentation/bad-handle.api.ts:${line}`,
  ),
  "presentation-with-problem-response: apps/backend/features/todo/internal/presentation/nested/bad-handle.api.mts:1",
  "presentation-with-problem-response: apps/backend/shared/http/bad-handle.api.ts:1",
  "frontend-placement: apps/frontend_customer/lib/db.ts",
  "frontend-placement: apps/frontend_customer/.lib/x.ts",
  "frontend-placement: apps/frontend_customer/next.config.mjs",
  "backend-placement: apps/backend/.lib/x.ts",
  "backend-to-frontend: apps/backend/.lib/x.ts → apps/frontend_customer/features/todo",
  "backend-relative-only: apps/backend/.lib/x.ts → apps/frontend_customer/features/todo",
  // Issue #68: 新しい 3 規則のための fixture（上の最後の 4 ファイル）。
  ...[
    "apps/backend/features/todo/internal/domain/todo",
    "apps/backend/features/todo/internal/domain/todo-repository",
    "apps/backend/shared/error/domain-error",
    "apps/backend/features/todo/internal/application/list-todos.query",
    "apps/backend",
  ].map(
    (to) =>
      `backend-relative-only: apps/backend/features/todo/internal/application/bad-alias.command.ts → ${to}`,
  ),
  "application: apps/backend/features/todo/internal/application/bad-alias.command.ts → apps/backend",
  ...[
    "apps/frontend_customer/next.config",
    "apps/frontend_customer/features/todo/api/todo-api",
    "apps/frontend_customer/features/todo",
  ].flatMap((to) => [
    `backend-to-frontend: apps/backend/shared/drizzle/drizzle.config.ts → ${to}`,
    `backend-shared: apps/backend/shared/drizzle/drizzle.config.ts → ${to}`,
  ]),
  "backend-relative-only: apps/backend/shared/drizzle/drizzle.config.ts → apps/frontend_customer/features/todo/api/todo-api",
  "backend-placement: apps/backend/features/todo/drizzle.config.ts",
  ...[
    "apps/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/backend/shared/drizzle/database",
    "apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/backend/shared/infra/env-helper",
  ].map(
    (to) =>
      `frontend-root-to-backend: apps/frontend_customer/next.config.ts → ${to}`,
  ),
  // Issue #90 で frontend-root-to-backend の例外（backend/shared/infra の env・logger）を無くしたので、相対パスの env も違反。
  "frontend-root-to-backend: apps/frontend_customer/instrumentation-node.ts → apps/backend/shared/infra/env",
  // Issue #90: apps/shared の規則。
  ...[
    "apps/frontend_customer/features/todo/components/bad-shared-base.tsx → apps/shared/logger",
    "apps/frontend_customer/features/todo/components/bad-shared-base.tsx → apps/shared/env",
    "apps/frontend_customer/features/todo/components/bad-shared-base.tsx → apps/shared/env",
    "apps/frontend_customer/app/bad-shared-page.tsx → apps/shared/env",
    "apps/frontend_customer/shared/bad-shared-base.ts → apps/shared/mismatch",
  ].map((line) => `screen-to-shared: ${line}`),
  ...[
    "apps/frontend_customer/features/todo/components/bad-shared-base.tsx → apps/shared/env",
    "apps/frontend_customer/proxy.ts → apps/shared/logger",
    "apps/frontend_customer/proxy.ts → apps/shared/env",
    "apps/e2e/bad-shared.ts → apps/shared/env",
    "bad-shared.config.mts → apps/shared/env",
  ].map((line) => `frontend-to-shared-specifier: ${line}`),
  ...[
    "apps/shared/extra.ts",
    "apps/shared/README.md",
    "apps/shared/lib/logger.ts",
    "apps/shared/extra.test.ts",
  ].map((file) => `shared-placement: ${file}`),
  "env-direct-access: apps/shared/lib/logger.ts:1",
  ...[
    "apps/backend/features/todo/internal/infra/todo-repository.postgres",
    "react",
    "drizzle-orm/node-postgres",
    "apps/frontend_customer/features/todo",
    "zod/v4",
  ].map((to) => `shared-self-contained: apps/shared/env.ts → ${to}`),
  "console-direct-access: apps/shared/lib/logger.ts:1",
  "domain: apps/backend/features/todo/internal/domain/bad-domain-shared.ts → apps/shared/logger",
  "application: apps/backend/features/todo/internal/application/bad-application-shared.command.ts → apps/shared/env",
  "presentation: apps/backend/features/todo/internal/presentation/bad-presentation-shared.api.ts → apps/shared/env",
  "presentation: apps/backend/features/todo/internal/presentation/bad-presentation-shared.api.ts → apps/backend/shared/infra/logger",
  "backend-relative-only: apps/backend/shared/drizzle/bad-shared-infra-base.ts → apps/shared/env",
  "backend-relative-only: apps/backend/shared/drizzle/bad-shared-infra-base.ts → apps/shared/logger",
  "backend-relative-only: apps/backend/features/todo/internal/application/bad-application-shared.command.ts → apps/shared/env",
  ...[
    "apps/frontend_customer/features/todo/components/bad-shared-base.tsx → @repo/shared/logger",
    "apps/backend/features/todo/internal/domain/bad-domain-shared.ts → @repo/shared/logger",
    "apps/backend/shared/drizzle/bad-shared-infra-base.ts → @repo/shared/env-helper",
    'apps/shared/package.json の exports "./mismatch" の値 "./env.ts" は、キーのパスに .ts を付けたものではない',
    'apps/shared/package.json の exports "./mismatch" が指すファイルが無い',
    'apps/shared/package.json の exports "./unused" はどこからも参照されていない',
    'apps/shared/package.json の exports "./unused" が指すファイルが無い',
  ].map((line) => `shared-exports: ${line}`),
  // Issue #68: 既存の fixture のうち、backend から画面側（features / shared / app）を参照している行は、層の規則に加えて
  //   backend-to-frontend にかかる。"@/" で書いたものは backend-relative-only にもかかる（相対パスで書いたものはかからない）。
  ...[
    "apps/backend/shared-x/domain/x.ts → apps/frontend_customer/features/todo",
    "apps/backend/shared/error/bad-shared-screen.ts → apps/frontend_customer/shared/x",
    "apps/backend/shared/http/bad-backend-shared.ts → apps/frontend_customer/app/page",
    "apps/backend/shared/http/bad-backend-shared.ts → apps/frontend_customer/features/todo",
    "apps/backend/features/todo/internal/application/bad-application.ts → apps/frontend_customer/features/todo/components/todo-item",
    "apps/backend/features/todo/internal/domain/bad-domain.ts → apps/frontend_customer/app/globals.css",
    "apps/backend/features/todo/internal/domain/bad-domain.ts → apps/frontend_customer/features/todo",
    "apps/backend/features/todo/internal/domain/bad-domain.ts → apps/frontend_customer/shared/x",
    "apps/backend/features/todo/internal/infra/bad-infra.ts → apps/frontend_customer/features/todo",
    "apps/backend/features/todo/internal/infra/bad-infra.ts → apps/frontend_customer/shared/x",
    "apps/backend/features/todo/p-root.ts → apps/frontend_customer/shared/x",
    "apps/backend/features/todo/internal/presentation/bad-presentation-2.api.ts → apps/frontend_customer/shared/x",
    "apps/backend/features/todo/internal/presentation/bad-presentation.api.ts → apps/frontend_customer/features/todo/api/todo-api",
  ].flatMap((line) => [
    `backend-to-frontend: ${line}`,
    `backend-relative-only: ${line}`,
  ]),
  ...[
    "apps/backend/features/todo/internal/application/bad-application-2.ts → apps/frontend_customer/shared/x",
    "apps/backend/features/todo/internal/application/bad-application.ts → apps/frontend_customer/app/page",
    "apps/backend/features/todo/internal/infra/bad-infra.ts → apps/frontend_customer/app/page",
    "apps/backend/features/todo/internal/presentation/bad-presentation.api.ts → apps/frontend_customer/app/globals.css",
  ].map((line) => `backend-to-frontend: ${line}`),
  "env-direct-access: apps/frontend_customer/instrumentation.ts:2",
  ...[1, 2, 4, 5, 6, 9, 10].map(
    (line) =>
      `env-direct-access: apps/backend/features/todo/internal/infra/bad-env.ts:${line}`,
  ),
  "env-direct-access: apps/e2e/bad-env.ts:1",
  "env-direct-access: bad.config.ts:1",
  "env-direct-access: bad.config.mjs:1",
  "env-direct-access: bad.config.cjs:1",
  "env-direct-access: apps/backend/shared/drizzle/env-helper.ts:1",
  ...[1, 2, 3, 4, 5, 8, 9].map(
    (line) =>
      `console-direct-access: apps/backend/features/todo/internal/presentation/bad-console.api.ts:${line}`,
  ),
  "console-direct-access: apps/frontend_customer/features/todo/components/bad-console.tsx:1",
  "console-direct-access: apps/e2e/bad-console.spec.ts:1",
  "console-direct-access: scripts/bad-console.ts:1",
  "console-direct-access: bad-console.config.mjs:1",
  "console-direct-access: apps/backend/shared/drizzle/logger-helper.ts:1",
  ...[2, 2, 3, 4, 4, 4, 4, 5, 7, 13, 14].map(
    (line) =>
      `frontend-hardcoded-text: apps/frontend_customer/features/todo/components/bad-text.tsx:${line}`,
  ),
  "frontend-hardcoded-text: apps/frontend_customer/features/todo/components/bad-text.jsx:1",
  "frontend-hardcoded-text: apps/frontend_customer/features/todo/api/bad-text.ts:1",
  "frontend-hardcoded-text: apps/frontend_customer/shared/i18n/messages/nested/ja.ts:1",
  "frontend-hardcoded-text: apps/frontend_customer/shared/i18n/ja.ts:1",
  "frontend-hardcoded-text: apps/frontend_customer/features/todo/components/bad-text.messages.tsx:1",
  "frontend-hardcoded-text: apps/frontend_customer/features/todo/components/bad-label.messages.ts:3",
  "frontend-hardcoded-text: apps/frontend_customer/shared/i18n/messages/ja.ts:1",
  ...[
    "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.messages",
    "apps/frontend_customer/features/todo/components/todo-item.messages",
    "apps/frontend_customer/features/todo/common.messages",
    "apps/frontend_customer/features/todo/screens/todo-screen/parts/header.messages",
  ].map(
    (to) =>
      `messages-colocation: apps/frontend_customer/features/todo/screens/todo-detail-screen/bad-import-messages.tsx → ${to}`,
  ),
  "messages-colocation: apps/frontend_customer/features/todo/bad-reexport-messages.ts → apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.messages",
  "messages-colocation: apps/frontend_customer/features/todo/screens/todo-screen/zz-barrel.ts → apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.messages",
  "messages-colocation: apps/frontend_customer/features/todo/screens/todo-screen/zz-barrel.ts → apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.messages",
  "messages-colocation: apps/e2e/bad-messages.spec.ts → apps/frontend_customer/shared/i18n/common.messages",
  "server-hardcoded-text: apps/backend/features/todo/internal/domain/bad-text.ts:2",
  "server-hardcoded-text: apps/backend/features/todo/internal/domain/bad-text.ts:4",
  "server-hardcoded-text: apps/shared/lib/logger.ts:2",
  ...[
    "apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/backend/features/todo/internal/domain/todo",
    "apps/backend/features/todo/internal/presentation/get-todo.api",
    "apps/backend/features/todo/internal/presentation/update-todo.api",
    "apps/backend/features/todo/internal/presentation/delete-todo.api",
    "apps/backend/features/todo/internal/presentation/create-todo.api",
    "apps/backend/shared/http/problem",
    "apps/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/backend/shared/http/json-body",
  ].map(
    (to) =>
      `screen-to-backend: apps/frontend_customer/features/todo/components/bad-backend.ts → ${to}`,
  ),
  "screen-to-backend: apps/frontend_customer/shared/bad-shared.tsx → apps/backend/features/todo/internal/presentation/list-todos.api",
  "screen-to-backend: apps/frontend_customer/shared/bad-shared.tsx → apps/backend/shared/error/domain-error",
  "shared-to-features: apps/frontend_customer/shared/bad-shared.tsx → apps/frontend_customer/features/todo",
  "shared-to-features: apps/frontend_customer/shared/bad-shared.tsx → apps/frontend_customer/features/todo/api/todo-api",
  "shared-to-features: apps/frontend_customer/shared/bad-shared.tsx → apps/frontend_customer/features/todo/components/todo-item",
  "screen-to-app: apps/frontend_customer/shared/bad-shared.tsx → apps/frontend_customer/app/page",
  "screen-to-app: apps/frontend_customer/shared/bad-shared.tsx → apps/frontend_customer/app/layout",
  ...[
    "apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/backend/features/todo/internal/domain/todo",
    "apps/backend/features/other/internal/presentation/list-others.api",
    "apps/backend/features/todo/internal/presentation/get-todo.api",
    "apps/backend/shared/http/problem",
    "apps/backend/features/todo/internal/presentation/list-todos",
    "apps/backend/shared/error/domain-error",
    "apps/backend/features/todo/internal/presentation/update-todo.api",
  ].map(
    (to) =>
      `feature-api-to-backend: apps/frontend_customer/features/todo/api/bad-api.ts → ${to}`,
  ),
  ...[
    "apps/frontend_customer/features/todo/components/todo-item",
    "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.hook",
    "apps/frontend_customer/features/todo/api/todo-api",
    "apps/frontend_customer/features/todo/api/todo-api",
    "apps/frontend_customer/features/todo/components",
  ].map(
    (to) =>
      `feature-to-feature: apps/frontend_customer/features/other/components/bad-feature.js → ${to}`,
  ),
  "feature-to-feature: apps/frontend_customer/features/todo/components/bad-prefix.jsx → apps/frontend_customer/features/todo-extra/components/x",
  "screen-to-app: apps/frontend_customer/features/todo/screens/s/bad-app.tsx → apps/frontend_customer/app/page",
  "screen-to-app: apps/frontend_customer/features/todo/screens/s/bad-app.tsx → apps/frontend_customer/app/api/todos/route",
  "screen-to-app: apps/frontend_customer/features/todo/screens/s/bad-app.tsx → apps/frontend_customer/app/layout",
  ...[
    "next/server",
    "react/jsx-runtime",
    "react-dom/client",
    "apps/backend/features/todo/internal/application/create-todo.command",
    "apps/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/backend/features/other/internal/domain/other",
    "apps/backend/shared/presentation/problem",
    "apps/frontend_customer/features/todo",
    "apps/frontend_customer/shared/x",
    "apps/frontend_customer/app/globals.css",
  ].map(
    (to) =>
      `domain: apps/backend/features/todo/internal/domain/bad-domain.ts → ${to}`,
  ),
  ...[
    "apps/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/backend/shared/presentation/problem",
    "react",
    "next/navigation",
    "react-dom",
    "apps/frontend_customer/features/todo/components/todo-item",
    "apps/frontend_customer/app/page",
  ].map(
    (to) =>
      `application: apps/backend/features/todo/internal/application/bad-application.ts → ${to}`,
  ),
  ...[
    "apps/backend/features/todo/internal/infra/todo-repository.in-memory",
    "apps/backend/features/todo/internal/infra/todo-repository.postgres-helper",
    "apps/backend/features/todo/internal/domain/todo",
    "apps/backend/features/todo/internal/domain/todo-factory",
    "apps/backend/features/todo/internal/domain/todo-entity",
    "apps/backend/features/todo/internal/domain/todo-keyed",
    "apps/backend/features/todo/internal/domain/todo-mixed",
    "apps/backend/features/todo/internal/domain/todo-constants",
    "apps/backend/features/todo/internal/domain/todo-alias",
    "apps/backend/features/todo/internal/domain/todo-default",
    "apps/backend/features/todo/internal/domain/todo-namespace",
    "next/server",
    "react",
    "apps/frontend_customer/features/todo/api/todo-api",
    "apps/backend/features/other/internal/infra/other-repository.in-memory",
    "apps/frontend_customer/app/globals.css",
  ].map(
    (to) =>
      `presentation: apps/backend/features/todo/internal/presentation/bad-presentation.api.ts → ${to}`,
  ),
  ...[
    "apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/backend/features/todo/internal/presentation/get-todo.api",
    "apps/backend/features/other/internal/domain/other",
    "apps/backend/features/other/internal/application/other.query",
    "apps/frontend_customer/features/todo",
    "apps/frontend_customer/shared/x",
    "apps/frontend_customer/app/page",
    "next/headers",
    "react-dom/server",
    "apps/backend/features/other/internal/infra/other-repository.postgres",
  ].map(
    (to) =>
      `infra: apps/backend/features/todo/internal/infra/bad-infra.ts → ${to}`,
  ),
  ...[
    "apps/backend/features/todo/internal/domain/todo",
    "apps/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/backend/features/todo/internal/domain/todo-factory",
    "apps/frontend_customer/features/todo",
    "apps/frontend_customer/app/page",
    "apps/backend/features/todo/internal/infra/todo-repository.in-memory",
    "apps/backend/features/todo/internal/domain/todo-constants",
  ].map(
    (to) =>
      `backend-shared: apps/backend/shared/http/bad-backend-shared.ts → ${to}`,
  ),
  ...[
    "apps/backend/features/other/internal/domain/other",
    "apps/frontend_customer/shared/x",
    "apps/backend/features/other/internal/application/other.query",
  ].map(
    (to) =>
      `application: apps/backend/features/todo/internal/application/bad-application-2.ts → ${to}`,
  ),
  ...[
    "apps/backend/features/other/internal/infra/other-repository.postgres",
    "apps/backend/features/other/internal/application/other.query",
    "apps/backend/features/other/internal/domain/other",
    "apps/frontend_customer/shared/x",
    "apps/backend/features/other/internal/domain/other-constants",
  ].map(
    (to) =>
      `presentation: apps/backend/features/todo/internal/presentation/bad-presentation-2.api.ts → ${to}`,
  ),
  "backend-shared: apps/backend/shared/error/bad-shared-screen.ts → apps/frontend_customer/shared/x",
  "backend-placement: apps/backend/features/todo/p-root.ts",
  "backend-placement: apps/backend/features/todo/lib/x.ts",
  // Issue #208 モジュールの境界。
  "backend-placement: apps/backend/features/notification/expose/nested/x.ts",
  "backend-placement: apps/backend/features/notification/expose-x/x.ts",
  ...[
    "application: apps/backend/features/todo/internal/application/bad-module-expose.command.ts",
    "domain: apps/backend/features/todo/internal/domain/bad-module-expose.ts",
    "infra: apps/backend/features/todo/internal/infra/bad-module-expose.ts",
  ].flatMap((line) => {
    const [rule, from] = line.split(": ");
    const to = "apps/backend/features/notification/expose/notifier";
    return [
      `${rule}: ${from} → ${to}`,
      `module-expose-only-from-presentation: ${from} → ${to}`,
    ];
  }),
  "presentation: apps/backend/features/todo/internal/presentation/bad-own-expose.api.ts → apps/backend/features/todo/expose/x",
  ...[
    "apps/backend/features/notification/internal/domain/notification-sender",
    "apps/backend/features/notification/internal/application/send-notification.command",
  ].flatMap((to) => [
    `application: apps/backend/features/todo/internal/application/bad-module-internal.command.ts → ${to}`,
    `module-internal: apps/backend/features/todo/internal/application/bad-module-internal.command.ts → ${to}`,
  ]),
  ...[
    "apps/backend/features/todo/internal/domain/todo",
    "apps/backend/features/todo/expose/x",
    "next/server",
    "apps/backend/features/notification/lib/y",
  ].map(
    (to) =>
      `expose-imports: apps/backend/features/notification/expose/bad-expose.ts → ${to}`,
  ),
  "module-internal: apps/backend/features/notification/expose/bad-expose.ts → apps/backend/features/todo/internal/domain/todo",
  "module-expose-only-from-presentation: apps/backend/features/notification/expose/bad-expose.ts → apps/backend/features/todo/expose/x",
  // 他 feature の internal への参照（上の層の規則の fixture）は、module-internal にも重ねてかかる。
  ...[
    "domain: apps/backend/features/todo/internal/domain/bad-domain.ts → apps/backend/features/other/internal/domain/other",
    "presentation: apps/backend/features/todo/internal/presentation/bad-presentation.api.ts → apps/backend/features/other/internal/infra/other-repository.in-memory",
    "infra: apps/backend/features/todo/internal/infra/bad-infra.ts → apps/backend/features/other/internal/domain/other",
    "infra: apps/backend/features/todo/internal/infra/bad-infra.ts → apps/backend/features/other/internal/application/other.query",
    "infra: apps/backend/features/todo/internal/infra/bad-infra.ts → apps/backend/features/other/internal/infra/other-repository.postgres",
    "application: apps/backend/features/todo/internal/application/bad-application-2.ts → apps/backend/features/other/internal/domain/other",
    "application: apps/backend/features/todo/internal/application/bad-application-2.ts → apps/backend/features/other/internal/application/other.query",
    "presentation: apps/backend/features/todo/internal/presentation/bad-presentation-2.api.ts → apps/backend/features/other/internal/infra/other-repository.postgres",
    "presentation: apps/backend/features/todo/internal/presentation/bad-presentation-2.api.ts → apps/backend/features/other/internal/application/other.query",
    "presentation: apps/backend/features/todo/internal/presentation/bad-presentation-2.api.ts → apps/backend/features/other/internal/domain/other",
    "presentation: apps/backend/features/todo/internal/presentation/bad-presentation-2.api.ts → apps/backend/features/other/internal/domain/other-constants",
  ].map((line) => `module-internal: ${line.slice(line.indexOf(": ") + 2)}`),
  "backend-placement: apps/backend/x.ts",
  "backend-placement: apps/backend/shared/bad-root.ts",
  "backend-placement: apps/backend/features/x.ts",
  "backend-placement: apps/backend/todo/domain/old.ts",
  "backend-placement: apps/backend/features/todo/domain/old-layer.ts",
  "backend-placement: apps/backend/features/todo/internal/x.ts",
  "backend-placement: apps/backend/shared/domain/old-layer.ts",
  "backend-placement: apps/backend/shared/foo/x.ts",
  "backend-placement: apps/backend/shared-x/domain/x.ts",
  "app: apps/frontend_customer/app/api-x/route.ts → apps/backend/features/todo/internal/presentation/list-todos.api",
  "screen-to-backend: apps/frontend_customer/features/todo/components/test-helper.tsx → apps/backend/features/todo/internal/domain/todo",
  "screen-to-backend: apps/frontend_customer/features/todo/components/bad-ext.mts → apps/backend/features/todo/internal/domain/todo",
  "screen-to-backend: apps/frontend_customer/features/todo/components/bad-ext.mts → apps/backend/features/todo/internal/infra/todo-repository.postgres",
  "screen-to-backend: apps/frontend_customer/features/todo/components/bad-ext.cts → apps/backend/features/todo/internal/presentation/get-todo.api",
  "screen-to-backend: apps/frontend_customer/features/todo/components/bad-ext.mjs → apps/backend/shared/http/problem",
  "screen-to-backend: apps/frontend_customer/features/todo/components/bad-ext.cjs → apps/backend/features/todo/internal/infra/todo-repository.in-memory",
  "backend-shared: apps/backend/shared/bad-root.ts → apps/backend/features/todo/internal/application/create-todo.command",
  ...[
    "apps/frontend_customer/features/todo/components/todo-item",
    "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.hook",
    "apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/backend/features/todo/internal/presentation/get-todo.api",
    "apps/frontend_customer/features/todo/api/todo-api",
    "apps/frontend_customer/features/todo-extra/components/y",
  ].map((to) => `app: apps/frontend_customer/app/bad-page.tsx → ${to}`),
  "app: apps/frontend_customer/app/todo/[id]/bad.jsx → apps/frontend_customer/features/todo/components/todo-item",
  ...[
    "apps/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/backend/features/todo/internal/application/create-todo.command",
    "next/server",
    "apps/frontend_customer/features/todo",
    "apps/backend/features/todo/internal/presentation/update-todo",
    "apps/backend/shared/http/problem",
    "apps/frontend_customer/shared/x",
  ].map(
    (to) =>
      `app-api: apps/frontend_customer/app/api/todos/bad-route.ts → ${to}`,
  ),
  "domain: apps/backend/features/todo/internal/domain/bad-domain-infra.ts → apps/backend/test-support/database",
  "domain: apps/backend/features/todo/internal/domain/bad-domain-application.ts → apps/backend/shared/application/x",
  "infra: apps/backend/features/todo/internal/infra/bad-infra-application.ts → apps/backend/features/todo/internal/application/create-todo.command",
  "infra: apps/backend/features/todo/internal/infra/bad-infra-application.ts → apps/backend/shared/application/x",
  ...[
    "apps/backend/features/todo/internal/infra/schema",
    "apps/backend/test-support/database",
    "apps/backend/test-support/transaction-runner.in-memory",
  ].map(
    (to) =>
      `presentation: apps/backend/features/todo/internal/presentation/bad-presentation-infra.api.ts → ${to}`,
  ),
  "backend-shared: apps/backend/shared/drizzle/bad-shared-infra.ts → apps/backend/features/todo/internal/infra/schema",
  "backend-shared: apps/backend/shared/drizzle/bad-shared-infra.ts → next/server",
  ...["drizzle-orm/pg-core", "drizzle-orm", "pg"].map(
    (to) =>
      `core-to-persistence: apps/backend/features/todo/internal/domain/bad-domain-db.ts → ${to}`,
  ),
  ...["drizzle-orm", "drizzle-orm/node-postgres", "pg"].map(
    (to) =>
      `core-to-persistence: apps/backend/features/todo/internal/application/bad-application-db.command.ts → ${to}`,
  ),
  // Issue #68 の段階 2: frontend-to-backend-specifier。上の fixture のうち、frontend・apps/e2e/・リポジトリ直下から相対パス
  //   （と "@/../backend/"）で backend を指すものは、ほかの規則の結果に関係なくすべてかかる。
  ...[
    "apps/frontend_customer/app/api/todos/[id]/bad-relative.ts → apps/backend/features/todo/internal/presentation/update-todo.api",
    "apps/frontend_customer/app/api/todos/bad-route.ts → apps/backend/features/todo/internal/application/create-todo.command",
    "apps/frontend_customer/app/bad-page.tsx → apps/backend/features/todo/internal/presentation/get-todo.api",
    "apps/frontend_customer/features/todo/api/bad-api.ts → apps/backend/shared/http/problem",
    "apps/frontend_customer/features/todo/api/bad-api.ts → apps/backend/features/todo/internal/domain/todo",
    "apps/frontend_customer/features/todo/api/bad-specifier.ts → apps/backend/features/todo/internal/presentation/get-todo.api",
    "apps/frontend_customer/features/todo/api/bad-specifier.ts → apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/frontend_customer/features/todo/components/bad-backend.ts → apps/backend/shared/http/json-body",
    "apps/frontend_customer/features/todo/components/bad-backend.ts → apps/backend/features/todo/internal/domain/todo",
    "apps/frontend_customer/features/todo/components/bad-backend.ts → apps/backend/features/todo/internal/presentation/delete-todo.api",
    "apps/frontend_customer/features/todo/components/bad-ext.mjs → apps/backend/shared/http/problem",
    "apps/frontend_customer/instrumentation-node.ts → apps/backend/shared/infra/env",
    "apps/frontend_customer/next.config.ts → apps/backend/shared/drizzle/database",
    "apps/frontend_customer/shared/bad-shared.tsx → apps/backend/features/todo/internal/presentation/list-todos.api",
    "apps/e2e/bad-relative.ts → apps/backend/shared/infra/env",
    "vitest.global-setup.mts → apps/backend/test-support/database",
    "vitest.global-setup.ts → apps/backend/shared/infra/env",
  ].map((line) => `frontend-to-backend-specifier: ${line}`),
  // Issue #68 の段階 2: backend-exports。"@repo/backend/..." の参照のうち、fixture の exports のどのキーにも当たらないもの
  //   （container・domain・application・他 feature・.api の付かない presentation・パッケージ名だけ）と、exports の各キーの違反。
  ...[
    "apps/frontend_customer/app/api/todos/bad-route.ts → @repo/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/frontend_customer/app/api/todos/bad-route.ts → @repo/backend/features/todo/internal/presentation/update-todo",
    "apps/frontend_customer/features/todo/api/bad-api.ts → @repo/backend/features/other/internal/presentation/list-others.api",
    "apps/frontend_customer/features/todo/api/bad-api.ts → @repo/backend/shared/error/domain-error",
    "apps/frontend_customer/features/todo/api/bad-api.ts → @repo/backend/features/todo/internal/presentation/list-todos",
    "apps/frontend_customer/features/todo/components/bad-backend.ts → @repo/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/frontend_customer/features/todo/components/bad-ext.cjs → @repo/backend/features/todo/internal/infra/todo-repository.in-memory",
    "apps/frontend_customer/features/todo/components/bad-ext.mts → @repo/backend/features/todo/internal/domain/todo",
    "apps/frontend_customer/features/todo/components/bad-ext.mts → @repo/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/frontend_customer/features/todo/components/test-helper.tsx → @repo/backend/features/todo/internal/domain/todo",
    "apps/frontend_customer/lib/db.ts → @repo/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/frontend_customer/next.config.ts → @repo/backend/shared/infra/env-helper",
    "apps/frontend_customer/next.config.ts → @repo/backend/features/todo/internal/infra/todo-repository.postgres",
    "apps/frontend_customer/shared/bad-shared.tsx → @repo/backend/shared/error/domain-error",
    "apps/e2e/bad-exports.ts → @repo/backend",
    "apps/e2e/bad-exports.ts → @repo/backend/features/todo/internal/infra/todo-repository.postgres",
    'apps/backend/package.json の exports "./mismatch" が指すファイルが無い',
    'apps/backend/package.json の exports "./mismatch" の値 "./features/todo/internal/domain/bad-domain.ts" は、キーのパスに .ts を付けたものではない',
    'apps/backend/package.json の exports "./shared/http/problem" が指すファイルが無い',
    'apps/backend/package.json の exports "./features/todo/internal/domain/bad-domain" はどこからも参照されていない',
  ].map((line) => `backend-exports: ${line}`),
];

// must-pass: 許可される参照を網羅する。今のリポジトリの本番コードにある import の形
// （`git grep -h "from \"" -- '*.ts' '*.tsx'` で列挙したもの）をすべて含め、alias と相対の両方を置く。
// コメント・文字列の中の import 風の文字列、from の無い `export type {...};`、テストファイル・TS 以外のファイルも置く。
const MUST_PASS_FILES: Record<string, string> = {
  // class-based（Issue #262）: static だけのクラス・クラスフィールドのアロー関数・メソッドの中の関数・クラス式・
  //   型と interface・定数のオブジェクト・コメントと文字列の中の function。テスト（test-support/ の中のテストも）と
  //   E2E のテスト（*.spec.ts）の関数は対象外（apps/shared のクラスは下の now-single-source の apps/shared/now.ts、
  //   テストの関数は apps/shared/env.test.ts、E2E のテストの関数は下の apps/e2e/todo.spec.ts）。
  "apps/backend/shared/error/good-class.ts": lines(
    "export type F = (x: number) => number;",
    "export interface Notifier { notify(message: string): void; }",
    'export const KEYS = { a: "a" } as const;',
    "export class Validate {",
    "  static of(x: number): number { function inner(): number { return x; } return inner(); }",
    "  private readonly twice = (x: number): number => x * 2;",
    "}",
    "export const Other = class { static f(): void {} };",
    "// export function commented(): void {}",
    'export const S = "export function inString() {}";',
  ),
  "apps/backend/shared/error/good-class.test.ts": lines(
    "function helper(): number { return 1; }",
  ),
  "apps/backend/test-support/class-based-helper.test.ts": lines(
    "function helper(): number { return 1; }",
  ),
  "apps/backend/test-support/class-based-helper.ts": lines(
    "export class Helper { static build(): void {} }",
  ),
  // presentation-with-problem-response（Issue #141）: ProblemResponse.wrap で包んだ handle（ctx あり・なし）。
  //   対象外: api ファイルでない presentation のファイル、テスト、ほかの層の handle。
  "apps/backend/features/todo/internal/presentation/good-handle.api.ts": lines(
    'import { ProblemResponse } from "../../../../shared/http/problem";',
    "export class ListApi {",
    "  readonly handle = ProblemResponse.wrap(async (request: Request) => new Response(null));",
    "}",
    "export class GetApi {",
    "  readonly handle = ProblemResponse.wrap(",
    "    async (request: Request, ctx: { params: Promise<{ id: string }> }) => {",
    "      await ctx.params;",
    "      return new Response(null);",
    "    },",
    "  );",
    "}",
  ),
  "apps/backend/features/todo/internal/presentation/good-handle-helper.ts":
    lines(
      "export class Helper { handle = async (request: Request) => new Response(null); }",
    ),
  "apps/backend/features/todo/internal/presentation/good-handle.api.test.ts":
    lines(
      "export class RawApi { handle = async (request: Request) => new Response(null); }",
    ),
  "apps/backend/features/todo/internal/application/good-handle.ts": lines(
    "export class Helper { handle = async (request: Request) => new Response(null); }",
  ),
  "apps/frontend_customer/app/layout.tsx": lines(
    'import type { Metadata } from "next";',
    'import { Inter } from "next/font/google";',
    'import "./globals.css";',
    // frontend-hardcoded-text（Issue #116）: JSX ではない ASCII の文字列は文言として扱わない。
    'export const metadata = { title: "ai-only-template" };',
  ),
  "apps/frontend_customer/app/globals.css": "body { margin: 0; }",
  "apps/frontend_customer/app/page.tsx": lines(
    'import { TodoScreen } from "@/features/todo";',
    'import { commonMessages } from "../shared/i18n/common.messages";',
    "const lazy = import(`@/features/todo`);",
    'import { x } from "@/shared/x";',
    'import { useState } from "react";',
    'import Link from "next/link";',
  ),
  "apps/frontend_customer/app/todo/[id]/page.tsx": lines(
    'import { TodoDetailScreen } from "@/features/todo";',
    'import { TodoScreen } from "../../../features/todo/index";',
  ),
  "apps/frontend_customer/app/api/todos/route.ts": lines(
    'export { POST } from "@repo/backend/features/todo/internal/presentation/create-todo.api";',
    'export { GET } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
  ),
  "apps/frontend_customer/app/api/todos/[id]/route.ts": lines(
    'export { DELETE } from "@repo/backend/features/todo/internal/presentation/delete-todo.api";',
    'export { GET } from "@repo/backend/features/todo/internal/presentation/get-todo.api";',
    'export { PUT } from "@repo/backend/features/todo/internal/presentation/update-todo.api";',
  ),
  "apps/frontend_customer/features/todo/index.ts": lines(
    'export { TodoDetailScreen } from "./screens/todo-detail-screen/todo-detail-screen";',
    'export { TodoScreen } from "./screens/todo-screen/todo-screen";',
  ),
  "apps/frontend_customer/features/todo/api/todo-api.ts": lines(
    'import type { Problem } from "@repo/backend/shared/http/problem";',
    "import type {",
    "  CreateTodoRequest,",
    "  CreateTodoResponse,",
    '} from "@repo/backend/features/todo/internal/presentation/create-todo.api";',
    'import type { GetTodoResponse } from "@repo/backend/features/todo/internal/presentation/get-todo.api";',
    "import type {",
    "  ListTodosResponse,",
    '} from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
    "import type {",
    "  UpdateTodoRequest,",
    "  UpdateTodoResponse,",
    '} from "@repo/backend/features/todo/internal/presentation/update-todo.api";',
    'import { type UpdateTodoRequest as Req, type UpdateTodoResponse as Res } from "@repo/backend/features/todo/internal/presentation/update-todo.api";',
    'export type { DeleteTodoResponse } from "@repo/backend/features/todo/internal/presentation/delete-todo.api";',
    "export type {",
    "  CreateTodoRequest,",
    "  CreateTodoResponse,",
    "  Problem,",
    "};",
    'const BASE_PATH = "/api/todos";',
  ),
  "apps/frontend_customer/features/todo/components/todo-item.tsx": lines(
    'import Link from "next/link";',
    'import type { Todo } from "@/features/todo/api/todo-api";',
    // messages-colocation（Issue #125）: 同じディレクトリの辞書と、*.messages ではない名前（前方一致だけが同じ、パッケージ）。
    'import { todoItemMessages } from "./todo-item.messages";',
    'import { helper } from "../screens/todo-screen/todo-screen.messages-helper";',
    'import { m } from "some-lib/app.messages";',
  ),
  "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx":
    lines(
      '"use client";',
      'import { commonMessages } from "@/shared/i18n/common.messages";',
      'import { useT } from "@/shared/i18n/i18n";',
      'import { TodoItem } from "../../components/todo-item";',
      'import { useTodoScreen } from "./todo-screen.hook";',
      'import { todoScreenMessages } from "./todo-screen.messages";',
    ),
  "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.test.tsx":
    lines(
      'import { todoItemMessages } from "@/features/todo/components/todo-item.messages";',
    ),
  "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.hook.ts":
    lines(
      'import { useCallback, useEffect, useRef, useState } from "react";',
      'import type { todoScreenMessages } from "@/features/todo/screens/todo-screen/todo-screen.messages";',
      "import {",
      "  TodoApi,",
      "  type Todo,",
      '} from "@/features/todo/api/todo-api";',
    ),
  "apps/frontend_customer/features/todo/screens/todo-detail-screen/todo-detail-screen.tsx":
    lines(
      '"use client";',
      'import Link from "next/link";',
      'import { useTodoDetailScreen } from "./todo-detail-screen.hook";',
    ),
  "apps/frontend_customer/features/todo/screens/todo-detail-screen/todo-detail-screen.hook.ts":
    lines(
      'import { useCallback, useEffect, useRef, useState } from "react";',
      "import {",
      "  TodoApi,",
      "  type Todo,",
      '} from "@/features/todo/api/todo-api";',
    ),
  // 別 feature からは index だけ（alias と相対、index の明示あり・なし）。画面側の shared/ は参照してよい。
  "apps/frontend_customer/features/other/components/uses-todo.jsx": lines(
    'import { TodoScreen } from "@/features/todo";',
    'import { TodoDetailScreen } from "../../todo/index";',
    'import { x } from "@/shared/x";',
  ),
  "apps/frontend_customer/shared/x.js": lines(
    'import { useState } from "react";',
  ),
  "apps/frontend_customer/shared/ui/button.tsx": lines(
    'import { x } from "../x";',
  ),
  // コメント・文字列の中の import 風の文字列は参照ではない。
  "apps/frontend_customer/features/todo/components/notes.ts": lines(
    '// import { GET } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
    '/* export { x } from "@/app/page"; */',
    "/**",
    ' * 例: import("@repo/backend/features/todo/internal/infra/todo-repository.postgres")',
    ' * import "@repo/backend/features/todo/internal/domain/todo";',
    " */",
    "export const single = 'import { GET } from \"@/backend/x\";';",
    "export const double = \"import('@repo/backend/y')\";",
    "export const side = 'import \"@/backend/z\"';",
    "export const template = `",
    'import { a } from "@/app/page";',
    "`;",
    'export const url = "https://example.com/import/from"; import { useState } from "react";',
  ),
  "apps/backend/shared/error/domain-error.ts": lines(
    "export class DomainError extends Error {}",
  ),
  "apps/backend/shared/http/problem.ts": lines(
    "import {",
    "  DomainError,",
    "  type DomainErrorCode,",
    '} from "../error/domain-error";',
    // Issue #85: 想定外の例外はログの唯一の出口（Issue #90 で apps/shared に移した logger）で残す。
    'import { logger } from "@repo/shared/logger";',
    'logger.emit({ message: "x", event: { name: "server_error" } });',
  ),
  // console を直接書いてよいのは logger.ts だけ（Issue #85。Issue #90 で apps/shared に移した）。
  "apps/shared/logger.ts": lines(
    'import type { Env } from "./env";',
    "export const logger = {",
    "  info: (line: string) => console.log(line),",
    "  warn: (line: string) => console.warn(line),",
    "  error: (line: string) => globalThis.console.error(line),",
    "};",
  ),
  // logger.ts 以外の、console に見えるが参照ではないもの（コメント・文字列・別の識別子）。
  "apps/backend/features/todo/internal/infra/console-lookalikes.ts": lines(
    '// console.log("x") は logger から出す',
    "/* console.error */",
    'const s = "console.log(1)";',
    "const t = 'console[\"log\"]';",
    "const consoleLog = read(); consoleLog.x;",
    "myconsole.log(1); console_.log(2);",
  ),
  // テストの console（出力の抑制や spy）は検査しない。
  "apps/shared/logger.test.ts": lines('vi.spyOn(console, "log");'),
  "scripts/hooks/tool.test.ts": lines("console.log(1);"),
  "apps/frontend_customer/features/todo/components/x.test.tsx":
    lines("console.error(1);"),
  "scripts/tool.sh": lines("console.log(1)"),
  "apps/backend/shared/http/json-body.ts": lines(
    'import { z } from "zod";',
    'import { type ProblemErrorInput, InvalidRequestError } from "./problem";',
    'import { ProblemResponse } from "./problem";',
  ),
  "apps/backend/features/todo/internal/domain/todo.ts": lines(
    'import { randomUUID } from "node:crypto";',
    'import { now } from "@repo/shared/now";',
    'import { z } from "zod";',
    'import { DomainError } from "../../../../shared/error/domain-error";',
    'import { DomainError as E } from "../../../../shared/error/domain-error";',
  ),
  "apps/backend/features/todo/internal/domain/todo-repository.ts": lines(
    'import type { Todo } from "./todo";',
    'import { Todo as T } from "./todo";',
    // Issue #230: Repository の interface の引数に取る印の型 Transaction は、shared/transaction/transaction から型だけ参照する。
    'import type { Transaction } from "../../../../shared/transaction/transaction";',
  ),
  // Issue #310（ユーザー判断）: feature のどの層も backend/shared のどの単位も参照してよい（値・型・re-export・dynamic import）。
  //   以前は違反だった参照（domain から drizzle・http、application から drizzle の runner、infra から transaction の値、
  //   presentation から writer）も通る。
  "apps/backend/features/todo/internal/domain/good-shared-units-domain.ts":
    lines(
      'import { Transaction } from "../../../../shared/transaction/transaction";',
      'import type { Database } from "../../../../shared/drizzle/database";',
      'import { ProblemResponse } from "../../../../shared/http/problem";',
      'export type { ChangeOperation } from "../../../../shared/change-log/change-operation";',
      'import { ErrorKey } from "../../../../shared/error/error-key";',
    ),
  "apps/backend/features/todo/internal/application/good-shared-units-application.ts":
    lines(
      'import { PostgresTransactionRunner } from "../../../../shared/drizzle/transaction.postgres";',
      'import { AppDatabase } from "../../../../shared/drizzle/database";',
      'const c = import("../../../../shared/change-log/change-log");',
      'import { JsonBody } from "../../../../shared/http/json-body";',
    ),
  "apps/backend/features/todo/internal/infra/good-shared-units-infra.ts": lines(
    'import { TransactionRunner } from "../../../../shared/transaction/transaction";',
    'export { Transaction } from "../../../../shared/transaction/transaction";',
    'import { ProblemResponse } from "../../../../shared/http/problem";',
    'import { changeLogs } from "../../../../shared/change-log/change-log.schema";',
  ),
  "apps/backend/features/todo/internal/presentation/good-shared-units-presentation.api.ts":
    lines(
      'import { PostgresWriter } from "../../../../shared/drizzle/writer";',
      'import { ColumnClassifier } from "../../../../shared/drizzle/column-classification";',
      'import { ChangeLog } from "../../../../shared/change-log/change-log";',
      'import type { Transaction } from "../../../../shared/transaction/transaction";',
    ),
  // Issue #310: backend/shared の中は単位をまたいでどの向きにも参照してよい（以前の shared の層の向きの縛りは無い）。
  "apps/backend/shared/error/good-shared-cross-unit.ts": lines(
    'import { ProblemResponse } from "../http/problem";',
    'import type { Database } from "../drizzle/database";',
    'import { env } from "@repo/shared/env";',
  ),
  "apps/backend/features/todo/internal/application/create-todo.command.ts":
    lines(
      // Issue #220・#230: トランザクションを張る口と brand の型 Transaction は、どちらも backend/shared/transaction（Issue #310 より前は shared の application）。
      'import type { Transaction, TransactionRunner } from "../../../../shared/transaction/transaction";',
      'import { Todo } from "../domain/todo";',
      'import type { TodoRepository } from "../domain/todo-repository";',
    ),
  "apps/backend/features/todo/internal/application/get-todo.query.ts": lines(
    'import { DomainError } from "../../../../shared/error/domain-error";',
    'import type { Todo } from "../domain/todo";',
    'import { DomainError as E } from "../../../../shared/error/domain-error";',
    'import { ListTodosQuery } from "./list-todos.query";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  "apps/backend/features/todo/internal/application/list-todos.query.ts": lines(
    'import type { Todo } from "../domain/todo";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  "apps/backend/features/todo/internal/application/update-todo.command.ts":
    lines(
      'import { DomainError } from "../../../../shared/error/domain-error";',
      'import type { Todo } from "../domain/todo";',
      'import type { TodoRepository } from "../domain/todo-repository";',
    ),
  "apps/backend/features/todo/internal/application/delete-todo.command.ts":
    lines(
      'import { DomainError } from "../../../../shared/error/domain-error";',
      'import type { TodoRepository } from "../domain/todo-repository";',
    ),
  // Issue #123: api ファイルが自分で組み立てる。自 feature の application（値）、Postgres の Repository の実装、
  //   backend/shared/drizzle/database（プール）を参照する（コンテナは廃止）。
  "apps/backend/features/todo/internal/presentation/list-todos.api.ts": lines(
    'import { AppDatabase } from "../../../../shared/drizzle/database";',
    'import { ProblemResponse } from "../../../../shared/http/problem";',
    'import { ListTodosQuery } from "../application/list-todos.query";',
    'import type { Todo } from "../domain/todo";',
    'import { PostgresTodoRepository } from "../infra/todo-repository.postgres";',
  ),
  "apps/backend/features/todo/internal/presentation/create-todo.api.ts": lines(
    'import { z } from "zod";',
    'import { ProblemResponse } from "../../../../shared/http/problem";',
    "import {",
    "  RequestBody,",
    '} from "../../../../shared/http/json-body";',
    'import { AppDatabase } from "../../../../shared/drizzle/database";',
    'import { CreateTodoCommand } from "../application/create-todo.command";',
    'import { PostgresTodoRepository } from "../infra/todo-repository.postgres";',
    // Issue #220: トランザクションの口（backend/shared/transaction）と runner の実装（backend/shared/drizzle。組み立て）。
    'import type { TransactionRunner } from "../../../../shared/transaction/transaction";',
    'import { PostgresTransactionRunner } from "../../../../shared/drizzle/transaction.postgres";',
    'import { DomainError } from "../../../../shared/error/domain-error";',
    'export type { Todo } from "../domain/todo";',
    'import { type Todo as T } from "../domain/todo";',
    // Issue #144: 自 feature の domain の定数（UPPER_SNAKE_CASE）は値で import できる。型との混在・複数行・別名も可。
    'import { TODO_TITLE_MAX_LENGTH } from "../domain/todo";',
    'import { type Todo as U, TODO_TITLE_MAX_LENGTH as MAX } from "../domain/todo";',
    "import {",
    "  TODO_A,",
    "  TODO_B_2,",
    '} from "../domain/todo";',
  ),
  "apps/backend/features/todo/internal/presentation/reexport.api.ts": lines(
    'import type { GetTodoResponse } from "./get-todo.api";',
    'import type { ListTodosQuery } from "../application/list-todos.query";',
    'import { GetTodoQuery } from "../application/get-todo.query";',
    'export { ProblemResponse } from "../../../../shared/http/problem";',
  ),
  "apps/frontend_customer/shared/y.mts": lines(
    'import { x } from "./x";',
    'const lazy = import(`./x`, { with: { type: "json" } });',
  ),
  "apps/backend/features/todo/internal/presentation/get-todo.api.ts": lines(
    'import { ProblemResponse } from "../../../../shared/http/problem";',
    'import { GetTodoQuery } from "../application/get-todo.query";',
    'import type { Todo } from "../domain/todo";',
    'import type { PostgresTodoRepository as R } from "../infra/todo-repository.postgres";',
    'import { PostgresTodoRepository } from "../infra/todo-repository.postgres";',
    'import { type Database, AppDatabase } from "../../../../shared/drizzle/database";',
  ),
  "apps/backend/features/todo/internal/presentation/update-todo.api.ts": lines(
    'import { z } from "zod";',
    'import { DomainError } from "../../../../shared/error/domain-error";',
    'import { ProblemResponse } from "../../../../shared/http/problem";',
    "import {",
    "  RequestBody,",
    '} from "../../../../shared/http/json-body";',
    'import type { Todo } from "../domain/todo";',
    'import { AppDatabase } from "../../../../shared/drizzle/database";',
    "import {",
    "  UpdateTodoCommand,",
    "  type UpdateTodoInput,",
    '} from "../application/update-todo.command";',
    'import { PostgresTodoRepository } from "../infra/todo-repository.postgres";',
  ),
  "apps/backend/features/todo/internal/presentation/delete-todo.api.ts": lines(
    'import { ProblemResponse } from "../../../../shared/http/problem";',
    'import { AppDatabase } from "../../../../shared/drizzle/database";',
    'import { DeleteTodoCommand } from "../application/delete-todo.command";',
    'const lazy = import("../infra/todo-repository.postgres");',
  ),
  // Issue #208 モジュールの境界: 公開の入口（expose）から自モジュールの internal（値・型）・expose の中・backend/shared・
  //   apps/shared の env / logger / now・Node の組み込み、組み立ての場所（presentation）から他のモジュールの expose（値・型）。
  "apps/backend/features/notification/expose/notifier.ts": lines(
    'import { logger } from "@repo/shared/logger";',
    'import { now } from "@repo/shared/now";',
    'import { randomUUID } from "node:crypto";',
    'import { SendNotificationCommand } from "../internal/application/send-notification.command";',
    'import { LogNotificationSender } from "../internal/infra/notification-sender.log";',
    'import type { NotificationSender } from "../internal/domain/notification-sender";',
    'import { AppDatabase } from "../../../shared/drizzle/database";',
    'import { env } from "@repo/shared/env";',
    'export type { Message } from "./message";',
  ),
  "apps/backend/features/notification/expose/message.ts": lines(
    "export type Message = string;",
  ),
  "apps/backend/features/notification/internal/infra/notification-sender.log.ts":
    lines(
      'import { logger } from "@repo/shared/logger";',
      'import type { NotificationSender } from "../domain/notification-sender";',
    ),
  "apps/backend/features/todo/internal/presentation/change-todo-completion.api.ts":
    lines(
      'import { Notifier } from "../../../notification/expose/notifier";',
      'import type { Message } from "../../../notification/expose/message";',
      'import { ChangeTodoCompletionCommand } from "../application/change-todo-completion.command";',
    ),
  // Issue #57: 永続化（Drizzle + Postgres）。backend の infra からパッケージ（drizzle-orm / pg）への参照、
  //   自 feature の infra → backend/shared/drizzle。
  // Issue #220・#230: runner の実装は、port と brand の型（どちらも shared/transaction/transaction）を型で使う。
  "apps/backend/shared/drizzle/transaction.postgres.ts": lines(
    'import type { Transaction, TransactionRunner } from "../transaction/transaction";',
    'import type { Database } from "./database";',
    'import { PostgresWriter } from "./writer";',
  ),
  "apps/backend/shared/drizzle/database.ts": lines(
    'import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";',
    'import { Pool, type PoolConfig } from "pg";',
    // Issue #59: 設定は env.ts から、ログは logger から取る（Issue #90 で apps/shared に移した。backend/shared/drizzle から apps/shared）。
    //   apps/shared へは "@repo/shared/..." だけ（相対パスは backend-relative-only の違反）。
    'import { env } from "@repo/shared/env";',
    'import { logger } from "@repo/shared/logger";',
    'import { env as e } from "@repo/shared/env";',
  ),
  // Issue #59: process.env を読んでよいのは env.ts だけ（Issue #90 で apps/shared に移した）。
  "apps/shared/env.ts": lines(
    'import { existsSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'process.loadEnvFile(".env");',
    "export const env = readEnv(process.env);",
    "export const toolEnv = readToolEnv(process . env);",
  ),
  // env.ts 以外の、process.env に見えるが参照ではないもの（コメント・文字列・別の識別子）。
  "apps/backend/features/todo/internal/infra/env-lookalikes.ts": lines(
    "// process.env.DATABASE_URL は env.ts から読む",
    "/* process['env'] */",
    'const s = "process.env.X";',
    "const t = 'process[\"env\"]';",
    "const processEnv = read(); processEnv.X;",
    "const v = myprocess.env; process.envelope;",
  ),
  // テスト、対象外の場所（scripts/・ルート直下のディレクトリの中）、TS / JS 以外のファイルは検査しない。
  //   class-based（Issue #262）: apps/shared のテストの中の最上位の関数は対象外。
  "apps/shared/env.test.ts": lines(
    "const p = process.env.PATH;",
    "function helper(): number { return 1; }",
  ),
  // apps/shared の package.json・tsconfig.json は置いてよい。依存のディレクトリ（node_modules）の中は置き場所の規則でも見ない。
  "apps/shared/package.json": JSON.stringify({
    name: "@repo/shared",
    exports: {
      "./env": "./env.ts",
      "./logger": "./logger.ts",
      "./now": "./now.ts",
    },
  }),
  "apps/shared/tsconfig.json": "{}",
  "apps/shared/node_modules/pkg/index.js": lines(
    "module.exports = process.env;",
    "console.log(1);",
  ),
  "apps/e2e/todo.test.ts": lines("const p = process.env.PATH;"),
  "architecture.test.ts": lines("const p = process.env.PATH;"),
  "scripts/tool.ts": lines("const p = process.env.PATH;"),
  "node_modules/pkg/index.js": lines(
    "module.exports = process.env;",
    "console.log(1);",
  ),
  ".next/server/chunk.js": lines("module.exports = process.env;"),
  // Issue #68: next build の生成物（apps/frontend_customer/.next/）と、workspace パッケージの依存（apps/backend/node_modules/）は
  //   自前のコードではないので、違反を書いても検査しない。
  "apps/frontend_customer/.next/server/chunk.js": lines(
    "module.exports = process.env;",
    'import "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
  ),
  "apps/frontend_customer/node_modules/pkg/index.js": lines(
    "module.exports = process.env;",
    'import "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
  ),
  // next build / next dev が生成する型の宣言（.gitignore 済み）。直下の許可された名前で、.next の中を import する。
  "apps/frontend_customer/next-env.d.ts": lines(
    '/// <reference types="next" />',
    'import "./.next/types/routes.d.ts";',
  ),
  "apps/backend/node_modules/pkg/index.js": lines(
    "module.exports = process.env;",
    'import "../../../frontend_customer/app/page";',
  ),
  // apps/frontend_customer 直下の Next の設定（パッケージの参照だけ）と、backend の中から前方一致だけが同じ別パッケージの参照。
  "apps/frontend_customer/next.config.ts": lines(
    'import type { NextConfig } from "next";',
    "export default {} satisfies NextConfig;",
  ),
  "apps/backend/features/todo/internal/infra/uses-packages.ts": lines(
    'import extra from "@repo/backend-extra/x";',
    'import { eq } from "drizzle-orm";',
  ),
  "README.md": "process.env.DATABASE_URL",
  // instrumentation.ts は NEXT_RUNTIME だけを読み、Node.js 用の処理（instrumentation-node.ts）が env.ts を読み込む。
  "apps/frontend_customer/instrumentation.ts": lines(
    "export async function register() {",
    '  if (process.env.NEXT_RUNTIME === "nodejs") {',
    '    const { verifyEnvAtStartup } = await import("./instrumentation-node");',
    "    await verifyEnvAtStartup();",
    "  }",
    "}",
  ),
  "apps/frontend_customer/instrumentation-node.ts": lines(
    'import { logger } from "@repo/shared/logger";',
    "export async function verifyEnvAtStartup() {",
    '  await import("@repo/shared/env");',
    "}",
  ),
  // proxy.ts（Next の規約ファイル。リクエストログ。Issue #80）は直下に置き、1 行の組み立てを frontend の shared/ から使う。
  //   出力はログの唯一の出口（apps/shared/logger。Issue #85・#90）を通す。
  "apps/frontend_customer/proxy.ts": lines(
    'import { logger } from "@repo/shared/logger";',
    'import { now } from "@repo/shared/now";',
    'import { type NextRequest, NextResponse } from "next/server";',
    'import { RequestLogBuilder } from "@/shared/request-log/request-log";',
    "logger.emit(RequestLogBuilder.build({ receivedAt: now() }));",
  ),
  // now-single-source: 現在時刻は apps/shared/now.ts だけが読み、ほかは Clock.now() を使う（backend の 4 層すべてと frontend 直下）。
  //   class-based（Issue #262）: apps/shared/now.ts もクラスの static メソッドにする。
  "apps/shared/now.ts": lines(
    "export class Clock {",
    "  static now(): Date {",
    "    return new Date();",
    "  }",
    "}",
  ),
  "apps/backend/features/todo/internal/application/uses-now.command.ts": lines(
    'import { now } from "@repo/shared/now";',
    "export const at = now();",
  ),
  "apps/backend/shared/http/uses-now.ts": lines(
    'import { now } from "@repo/shared/now";',
    "export const at = now();",
  ),
  "apps/backend/features/todo/internal/infra/uses-now.ts": lines(
    'import { now } from "@repo/shared/now";',
    "export const at = now();",
  ),
  // 現在時刻の読み取りに見えるが違反ではないもの（引数のある new Date・Date.parse / Date.UTC・型・別の識別子・コメント・文字列）。
  "apps/backend/features/todo/internal/domain/date-lookalikes.ts": lines(
    "// new Date() と Date.now() は now.ts だけ",
    "/* Date() */",
    'const s = "new Date()";',
    "const t = 'Date.now()';",
    'export const parsed = new Date("2026-01-01T00:00:00.000Z");',
    "export const copied = new Date(parsed);",
    "export const multi = new Date(",
    '  "2026-01-01",',
    ");",
    'export const utc = Date.UTC(2026, 0, 1) + Date.parse("2026-01-01");',
    "export let d: Date;",
    "export const x = [new DateTime(), toDate(), myDate.now(), Dates.now()];",
  ),
  // テスト・テストの補助・apps/e2e/・scripts/・ルート直下は対象外。
  "apps/backend/features/todo/internal/domain/clock.test.ts": lines(
    "vi.mocked(now).mockReturnValue(new Date());",
    "const n = Date.now();",
  ),
  "apps/e2e/clock.spec.ts": lines("export const runId = Date.now();"),
  "scripts/clock.ts": lines("export const t = Date.now();"),
  "clock.config.mts": lines("export default { at: new Date() };"),
  // class-based（ADR 20261002-class-based-frontend-modules.md）: frontend の shared/ もクラスの static メソッドにする。
  "apps/frontend_customer/shared/request-log/request-log.ts": lines(
    "export class RequestLogBuilder { static build() {} }",
  ),
  // env.ts は apps/shared（@repo/shared。Issue #90）にあり、apps/backend の設定ファイル（apps/backend/shared/drizzle/drizzle.config.ts）・apps/e2e/・
  //   リポジトリ直下の設定ファイルは "@repo/shared/env" で import する。
  "apps/backend/shared/drizzle/drizzle.config.ts": lines(
    'import { env } from "@repo/shared/env";',
    "export default { url: env.DATABASE_URL };",
  ),
  "apps/e2e/support/database.ts": lines(
    'import { Client } from "pg";',
    'import { env } from "@repo/shared/env";',
    "export const url = env.DATABASE_URL;",
  ),
  "apps/e2e/playwright.config.ts": lines(
    'import { defineConfig } from "@playwright/test";',
    'import { env, toolEnv } from "@repo/shared/env";',
  ),
  // E2E のテスト（*.spec.ts。Vitest のテスト *.test.ts ではないので検査の対象）。apps/e2e は置き場所の規則
  //   （BACKEND_PLACEMENT / FRONTEND_PLACEMENT）の対象外で、直下に置いても違反にならない（Issue #84）。
  "apps/e2e/todo.spec.ts": lines(
    'import { expect, test } from "@playwright/test";',
    'import { E2eDatabase } from "./database";',
    "async function addTodo(): Promise<void> {}",
  ),
  // テスト基盤の vitest.global-setup.ts だけは、test-support/database を相対パスで参照する（exports に含めない例外）。
  "vitest.global-setup.ts": lines(
    'import { env, toolEnv } from "@repo/shared/env";',
    'import { TestDatabase } from "./apps/backend/test-support/database";',
    "export default async function setup(): Promise<void> {}",
  ),
  // exports（Issue #68 の段階 2）: 外が "@repo/backend/..." で参照するものだけを、キーのパスの .ts で公開する。
  //   すべてのキーが上の参照で使われ、指すファイルがある（パターンは *.api の 5 ファイルに当たる）。
  "apps/backend/package.json": JSON.stringify({
    name: "@repo/backend",
    exports: {
      "./features/todo/internal/presentation/*.api":
        "./features/todo/internal/presentation/*.api.ts",
      "./shared/http/problem": "./shared/http/problem.ts",
    },
  }),
  // テストだけが使うコード（Issue #181。直下の test-support/）。置き場所の規則で許し、層の規則は当てない（どの層でもない）。
  //   backend の中なので backend-relative-only（相対パスと @repo/shared）はかかる。
  "apps/backend/test-support/database.ts": lines(
    'import { randomUUID } from "node:crypto";',
    'import { drizzle } from "drizzle-orm/node-postgres";',
    'import { migrate } from "drizzle-orm/node-postgres/migrator";',
    'import { Pool } from "pg";',
    'import type { Database } from "../shared/drizzle/database";',
    'import { env } from "@repo/shared/env";',
    // now-single-source: テストの補助（test-support/ の下）は現在時刻を直接読んでもよい。
    "export const stamp = Date.now();",
  ),
  "apps/backend/features/todo/internal/infra/schema.ts": lines(
    'import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";',
  ),
  "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts":
    lines(
      'import { asc, eq } from "drizzle-orm";',
      'import type { Database } from "../../../../shared/drizzle/database";',
      // Issue #220・#230: brand の型 Transaction と、infra が実装する port（どちらも shared/transaction/transaction）は型で参照できる。
      'import type { Transaction } from "../../../../shared/transaction/transaction";',
      'import type { TransactionRunner } from "../../../../shared/transaction/transaction";',
      'import { Todo } from "../domain/todo";',
      'import type { TodoRepository } from "../domain/todo-repository";',
      'import { todos } from "./schema";',
      'import { todos as t } from "./schema";',
    ),
  // InMemory の実装（Issue #191 で features/todo/internal/infra/ から test-support/<feature>/ に移した）。test-support は層の規則の外なので、
  //   feature の domain・infra の schema・backend/shared/drizzle を値で参照してよい（本番のコードからの参照は test-support.test.ts が止める）。
  "apps/backend/test-support/todo/todo-repository.in-memory.ts": lines(
    'import { now } from "@repo/shared/now";',
    'import { ChangedProps } from "../../shared/drizzle/changed-props";',
    'import { Todo } from "../../features/todo/internal/domain/todo";',
    'import type { TodoRepository } from "../../features/todo/internal/domain/todo-repository";',
    'import { todos } from "../../features/todo/internal/infra/schema";',
  ),
  // frontend-hardcoded-text・server-hardcoded-text（Issue #116）: 辞書の日本語、t(...) で描く画面、一覧に無い属性、
  //   空白だけの alt、埋め込み式だけのテンプレート、コメントの日本語、ErrorKey で表すエラー、テストの日本語は通す。
  "apps/frontend_customer/shared/i18n/common.messages.ts": lines(
    'import { defineMessages } from "./i18n";',
    'export const commonMessages = defineMessages({ ja: { "todo.notFound": "Todo（id: {id}）が見つかりません" }, en: { "todo.notFound": "Todo (id: {id}) was not found" } });',
  ),
  "apps/frontend_customer/test-support/i18n.tsx": lines(
    'import { createTranslator } from "@/shared/i18n/i18n";',
    'import { commonMessages } from "@/shared/i18n/common.messages";',
    "export const at = new Date();",
  ),
  "apps/frontend_customer/features/todo/components/todo-item.messages.ts":
    lines(
      'import { defineMessages } from "@/shared/i18n/i18n";',
      'export const todoItemMessages = defineMessages({ ja: { delete: "削除", deleteLabel: "「{title}」を削除" }, en: { delete: "Delete", deleteLabel: "Delete {title}" } });',
    ),
  "apps/frontend_customer/features/todo/api/api-error.ts": lines(
    'import { commonMessages } from "../../../shared/i18n/common.messages";',
  ),
  "apps/frontend_customer/features/todo/components/good-text.tsx": lines(
    "// 削除のボタン（コメントの日本語は拾わない）",
    "export const GoodText = ({ todo, t }) => (",
    '  <div className="foo" data-testid="todo-item">',
    '    <button type="button" aria-label={t("todo.item.deleteLabel", { title: todo.title })}>',
    '      {t("todo.item.delete")}',
    "    </button>",
    `    <img alt="" src="/logo.svg" title={\`\${todo.title}\`} />`,
    "    {/* 日本語のコメント */}",
    "  </div>",
    ");",
  ),
  "apps/frontend_customer/features/todo/components/good-text.test.tsx": lines(
    'expect(screen.getByRole("button", { name: "削除" })).toBeDefined();',
    "render(<p>削除</p>);",
  ),
  "apps/backend/features/todo/internal/domain/good-text.ts": lines(
    "// 見つからないときは ErrorKey で表す（日本語は画面側の辞書に置く）",
    'export class NotFound { static of = (id) => new DomainError("not_found", "todo.notFound", { id }); }',
  ),
  "apps/backend/features/todo/internal/domain/good-text.test.ts": lines(
    'expect(message).toBe("Todo が見つかりません");',
  ),
  // テストファイルと TS / JS 以外のファイルは検査しない。
  "apps/backend/features/todo/internal/presentation/list-todos.api.test.ts":
    lines(
      'import { InMemoryTodoRepository } from "../../../../test-support/todo/todo-repository.in-memory";',
    ),
  "apps/frontend_customer/features/todo/components/todo-item.test.tsx": lines(
    'import { ListTodosApi } from "@repo/backend/features/todo/internal/presentation/list-todos.api";',
  ),
  "apps/frontend_customer/features/todo/README.md":
    'import { GET } from "@repo/backend/features/todo/internal/infra/todo-repository.postgres";',
};

// [ファイル, ソース] の例に、移す前の it.each の名前（`%s の %j`）と同じ形のケース名を付ける（Issue #282 で casesByName に移した）。
function sourceExampleCases(
  examples: [file: string, source: string][],
): [string, [file: string, source: string]][] {
  return examples.map((example) => [
    `${example[0]} の ${JSON.stringify(example[1])}`,
    example,
  ]);
}

// 規則ごとの判定の例のケース名（移す前の it.each の名前 `%s → %s（%s）` と同じ形）。
function exampleName([from, specifier, kind]: Example): string {
  return `${from} → ${specifier}（${kind}）`;
}

// 規則の名前（Rule の name など。.claude/rules/architecture-check.md の規則の文）を、.feature の step の文にする（Issue #282）。
// WHY 「*」を言い換える: step の文の中の「*」は vitest-cucumber が読み違える（rule-tests/rule-test-feature.test.ts の
//   rule-test-feature-format が止める）。名前の中の「*」は glob なので、「**/」を「<階層>/」、残りの「*」を「<名前>」と読み替える。
//   規則の名前そのものは変えない（違反の一覧や文書と同じ文のまま）。
function ruleStepText(name: string): string {
  return name.replaceAll("**/", "<階層>/").replaceAll("*", "<名前>");
}

const feature = await loadFeature("./architecture.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("依存の向き（.claude/rules/architecture-check.md）", ({ And }) => {
    const references = collectReferences(repoRoot);

    And(
      "検査の対象から参照を取り出せている（抽出が壊れて 0 件になり、すべての規則が素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const referenceCount = references.length;

        // then
        expect(referenceCount).toBeGreaterThan(0);
      },
    );

    And(ruleStepText(BACKEND_PLACEMENT.name), () => {
      // given: 前提なし
      // when
      const result = listReferencingFiles(repoRoot).filter(
        BACKEND_PLACEMENT.isMisplaced,
      );

      // then
      expect(result).toEqual([]);
    });

    And(ruleStepText(FRONTEND_PLACEMENT.name), () => {
      // given: 前提なし
      // when
      const result = listReferencingFiles(repoRoot).filter(
        FRONTEND_PLACEMENT.isMisplaced,
      );

      // then
      expect(result).toEqual([]);
    });

    And(ruleStepText(SHARED_PLACEMENT.name), () => {
      // given: 前提なし
      // when
      const result = listAllFiles(repoRoot, SHARED_ROOT).filter(
        SHARED_PLACEMENT.isMisplaced,
      );

      // then
      expect(result).toEqual([]);
    });

    // WHY: 列挙が空（ディレクトリ名の書き間違い・列挙の壊れ）なら置き場所の違反も 0 件で常に緑になる。
    // WHY arrayContaining（一覧の外のファイルがあっても落とさない）: 一覧の外のファイルは上の shared-placement の 1 件だけで落とし、
    //   規則を破ったときに、どの規則が破れたかをテスト名で分かるようにする。
    And(
      "apps/shared の全ファイル（ソース・テスト・package.json・tsconfig.json）を列挙できている（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const allFiles = listAllFiles(repoRoot, SHARED_ROOT);

        // then
        expect(allFiles).toEqual(expect.arrayContaining([...SHARED_FILES]));
      },
    );

    for (const rule of RULES) {
      And(ruleStepText(rule.name), () => {
        // given: 前提なし
        // when
        const violations = findViolations(references, rule);

        // then
        // 失敗時にどのファイルがどこを参照しているかが出力に出るよう、違反を「ファイル → 参照先」の一覧にして空配列と比較する。
        expect(violations).toEqual([]);
      });
    }

    // WHY 本物の expose の参照が取り出せていることを見る（Issue #208）: モジュールの境界の規則（module-internal・
    //   module-expose-only-from-presentation・expose-imports）は、expose/ の下のファイルと、expose を使う presentation の参照を
    //   取り出せていなければ、違反も 0 件で常に緑になる。
    And(
      "モジュールの境界の規則は、本物の expose（notification の notifier.ts）の参照と、それを使う todo の presentation の参照を取り出せている（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const result = references.map((ref) => `${ref.from} → ${ref.to}`);

        // then
        expect(result).toEqual(
          expect.arrayContaining([
            "apps/backend/features/todo/internal/presentation/change-todo-completion.api.ts → apps/backend/features/notification/expose/notifier",
            "apps/backend/features/notification/expose/notifier.ts → apps/backend/features/notification/internal/application/send-notification.command",
            "apps/backend/features/notification/expose/notifier.ts → apps/backend/features/notification/internal/infra/notification-sender.log",
            "apps/backend/features/notification/expose/notifier.ts → apps/shared/logger",
          ]),
        );
      },
    );

    And(ruleStepText(ENV_DIRECT_ACCESS.name), () => {
      // given: 前提なし
      // when
      const violations = findEnvViolations(repoRoot);

      // then
      // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
      expect(violations).toEqual([]);
    });

    And(ruleStepText(CONSOLE_DIRECT_ACCESS.name), () => {
      // given: 前提なし
      // when
      const violations = findConsoleViolations(repoRoot);

      // then
      // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
      expect(violations).toEqual([]);
    });

    And(ruleStepText(NOW_SINGLE_SOURCE.name), () => {
      // given: 前提なし
      // when
      const violations = findNowViolations(repoRoot);

      // then
      // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
      expect(violations).toEqual([]);
    });

    And(
      "現在時刻の読み取りの検査は、apps/frontend_customer・apps/backend・apps/shared のソースを対象にし、テスト・テストの補助・apps/e2e/・ルート直下は対象にしない（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const files = listNowCheckedFiles(repoRoot);

        // then
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/shared/now.ts",
            "apps/shared/logger.ts",
            "apps/backend/features/todo/internal/domain/todo.ts",
            "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
            "apps/frontend_customer/proxy.ts",
            "apps/frontend_customer/shared/i18n/format.ts",
            "apps/frontend_customer/features/todo/components/todo-item.tsx",
            "apps/frontend_customer/app/page.tsx",
          ]),
        );

        // when
        for (const excluded of [
          "apps/shared/now.test.ts",
          "apps/backend/features/todo/internal/domain/todo.test.ts",
          "apps/backend/test-support/database.ts",
          "apps/frontend_customer/test-support/i18n.tsx",
          "apps/e2e/spec/todo.steps.ts",
          "vitest.config.mts",
        ]) {
          expect(files).not.toContain(excluded);
        }

        const result = files.filter((file) => file.includes("/.next/"));

        // then
        expect(result).toEqual([]);
      },
    );

    for (const rule of HARDCODED_TEXT_RULES) {
      And(ruleStepText(rule.name), () => {
        // given: 前提なし
        // when
        const violations = findHardcodedTextViolations(repoRoot, rule);

        // then
        // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
        expect(violations).toEqual([]);
      });
    }

    And(ruleStepText(PRESENTATION_WITH_PROBLEM_RESPONSE.name), () => {
      // given: 前提なし
      // when
      const violations = findProblemResponseViolations(repoRoot);

      // then
      // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
      expect(violations).toEqual([]);
    });

    // WHY 本物の 5 本が列挙に入っていることを見る: 列挙（パスの正規表現）が壊れて 0 件になると、違反も 0 件で常に緑になる。
    And(
      "handle を ProblemResponse.wrap で包む規則は、本物の api ファイル 6 本を対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const files = listProblemResponseCheckedFiles(repoRoot);

        // then
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/backend/features/todo/internal/presentation/create-todo.api.ts",
            "apps/backend/features/todo/internal/presentation/delete-todo.api.ts",
            "apps/backend/features/todo/internal/presentation/get-todo.api.ts",
            "apps/backend/features/todo/internal/presentation/list-todos.api.ts",
            "apps/backend/features/todo/internal/presentation/rename-todo.api.ts",
            "apps/backend/features/todo/internal/presentation/change-todo-completion.api.ts",
          ]),
        );

        // when
        const result = files.filter((file) => TEST_FILE.test(file));

        // then
        expect(result).toEqual([]);
      },
    );

    And(ruleStepText(CLASS_BASED.name), () => {
      // given: 前提なし
      // when
      const violations = findClassBasedViolations(repoRoot);

      // then
      // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
      expect(violations).toEqual([]);
    });

    // WHY 本物のファイルが列挙に入っていることを見る: 列挙（パスの判定）が壊れて 0 件になると、違反も 0 件で常に緑になる。
    And(
      "最上位に関数を置かない規則は、apps/backend の本番コード（層・expose・drizzle.config.ts）・apps/shared の本番コード・テストの補助（test-support/・spec/ の support.ts・apps/e2e/ の spec 以外）・frontend の React 以外のモジュール（features/・shared/ の .ts）を対象にし、テスト・E2E の .spec.ts・リポジトリ直下・frontend の .tsx・.hook.ts・app/・直下のファイルは対象にしない（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const files = listClassBasedCheckedFiles(repoRoot);

        // then
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/backend/shared/error/validate.ts",
            "apps/backend/shared/drizzle/writer.ts",
            "apps/backend/shared/http/problem.ts",
            "apps/backend/shared/drizzle/drizzle.config.ts",
            "apps/backend/features/notification/expose/notifier.ts",
            "apps/backend/features/todo/internal/domain/todo.ts",
            "apps/backend/features/todo/internal/presentation/create-todo.api.ts",
            "apps/shared/env.ts",
            "apps/shared/log-event.ts",
            "apps/shared/logger.ts",
            "apps/shared/now.ts",
            "apps/backend/test-support/database.ts",
            "apps/backend/test-support/transaction-runner.in-memory.ts",
            "apps/backend/test-support/todo/todo-builder.ts",
            "apps/backend/test-support/todo/todo-repository.in-memory.ts",
            "apps/backend/spec/api/todo/support.ts",
            "apps/e2e/support/database.ts",
            "apps/e2e/playwright.config.ts",
            "apps/e2e/support/fixtures.ts",
            "apps/e2e/spec/todo.steps.ts",
            "apps/frontend_customer/features/todo/api/todo-api.ts",
            "apps/frontend_customer/features/todo/api/api-error.ts",
            "apps/frontend_customer/features/todo/index.ts",
            "apps/frontend_customer/features/todo/components/todo-item.messages.ts",
            "apps/frontend_customer/shared/i18n/locale.ts",
            "apps/frontend_customer/shared/i18n/format.ts",
            "apps/frontend_customer/shared/request-log/request-log.ts",
          ]),
        );

        // when
        const result = files.filter(
          (file) =>
            TEST_FILE.test(file) ||
            E2E_SPEC_FILE.test(file) ||
            !(
              isUnder(file, BACKEND_ROOT) ||
              isUnder(file, SHARED_ROOT) ||
              isUnder(file, E2E_ROOT) ||
              isUnder(file, FRONTEND_ROOT)
            ),
        );

        // then
        expect(result).toEqual([]);

        // when
        // WHY frontend の対象外を別に見る: 対象外（React の component・hook、Next の規約のファイル）が列挙に入ると、関数の形を
        //   外の仕様が求めるファイルが違反になる（判定の例でも固定するが、実ファイルの列挙でも確かめる）。
        const frontendExcluded = files.filter(
          (file) =>
            isUnder(file, FRONTEND_ROOT) &&
            (/\.[jt]sx$/.test(file) ||
              /\.hook\./.test(file) ||
              isUnder(file, `${FRONTEND_ROOT}/app`) ||
              /^apps\/frontend_customer\/[^/]+$/.test(file)),
        );

        // then
        expect(frontendExcluded).toEqual([]);
        // 前提: 対象外の実ファイルがリポジトリにあること（無ければ上の検査は何も確かめていない）。
        expect(listSourceFiles(repoRoot, FRONTEND_ROOT)).toEqual(
          expect.arrayContaining([
            "apps/frontend_customer/features/todo/components/todo-item.tsx",
            "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.hook.ts",
            "apps/frontend_customer/app/page.tsx",
            "apps/frontend_customer/app/api/todos/route.ts",
            "apps/frontend_customer/proxy.ts",
            "apps/frontend_customer/instrumentation.ts",
            "apps/frontend_customer/instrumentation-node.ts",
            "apps/frontend_customer/next.config.ts",
          ]),
        );
      },
    );

    for (const pkg of EXPORTED_PACKAGES) {
      And(ruleStepText(pkg.name), () => {
        // given: 前提なし
        // when
        const violations = findPackageExportsViolations(
          repoRoot,
          pkg,
          references,
        );

        // then
        expect(violations).toEqual([]);
      });
    }

    And(
      "apps/backend の exports を 1 件以上読め、apps/frontend_customer の @repo/backend の参照を取り出せている（読み込みや列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const exportCount = Object.keys(
          readPackageExports(repoRoot, BACKEND_EXPORTS),
        ).length;

        // then
        expect(exportCount).toBeGreaterThan(0);

        // when
        const consumers = new Set(
          references
            .filter((ref) => isBackendPackage(ref.specifier))
            .map((ref) => ref.from),
        );

        const result = [...consumers];

        // then
        expect(result).toEqual(
          expect.arrayContaining([
            "apps/frontend_customer/app/api/todos/route.ts",
            "apps/frontend_customer/features/todo/api/todo-api.ts",
          ]),
        );
      },
    );

    And(
      "apps/shared の exports を読め、apps/frontend_customer 直下・apps/backend・apps/e2e/・リポジトリ直下の @repo/shared の参照を取り出せている（読み込みや列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const result = Object.keys(
          readPackageExports(repoRoot, SHARED_EXPORTS),
        ).sort();

        // then
        expect(result).toEqual(["./env", "./logger", "./now"]);

        // when
        const consumers = new Set(
          references
            .filter((ref) => isSharedPackage(ref.specifier))
            .map((ref) => ref.from),
        );

        const sharedConsumers = [...consumers];

        // then
        expect(sharedConsumers).toEqual(
          expect.arrayContaining([
            "apps/frontend_customer/instrumentation-node.ts",
            "apps/frontend_customer/proxy.ts",
            "apps/backend/features/todo/internal/domain/todo.ts",
            "apps/backend/features/notification/expose/notifier.ts",
            "apps/backend/features/notification/internal/infra/notification-sender.log.ts",
            "apps/backend/shared/drizzle/drizzle.config.ts",
            "apps/backend/shared/drizzle/database.ts",
            "apps/backend/shared/http/problem.ts",
            "apps/e2e/support/database.ts",
            "apps/e2e/playwright.config.ts",
            "vitest.global-setup.ts",
          ]),
        );
      },
    );

    And(
      "環境変数の直参照の検査は、各ディレクトリとルート直下の設定ファイルを対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const files = listEnvCheckedFiles(repoRoot);

        // then
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/shared/env.ts",
            "apps/shared/logger.ts",
            "apps/backend/shared/drizzle/database.ts",
            "apps/backend/test-support/database.ts",
            "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
            "apps/backend/shared/drizzle/drizzle.config.ts",
            "apps/frontend_customer/next.config.ts",
            "apps/frontend_customer/instrumentation.ts",
            "apps/frontend_customer/instrumentation-node.ts",
            "apps/frontend_customer/features/todo/api/todo-api.ts",
            "apps/frontend_customer/app/page.tsx",
            "apps/e2e/support/database.ts",
            "apps/e2e/playwright.config.ts",
            "vitest.config.mts",
            "vitest.global-setup.ts",
            "stryker.config.mjs",
          ]),
        );
        expect(files).not.toContain("rule-tests/architecture.test.ts");
        expect(files).not.toContain("apps/shared/env.test.ts");

        // when
        const result = files.filter((file) => file.includes("/.next/"));

        // then
        // next build の生成物（apps/frontend_customer/.next/）は数えない（あれば数千件の JS を検査することになる）。
        expect(result).toEqual([]);
      },
    );

    And(
      "console の直接の呼び出しの検査は、各ディレクトリ・scripts/・ルート直下の設定ファイルを対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const files = listConsoleCheckedFiles(repoRoot);

        // then
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/shared/logger.ts",
            "apps/shared/env.ts",
            "apps/backend/shared/drizzle/database.ts",
            "apps/backend/shared/http/problem.ts",
            "apps/backend/features/todo/internal/presentation/list-todos.api.ts",
            "apps/backend/shared/drizzle/drizzle.config.ts",
            "apps/frontend_customer/proxy.ts",
            "apps/frontend_customer/instrumentation-node.ts",
            "apps/frontend_customer/features/todo/api/todo-api.ts",
            "apps/frontend_customer/app/page.tsx",
            "apps/e2e/support/database.ts",
            "apps/e2e/playwright.config.ts",
            "apps/e2e/support/log-server.ts",
            "apps/e2e/spec/request-log.steps.ts",
            "vitest.config.mts",
            "vitest.global-setup.ts",
            "stryker.config.mjs",
          ]),
        );
        expect(files).not.toContain("rule-tests/architecture.test.ts");
        expect(files).not.toContain("apps/shared/logger.test.ts");
        expect(files).not.toContain("scripts/hooks/guard-git.test.ts");

        // when
        const result = files.filter((file) => file.includes("/.next/"));

        // then
        expect(result).toEqual([]);
      },
    );

    And(
      "ハードコードの文言の検査は、apps/frontend_customer・apps/backend・apps/shared のソース（辞書 .messages.ts を含む）を対象にし、テスト・生成物は対象にしない（列挙が壊れて素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const frontend = listHardcodedTextCheckedFiles(
          repoRoot,
          FRONTEND_HARDCODED_TEXT,
        );

        // then
        expect(frontend).toEqual(
          expect.arrayContaining([
            "apps/frontend_customer/app/layout.tsx",
            "apps/frontend_customer/app/page.tsx",
            "apps/frontend_customer/features/todo/api/todo-api.ts",
            "apps/frontend_customer/features/todo/components/todo-item.tsx",
            "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx",
            "apps/frontend_customer/proxy.ts",
          ]),
        );

        // when
        const result = frontend.filter((file) => I18N_MESSAGES.test(file));

        // then
        // WHY 辞書も対象に入っていることを見る（Issue #125 の reviewer 指摘で、辞書を対象から外すのをやめた）: 辞書も
        //   defineMessages(...) の引数の外は同じ検査をかける。対象から外れると、辞書に書いた引数の外の文言が素通りする。
        //   辞書の例外（I18N_MESSAGES）が実在のファイルに当たっていることも、ここで見る（名前の付け方が変わったら落ちる）。
        expect(result).toEqual(
          expect.arrayContaining([
            "apps/frontend_customer/shared/i18n/common.messages.ts",
            "apps/frontend_customer/features/todo/components/todo-item.messages.ts",
            "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.messages.ts",
            "apps/frontend_customer/features/todo/screens/todo-detail-screen/todo-detail-screen.messages.ts",
          ]),
        );

        // when
        const backend = listHardcodedTextCheckedFiles(
          repoRoot,
          SERVER_HARDCODED_TEXT,
        );

        // then
        expect(backend).toEqual(
          expect.arrayContaining([
            "apps/backend/shared/error/domain-error.ts",
            "apps/backend/shared/http/problem.ts",
            "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
            "apps/backend/features/notification/expose/notifier.ts",
            "apps/backend/shared/drizzle/drizzle.config.ts",
            "apps/shared/env.ts",
            "apps/shared/logger.ts",
          ]),
        );
        for (const files of [frontend, backend]) {
          expect(files.filter((file) => TEST_FILE.test(file))).toEqual([]);
          expect(
            files.filter((file) => /\/(?:\.next|node_modules)\//.test(file)),
          ).toEqual([]);
        }
      },
    );

    And(
      "logger.ts の中の console は拾えている（抽出が壊れて 0 件になり、規則が素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const consoleAccessCount = findConsoleAccesses(
          readFileSync(
            join(repoRoot, CONSOLE_DIRECT_ACCESS.allowedFile),
            "utf8",
          ),
        ).length;

        // then
        expect(consoleAccessCount).toBeGreaterThan(0);
      },
    );

    And(
      "env.ts の中の process.env は拾えている（抽出が壊れて 0 件になり、規則が素通りするのを防ぐ）",
      () => {
        // given: 前提なし
        // when
        const envAccessCount = findProcessEnvAccesses(
          readFileSync(join(repoRoot, ENV_DIRECT_ACCESS.allowedFile), "utf8"),
        ).length;

        // then
        expect(envAccessCount).toBeGreaterThan(0);
      },
    );
  });

  Scenario("backend の置き場所の判定", ({ And }) => {
    And(
      "違反例（PLACEMENT_EXAMPLES.misplaced）はすべて置き場所の違反になる",
      () => {
        // given
        const cases = PLACEMENT_EXAMPLES.misplaced.map((file): [string] => [
          file,
        ]);

        // when
        const result = casesByName(cases, ([file]) =>
          BACKEND_PLACEMENT.isMisplaced(file),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );
    And(
      "許可例（PLACEMENT_EXAMPLES.placed）はどれも置き場所の違反にならない",
      () => {
        // given
        const cases = PLACEMENT_EXAMPLES.placed.map((file): [string] => [file]);

        // when
        const result = casesByName(cases, ([file]) =>
          BACKEND_PLACEMENT.isMisplaced(file),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("apps/shared の置き場所の判定", ({ And }) => {
    And(
      "違反例（SHARED_PLACEMENT_EXAMPLES.misplaced）はすべて置き場所の違反になる",
      () => {
        // given
        const cases = SHARED_PLACEMENT_EXAMPLES.misplaced.map(
          (file): [string] => [file],
        );

        // when
        const result = casesByName(cases, ([file]) =>
          SHARED_PLACEMENT.isMisplaced(file),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );
    And(
      "許可例（SHARED_PLACEMENT_EXAMPLES.placed）はどれも置き場所の違反にならない",
      () => {
        // given
        const cases = SHARED_PLACEMENT_EXAMPLES.placed.map((file): [string] => [
          file,
        ]);

        // when
        const result = casesByName(cases, ([file]) =>
          SHARED_PLACEMENT.isMisplaced(file),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("frontend の置き場所の判定", ({ And }) => {
    And(
      "違反例（FRONTEND_PLACEMENT_EXAMPLES.misplaced）はすべて置き場所の違反になる",
      () => {
        // given
        const cases = FRONTEND_PLACEMENT_EXAMPLES.misplaced.map(
          (file): [string] => [file],
        );

        // when
        const result = casesByName(cases, ([file]) =>
          FRONTEND_PLACEMENT.isMisplaced(file),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );
    And(
      "許可例（FRONTEND_PLACEMENT_EXAMPLES.placed）はどれも置き場所の違反にならない",
      () => {
        // given
        const cases = FRONTEND_PLACEMENT_EXAMPLES.placed.map(
          (file): [string] => [file],
        );

        // when
        const result = casesByName(cases, ([file]) =>
          FRONTEND_PLACEMENT.isMisplaced(file),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("環境変数の直参照の判定", ({ And }) => {
    And("違反例・許可例はそれぞれ 4 件以上ある", () => {
      // given: 前提なし
      // when
      const violatingExampleCount = ENV_ACCESS_EXAMPLES.violating.length;

      // then
      expect(violatingExampleCount).toBeGreaterThanOrEqual(4);

      // when
      const allowedExampleCount = ENV_ACCESS_EXAMPLES.allowed.length;

      // then
      expect(allowedExampleCount).toBeGreaterThanOrEqual(4);
    });
    And("違反例（ENV_ACCESS_EXAMPLES.violating）はすべて違反になる", () => {
      // given
      const cases = sourceExampleCases(ENV_ACCESS_EXAMPLES.violating);

      // when
      const result = casesByName(cases, ([, example]) =>
        judgeEnvAccess(example),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => true));
    });
    And("許可例（ENV_ACCESS_EXAMPLES.allowed）はどれも違反にならない", () => {
      // given
      const cases = sourceExampleCases(ENV_ACCESS_EXAMPLES.allowed);

      // when
      const result = casesByName(cases, ([, example]) =>
        judgeEnvAccess(example),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => false));
    });
  });

  Scenario("環境変数の直参照の抽出（findProcessEnvAccesses）", ({ And }) => {
    And(
      "参照ごとに、読んだ変数の名前を返す（.NAME / ?.NAME の形だけ。取れない形は undefined）",
      () => {
        // given
        const source = [
          "const a = process.env.NEXT_RUNTIME;",
          "const b = process?.env?.DATABASE_URL;",
          'const c = process["env"].X;',
          'const d = process.env["Y"];',
          "const e = process.env;",
        ].join("\n");

        // when
        const result = findProcessEnvAccesses(source).map(
          ({ variable }) => variable,
        );

        // then
        expect(result).toEqual([
          "NEXT_RUNTIME",
          "DATABASE_URL",
          "X",
          undefined,
          undefined,
        ]);
      },
    );

    And(
      "参照ごとに、書かれた行番号を返す（コメントを消しても行はずれない）",
      () => {
        // given
        const source = [
          "/*",
          " * process.env は読まない",
          " */",
          "const a = process.env.A; const b = process.env.B;",
          "// process.env",
          'const c = process["env"].C;',
        ].join("\n");

        // when
        const result = findProcessEnvAccesses(source).map(({ line }) => line);

        // then
        expect(result).toEqual([4, 4, 6]);
      },
    );

    And(
      "分割代入・別名・Reflect.get・node:process の default import 経由の参照は拾わない（見逃す方向の限界。Biome の noProcessEnv も検出しない）",
      () => {
        // given
        const source = [
          "const { env } = process;",
          "const p = process; p.env;",
          'const e = Reflect.get(process, "env");',
          'import proc from "node:process"; proc.env.X;',
        ].join("\n");

        // when
        const processEnvAccesses = findProcessEnvAccesses(source);

        // then
        expect(processEnvAccesses).toEqual([]);
      },
    );

    And(
      "node:process の名前付き import（env を取り出す形）は拾わない（見逃す方向の限界。Biome の noProcessEnv が検出する）",
      () => {
        // given
        const source = [
          'import { env } from "node:process";',
          "export const u = env.X;",
        ].join("\n");

        // when
        const processEnvAccesses = findProcessEnvAccesses(source);

        // then
        expect(processEnvAccesses).toEqual([]);
      },
    );

    And(
      "テンプレートリテラルの埋め込み式の中の参照は拾わない（見逃す方向の限界。Biome の noProcessEnv が検出する）",
      () => {
        // given
        // WHY テンプレートリテラルで書く: 普通の文字列の中に埋め込み式の形を書くと Biome の noTemplateCurlyInString が
        //   書き間違いとして検出するため、\${ でエスケープして同じ文字列を作る。
        const source = `const url = \`db: \${process.env.DATABASE_URL}\`;`;

        // when
        const processEnvAccesses = findProcessEnvAccesses(source);

        // then
        expect(processEnvAccesses).toEqual([]);
      },
    );
  });

  Scenario("console を直接書く規則の判定", ({ And }) => {
    And("違反例・許可例はそれぞれ 4 件以上ある", () => {
      // given: 前提なし
      // when
      const violatingExampleCount = CONSOLE_ACCESS_EXAMPLES.violating.length;

      // then
      expect(violatingExampleCount).toBeGreaterThanOrEqual(4);

      // when
      const allowedExampleCount = CONSOLE_ACCESS_EXAMPLES.allowed.length;

      // then
      expect(allowedExampleCount).toBeGreaterThanOrEqual(4);
    });
    And("違反例（CONSOLE_ACCESS_EXAMPLES.violating）はすべて違反になる", () => {
      // given
      const cases = sourceExampleCases(CONSOLE_ACCESS_EXAMPLES.violating);

      // when
      const result = casesByName(cases, ([, example]) =>
        judgeConsoleAccess(example),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => true));
    });
    And(
      "許可例（CONSOLE_ACCESS_EXAMPLES.allowed）はどれも違反にならない",
      () => {
        // given
        const cases = sourceExampleCases(CONSOLE_ACCESS_EXAMPLES.allowed);

        // when
        const result = casesByName(cases, ([, example]) =>
          judgeConsoleAccess(example),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("console の参照の抽出（findConsoleAccesses）", ({ And }) => {
    And(
      "参照ごとに、書かれた行番号を返す（コメントを消しても行はずれない）",
      () => {
        // given
        const source = [
          "/*",
          " * console.log は書かない",
          " */",
          "console.log(1); console.error(2);",
          "// console.warn",
          'globalThis.console["info"](3);',
        ].join("\n");

        // when
        const consoleAccesses = findConsoleAccesses(source);

        // then
        expect(consoleAccesses).toEqual([4, 4, 6]);
      },
    );

    And(
      "node:console の import（名前付きの import と default import）は拾わない（見逃す方向の限界。Biome の noConsole も検出しない）",
      () => {
        // given
        const source = [
          'import { log } from "node:console";',
          'import c from "node:console";',
          "log(1); c.log(2);",
        ].join("\n");

        // when
        const consoleAccesses = findConsoleAccesses(source);

        // then
        expect(consoleAccesses).toEqual([]);
      },
    );

    And(
      "テンプレートリテラルの埋め込み式の中の console は拾わない（見逃す方向の限界。Biome の noConsole が検出する）",
      () => {
        // given
        // WHY テンプレートリテラルで書く: 環境変数の抽出のテストと同じく、noTemplateCurlyInString を避けるため。
        const source = `const s = \`x: \${console.log(1)}\`;`;

        // when
        const consoleAccesses = findConsoleAccesses(source);

        // then
        expect(consoleAccesses).toEqual([]);
      },
    );
  });

  Scenario("現在時刻を読む規則の判定", ({ And }) => {
    And("違反例・許可例はそれぞれ 4 件以上ある", () => {
      // given: 前提なし
      // when
      const violatingExampleCount = NOW_ACCESS_EXAMPLES.violating.length;

      // then
      expect(violatingExampleCount).toBeGreaterThanOrEqual(4);

      // when
      const allowedExampleCount = NOW_ACCESS_EXAMPLES.allowed.length;

      // then
      expect(allowedExampleCount).toBeGreaterThanOrEqual(4);
    });
    And("違反例（NOW_ACCESS_EXAMPLES.violating）はすべて違反になる", () => {
      // given
      const cases = sourceExampleCases(NOW_ACCESS_EXAMPLES.violating);

      // when
      const result = casesByName(cases, ([, example]) =>
        judgeNowAccess(example),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => true));
    });
    And("許可例（NOW_ACCESS_EXAMPLES.allowed）はどれも違反にならない", () => {
      // given
      const cases = sourceExampleCases(NOW_ACCESS_EXAMPLES.allowed);

      // when
      const result = casesByName(cases, ([, example]) =>
        judgeNowAccess(example),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => false));
    });
  });

  Scenario("現在時刻の読み取りの抽出（findCurrentTimeAccesses）", ({ And }) => {
    And(
      "読み取りごとに、書かれた行番号を返す（1 行に 2 つあれば 2 件。コメントを消しても行はずれない）",
      () => {
        // given
        const source = [
          "/*",
          " * new Date() は書かない",
          " */",
          "const a = new Date(); const b = Date.now();",
          "// Date.now()",
          "const c = new Date(a);",
          "const d = new Date(",
          ");",
        ].join("\n");

        // when
        const currentTimeAccesses = findCurrentTimeAccesses(source);

        // then
        expect(currentTimeAccesses).toEqual([4, 4, 7]);
      },
    );

    And(
      "別名・分割代入・括弧で囲んだ Date・空のスプレッド・Reflect.construct は拾わない（見逃す方向の限界）",
      () => {
        // given
        const source = [
          "const D = Date; const a = new D();",
          "const { now: read } = Date; read();",
          "const b = new (Date)();",
          "const c = new Date(...[]);",
          "const d = Reflect.construct(Date, []);",
        ].join("\n");

        // when
        const currentTimeAccesses = findCurrentTimeAccesses(source);

        // then
        expect(currentTimeAccesses).toEqual([]);
      },
    );

    And(
      "テンプレートリテラルの埋め込み式の中は拾わない（見逃す方向の限界）",
      () => {
        // given
        // WHY テンプレートリテラルで書く: console の抽出のテストと同じく、noTemplateCurlyInString を避けるため。
        const source = `const s = \`at: \${Date.now()}\`;`;

        // when
        const currentTimeAccesses = findCurrentTimeAccesses(source);

        // then
        expect(currentTimeAccesses).toEqual([]);
      },
    );

    And(
      "Date という名前のメソッドの呼び出し（calendar.Date()）も new の無い Date() として数える（多く検出する方向の限界）",
      () => {
        // given: 前提なし
        // when
        const currentTimeAccesses = findCurrentTimeAccesses("calendar.Date();");

        // then
        expect(currentTimeAccesses).toEqual([1]);
      },
    );
  });

  for (const rule of HARDCODED_TEXT_RULES) {
    Scenario(`ハードコードの文言の判定（${rule.id}）`, ({ And }) => {
      const examples = HARDCODED_TEXT_EXAMPLES[rule.id];
      // WHY 遅延して 1 回だけ判定する: 例ごとに tsgo を起動すると遅いため、最初に判定する step で全例をまとめて判定する。
      let verdicts: { violating: boolean[]; allowed: boolean[] } | undefined;
      const verdictsOf = () => {
        verdicts ??= {
          violating: judgeHardcodedTexts(rule, examples.violating),
          allowed: judgeHardcodedTexts(rule, examples.allowed),
        };
        return verdicts;
      };
      And("違反例・許可例はそれぞれ 4 件以上ある", () => {
        // given: 前提なし
        // when
        const violatingExampleCount = examples.violating.length;

        // then
        expect(violatingExampleCount).toBeGreaterThanOrEqual(4);

        // when
        const allowedExampleCount = examples.allowed.length;

        // then
        expect(allowedExampleCount).toBeGreaterThanOrEqual(4);
      });
      And(
        "違反例（HARDCODED_TEXT_EXAMPLES の violating）はすべて違反になる",
        () => {
          // given
          const cases = examples.violating.map(
            ([file, source], i): [string, number] => [
              `${file} の ${JSON.stringify(source)}`,
              i,
            ],
          );

          // when
          const result = casesByName(
            cases,
            ([, i]) => verdictsOf().violating[i],
          );

          // then
          expect(result).toEqual(casesByName(cases, () => true));
        },
      );
      And(
        "許可例（HARDCODED_TEXT_EXAMPLES の allowed）はどれも違反にならない",
        () => {
          // given
          const cases = examples.allowed.map(
            ([file, source], i): [string, number] => [
              `${file} の ${JSON.stringify(source)}`,
              i,
            ],
          );

          // when
          const result = casesByName(cases, ([, i]) => verdictsOf().allowed[i]);

          // then
          expect(result).toEqual(casesByName(cases, () => false));
        },
      );
    });
  }

  Scenario("ハードコードの文言の抽出（findHardcodedTexts）", ({ And }) => {
    And(
      "文言ごとに、書かれた行番号を返す（JSX のテキストは最初の文字の行。属性と日本語の両方に当たる値は 1 件）",
      () => {
        // given
        const source = [
          "/*",
          " * 削除のボタン",
          " */",
          "export const C = ({ todo }) => (",
          '  <button aria-label="Delete" title={`Edit`}>',
          "",
          "    削除",
          "  </button>",
          ");",
          `export const D = ({ todo }) => <img alt={\`「\${todo.title}」\`} />;`,
          'export const m = "保存しました"; // 日本語',
        ].join("\n");

        // when
        const result = hardcodedTextLinesOf(
          "x.tsx",
          source,
          FRONTEND_HARDCODED_TEXT,
        );

        // then
        expect(result).toEqual([5, 5, 7, 10, 11]);
      },
    );

    And(
      "ASCII の文字列を変数に入れてから JSX に渡す・JSX の子に式で書く・一覧に無い props・三項演算子の中は拾わない（見逃す方向の限界。日本語なら拾う）",
      () => {
        // given
        const source = [
          'const s = "Delete";',
          "export const A = () => <p>{s}</p>;",
          'export const B = () => <p>{"Delete"}</p>;',
          'export const C = () => <Dialog heading="Delete" />;',
          'export const D = (x) => <a title={x ? "Open" : "Close"} />;',
          'export const E = (x) => <a title={x ? "開く" : "閉じる"} />;',
        ].join("\n");

        // when
        const result = hardcodedTextLinesOf(
          "x.tsx",
          source,
          FRONTEND_HARDCODED_TEXT,
        );

        // then
        expect(result).toEqual([6, 6]);
      },
    );

    And(
      "辞書（.messages.ts）では defineMessages(...) の引数の中だけを通し、引数の外の文言は行番号で返す",
      () => {
        // given
        const source = [
          'import { defineMessages } from "@/shared/i18n/i18n";',
          'export const label = "削除";',
          "export const m = defineMessages({",
          '  ja: { delete: "削除" },',
          '  en: { delete: "Delete" },',
          "});",
          'export const e = createElement("button", { "aria-label": "閉じる" });',
        ].join("\n");

        // when
        const result = hardcodedTextLinesOf(
          "apps/frontend_customer/features/todo/components/x.messages.ts",
          source,
          FRONTEND_HARDCODED_TEXT,
        );

        // then
        expect(result).toEqual([2, 7]);

        // when
        const nonDictionaryLines = hardcodedTextLinesOf(
          "apps/frontend_customer/features/todo/components/x.ts",
          source,
          FRONTEND_HARDCODED_TEXT,
        );

        // then
        // 同じ中身でも辞書でないファイルなら、defineMessages の引数の中も違反。
        expect(nonDictionaryLines).toEqual([2, 4, 7]);
      },
    );

    And(
      "構文解析の結果に無いファイルを渡すと例外にする（黙って飛ばして素通りさせない）",
      () => {
        // given: 前提なし
        // when
        const action = () => parseSourceFiles({ "README.md": "# x" });

        // then
        // .md は tsconfig の files に書いても TypeScript のソースにならない。
        expect(action).toThrow(new Error("構文解析の結果に README.md が無い"));
      },
    );
  });

  Scenario(
    `handle を ProblemResponse.wrap で包む規則の判定（${PRESENTATION_WITH_PROBLEM_RESPONSE.id}）`,
    ({ And }) => {
      const { violating, allowed } = PROBLEM_RESPONSE_EXAMPLES;
      // WHY 遅延して 1 回だけ判定する: 例ごとに tsgo を起動すると遅いため（ハードコードの文言の判定と同じ）。
      let verdicts: { violating: boolean[]; allowed: boolean[] } | undefined;
      const verdictsOf = () => {
        verdicts ??= {
          violating: judgeProblemResponses(violating),
          allowed: judgeProblemResponses(allowed),
        };
        return verdicts;
      };
      // WHY ケース名にソースを入れない: 複数行のソースがあり、名前が崩れる。どの例かは番号と、例の一覧のコメントで追う。
      And(
        "違反例（PROBLEM_RESPONSE_EXAMPLES.violating）はすべて違反になる",
        () => {
          // given
          const cases = violating.map(([file], i): [string, number] => [
            `違反例 ${i}（${file}）`,
            i,
          ]);

          // when
          const result = casesByName(
            cases,
            ([, i]) => verdictsOf().violating[i],
          );

          // then
          expect(result).toEqual(casesByName(cases, () => true));
        },
      );
      And(
        "許可例（PROBLEM_RESPONSE_EXAMPLES.allowed）はどれも違反にならない",
        () => {
          // given
          const cases = allowed.map(([file], i): [string, number] => [
            `許可例 ${i}（${file}）`,
            i,
          ]);

          // when
          const result = casesByName(cases, ([, i]) => verdictsOf().allowed[i]);

          // then
          expect(result).toEqual(casesByName(cases, () => false));
        },
      );
    },
  );

  Scenario(
    "ProblemResponse.wrap で包んでいない handle の抽出（findUnwrappedHandles）",
    ({ And }) => {
      And(
        "包んでいない handle ごとに、メンバーの書き出しの行番号を返す（包んだ handle・ほかの名前のメンバーは返さない）",
        () => {
          // given
          const source = lines(
            IMPORT_WITH_PROBLEM_RESPONSE,
            "export class AApi {",
            "  readonly handle = ProblemResponse.wrap(async (request: Request) => new Response(null));",
            "}",
            "export class BApi {",
            "  private readonly other = 1;",
            "  readonly handle = async (request: Request) => new Response(null);",
            "}",
            "export const C = class {",
            "  async handle() {",
            "    return new Response(null);",
            "  }",
            "};",
          );

          // when
          const unwrappedHandles = findUnwrappedHandles(
            parseSourceFiles({ [API_FILE]: source }).get(
              API_FILE,
            ) as SourceFile,
          );

          // then
          expect(unwrappedHandles).toEqual([7, 10]);
        },
      );
    },
  );

  Scenario(
    `backend と apps/shared の本番コードとテストの補助、frontend の React 以外のモジュールの最上位に関数を置かない規則の判定（${CLASS_BASED.id}）`,
    ({ And }) => {
      const { violating, allowed } = CLASS_BASED_EXAMPLES;
      // WHY 遅延して 1 回だけ判定する: 例ごとに tsgo を起動すると遅いため（handle の規則の判定と同じ）。
      let verdicts: { violating: boolean[]; allowed: boolean[] } | undefined;
      const verdictsOf = () => {
        verdicts ??= {
          violating: judgeClassBased(violating),
          allowed: judgeClassBased(allowed),
        };
        return verdicts;
      };
      And("違反例（CLASS_BASED_EXAMPLES.violating）はすべて違反になる", () => {
        // given
        const cases = violating.map(([file], i): [string, number] => [
          `違反例 ${i}（${file}）`,
          i,
        ]);

        // when
        const result = casesByName(cases, ([, i]) => verdictsOf().violating[i]);

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      });
      And(
        "許可例（CLASS_BASED_EXAMPLES.allowed）はどれも違反にならない",
        () => {
          // given
          const cases = allowed.map(([file], i): [string, number] => [
            `許可例 ${i}（${file}）`,
            i,
          ]);

          // when
          const result = casesByName(cases, ([, i]) => verdictsOf().allowed[i]);

          // then
          expect(result).toEqual(casesByName(cases, () => false));
        },
      );
    },
  );

  Scenario("最上位の関数の抽出（findTopLevelFunctions）", ({ And }) => {
    And(
      "最上位の関数ごとに宣言の書き出しの行番号を返す（オーバーロードは宣言ごと、1 つの文の変数は関数のものだけ、クラスの中は返さない）",
      () => {
        // given
        const source = lines(
          "export function f(x: string): string;",
          "export function f(x: number): number;",
          "export function f(x: unknown): unknown {",
          "  return x;",
          "}",
          "export class A {",
          "  static g(): void {}",
          "  readonly h = () => 1;",
          "}",
          "const a = 1,",
          "  b = () => a;",
          "export default function () {}",
        );

        // when
        const topLevelFunctions = findTopLevelFunctions(
          parseSourceFiles({ [SHARED_ERROR_FILE]: source }).get(
            SHARED_ERROR_FILE,
          ) as SourceFile,
        );

        // then
        expect(topLevelFunctions).toEqual([1, 2, 3, 11, 12]);
      },
    );
  });

  Scenario("規則ごとの判定", ({ And }) => {
    // WHY: 規則を足したのに判定の例を足し忘れると、その規則の判定は下の規則ごとの Scenario で 1 度も確かめられない（Issue #68 で 3 規則を足した）。
    And(
      "RULES のすべての規則に判定の例があり、RULES に無い規則の例は無い",
      () => {
        // given: 前提なし
        // when
        const result = Object.keys(RULE_EXAMPLES).sort();

        // then
        expect(result).toEqual(RULES.map((rule) => rule.id).sort());
      },
    );

    // WHY 件数をそろえる: 例が 1 件だけだと、規則の書き方を少し崩した（条件を 1 つ落とした）ときに気づけない。
    //   違反・許可の両側に複数の例を置き、境界の両側を固定する。
    And("どの規則も違反例・許可例がそれぞれ 3 件以上ある", () => {
      // given
      const cases = Object.keys(RULE_EXAMPLES).map((id): [string] => [id]);

      // when
      const result = casesByName(cases, ([id]) => {
        const { violating, allowed } = RULE_EXAMPLES[id as RuleId];
        return {
          violating: violating.length >= 3,
          allowed: allowed.length >= 3,
        };
      });

      // then
      expect(result).toEqual(
        casesByName(cases, () => ({ violating: true, allowed: true })),
      );
    });
  });

  for (const [id, { violating, allowed }] of Object.entries(RULE_EXAMPLES) as [
    RuleId,
    { violating: Example[]; allowed: Example[] },
  ][]) {
    Scenario(`規則ごとの判定（${id}）`, ({ And }) => {
      And("違反例（RULE_EXAMPLES の violating）はすべて違反になる", () => {
        // given
        const cases = violating.map((example): [string, Example] => [
          exampleName(example),
          example,
        ]);

        // when
        const result = casesByName(cases, ([, example]) => judge(id, example));

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      });
      And("許可例（RULE_EXAMPLES の allowed）はどれも違反にならない", () => {
        // given
        const cases = allowed.map((example): [string, Example] => [
          exampleName(example),
          example,
        ]);

        // when
        const result = casesByName(cases, ([, example]) => judge(id, example));

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      });
    });
  }

  Scenario("exports のキーの照合（resolveExportKey）", ({ And }) => {
    And("当たる例・当たらない例はそれぞれ 3 件以上ある", () => {
      // given: 前提なし
      // when
      const resolvedExampleCount = EXPORT_KEY_EXAMPLES.resolved.length;

      // then
      expect(resolvedExampleCount).toBeGreaterThanOrEqual(3);

      // when
      const unresolvedExampleCount = EXPORT_KEY_EXAMPLES.unresolved.length;

      // then
      expect(unresolvedExampleCount).toBeGreaterThanOrEqual(3);
    });

    And(
      "当たる例（EXPORT_KEY_EXAMPLES.resolved）は、それぞれ例に書いたキーに当たる",
      () => {
        // given
        const cases = EXPORT_KEY_EXAMPLES.resolved;

        // when
        const result = casesByName(cases, ([specifier]) =>
          resolveExportKey(
            exportSubpath(BACKEND_EXPORTS, specifier),
            EXPORT_KEY_EXAMPLES.keys,
          ),
        );

        // then
        expect(result).toEqual(casesByName(cases, ([, key]) => key));
      },
    );

    And(
      "当たらない例（EXPORT_KEY_EXAMPLES.unresolved）はどのキーにも当たらない",
      () => {
        // given
        const cases = EXPORT_KEY_EXAMPLES.unresolved.map(
          (specifier): [string] => [specifier],
        );

        // when
        const result = casesByName(cases, ([specifier]) =>
          resolveExportKey(
            exportSubpath(BACKEND_EXPORTS, specifier),
            EXPORT_KEY_EXAMPLES.keys,
          ),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => undefined));
      },
    );
  });

  Scenario("exports の違反の検出（findExportsViolations）", ({ And }) => {
    const ref = (from: string, specifier: string): Reference =>
      toReference(from, { specifier, typeOnly: false });
    const backendFiles = [
      "apps/backend/features/todo/internal/presentation/list-todos.api.ts",
      "apps/backend/shared/infra/env.ts",
      "apps/backend/unused.ts",
      "apps/backend/mismatch.ts",
      "apps/backend/object.ts",
    ];

    And(
      "すべての参照がキーに当たり、すべてのキーが使われ、値がキーのパスの .ts でファイルがあれば、違反は 0 件",
      () => {
        // given: 前提なし
        // when
        const violations = findExportsViolations(
          BACKEND_EXPORTS,
          {
            "./features/todo/internal/presentation/*.api":
              "./features/todo/internal/presentation/*.api.ts",
            "./shared/infra/env": "./shared/infra/env.ts",
          },
          [
            ref(
              "apps/frontend_customer/app/api/todos/route.ts",
              "@repo/backend/features/todo/internal/presentation/list-todos.api",
            ),
            ref(
              "apps/e2e/support/database.ts",
              "@repo/backend/shared/infra/env",
            ),
            // backend の中の参照（backend-relative-only が見る）と、前方一致だけが同じ別パッケージは数えない。
            ref(
              "apps/backend/features/todo/internal/infra/x.ts",
              "@repo/backend/features/todo/internal/infra/todo-repository.postgres",
            ),
            ref("apps/frontend_customer/app/page.tsx", "@repo/backend-extra/x"),
          ],
          backendFiles,
        );

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "キーに当たらない参照、使われないキー、キーと違う値、ファイルの無いキーを、それぞれ検出する",
      () => {
        // given: 前提なし
        // when
        const violations = findExportsViolations(
          BACKEND_EXPORTS,
          {
            "./features/todo/internal/presentation/*.api":
              "./features/todo/internal/presentation/*.api.ts",
            "./unused": "./unused.ts",
            "./mismatch":
              "./features/todo/internal/presentation/list-todos.api.ts",
            "./object": { import: "./object.ts" },
            "./missing": "./missing.ts",
            "./features/todo/internal/domain/*":
              "./features/todo/internal/domain/*.ts",
          },
          [
            ref(
              "apps/frontend_customer/app/api/todos/route.ts",
              "@repo/backend/features/todo/internal/presentation/list-todos.api",
            ),
            ref(
              "apps/frontend_customer/features/todo/api/x.ts",
              "@repo/backend/features/todo/internal/infra/todo-repository.postgres",
            ),
            ref("apps/e2e/playwright.config.ts", "@repo/backend"),
            ref("apps/e2e/a.ts", "@repo/backend/mismatch"),
            ref("apps/e2e/a.ts", "@repo/backend/object"),
            ref("apps/e2e/a.ts", "@repo/backend/missing"),
            ref(
              "apps/e2e/a.ts",
              "@repo/backend/features/todo/internal/domain/todo",
            ),
          ],
          backendFiles,
        );

        // then
        expect(violations).toEqual([
          "apps/frontend_customer/features/todo/api/x.ts → @repo/backend/features/todo/internal/infra/todo-repository.postgres",
          "apps/e2e/playwright.config.ts → @repo/backend",
          'apps/backend/package.json の exports "./unused" はどこからも参照されていない',
          'apps/backend/package.json の exports "./mismatch" の値 "./features/todo/internal/presentation/list-todos.api.ts" は、キーのパスに .ts を付けたものではない',
          'apps/backend/package.json の exports "./object" の値 {"import":"./object.ts"} は、キーのパスに .ts を付けたものではない',
          'apps/backend/package.json の exports "./missing" が指すファイルが無い',
          'apps/backend/package.json の exports "./features/todo/internal/domain/*" が指すファイルが無い',
        ]);
      },
    );

    And('キーが "./" で始まらないものは、値の形の違反にする', () => {
      // given: 前提なし
      // when
      const violations = findExportsViolations(
        BACKEND_EXPORTS,
        { "./x": "./x.ts", x: "x.ts" },
        [ref("apps/e2e/a.ts", "@repo/backend/x")],
        ["apps/backend/x.ts"],
      );

      // then
      expect(violations).toEqual([
        'apps/backend/package.json の exports "x" はどこからも参照されていない',
        'apps/backend/package.json の exports "x" の値 "x.ts" は、キーのパスに .ts を付けたものではない',
        'apps/backend/package.json の exports "x" が指すファイルが無い',
      ]);
    });
  });

  Scenario(
    "apps/shared の exports の違反の検出（findExportsViolations と SHARED_EXPORTS。Issue #90）",
    ({ And }) => {
      const ref = (from: string, specifier: string): Reference =>
        toReference(from, { specifier, typeOnly: false });
      const sharedFiles = ["apps/shared/env.ts", "apps/shared/logger.ts"];
      const exports = {
        "./env": "./env.ts",
        "./logger": "./logger.ts",
      };

      And(
        "frontend 直下・backend・apps/e2e/・リポジトリ直下の参照がすべてキーに当たり、すべてのキーが使われていれば、違反は 0 件",
        () => {
          // given: 前提なし
          // when
          const violations = findExportsViolations(
            SHARED_EXPORTS,
            exports,
            [
              ref("apps/frontend_customer/proxy.ts", "@repo/shared/logger"),
              ref(
                "apps/backend/shared/drizzle/database.ts",
                "@repo/shared/env",
              ),
              ref("apps/e2e/support/database.ts", "@repo/shared/env"),
              ref("vitest.global-setup.ts", "@repo/shared/env"),
              // apps/shared の中の参照と、前方一致だけが同じ別パッケージ・@repo/backend の参照は数えない。
              ref("apps/shared/x.ts", "@repo/shared/missing"),
              ref(
                "apps/frontend_customer/app/page.tsx",
                "@repo/shared-extra/x",
              ),
              ref("apps/e2e/a.ts", "@repo/backend/env"),
            ],
            sharedFiles,
          );

          // then
          expect(violations).toEqual([]);
        },
      );

      And(
        "キーに当たらない参照（backend からのものも）、使われないキー、キーと違う値、ファイルの無いキーを検出し、apps/shared/package.json の名前で出す",
        () => {
          // given: 前提なし
          // when
          const violations = findExportsViolations(
            SHARED_EXPORTS,
            {
              ...exports,
              "./unused": "./unused.ts",
              "./mismatch": "./env.ts",
            },
            [
              ref("apps/frontend_customer/proxy.ts", "@repo/shared/logger"),
              ref(
                "apps/backend/shared/drizzle/database.ts",
                "@repo/shared/env",
              ),
              ref(
                "apps/backend/shared/drizzle/database.ts",
                "@repo/shared/database",
              ),
              ref("apps/e2e/a.ts", "@repo/shared"),
              ref("apps/e2e/a.ts", "@repo/shared/mismatch"),
            ],
            sharedFiles,
          );

          // then
          expect(violations).toEqual([
            "apps/backend/shared/drizzle/database.ts → @repo/shared/database",
            "apps/e2e/a.ts → @repo/shared",
            'apps/shared/package.json の exports "./unused" はどこからも参照されていない',
            'apps/shared/package.json の exports "./unused" が指すファイルが無い',
            'apps/shared/package.json の exports "./mismatch" の値 "./env.ts" は、キーのパスに .ts を付けたものではない',
            'apps/shared/package.json の exports "./mismatch" が指すファイルが無い',
          ]);
        },
      );
    },
  );

  // Issue #130 / #142: 列挙は除外するディレクトリ（EXCLUDED_DIRS）の中に入らない（列挙した後で除くのではない）。
  // WHY: next build が作る apps/frontend_customer/.next/standalone/ には、pnpm の node_modules の形（.pnpm の中の相対パスの
  //   symlink）が複製される。以前の列挙（readdirSync の recursive: true）は symlink の先のディレクトリにも入り（Node 24.21.0 の
  //   lib/fs.js の handleFilePaths が internalModuleStat で symlink をたどる）、除くのは列挙の後だったため、symlink の組み合わせで
  //   列挙が膨らみ、rule-tests が heap を使い切って落ちた（#130 で 463 秒かけて OOM、#137 で手元の node_modules/node_modules の
  //   自己参照 symlink が standalone に複製されて SIGABRT。2026-09-29 に実測）。
  // WHY 読んだディレクトリを記録して確かめる（結果の一覧だけを見ない）: 列挙した後で除いても結果の一覧は同じで、違いは
  //   中に入るかどうか（かかる時間と memory）だけ。循環する symlink の fixture は、以前の列挙でも ELOOP（symlink 40 段）で
  //   止まって結果が同じになるか、2 本以上あると止まらなくなり（2^40）、どちらも決定的な失敗にならない（2026-09-29 に実測）。
  Scenario(
    "ファイルの列挙（walkFiles・listSourceFiles・listAllFiles）",
    ({ And }) => {
      // WHY 結果を返す: テストの本体で when（実行）と then（検証）を分けるため、一時ツリーの中で集めた結果を外に返す（後始末は finally のまま）。
      function withTree<T>(
        files: Record<string, string>,
        symlinks: Record<string, string>,
        collect: (root: string) => T,
      ): T {
        const root = mkdtempSync(join(tmpdir(), "architecture-list-test-"));
        try {
          for (const [path, content] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), content);
          }
          for (const [path, target] of Object.entries(symlinks)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            symlinkSync(target, join(root, path));
          }
          return collect(root);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }

      function walkRecordingReads(root: string, dir: string) {
        const read: string[] = [];
        const files = walkFiles(root, dir, (path) => {
          read.push(toPosix(relative(root, path)));
          return readDirectory(path);
        });
        return { read: read.sort(), files: files.sort() };
      }

      const GENERATED_TREE = {
        "apps/frontend_customer/app/page.tsx": "export default 1;",
        "apps/frontend_customer/.lib/x.ts": "export const x = 1;",
        "apps/frontend_customer/.next/standalone/server.js": "process.env;",
        "apps/frontend_customer/.next/server/chunk.js": "process.env;",
        "apps/frontend_customer/node_modules/pkg/index.js": "process.env;",
        "apps/frontend_customer/features/todo/node_modules/pkg/index.js":
          "process.env;",
      };

      And(
        "除外するディレクトリ（node_modules・.next）は、どの階層でも読まない（中に入ってから除くのではない）",
        () => {
          // given: モジュールの定数 GENERATED_TREE（生成物のディレクトリを含むツリー）
          // when
          const walked = withTree(GENERATED_TREE, {}, (root) =>
            walkRecordingReads(root, FRONTEND_ROOT),
          );

          // then
          expect(walked).toEqual({
            read: [
              "apps/frontend_customer",
              "apps/frontend_customer/.lib",
              "apps/frontend_customer/app",
              "apps/frontend_customer/features",
              "apps/frontend_customer/features/todo",
            ],
            files: [
              "apps/frontend_customer/.lib/x.ts",
              "apps/frontend_customer/app/page.tsx",
            ],
          });
        },
      );

      // Issue #142 の再現の形: .next/standalone/ に複製された pnpm の相対 symlink が循環する（2 本あると以前の列挙は 2^40 で
      //   止まらない）。除外のディレクトリの中なので、読まずに完走する。中に入ってから除くと statSync が ELOOP を投げて失敗する。
      And(
        "除外するディレクトリの中に循環する symlink（.next/standalone/node_modules/x -> ../..）があっても、中に入らずに完走する",
        () => {
          // given
          const symlinks = {
            "apps/frontend_customer/.next/standalone/node_modules/x": "../..",
            "apps/frontend_customer/.next/standalone/node_modules/y": "../..",
            "apps/frontend_customer/node_modules/node_modules": "..",
          };

          // when
          const walked = withTree(GENERATED_TREE, symlinks, (root) =>
            walkRecordingReads(root, FRONTEND_ROOT),
          );

          // then
          expect(walked).toEqual({
            read: [
              "apps/frontend_customer",
              "apps/frontend_customer/.lib",
              "apps/frontend_customer/app",
              "apps/frontend_customer/features",
              "apps/frontend_customer/features/todo",
            ],
            files: [
              "apps/frontend_customer/.lib/x.ts",
              "apps/frontend_customer/app/page.tsx",
            ],
          });
        },
      );

      And(
        "listSourceFiles・listAllFiles は、除外するディレクトリの中に自分を指す symlink があっても、その外のファイルだけを返す",
        () => {
          // given
          const files = {
            ...GENERATED_TREE,
            "apps/shared/env.ts": "export const env = 1;",
            "apps/shared/node_modules/pkg/index.js": "process.env;",
          };
          const symlinks = {
            "apps/frontend_customer/.next/standalone/self": ".",
            "apps/shared/node_modules/self": ".",
          };

          // when
          const listed = withTree(files, symlinks, (root) => ({
            source: listSourceFiles(root, FRONTEND_ROOT).sort(),
            all: listAllFiles(root, SHARED_ROOT),
          }));

          // then
          expect(listed).toEqual({
            source: [
              "apps/frontend_customer/.lib/x.ts",
              "apps/frontend_customer/app/page.tsx",
            ],
            all: ["apps/shared/env.ts"],
          });
        },
      );

      // WHY symlink の先も列挙する: 以前の列挙（readdirSync の recursive: true）と同じ範囲を検査し、symlink で置いたディレクトリの
      //   コードが検査を素通りしないようにする。
      // listAllFiles の挙動の差: 以前は通常ファイル（entry.isFile()）だけを返し、ファイルを指す symlink は数えなかった。今は
      //   ディレクトリ以外をすべて返すので、ファイルへの symlink（と先の無い symlink）も返す（置き場所の規則で違反にできる）。
      And(
        "除外しないディレクトリの symlink は、先のディレクトリの中も列挙し、ファイルへの symlink もファイルとして返す",
        () => {
          // given
          const files = {
            "apps/frontend_customer/app/page.tsx": "export default 1;",
            "outside/lib/db.ts": "export const db = 1;",
            "outside/shared-extra/extra.ts": "export const x = 1;",
            "outside/note.md": "x",
          };
          const symlinks = {
            "apps/frontend_customer/lib": "../../outside/lib",
            "apps/shared/extra": "../../outside/shared-extra",
            "apps/shared/note.md": "../../outside/note.md",
            "apps/shared/dangling.ts": "../../outside/missing.ts",
          };

          // when
          const listed = withTree(files, symlinks, (root) => ({
            source: listSourceFiles(root, FRONTEND_ROOT).sort(),
            all: listAllFiles(root, SHARED_ROOT).sort(),
          }));

          // then
          expect(listed).toEqual({
            source: [
              "apps/frontend_customer/app/page.tsx",
              "apps/frontend_customer/lib/db.ts",
            ],
            all: [
              "apps/shared/dangling.ts",
              "apps/shared/extra/extra.ts",
              "apps/shared/note.md",
            ],
          });
        },
      );

      // WHY 例外で止まることを固定する: 除外の外で循環すると、statSync が ELOOP（symlink 40 段）を投げて列挙が失敗する（無限には
      //   再帰しない）。以前の列挙（readdirSync の recursive: true）は ELOOP を黙って握りつぶし、途中までの一覧を返していた
      //   （検査が一部だけで緑になりうる）。今は音を立てて失敗する。
      And(
        "除外の外に置いた循環する symlink（apps/backend/loop -> ..）は、ELOOP の例外で止まる（無限に回らない）",
        () => {
          // given
          const files = {
            "apps/backend/features/todo/internal/domain/todo.ts":
              "export const x = 1;",
          };
          const symlinks = { "apps/backend/loop": ".." };

          // when
          const thrown = withTree(files, symlinks, (root) => {
            try {
              walkFiles(root, BACKEND_ROOT);
              return undefined;
            } catch (error) {
              return error;
            }
          });

          // then
          expect(thrown).toMatchObject({ code: "ELOOP", syscall: "stat" });
        },
      );

      And("ディレクトリが無ければ空を返す", () => {
        // given: 前提なし（空のツリー）
        // when
        const listed = withTree({}, {}, (root) => ({
          walked: walkFiles(root, FRONTEND_ROOT),
          source: listSourceFiles(root, FRONTEND_ROOT),
          all: listAllFiles(root, SHARED_ROOT),
        }));

        // then
        expect(listed).toEqual({ walked: [], source: [], all: [] });
      });
    },
  );

  Scenario("fixture のツリーを検査したときに検出される違反", ({ And }) => {
    And(
      "must-reject: 置いた違反がすべて、置いたとおりの規則で検出され、それ以外は検出されない",
      () => {
        // given: 前提なし
        // when
        const result = violationsOfFixture(MUST_REJECT_FILES);

        // then
        expect(result).toEqual([...MUST_REJECT_VIOLATIONS].sort());
      },
    );

    And("must-pass: 許可される参照だけのツリーでは違反が 0 件", () => {
      // given: 前提なし
      // when
      const result = violationsOfFixture(MUST_PASS_FILES);

      // then
      expect(result).toEqual([]);
    });
  });

  Scenario("参照の抽出（extractImports）", ({ And }) => {
    And("複数行にまたがる import を 1 つの参照として取り出す", () => {
      // given
      const source = [
        "import {",
        "  CreateTodoCommand,",
        "  DeleteTodoCommand,",
        '} from "@/backend/features/todo/internal/application/x";',
      ].join("\n");

      // when
      const imports = extractImports(source);

      // then
      expect(imports).toEqual([
        {
          specifier: "@/backend/features/todo/internal/application/x",
          typeOnly: false,
        },
      ]);
    });

    And(
      "import type / export type は型だけの参照、名前を並べた export ... from は値の参照になる。export ... from は re-export の印を持つ",
      () => {
        // given
        const source = [
          'import type { A } from "a";',
          'export type { B } from "b";',
          'export { GET } from "c";',
          'export * from "d";',
          'import { Entity } from "e";',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        // WHY import に reExport が無いことも toEqual で見る: toEqual は undefined のプロパティを無いものと同じに扱うが、
        //   reExport: true が付けば一致しない（import を re-export と取り違えると、同じディレクトリの辞書の import まで違反になる）。
        expect(imports).toEqual([
          { specifier: "a", typeOnly: true },
          { specifier: "b", typeOnly: true, reExport: true },
          { specifier: "c", typeOnly: false, reExport: true },
          { specifier: "d", typeOnly: false, reExport: true },
          { specifier: "e", typeOnly: false },
        ]);
      },
    );

    And(
      "inline の type は、すべての名前に付いているときだけ型だけの参照になる",
      () => {
        // given
        const source = [
          'import { type A, type B } from "all-type";',
          'import { type A, Value } from "mixed";',
          'import Default, { type A } from "with-default";',
          'import {} from "empty";',
          // Issue #224（Codex のレビュー）: `type` という名前の値の export を別名で受ける形は、inline の type 修飾子ではなく値の import。
          'import { type as portValue } from "named-type";',
          'import { type A, type as portValue } from "named-type-mixed";',
          // 空白が複数でも（ブロックコメントを落とした跡）`type as` は値の import。
          'import { type    as portValue } from "named-type-spaces";',
          'import { type /* keep */ as portValue } from "named-type-comment";',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([
          { specifier: "all-type", typeOnly: true },
          { specifier: "mixed", typeOnly: false },
          { specifier: "with-default", typeOnly: false },
          { specifier: "empty", typeOnly: false },
          { specifier: "named-type", typeOnly: false },
          { specifier: "named-type-mixed", typeOnly: false },
          { specifier: "named-type-spaces", typeOnly: false },
          { specifier: "named-type-comment", typeOnly: false },
        ]);
      },
    );

    // Issue #144: presentation が自 feature の domain から値で import してよいのは定数だけ（規則 presentation）。import の名前が
    //   すべて UPPER_SNAKE_CASE（/^[A-Z][A-Z0-9_]*$/。inline の type の名前は数えない）のときだけ定数だけの印を持つ。
    // WHY as の前の名前（元の export 名）で見る: 参照先で何を export しているかが規則の対象で、手元の別名は関係ない。
    // WHY re-export・default・* as・{} は印を持たない: re-export は presentation から domain の値を外へ出す。default と * as は
    //   名前で中身が分からない（モジュール全体・任意の値）。{} は名前が無い。
    And(
      "名前がすべて UPPER_SNAKE_CASE の定数の import だけが、定数だけの印を持つ",
      () => {
        // given
        const source = [
          'import { TODO_TITLE_MAX_LENGTH } from "constant";',
          'import { MAX_2, A } from "constants";',
          'import { type Todo, TODO_TITLE_MAX_LENGTH } from "constant-and-type";',
          'import { TODO_TITLE_MAX_LENGTH as max } from "constant-alias";',
          "import {",
          "  TODO_A,",
          "  TODO_B,",
          '} from "multi-line";',
          'import { Todo } from "pascal";',
          'import { KeyedIssue } from "camel";',
          'import { TODO_MAX, Todo } from "mixed";',
          'import { max as TODO_MAX } from "alias-to-constant";',
          'import { Todo_MAX } from "not-upper";',
          'import { _TODO } from "underscore-first";',
          'import { TODO$ } from "dollar";',
          'import TODO_DEFAULT from "default";',
          'import * as TODO from "namespace";',
          'import TODO_D, { TODO_E } from "default-and-named";',
          'import {} from "empty";',
          'import { type TODO_T } from "type-only-inline";',
          'import type { TODO_T } from "type-only";',
          'export { TODO_MAX } from "re-export";',
          'import "side-effect";',
          'const m = import("dynamic");',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([
          { specifier: "constant", typeOnly: false, constantsOnly: true },
          { specifier: "constants", typeOnly: false, constantsOnly: true },
          {
            specifier: "constant-and-type",
            typeOnly: false,
            constantsOnly: true,
          },
          { specifier: "constant-alias", typeOnly: false, constantsOnly: true },
          { specifier: "multi-line", typeOnly: false, constantsOnly: true },
          { specifier: "pascal", typeOnly: false },
          { specifier: "camel", typeOnly: false },
          { specifier: "mixed", typeOnly: false },
          { specifier: "alias-to-constant", typeOnly: false },
          { specifier: "not-upper", typeOnly: false },
          { specifier: "underscore-first", typeOnly: false },
          { specifier: "dollar", typeOnly: false },
          { specifier: "default", typeOnly: false },
          { specifier: "namespace", typeOnly: false },
          { specifier: "default-and-named", typeOnly: false },
          { specifier: "empty", typeOnly: false },
          { specifier: "type-only-inline", typeOnly: true },
          { specifier: "type-only", typeOnly: true },
          { specifier: "re-export", typeOnly: false, reExport: true },
          { specifier: "side-effect", typeOnly: false },
          { specifier: "dynamic", typeOnly: false },
        ]);
      },
    );

    And(
      "副作用だけの import と dynamic import を値の参照として取り出す",
      () => {
        // given
        const source = [
          'import "./globals.css";',
          'const mod = await import("@/features/todo");',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([
          { specifier: "./globals.css", typeOnly: false },
          { specifier: "@/features/todo", typeOnly: false },
        ]);
      },
    );

    And(
      "コメントの中の import は拾わず、文字列の中の // でその後ろを消さない",
      () => {
        // given
        const source = [
          '// 例: import { GET } from "@/backend/line-comment";',
          "/*",
          ' * import { GET } from "@/backend/block-comment";',
          " */",
          'const url = "https://example.com"; import { a } from "after-string";',
          "const s = '/* not a comment */'; import { b } from \"after-quote\";",
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([
          { specifier: "after-string", typeOnly: false },
          { specifier: "after-quote", typeOnly: false },
        ]);
      },
    );

    And(
      "セミコロンの無い文の直後の import type を、前の文とつなげずに型だけの参照として取り出す",
      () => {
        // given
        const source = [
          "export enum E { A }",
          'import type { X } from "after-enum";',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([{ specifier: "after-enum", typeOnly: true }]);
      },
    );

    And(
      "文字列リテラル（テンプレートリテラルを含む）の中の import 風の文字列は拾わない",
      () => {
        // given
        const source = [
          "const a = 'import(\"@/backend/x\")';",
          "const b = 'import \"@/backend/y\"';",
          "const t = `",
          'import { c } from "@/backend/z";',
          "`;",
          'import { real } from "real";',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([{ specifier: "real", typeOnly: false }]);
      },
    );

    And(
      "埋め込み式（ドル記号と波かっこ）を含むテンプレートリテラルの import() は、参照先を静的に決められないので拾わない（見逃す方向の限界）",
      () => {
        // given
        // WHY テンプレートリテラルで書く: 普通の文字列の中に埋め込み式の形を書くと Biome の noTemplateCurlyInString が
        //   書き間違いとして検出するため、\${ でエスケープして同じ文字列を作る。
        const source = [
          `const m = import(\`@/backend/\${name}/presentation/x.api\`);`,
          'import { real } from "real";',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([{ specifier: "real", typeOnly: false }]);
      },
    );

    And(
      "from を持たない export 文から、後ろの文の from まで一致を伸ばさない",
      () => {
        // given
        const source = [
          "export const GET = new ListTodosApi(new ListTodosQuery(repository)).handle;",
          "export default function Page() {",
          "  return null",
          "}",
          'import { x } from "real";',
        ].join("\n");

        // when
        const imports = extractImports(source);

        // then
        expect(imports).toEqual([{ specifier: "real", typeOnly: false }]);
      },
    );
  });

  Scenario("参照先の正規化（toReference）", ({ And }) => {
    const from =
      "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx";

    And(
      '"@/" は apps/frontend_customer からのパスにする（tsconfig の paths で "@/" の下は apps/frontend_customer の下）',
      () => {
        // given: 前提なし
        // when
        const result = toReference(from, {
          specifier: "@/features/todo/api/todo-api",
          typeOnly: true,
        });

        // then
        expect(result).toEqual({
          from,
          specifier: "@/features/todo/api/todo-api",
          to: "apps/frontend_customer/features/todo/api/todo-api",
          own: true,
          typeOnly: true,
        });
      },
    );

    And(
      '"@repo/backend/" と "@repo/backend" は apps/backend からのパスにする',
      () => {
        // given: 前提なし
        // when
        const result = toReference(from, {
          specifier:
            "@repo/backend/features/todo/internal/presentation/list-todos.api.ts",
          typeOnly: true,
        });

        // then
        expect(result).toEqual({
          from,
          specifier:
            "@repo/backend/features/todo/internal/presentation/list-todos.api.ts",
          to: "apps/backend/features/todo/internal/presentation/list-todos.api",
          own: true,
          typeOnly: true,
        });

        // when
        const to2 = toReference(from, {
          specifier: "@repo/backend",
          typeOnly: false,
        }).to;

        // then
        expect(to2).toBe("apps/backend");
      },
    );

    And(
      '"@repo/shared/" と "@repo/shared" は apps/shared からのパスにし、"@repo/shared-extra/x" は自前のコードにしない（Issue #90）',
      () => {
        // given: 前提なし
        // when
        const result = toReference(from, {
          specifier: "@repo/shared/env.ts",
          typeOnly: false,
        });

        // then
        expect(result).toEqual({
          from,
          specifier: "@repo/shared/env.ts",
          to: "apps/shared/env",
          own: true,
          typeOnly: false,
        });

        // when
        const to2 = toReference(from, {
          specifier: "@repo/shared",
          typeOnly: false,
        }).to;

        // then
        expect(to2).toBe("apps/shared");

        // when
        const to3 = toReference(from, {
          specifier: "@repo/shared/../backend/x",
          typeOnly: false,
        }).to;

        // then
        expect(to3).toBe("apps/backend/x");

        // when
        const sharedExtraReference = toReference(from, {
          specifier: "@repo/shared-extra/x",
          typeOnly: false,
        });

        // then
        expect(sharedExtraReference).toEqual({
          from,
          specifier: "@repo/shared-extra/x",
          to: "@repo/shared-extra/x",
          own: false,
          typeOnly: false,
        });
      },
    );

    And(
      '"@/" と "@repo/backend/" の後ろの ".." は解決する（"@/../backend/x" は apps/backend/x）',
      () => {
        // given: 前提なし
        // when
        const to2 = toReference(from, {
          specifier:
            "@/../backend/features/todo/internal/presentation/list-todos.api",
          typeOnly: true,
        }).to;

        // then
        expect(to2).toBe(
          "apps/backend/features/todo/internal/presentation/list-todos.api",
        );

        // when
        const to3 = toReference(from, {
          specifier: "@repo/backend/../frontend_customer/features/todo",
          typeOnly: false,
        }).to;

        // then
        expect(to3).toBe("apps/frontend_customer/features/todo");
      },
    );

    And(
      '名前の前方一致だけが同じ別パッケージ（"@repo/backend-extra/x"）は自前のコードにしない',
      () => {
        // given: 前提なし
        // when
        const result = toReference(from, {
          specifier: "@repo/backend-extra/x",
          typeOnly: false,
        });

        // then
        expect(result).toEqual({
          from,
          specifier: "@repo/backend-extra/x",
          to: "@repo/backend-extra/x",
          own: false,
          typeOnly: false,
        });
      },
    );

    And("相対パスは参照元の位置から解決し、拡張子を外す", () => {
      // given: 前提なし
      // when
      const result = toReference(from, {
        specifier: "../../components/todo-item.tsx",
        typeOnly: false,
      });

      // then
      expect(result).toEqual({
        from,
        specifier: "../../components/todo-item.tsx",
        to: "apps/frontend_customer/features/todo/components/todo-item",
        own: true,
        typeOnly: false,
      });

      // when
      const to2 = toReference(from, {
        specifier: "../../../../../backend/features/todo/internal/domain/todo",
        typeOnly: false,
      }).to;

      // then
      // apps をまたぐ相対パスも、リポジトリ相対のパスに解決する。
      expect(to2).toBe("apps/backend/features/todo/internal/domain/todo");
    });

    And("それ以外はパッケージとして specifier のまま扱う", () => {
      // given: 前提なし
      // when
      const result = toReference(from, {
        specifier: "next/link",
        typeOnly: false,
      });

      // then
      expect(result).toEqual({
        from,
        specifier: "next/link",
        to: "next/link",
        own: false,
        typeOnly: false,
      });
    });
  });
});
