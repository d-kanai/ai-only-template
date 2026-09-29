// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはソースを文字列として読むだけで DOM を使わないため、
//   jsdom の初期化を省き、ブラウザ相当の globals が Node の API と混ざる余地をなくすため node 環境で動かす。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ディレクトリ構成ルール（.claude/rules/backend.md・frontend.md。規則の一覧は .claude/rules/architecture-check.md）の依存の向きを、仕様として機械的に検査するテスト。
// 対象は「依存の向き（全体）」「画面側とサーバ側の境界」「backend の 4 層の依存してよい先」、apps/frontend と apps/backend の
// 境界（Issue #68。backend → frontend の禁止、backend の中は相対パスだけ、frontend などから backend へは "@repo/backend/..." の
// 書き方だけ、apps/backend/package.json の exports の過不足）、frontend と backend で共通の apps/shared（Issue #90。置き場所、
// "@repo/shared/..." の書き方、画面側から参照しない、apps/shared/package.json の exports の過不足）と、環境変数の直参照の禁止
// （.claude/rules/env.md の「環境変数」。規則 env-direct-access）。
//
// WHY 自前のテストにする（Biome の noRestrictedImports を使わない）:
//   「features/<f>/api/ から backend へは import type だけ許す」を表現できない。Biome 2.5.13 の noRestrictedImports は
//   型だけの import（import type）も同じく違反にすることを実測した（Issue #47 の調査）。また、パスの制限を
//   「どのディレクトリからの import か」で変えるには feature ごと・層ごとに overrides を書く必要があり、feature を
//   足すたびに biome.json を直すことになる。ここでは参照元のパスから feature 名・層を取り出して、規則を 1 か所で書く。
//
// WHY 依存を増やさず正規表現で抽出する: 検査に必要なのは import / export の参照先と「型だけか」の 2 つで、
//   TypeScript の構文木までは要らない。dependency-cruiser は 18.4.0 の supportedTranspilers.typescript が <7.0.0 で、
//   本リポジトリの TypeScript 7.0.2 に対応していない（docs/architecture-decisions.md の「採用しなかった案」）。
//   抽出の限界は stripComments / extractImports の WHY に書き、仕様を下の describe と fixture テストで固定する。

const repoRoot = join(import.meta.dirname, "..");

// 検査の対象（.claude/rules/architecture-check.md の「対象と抽出」。Issue #68 で apps/frontend と apps/backend に分けた）。
//   apps/frontend と apps/backend（と Issue #90 の apps/shared）の全体（再帰）。除くのは依存と生成物のディレクトリ（EXCLUDED_DIRS）だけ。
// WHY 全体を再帰する（app/・features/・shared/ だけにしない）: 以前は app/・features/・shared/ と直下のファイルだけを見ていたため、
//   apps/frontend/lib/db.ts のような場所のファイルは、backend の container を値で import しても検査に出なかった（Issue #68 の
//   reviewer が実測）。全体を列挙したうえで、置き場所の規則（FRONTEND_PLACEMENT / BACKEND_PLACEMENT）で、どの規則もかからない
//   場所にファイルを置くこと自体を違反にする。
const FRONTEND_ROOT = "apps/frontend";
const BACKEND_ROOT = "apps/backend";
// E2E の workspace パッケージ @repo/e2e（Issue #84 で e2e/ から移した）。依存の向きの規則（frontend / backend の中の規則）と
//   置き場所の規則の対象ではなく、backend を使う側（frontend-to-backend-specifier・backend-exports）と環境変数の直参照
//   （env-direct-access）の対象。
const E2E_ROOT = "apps/e2e";
// frontend と backend で共通の基盤の workspace パッケージ @repo/shared（Issue #90。env.ts と logger.ts を apps/backend/shared/infra/
//   から移した）。置き場所の規則（SHARED_PLACEMENT）、"@repo/shared/..." の書き方（frontend-to-shared-specifier）、画面側から
//   参照しない（screen-to-shared）、exports（SHARED_EXPORTS）、環境変数の直参照・console の例外（env.ts・logger.ts）の対象。
const SHARED_ROOT = "apps/shared";

// WHY テストを対象外にする: テストは組み立てのために規則の外側を参照する（例: presentation のテストが
//   infra の InMemory リポジトリを new して createTodoContainer に渡す。.claude/rules/testing.md の「置き方と環境」）。
//   規則は本番のコードの依存の向きを縛るもので、テストの組み立てまで縛ると正当なテストが書けなくなる。
// WHY .js / .jsx / .mjs / .cjs と .mts / .cts も対象にする: tsconfig.json が allowJs: true で、include が **/*.ts / **/*.tsx /
//   **/*.mts を含み、JS のファイルや ESM / CJS を明示した拡張子のファイルも同じビルドに入り、同じ規則の対象になるため。
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/;

type ImportStatement = {
  // import / export の from に書かれた文字列そのもの（"@repo/backend/..."、"../x"、"next/link" など）。
  specifier: string;
  // 型だけの参照か（import type / export type / すべての名前に inline の type が付いた import）。
  typeOnly: boolean;
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
const IMPORT_EXPORT_FROM =
  /(?:^|;)\s*(?:import|export)\s+(type\s+)?((?:(?!^\s*(?:import|export)\b)[\w\s{},*$])*?)\s*\bfrom\s*["']([^"']+)["']/gm;
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
  return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

type Located = ImportStatement & { index: number };

function findFromStatements(code: string): Located[] {
  return [...code.matchAll(IMPORT_EXPORT_FROM)].map((match) => ({
    index: match.index,
    specifier: match[3] ?? "",
    typeOnly: match[1] !== undefined || isInlineTypeOnly(match[2] ?? ""),
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
    .map(({ specifier, typeOnly }) => ({ specifier, typeOnly }));
}

// WHY 拡張子を外す: 参照先の規則（`backend/<x>/presentation/*.api` など）を拡張子なしの形で 1 通りに書くため。
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
//   "@/x" → "apps/frontend/x"（tsconfig の paths で "@/*" は apps/frontend/*。backend のファイルに書いても、Next の
//     Turbopack は frontend の tsconfig の paths を当てるので apps/frontend を指す。Issue #68 の researcher の実測）
//   "@repo/backend/x" → "apps/backend/x"、"@repo/shared/x" → "apps/shared/x"（各 package.json の exports は、キーのパスに .ts を
//     付けたファイルを指すことを BACKEND_EXPORTS / SHARED_EXPORTS で検査しているので、キーのパスがそのまま参照先になる）
//   相対パス → 参照元のファイルの位置から解決したリポジトリ相対のパス
//   それ以外 → パッケージ（specifier のまま）
// WHY "@/" と "@repo/backend/"・"@repo/shared/" の後ろも posix.normalize で ".." を解決する: "@/../backend/x" は tsconfig の
//   paths で apps/frontend/../backend/x、つまり apps/backend/x に解決される。".." を残すと apps/frontend の下の参照に見え、
//   backend への参照を検査する規則（frontend-to-backend-specifier など）を素通りする。
function toReference(
  from: string,
  { specifier, typeOnly }: ImportStatement,
): Reference {
  const own = { from, specifier, own: true, typeOnly };
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
  return { from, specifier, to: specifier, own: false, typeOnly };
}

function isSourceNonTest(path: string): boolean {
  return SOURCE_FILE.test(path) && !TEST_FILE.test(path);
}

// 列挙から除くディレクトリ（どの階層にあっても、その中を見ない）。
//   node_modules: 依存（workspace パッケージ化した段階 2 では apps/*/node_modules/ ができる）。
//   .next: next build / next dev の生成物（apps/frontend/.next/。数千件の JS）。
// WHY 名前を列挙する（"." で始まるディレクトリをまとめて除かない）: まとめて除くと apps/backend/.lib/x.ts のような自前のコードが
//   検査を素通りする（Issue #68 の reviewer 指摘）。既知の生成物・依存だけを除き、それ以外の "." のディレクトリは通常どおり
//   検査して、置き場所の規則で違反にする。生成物のディレクトリが増えたらここに足す。
const EXCLUDED_DIRS = new Set(["node_modules", ".next"]);

function isGeneratedOrDependency(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => EXCLUDED_DIRS.has(segment));
}

// WHY root を引数で受け取る: 本番の検査（リポジトリ直下）と、fixture の一時ディレクトリに置いた架空のツリーの検査で、
//   列挙 → 抽出 → 正規化 → 判定の同じ経路を通すため。
function listSourceFiles(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) {
    return [];
  }
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .map((path) => toPosix(join(dir, path)))
    .filter((path) => isSourceNonTest(path) && !isGeneratedOrDependency(path));
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

// apps/frontend・apps/backend・apps/shared のソース（テスト以外）。
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

// "apps/frontend/features/todo/..." → "todo"
function featureOf(path: string): string | undefined {
  return /^apps\/frontend\/features\/([^/]+)\//.exec(path)?.[1];
}

type BackendLayer = "domain" | "application" | "presentation" | "infra";
type BackendLocation = { feature: string; layer: BackendLayer };

// "apps/backend/todo/presentation/..." → { feature: "todo", layer: "presentation" }
function backendLayerOf(path: string): BackendLocation | undefined {
  const match =
    /^apps\/backend\/([^/]+)\/(domain|application|presentation|infra)(?:\/|$)/.exec(
      path,
    );
  return match === null
    ? undefined
    : { feature: match[1] ?? "", layer: (match[2] ?? "") as BackendLayer };
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

// backend の api ファイル（1 API = 1 ファイル `apps/backend/<x>/presentation/<verb>-<noun>.api.ts`）。
const PRESENTATION_API = /^apps\/backend\/[^/]+\/presentation\/[^/]+\.api$/;

// feature の公開 API（`apps/frontend/features/<f>/index.ts`）。"…/features/todo" と "…/features/todo/index" のどちらの
//   書き方も同じファイルを指す。
const FEATURE_INDEX = /^apps\/frontend\/features\/[^/]+(?:\/index)?$/;

function isFeatureApi(path: string): boolean {
  return /^apps\/frontend\/features\/[^/]+\/api\//.test(path);
}

// apps/frontend 直下のファイル（next.config.ts・instrumentation.ts・instrumentation-node.ts・proxy.ts）。
function isFrontendRootFile(path: string): boolean {
  return /^apps\/frontend\/[^/]+$/.test(path);
}

// 環境変数の唯一の入口（Issue #59）とサーバ側のログの唯一の出口（Issue #85）。Issue #90 で apps/backend/shared/infra/ から
//   apps/shared/ に移した（frontend 直下の instrumentation-node.ts・proxy.ts、backend、apps/e2e/、リポジトリ直下が共通で使うため。
//   以前は frontend 直下から backend を参照する frontend-root-to-backend の例外だった）。
const SHARED_ENV_MODULE = `${SHARED_ROOT}/env`;
const SHARED_LOGGER_MODULE = `${SHARED_ROOT}/logger`;

// backend の層ごとに、参照してよい apps/shared のモジュール（Issue #90。移す前に backend/shared/infra にあったときと同じ範囲）。
// WHY domain / application には許さない: env・logger は外の世界（環境変数・stdout）に触る基盤で、移す前も infra 層にあった。
//   domain / application から使うと、層の規則で infra を参照させなかった意味が無くなる。
// WHY presentation には logger だけ許す: presentation の infra は自 feature の container だけ（下の presentationAllows）だが、
//   想定外の例外をログに残すのは HTTP の境界（toErrorResponse）の仕事で、ログの出口を container 経由で渡すと全 API の組み立てに
//   logger が入る。logger は状態を持たず、差し替えずにテストできる（console を spy する）ので、直接 import させる（Issue #85）。
//   env は infra（接続先・プールの設定）だけが使う。
const SHARED_MODULES_BY_LAYER: Record<BackendLayer, ReadonlySet<string>> = {
  domain: new Set(),
  application: new Set(),
  presentation: new Set([SHARED_LOGGER_MODULE]),
  infra: new Set([SHARED_ENV_MODULE, SHARED_LOGGER_MODULE]),
};

// features/<f>/api/ から、同じ feature の api ファイル（backend/<f>/presentation/*.api）への参照か。
// frontend-to-backend-specifier の例外（Issue #68 の段階 2。オーケストレータの判断）: リポジトリ直下の vitest.global-setup.ts
//   （テスト基盤）だけは、database.test-support を相対パスで参照してよい。
// WHY: database.test-support はテストのための処理（前の実行が残したテスト用スキーマの後始末）で、パッケージの公開面（exports。
//   frontend / e2e / 設定が使うアプリの入口だけ、というユーザー判断）に含めない。exports に無いので @repo/backend では
//   解決できず、相対パスで読むしかない。例外はファイルと参照先の組で絞り、ほかのファイルからの test-support、global-setup から
//   ほかの backend のファイル（env など）への相対参照は違反のままにする。
const TEST_INFRA_RELATIVE_EXCEPTION = {
  from: "vitest.global-setup.ts",
  to: "apps/backend/shared/infra/database.test-support",
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
    backendLayerOf(ref.to)?.feature === featureOf(ref.from)
  );
}

// 参照元の層ごとに、自 feature と backend/shared の中で参照してよい層（.claude/rules/backend.md の 4 層の表）。
// WHY 許可の一覧で書く: 禁止の一覧だと、書き忘れた参照先（他 feature の層、画面側の shared/ など）が黙って通る。
//   許可の一覧なら、ここに無い自前コードはすべて違反になる。
// WHY backend/shared の中も層で縛る: backend/shared も domain / presentation などの層に分かれており、その中で
//   domain → presentation のような逆向きの依存を作ると、feature の中と同じく依存の向きが崩れるため。
const LAYERS_MAY_USE: Record<BackendLayer, ReadonlySet<BackendLayer>> = {
  domain: new Set(["domain"]),
  application: new Set(["domain", "application"]),
  // presentation の infra は infra/container だけ、feature の domain は型だけ（presentationAllows で絞る）。
  presentation: new Set(["domain", "application", "presentation", "infra"]),
  // container.ts が同じ infra の Repository の実装を組み立てるので、infra 同士の参照も許す。
  infra: new Set(["domain", "application", "infra"]),
};

// presentation 固有の絞り込み。
//   - infra は自 feature の infra/container だけ（「presentation は query / command を infra/container.ts で組み立てた
//     コンテナからだけ受け取る。Repository の実装を直接 new しない」）。ログの出口 apps/shared/logger は backend の外なので
//     ここではなく SHARED_MODULES_BY_LAYER で許す（Issue #90）。
//   - feature の domain は import type だけ（「domain（Entity の型の参照のみ）」）。Entity の生成や操作は application を通す。
//     backend/shared/domain（DomainError）はエラーの変換（instanceof）に値として使うので対象外。
function presentationAllows(
  ref: Reference,
  self: BackendLocation,
  target: BackendLocation,
): boolean {
  if (target.layer === "infra") {
    return ref.to === `apps/backend/${self.feature}/infra/container`;
  }
  if (target.layer === "domain" && target.feature !== "shared") {
    return ref.typeOnly;
  }
  return true;
}

// backend の層にあるファイルから、自前コードへの参照が許可の一覧に入っているか。
// 許すのは、自 feature か backend/shared の、参照元の層が参照してよい層と、参照元の層が使ってよい apps/shared のモジュール
// （SHARED_MODULES_BY_LAYER）だけ。他 feature のどの層も、画面側（features/ app/ shared/）も、層に属さない場所も許さない。
function backendMayUse(ref: Reference): boolean {
  const self = backendLayerOf(ref.from);
  if (self === undefined) {
    return false;
  }
  if (isUnder(ref.to, SHARED_ROOT)) {
    return SHARED_MODULES_BY_LAYER[self.layer].has(ref.to);
  }
  const target = backendLayerOf(ref.to);
  if (target === undefined) {
    return false;
  }
  const sameFeatureOrShared =
    target.feature === self.feature || target.feature === "shared";
  return (
    sameFeatureOrShared &&
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
  | "app-api";

type Rule = {
  id: RuleId;
  // テスト名。.claude/rules/architecture-check.md の規則の文に対応する仕様文。
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
    // WHY 参照先が backend のものだけを見る: apps/frontend の中の参照（"@/..." や "./x"）はこの規則の対象外。
    // WHY apps/e2e/ とリポジトリ直下も対象にする: apps/e2e/playwright.config.ts・apps/e2e/database.ts・vitest.global-setup.ts も env.ts などを
    //   使う。相対パスを許すと、exports に無いファイルを使っていても気づけない。
    id: "frontend-to-backend-specifier",
    name: 'apps/frontend/・apps/e2e/・リポジトリ直下のファイルから apps/backend/ への参照は "@repo/backend/..." の書き方だけ（相対パスや "@/../backend/" を使わない。例外は vitest.global-setup.ts → database.test-support の相対パスだけ）',
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
    //   （vitest.global-setup.ts → database.test-support の相対パス）を apps/shared に持ち込まないためでもある。
    // WHY 相対パスを禁止する: frontend-to-backend-specifier と同じく、apps/shared/package.json の exports（公開する入口）を通らずに
    //   apps/shared の中のファイルを指せてしまい、公開の過不足（SHARED_EXPORTS）を検査できなくなる。
    // WHY backend は対象にしない: backend の中の書き方は backend-relative-only が 1 つの規則で見る（backend の中は相対パス、
    //   apps/shared へは "@repo/shared/..." だけ）。ここで backend も見ると、同じ参照が 2 つの規則で重ねて出る。
    id: "frontend-to-shared-specifier",
    name: 'apps/frontend/・apps/e2e/・リポジトリ直下のファイルから apps/shared/ への参照は "@repo/shared/..." の書き方だけ（相対パスや "@/../shared/" を使わない）',
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
    // WHY 4 層の規則と別に持つ: 4 層の規則は層の下のファイルにしかかからない。apps/backend 直下の drizzle.config.ts のような
    //   層に属さない（置き場所の規則で例外にした）ファイルからの参照も止める。
    id: "backend-to-frontend",
    name: "apps/backend/ は apps/frontend/ を参照しない",
    appliesTo: (from) => isUnder(from, BACKEND_ROOT),
    isViolation: (ref) => ownUnder(ref, FRONTEND_ROOT),
  },
  {
    // 「backend の内部 import はすべて相対パス」（Issue #68）。
    // WHY "@/" を使わない: Next（Turbopack）は backend のファイルの "@/" にも frontend の tsconfig の paths を当て、
    //   apps/frontend の中を探してビルドが失敗する（researcher の実測）。
    // WHY "@repo/backend/" も使わない: workspace パッケージ化（段階 2）で exports を明示し、公開するのは frontend が使う
    //   入口だけにする（ユーザー判断）。自パッケージ名の参照は exports を通るので、公開していない内部のファイルを
    //   指せなくなる。相対パスなら exports に関係なく解決する。
    // WHY 参照先ではなく書き方（specifier）で判定する: "@repo/backend/x" と "../x" は同じファイルを指し、参照先では区別できない。
    // WHY apps/shared へは "@repo/shared/..." だけ（Issue #90。相対パスの "../../../shared/env" も違反）: apps/shared は別の
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
    // 「frontend から backend への参照は app/api（値）と features/*/api（型）だけ」（Issue #68）。apps/frontend 直下のファイルは
    //   backend を参照しない。
    // WHY 直下のファイルに規則を置く: 置かないと、next.config.ts などから backend の何を参照しても検査を素通りする。
    // WHY 例外を持たない（Issue #90）: 以前は instrumentation-node.ts の起動時の検証（env。Issue #59）と proxy.ts・
    //   instrumentation-node.ts のログ（logger。Issue #85）のために backend/shared/infra の env・logger だけを許していた。
    //   env・logger は frontend と backend で共通のものなので apps/shared（@repo/shared）に移し、直下のファイルは
    //   "@repo/shared/..." で使う（frontend-to-shared-specifier）。
    id: "frontend-root-to-backend",
    name: "apps/frontend/ 直下のファイルは apps/backend/ を参照しない（env・logger は apps/shared から使う）",
    appliesTo: isFrontendRootFile,
    isViolation: (ref) => ownUnder(ref, BACKEND_ROOT),
  },
  {
    // 「`features/<feature>/` の `api/` 以外は backend を参照せず、`api/` が re-export した型を使う」
    // WHY 画面側の shared/ も含める: 画面側で backend を参照してよいのは features/<f>/api/ だけ（「画面側とサーバ側の境界」）で、
    //   shared/ から参照すると境界が api/ の 1 か所に集まらなくなるため。
    id: "screen-to-backend",
    name: "apps/frontend/features/<f>/ の api/ 以外と apps/frontend/shared/ は apps/backend/ を参照しない",
    appliesTo: (from) =>
      (isUnder(from, "apps/frontend/features") && !isFeatureApi(from)) ||
      isUnder(from, "apps/frontend/shared"),
    isViolation: (ref) => ownUnder(ref, BACKEND_ROOT),
  },
  {
    // 「apps/frontend の app/・features/・shared/ は apps/shared を参照しない」（Issue #90）。apps/shared を使ってよいのは
    //   frontend では直下のサーバ側のファイル（instrumentation-node.ts・proxy.ts）だけ。
    // WHY: apps/shared の env（process.env を読み、.env をファイルから読み込む）と logger（stdout への出力）はサーバ側の基盤で、
    //   画面のコード（Client Component から読み込まれうる）に入れると、ブラウザのバンドルに Node の API や環境変数の読み込みが
    //   入る。画面側のログは出さない（.claude/rules/frontend.md）。
    // WHY 画面側の shared/ も含める: screen-to-backend と同じく、shared/ は features から使われる画面側の部品で、Client Component
    //   からも読み込まれるため。app/api/ も含める（app-api が api ファイル以外を止めるので重ねて検出するが、範囲を app/ 全体で書く）。
    id: "screen-to-shared",
    name: "apps/frontend の app/・features/・shared/ は apps/shared/ を参照しない（env・logger をブラウザのバンドルに持ち込まない）",
    appliesTo: (from) =>
      isUnder(from, "apps/frontend/app") ||
      isUnder(from, "apps/frontend/features") ||
      isUnder(from, "apps/frontend/shared"),
    isViolation: (ref) => ownUnder(ref, SHARED_ROOT),
  },
  {
    // 「画面側で backend を参照してよいのは `features/<feature>/api/` だけ。参照先は
    //   `backend/<feature>/presentation/<name>.api.ts` と `backend/shared/presentation/` で、いずれも `import type` のみ」
    // WHY 型だけに限る: import type はビルド時に消えるので、サーバ専用のコードが画面のバンドルに入らない。
    // WHY 自 feature の api ファイルに限る: 別 feature の API の契約を使うなら、その feature の api/ を通すべきで、
    //   feature 同士は index 経由でしか参照しない（規則 feature-to-feature）方針と揃えるため。
    id: "feature-api-to-backend",
    name: "apps/frontend/features/<f>/api/ から apps/backend/ への参照は型だけで、参照先は自 feature の apps/backend/<f>/presentation/*.api か apps/backend/shared/presentation/ だけ",
    appliesTo: isFeatureApi,
    isViolation: (ref) =>
      ownUnder(ref, BACKEND_ROOT) &&
      !(
        ref.typeOnly &&
        (isOwnFeatureApiFile(ref) ||
          isUnder(ref.to, "apps/backend/shared/presentation"))
      ),
  },
  {
    // 「feature 同士は原則 import しない。必要なときは相手の `index.ts` だけを import する」
    id: "feature-to-feature",
    name: "別の feature を参照するときは apps/frontend/features/<other>（index）だけ",
    appliesTo: (from) => featureOf(from) !== undefined,
    isViolation: (ref) =>
      ownUnder(ref, "apps/frontend/features") &&
      featureOf(`${ref.to}/`) !== featureOf(ref.from) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「画面側: `app → features → shared`」。app/ はルーティングで、features / shared から参照すると向きが逆になる。
    id: "screen-to-app",
    name: "apps/frontend の features/ と shared/ は app/ を参照しない",
    appliesTo: (from) =>
      isUnder(from, "apps/frontend/features") ||
      isUnder(from, "apps/frontend/shared"),
    isViolation: (ref) => ownUnder(ref, "apps/frontend/app"),
  },
  {
    // 「`shared/` は `features/` を import しない（逆向きの依存を作らない）」
    id: "shared-to-features",
    name: "apps/frontend/shared/ は features/ を参照しない",
    appliesTo: (from) => isUnder(from, "apps/frontend/shared"),
    isViolation: (ref) => ownUnder(ref, "apps/frontend/features"),
  },
  {
    // 「domain は Next・React・DB に依存させない」「依存してよい先は backend/shared だけ」
    //   自 feature の domain/ の中の参照（Repository の interface が Entity を参照するなど）は許す。
    id: "domain",
    name: "apps/backend/<f>/domain/ が参照してよい自前コードは自 feature と apps/backend/shared/ の domain/ だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "domain",
    isViolation: violatesBackendLayer,
  },
  {
    // 「domain は Next・React・DB に依存させない」。application も DB に直接依存させない（Repository の interface 越しに使う）。
    // WHY 層の許可の一覧（domain / application の規則）と別の規則にする: 許可の一覧はパッケージを next / react / react-dom 以外
    //   すべて許すので、DB のパッケージはそこでは止まらない。DB への依存は infra に閉じ込める（schema.ts・Repository の実装・
    //   database.ts）という別の観点なので、1 規則 = 1 テストで独立に検査する。
    // WHY backend/shared の domain / application も含める: TransactionRunner の interface（shared/domain）が Drizzle の型に
    //   依存すると、domain から DB が見えてしまうため（Tx をジェネリックにしている理由。transaction-runner.ts）。
    // 型だけの参照（import type）も違反にする: 型でも DB の形が domain に入り込み、DB を差し替えると domain を直すことになる。
    id: "core-to-persistence",
    name: "apps/backend の domain/・application/ は DB のパッケージ（drizzle-orm とそのサブパス、pg）を参照しない（型だけでも）",
    appliesTo: (from) => {
      const layer = backendLayerOf(from)?.layer;
      return layer === "domain" || layer === "application";
    },
    isViolation: usesPersistence,
  },
  {
    // 「application の依存してよい先は domain と backend/shared」「依存の向き: presentation → application → domain」
    //   同じ application の中の参照（ユースケースの共通処理など）は許す。
    id: "application",
    name: "apps/backend/<f>/application/ が参照してよい自前コードは自 feature と apps/backend/shared/ の domain/・application/ だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "application",
    isViolation: violatesBackendLayer,
  },
  {
    // 「presentation の依存してよい先: application、domain（Entity の型の参照のみ）、infra/container.ts、backend/shared、
    //   apps/shared の logger（Issue #85・#90）」
    //   同じ presentation の中の参照（api ファイル間の re-export など）は許す。
    // WHY next も禁止する: api ファイルは Web 標準の Request / Response で書き、Next を起動せずにテストできるようにしているため
    //   （.claude/rules/testing.md の「置き方と環境」）。
    id: "presentation",
    name: "apps/backend/<f>/presentation/ が参照してよい自前コードは自 feature と apps/backend/shared/ の application/・domain/（feature の domain は型だけ）・presentation/ と自 feature の infra/container・apps/shared/logger だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "presentation",
    isViolation: violatesBackendLayer,
  },
  {
    // 「infra: Repository の実装、container.ts（組み立て = DI）」「依存してよい先: domain（interface を実装する）、
    //   application（container で組み立てる）」。container.ts が同じ infra の Repository の実装を組み立てるので、infra/ の中の
    //   参照も許す。
    id: "infra",
    name: "apps/backend/<f>/infra/ が参照してよい自前コードは自 feature と apps/backend/shared/ の domain/・application/・infra/ と apps/shared/ の env・logger だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "infra",
    isViolation: violatesBackendLayer,
  },
  {
    // 「backend/shared/: feature をまたいで使う型や処理」。各 feature が shared に依存するので、逆向きにすると循環する。
    //   画面側の shared/ も含め、backend/shared/ の外の自前コードは参照しない。
    // WHY apps/shared は許す（Issue #90）: frontend と backend で共通の基盤（env・logger）で、feature ではないので循環しない。
    //   どの層がどのモジュールを使ってよいかは層の規則（SHARED_MODULES_BY_LAYER）が見る。
    id: "backend-shared",
    name: "apps/backend/shared/ が参照してよい自前コードは apps/backend/shared/ の中と apps/shared/ だけで、next・react も参照しない",
    appliesTo: (from) => isUnder(from, "apps/backend/shared"),
    isViolation: (ref) =>
      usesFramework(ref) ||
      (ref.own &&
        !isUnder(ref.to, "apps/backend/shared") &&
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
    name: "apps/frontend/app/（app/api 以外）が features/・apps/backend/・shared/ を参照するときは features/<f>（index）か shared/ だけ",
    appliesTo: (from) =>
      isUnder(from, "apps/frontend/app") &&
      !isUnder(from, "apps/frontend/app/api"),
    isViolation: (ref) =>
      (ownUnder(ref, "apps/frontend/features") ||
        ownUnder(ref, BACKEND_ROOT)) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「`app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ」
    id: "app-api",
    name: "apps/frontend/app/api/ は apps/backend/<x>/presentation/*.api だけを参照する",
    appliesTo: (from) => isUnder(from, "apps/frontend/app/api"),
    isViolation: (ref) => !(ref.own && PRESENTATION_API.test(ref.to)),
  },
];

// backend のソースファイルは、apps/backend/<x>/ の 4 層（domain / application / presentation / infra）のどれかの下に置く。
// 例外は apps/backend 直下の設定ファイル（<name>.config.<拡張子>。drizzle.config.ts）だけ。
// WHY 置き場所そのものを規則にする: 層に属さない場所（backend/todo/lib/ や backend/todo/ 直下）のファイルは、どの層の規則も
//   かからず、そこから何を参照しても検査を素通りする。層を決めて置かせることで、すべての backend のコードに依存の向きの
//   検査がかかるようにする。
// WHY backend/shared/ も同じに扱う（直下を許さない）: backend/shared/ も domain / presentation の層に分けて置いており
//   （.claude/rules/backend.md の「置き場所（DDD 4 層）」）、直下を許すと同じ抜け道になるため。
// WHY 設定ファイルを例外にする: drizzle-kit の設定（drizzle.config.ts）は backend のマイグレーションの設定で、Issue #68 で
//   apps/backend に置いた。層のコードではなく、依存の規則は backend-to-frontend・backend-relative-only でかける。
//   直下に限り、名前を <name>.config.<拡張子> に限るのは、層に属さないコードの置き場所にさせないため。
const BACKEND_LAYER_DIR =
  /^apps\/backend\/[^/]+\/(?:domain|application|presentation|infra)\//;
const BACKEND_ROOT_CONFIG = /^apps\/backend\/[^/]+\.config\.(?:[cm]?[jt]s)$/;

const BACKEND_PLACEMENT = {
  id: "backend-placement",
  name: "apps/backend/ のソースファイルは apps/backend/<x>/ の domain/・application/・presentation/・infra/ のどれかの下に置く（直下の <name>.config.ts だけ例外）",
  isMisplaced: (file: string) =>
    isUnder(file, BACKEND_ROOT) &&
    !BACKEND_LAYER_DIR.test(file) &&
    !BACKEND_ROOT_CONFIG.test(file),
};

// frontend のソースファイルは、apps/frontend の app/・features/・shared/ の下か、直下の決まった名前のファイルだけに置く
// （Issue #68 の reviewer 指摘）。
// WHY 置き場所を規則にする: 依存の規則は app/・features/・shared/ と直下のファイル（frontend-root-to-backend）にしかかからない。
//   apps/frontend/lib/ のような場所のファイルは、backend の container を値で import してもどの規則にもかからず素通りする。
// WHY 直下は名前で許す: Next の設定（next.config.ts）と規約ファイル（instrumentation.ts・proxy.ts）、その Node.js 用の処理
//   （instrumentation-node.ts）、Next が生成する型の宣言（next-env.d.ts。.gitignore 済みだが手元にはある）だけが直下に要る。
//   proxy.ts（リクエストログ。Issue #80）は Next の規約で app/ と同じ階層（プロジェクトのルート）に置く（Next.js 16.3.6 同梱
//   node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md の「Convention」）。旧名の middleware.ts
//   は Next 16 で非推奨なので許さない。中身は薄くし、1 行の組み立ては shared/request-log/ に置く（shared/ は置き場所の規則の中）。
//   名前を決めずに直下を許すと、層に属さないコードの置き場所になる。直下のファイルが backend を参照するときは
//   frontend-root-to-backend が見る。
const FRONTEND_SOURCE_DIR = /^apps\/frontend\/(?:app|features|shared)\//;
const FRONTEND_ROOT_FILES = new Set([
  "apps/frontend/next.config.ts",
  "apps/frontend/instrumentation.ts",
  "apps/frontend/instrumentation-node.ts",
  "apps/frontend/proxy.ts",
  "apps/frontend/next-env.d.ts",
]);

const FRONTEND_PLACEMENT = {
  id: "frontend-placement",
  name: "apps/frontend/ のソースファイルは app/・features/・shared/ の下か、直下の next.config.ts・instrumentation.ts・instrumentation-node.ts・proxy.ts・next-env.d.ts だけに置く",
  isMisplaced: (file: string) =>
    isUnder(file, FRONTEND_ROOT) &&
    !FRONTEND_SOURCE_DIR.test(file) &&
    !FRONTEND_ROOT_FILES.has(file),
};

// 置き場所の規則（参照ではなくファイルの場所で決まる）。collectViolations で使う。
const PLACEMENT_RULES = [BACKEND_PLACEMENT, FRONTEND_PLACEMENT];

// apps/shared（@repo/shared。Issue #90）に置いてよいのは、名前を決めたファイルだけ（env.ts・logger.ts とそのテスト、
//   package.json・tsconfig.json）。
// WHY 何でも置ける場所にしない: 「frontend と backend の両方で使う」ものは多く、共通の置き場所を自由にすると、feature の
//   コードや DB・React に依存するコードが集まり、層の規則（backend の 4 層・画面側の境界）の外で依存が育つ。
//   置いてよいのは横断的な基盤（環境変数の入口とログの出口）だけにし、足すときはこの一覧・exports（SHARED_EXPORTS）・
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
    "package.json",
    "tsconfig.json",
  ].map((name) => `${SHARED_ROOT}/${name}`),
);

const SHARED_PLACEMENT = {
  id: "shared-placement",
  name: "apps/shared/ に置いてよいのは env.ts・logger.ts とそのテスト（env.test.ts・logger.test.ts）、package.json・tsconfig.json だけ",
  isMisplaced: (file: string) =>
    isUnder(file, SHARED_ROOT) && !SHARED_FILES.has(file),
};

// dir の下のすべてのファイル（再帰。ソース以外も含む。依存と生成物のディレクトリの中は除く）。SHARED_PLACEMENT で使う。
function listAllFiles(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) {
    return [];
  }
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(relative(root, join(entry.parentPath, entry.name))))
    .filter((path) => !isGeneratedOrDependency(path));
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

// 検査の対象にするディレクトリ。依存の向きの対象（apps/frontend・apps/backend・apps/shared）に、E2E（apps/e2e/）を足す。
// WHY apps/e2e/ を含める: E2E の補助（apps/e2e/database.ts）と設定（apps/e2e/playwright.config.ts）は接続先やフラグを読むので、
//   既定値や直参照が入り込みやすい。
// WHY apps/shared を含める（Issue #90）: 例外の env.ts がここにあり、同じ場所のほかのファイル（env-helper.ts など）は違反にするため。
const ENV_CHECK_DIRS = [FRONTEND_ROOT, BACKEND_ROOT, SHARED_ROOT, E2E_ROOT];

const ENV_DIRECT_ACCESS = {
  id: "env-direct-access",
  name: "process.env を直接読んでよいのは apps/shared/env.ts だけ（例外は apps/frontend/instrumentation.ts の NEXT_RUNTIME だけ。apps/frontend・apps/backend・apps/shared・apps/e2e/ とルート直下の設定ファイルが対象。テストは除く）",
  // 何を読んでもよいファイル（環境変数の唯一の入口）。
  allowedFile: `${SHARED_ENV_MODULE}.ts`,
  // ファイルごとに、読んでよい変数だけを許す例外。
  // WHY instrumentation.ts の NEXT_RUNTIME: Next.js がビルド時に値を埋め込む規約の変数で、Edge 向けのビルドから Node.js 専用の
  //   import を消すために process.env.NEXT_RUNTIME の形で書く必要がある（Next.js 16.3.6 同梱ドキュメント
  //   01-app/02-guides/instrumentation.md の「Importing runtime-specific code」。WHY の詳細は instrumentation.ts）。
  //   ファイルごと許すと、同じファイルに別の変数の直参照が入っても通るので、変数の名前まで絞る。
  allowedVariables: {
    "apps/frontend/instrumentation.ts": ["NEXT_RUNTIME"],
  } as Record<string, string[]>,
  // 対象のファイルか。ENV_CHECK_DIRS の下か、ルート直下（"/" を含まない）の、テストでない TS / JS。
  // WHY ルート直下の設定ファイルを含める: vitest.global-setup.ts・vitest.config.mts などは、接続先やフラグを読むので、
  //   既定値や直参照が入り込みやすい。ルート直下のテスト（rule-tests/ の architecture.test.ts など）は除く。apps の設定ファイル
  //   （apps/frontend/next.config.ts、apps/backend/drizzle.config.ts）は ENV_CHECK_DIRS の下として対象になる。
  // どのファイルを列挙するか（apps/frontend の .next/ を除くなど）は listEnvCheckedFiles が決める。
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
//     検出しない。2026-09-29 実測）。一覧は docs/logger.md。

// 検査の対象にするディレクトリ。環境変数の直参照の対象（ENV_CHECK_DIRS）に scripts/ を足す。
// WHY scripts/ を含める: scripts/ の TS / JS（今はテストだけで、ソースは無い）はフックなどから動かすツールになり、
//   console で出力を書きたくなる場所なので、置いた時点で検査にかける。
const SCRIPTS_ROOT = "scripts";
const CONSOLE_CHECK_DIRS = [...ENV_CHECK_DIRS, SCRIPTS_ROOT];

const CONSOLE_DIRECT_ACCESS = {
  id: "console-direct-access",
  name: "console を直接書いてよいのは apps/shared/logger.ts だけ（apps/frontend・apps/backend・apps/shared・apps/e2e/・scripts/ とルート直下の設定ファイルが対象。テストは除く）",
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
  name: 'apps/backend/package.json の exports は、外（apps/frontend・apps/e2e/・リポジトリ直下）が "@repo/backend/..." で参照するものをすべて含み、参照されないキーを持たず、各キーはそのパスの .ts を指す',
  root: BACKEND_ROOT,
  packageName: BACKEND_PACKAGE,
};

// apps/shared/package.json の exports（Issue #90）。今のキーは "./env" と "./logger" の 2 つ（1 ファイル = 1 キー。パターンを使わない
//   のは .claude/rules/shared.md の方針で、置き場所の規則 SHARED_PLACEMENT と合わせて公開するものを名前で決めるため）。
const SHARED_EXPORTS: ExportedPackage = {
  id: "shared-exports",
  name: 'apps/shared/package.json の exports は、外（apps/frontend・apps/backend・apps/e2e/・リポジトリ直下）が "@repo/shared/..." で参照するものをすべて含み、参照されないキーを持たず、各キーはそのパスの .ts を指す',
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
//   exports の違反は「backend-exports: ...」「shared-exports: ...」の 1 行で出す（findExportsViolations）。
//   apps/shared の置き場所の違反は「shared-placement: ファイル」の 1 行で出す（ソース以外も含め、apps/shared の全ファイルを見る）。
// WHY 置き場所の規則も参照を取り出すファイル（listReferencingFiles。apps/e2e/ とリポジトリ直下を含む）全体にかける:
//   置き場所の規則は isMisplaced の中で apps/backend・apps/frontend の下かを見るので、それ以外のファイルは違反にならない。
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

describe("依存の向き（.claude/rules/architecture-check.md）", () => {
  const references = collectReferences(repoRoot);

  it("検査の対象から参照を取り出せている（抽出が壊れて 0 件になり、すべての規則が素通りするのを防ぐ）", () => {
    expect(references.length).toBeGreaterThan(0);
  });

  it(BACKEND_PLACEMENT.name, () => {
    expect(
      listReferencingFiles(repoRoot).filter(BACKEND_PLACEMENT.isMisplaced),
    ).toEqual([]);
  });

  it(FRONTEND_PLACEMENT.name, () => {
    expect(
      listReferencingFiles(repoRoot).filter(FRONTEND_PLACEMENT.isMisplaced),
    ).toEqual([]);
  });

  it(SHARED_PLACEMENT.name, () => {
    expect(
      listAllFiles(repoRoot, SHARED_ROOT).filter(SHARED_PLACEMENT.isMisplaced),
    ).toEqual([]);
  });

  // WHY: 列挙が空（ディレクトリ名の書き間違い・列挙の壊れ）なら置き場所の違反も 0 件で常に緑になる。
  // WHY arrayContaining（一覧の外のファイルがあっても落とさない）: 一覧の外のファイルは上の shared-placement の 1 件だけで落とし、
  //   規則を破ったときに、どの規則が破れたかをテスト名で分かるようにする。
  it("apps/shared の全ファイル（ソース・テスト・package.json・tsconfig.json）を列挙できている（列挙が壊れて素通りするのを防ぐ）", () => {
    expect(listAllFiles(repoRoot, SHARED_ROOT)).toEqual(
      expect.arrayContaining([...SHARED_FILES]),
    );
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      // 失敗時にどのファイルがどこを参照しているかが出力に出るよう、違反を「ファイル → 参照先」の一覧にして空配列と比較する。
      expect(findViolations(references, rule)).toEqual([]);
    });
  }

  it(ENV_DIRECT_ACCESS.name, () => {
    // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
    expect(findEnvViolations(repoRoot)).toEqual([]);
  });

  it(CONSOLE_DIRECT_ACCESS.name, () => {
    // 失敗時に「ファイル:行」が出るよう、一覧を空配列と比較する。
    expect(findConsoleViolations(repoRoot)).toEqual([]);
  });

  for (const pkg of EXPORTED_PACKAGES) {
    it(pkg.name, () => {
      expect(findPackageExportsViolations(repoRoot, pkg, references)).toEqual(
        [],
      );
    });
  }

  it("apps/backend の exports を 1 件以上読め、apps/frontend の @repo/backend の参照を取り出せている（読み込みや列挙が壊れて素通りするのを防ぐ）", () => {
    expect(
      Object.keys(readPackageExports(repoRoot, BACKEND_EXPORTS)).length,
    ).toBeGreaterThan(0);
    const consumers = new Set(
      references
        .filter((ref) => isBackendPackage(ref.specifier))
        .map((ref) => ref.from),
    );
    expect([...consumers]).toEqual(
      expect.arrayContaining([
        "apps/frontend/app/api/todos/route.ts",
        "apps/frontend/features/todo/api/todo-api.ts",
      ]),
    );
  });

  it("apps/shared の exports を読め、apps/frontend 直下・apps/backend・apps/e2e/・リポジトリ直下の @repo/shared の参照を取り出せている（読み込みや列挙が壊れて素通りするのを防ぐ）", () => {
    expect(
      Object.keys(readPackageExports(repoRoot, SHARED_EXPORTS)).sort(),
    ).toEqual(["./env", "./logger"]);
    const consumers = new Set(
      references
        .filter((ref) => isSharedPackage(ref.specifier))
        .map((ref) => ref.from),
    );
    expect([...consumers]).toEqual(
      expect.arrayContaining([
        "apps/frontend/instrumentation-node.ts",
        "apps/frontend/proxy.ts",
        "apps/backend/drizzle.config.ts",
        "apps/backend/shared/infra/database.ts",
        "apps/backend/shared/presentation/http-error.ts",
        "apps/e2e/database.ts",
        "apps/e2e/playwright.config.ts",
        "vitest.global-setup.ts",
      ]),
    );
  });

  it("環境変数の直参照の検査は、各ディレクトリとルート直下の設定ファイルを対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）", () => {
    const files = listEnvCheckedFiles(repoRoot);
    expect(files).toEqual(
      expect.arrayContaining([
        "apps/shared/env.ts",
        "apps/shared/logger.ts",
        "apps/backend/shared/infra/database.ts",
        "apps/backend/shared/infra/database.test-support.ts",
        "apps/backend/todo/infra/container.ts",
        "apps/backend/drizzle.config.ts",
        "apps/frontend/next.config.ts",
        "apps/frontend/instrumentation.ts",
        "apps/frontend/instrumentation-node.ts",
        "apps/frontend/features/todo/api/todo-api.ts",
        "apps/frontend/app/page.tsx",
        "apps/e2e/database.ts",
        "apps/e2e/playwright.config.ts",
        "vitest.config.mts",
        "vitest.global-setup.ts",
        "stryker.config.mjs",
      ]),
    );
    expect(files).not.toContain("rule-tests/architecture.test.ts");
    expect(files).not.toContain("apps/shared/env.test.ts");
    // next build の生成物（apps/frontend/.next/）は数えない（あれば数千件の JS を検査することになる）。
    expect(files.filter((file) => file.includes("/.next/"))).toEqual([]);
  });

  it("console の直接の呼び出しの検査は、各ディレクトリ・scripts/・ルート直下の設定ファイルを対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）", () => {
    const files = listConsoleCheckedFiles(repoRoot);
    expect(files).toEqual(
      expect.arrayContaining([
        "apps/shared/logger.ts",
        "apps/shared/env.ts",
        "apps/backend/shared/infra/database.ts",
        "apps/backend/shared/presentation/http-error.ts",
        "apps/backend/todo/presentation/list-todos.api.ts",
        "apps/backend/drizzle.config.ts",
        "apps/frontend/proxy.ts",
        "apps/frontend/instrumentation-node.ts",
        "apps/frontend/features/todo/api/todo-api.ts",
        "apps/frontend/app/page.tsx",
        "apps/e2e/database.ts",
        "apps/e2e/playwright.config.ts",
        "apps/e2e/request-log.spec.ts",
        "vitest.config.mts",
        "vitest.global-setup.ts",
        "stryker.config.mjs",
      ]),
    );
    expect(files).not.toContain("rule-tests/architecture.test.ts");
    expect(files).not.toContain("apps/shared/logger.test.ts");
    expect(files).not.toContain("scripts/hooks/guard-git.test.ts");
    expect(files.filter((file) => file.includes("/.next/"))).toEqual([]);
  });

  it("logger.ts の中の console は拾えている（抽出が壊れて 0 件になり、規則が素通りするのを防ぐ）", () => {
    expect(
      findConsoleAccesses(
        readFileSync(join(repoRoot, CONSOLE_DIRECT_ACCESS.allowedFile), "utf8"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("env.ts の中の process.env は拾えている（抽出が壊れて 0 件になり、規則が素通りするのを防ぐ）", () => {
    expect(
      findProcessEnvAccesses(
        readFileSync(join(repoRoot, ENV_DIRECT_ACCESS.allowedFile), "utf8"),
      ).length,
    ).toBeGreaterThan(0);
  });
});

// --- 規則ごとの判定の仕様 ---
// 上の「依存の向き」のテストは今のコードに違反が無いことしか確かめないため、規則そのものが緩すぎても（常に違反なしと
// 判定しても）通ってしまう。規則ごとに「違反になる例」「ならない例」を架空の参照で固定し、規則の判定が仕様どおりかを確かめる。
// 例は [参照元のファイル, import に書く specifier, 値の参照か型だけの参照か]。

type Example = [from: string, specifier: string, kind: "value" | "type"];

const RULE_EXAMPLES: Record<
  RuleId,
  { violating: Example[]; allowed: Example[] }
> = {
  "frontend-to-backend-specifier": {
    violating: [
      [
        "apps/frontend/app/api/todos/[id]/route.ts",
        "../../../../../backend/todo/presentation/get-todo.api",
        "value",
      ],
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "../../../../backend/todo/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend/instrumentation-node.ts",
        "../backend/shared/infra/env",
        "value",
      ],
      // "@/" の後ろの ".." で apps/frontend の外に出る書き方も、backend への参照として数える（toReference の normalize）。
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@/../backend/todo/presentation/list-todos.api",
        "type",
      ],
      ["apps/e2e/database.ts", "../backend/shared/infra/env", "value"],
      ["apps/e2e/playwright.config.ts", "../backend/shared/infra/env", "value"],
      // 例外（vitest.global-setup.ts → database.test-support）は、そのファイルとその参照先の組だけ。
      //   global-setup からでも env を相対パスで参照するのは違反。別のルート直下のファイルから test-support も違反。
      ["vitest.global-setup.ts", "./apps/backend/shared/infra/env", "value"],
      [
        "vitest.config.mts",
        "./apps/backend/shared/infra/database.test-support",
        "value",
      ],
      [
        "apps/e2e/database.ts",
        "../backend/shared/infra/database.test-support",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend/app/api/todos/route.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "value",
      ],
      [
        "apps/e2e/x.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "type",
      ],
      [
        "vitest.config.mts",
        "@repo/backend/shared/presentation/http-error",
        "type",
      ],
      // 例外: テスト基盤の vitest.global-setup.ts だけは、database.test-support を相対パスで参照してよい。
      [
        "vitest.global-setup.ts",
        "./apps/backend/shared/infra/database.test-support",
        "value",
      ],
      // apps/frontend の中の参照（相対パス・"@/"）は backend を指さないので対象外。
      ["apps/frontend/app/page.tsx", "../features/todo", "value"],
      [
        "apps/frontend/features/todo/components/x.ts",
        "@/features/todo/api/todo-api",
        "type",
      ],
      // 前方一致だけが同じ別ディレクトリ（apps/backend-x）は backend ではない。
      ["apps/frontend/app/page.tsx", "../../backend-x/y", "value"],
      // backend の中の相対パスは、この規則の対象外（参照元が backend。backend-relative-only が見る）。
      ["apps/backend/drizzle.config.ts", "./todo/infra/schema", "value"],
      // apps/shared への相対パスは、この規則の対象外（frontend-to-shared-specifier が見る。Issue #90）。
      ["apps/frontend/proxy.ts", "../shared/logger", "value"],
    ],
  },
  "frontend-to-shared-specifier": {
    violating: [
      ["apps/frontend/instrumentation-node.ts", "../shared/env", "value"],
      // "@/" の後ろの ".." で apps/frontend の外に出る書き方も、apps/shared への参照として数える（toReference の normalize）。
      ["apps/frontend/proxy.ts", "@/../shared/logger", "value"],
      ["apps/e2e/database.ts", "../shared/env", "value"],
      ["apps/e2e/playwright.config.ts", "../shared/env.ts", "type"],
      ["vitest.global-setup.ts", "./apps/shared/env", "value"],
      // backend と違い、リポジトリ直下のテスト基盤にも相対パスの例外は無い。
      ["vitest.config.mts", "./apps/shared/logger", "value"],
      [
        "apps/frontend/features/todo/api/x.ts",
        "../../../../shared/env",
        "type",
      ],
    ],
    allowed: [
      ["apps/frontend/instrumentation-node.ts", "@repo/shared/env", "value"],
      ["apps/frontend/proxy.ts", "@repo/shared/logger", "value"],
      ["apps/e2e/playwright.config.ts", "@repo/shared/env", "value"],
      ["vitest.global-setup.ts", "@repo/shared/env", "value"],
      // 画面側の shared/（apps/frontend/shared/）は apps/shared ではない。前方一致だけが同じ別ディレクトリ（apps/shared-x）も。
      ["apps/frontend/proxy.ts", "@/shared/request-log/request-log", "value"],
      ["apps/frontend/app/page.tsx", "../../shared-x/y", "value"],
      // 前方一致だけが同じ別パッケージ（@repo/shared-extra）はパッケージの参照。
      ["apps/e2e/database.ts", "@repo/shared-extra/x", "value"],
      // backend は対象外（backend の中の書き方は backend-relative-only が見る。Issue #90）。
      ["apps/backend/drizzle.config.ts", "../shared/env", "value"],
    ],
  },
  "backend-to-frontend": {
    violating: [
      ["apps/backend/todo/infra/x.ts", "@/features/todo", "value"],
      ["apps/backend/drizzle.config.ts", "../frontend/next.config", "value"],
      [
        "apps/backend/shared/presentation/x.ts",
        "../../../frontend/app/page",
        "type",
      ],
      ["apps/backend/todo/domain/x.ts", "@/shared/x", "type"],
    ],
    allowed: [
      ["apps/backend/drizzle.config.ts", "@repo/shared/env", "value"],
      ["apps/backend/todo/infra/x.ts", "../domain/todo", "value"],
      // 前方一致だけが同じ別ディレクトリ（apps/frontend-x）は frontend ではない。
      ["apps/backend/todo/infra/x.ts", "../../../frontend-x/y", "value"],
      ["apps/backend/todo/infra/x.ts", "next/server", "value"],
      // frontend から backend への参照は、この規則の対象外（参照元が backend のときだけ）。
      [
        "apps/frontend/app/api/todos/route.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "value",
      ],
    ],
  },
  "backend-relative-only": {
    violating: [
      [
        "apps/backend/todo/domain/x.ts",
        "@repo/backend/todo/domain/todo",
        "value",
      ],
      [
        "apps/backend/todo/infra/container.ts",
        "@repo/backend/shared/infra/database",
        "type",
      ],
      [
        "apps/backend/drizzle.config.ts",
        "@repo/backend/shared/infra/env",
        "value",
      ],
      ["apps/backend/todo/application/x.ts", "@repo/backend", "value"],
      ["apps/backend/todo/infra/x.ts", "@/features/todo", "value"],
      // "@/" で apps/shared を指す書き方も "@/" なので違反（Issue #90）。
      ["apps/backend/shared/infra/database.ts", "@/../shared/env", "value"],
      // 相対パスで apps/shared を指すのも違反（exports を経由しない。Issue #90）。
      ["apps/backend/drizzle.config.ts", "../shared/env", "value"],
      [
        "apps/backend/shared/infra/database.ts",
        "../../../shared/logger",
        "value",
      ],
      ["apps/backend/todo/infra/x.ts", "../../../shared/env.ts", "type"],
    ],
    allowed: [
      ["apps/backend/todo/domain/x.ts", "./todo", "value"],
      // apps/shared（別の workspace パッケージ）は "@repo/shared/..." で参照してよい（Issue #90）。
      ["apps/backend/shared/infra/database.ts", "@repo/shared/env", "value"],
      [
        "apps/backend/shared/presentation/http-error.ts",
        "@repo/shared/logger",
        "value",
      ],
      ["apps/backend/drizzle.config.ts", "@repo/shared/env", "value"],
      // 前方一致だけが同じ別ディレクトリ（apps/shared-x）は apps/shared ではない（backend の外への相対パスの扱いは層の規則が見る）。
      ["apps/backend/drizzle.config.ts", "../shared-x/y", "value"],
      ["apps/backend/todo/infra/x.ts", "../../shared/infra/database", "type"],
      // 前方一致だけが同じ別パッケージ（@repo/backend-extra）はパッケージの参照。
      ["apps/backend/todo/infra/x.ts", "@repo/backend-extra/x", "value"],
      ["apps/backend/todo/infra/x.ts", "drizzle-orm", "value"],
      // frontend の "@/" と "@repo/backend/" は、この規則の対象外（参照元が backend のときだけ）。
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "type",
      ],
      ["apps/frontend/app/page.tsx", "@/features/todo", "value"],
    ],
  },
  "frontend-root-to-backend": {
    violating: [
      [
        "apps/frontend/instrumentation-node.ts",
        "@repo/backend/shared/infra/database",
        "value",
      ],
      [
        "apps/frontend/next.config.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend/instrumentation.ts",
        "../backend/todo/infra/container",
        "value",
      ],
      ["apps/frontend/proxy.ts", "@repo/backend/todo/infra/container", "value"],
      // Issue #90 で例外を無くした: 以前許していた env・logger（backend/shared/infra）も、alias でも相対パスでも違反。
      [
        "apps/frontend/instrumentation-node.ts",
        "@repo/backend/shared/infra/env",
        "value",
      ],
      [
        "apps/frontend/instrumentation-node.ts",
        "../backend/shared/infra/env",
        "value",
      ],
      ["apps/frontend/proxy.ts", "@repo/backend/shared/infra/logger", "value"],
      [
        "apps/frontend/instrumentation-node.ts",
        "@repo/backend/shared/infra/logger",
        "type",
      ],
    ],
    allowed: [
      // env・logger は apps/shared から使う（Issue #90）。
      ["apps/frontend/instrumentation-node.ts", "@repo/shared/env", "value"],
      ["apps/frontend/proxy.ts", "@repo/shared/logger", "value"],
      ["apps/frontend/instrumentation-node.ts", "@repo/shared/logger", "value"],
      ["apps/frontend/instrumentation.ts", "./instrumentation-node", "value"],
      ["apps/frontend/next.config.ts", "next", "type"],
      // proxy.ts（リクエストログ。Issue #80）が frontend の shared/ を使うのは、backend の参照ではないので対象外。
      ["apps/frontend/proxy.ts", "@/shared/request-log/request-log", "value"],
      ["apps/frontend/proxy.ts", "next/server", "type"],
      // 前方一致だけが同じ別パッケージ（@repo/backend-extra）はパッケージの参照。
      ["apps/frontend/next.config.ts", "@repo/backend-extra/x", "value"],
      // 直下でないファイルは、この規則の対象外（app/・features/ の規則で検査する）。
      [
        "apps/frontend/app/api/todos/route.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "value",
      ],
    ],
  },
  "screen-to-backend": {
    violating: [
      [
        "apps/frontend/features/todo/components/x.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend/features/todo/screens/s/s.hook.ts",
        "../../../../../backend/todo/domain/todo",
        "value",
      ],
      [
        "apps/frontend/shared/x.ts",
        "@repo/backend/shared/presentation/http-error",
        "type",
      ],
    ],
    allowed: [
      [
        "apps/frontend/features/todo/components/x.ts",
        "@/features/todo/api/todo-api",
        "type",
      ],
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "type",
      ],
      ["apps/frontend/shared/x.ts", "react", "value"],
    ],
  },
  "screen-to-shared": {
    violating: [
      [
        "apps/frontend/features/todo/components/x.tsx",
        "@repo/shared/logger",
        "value",
      ],
      // 型だけの参照も違反（apps/shared の型を画面側に持ち込む理由が無い。書き方を 1 つにする）。
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/shared/env",
        "type",
      ],
      ["apps/frontend/app/page.tsx", "@repo/shared/env", "value"],
      ["apps/frontend/app/api/todos/route.ts", "@repo/shared/logger", "value"],
      [
        "apps/frontend/shared/request-log/request-log.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/frontend/features/todo/screens/s/s.hook.ts",
        "../../../../../shared/env",
        "value",
      ],
    ],
    allowed: [
      // frontend 直下のサーバ側のファイルは apps/shared を使ってよい（この規則の対象外）。
      ["apps/frontend/instrumentation-node.ts", "@repo/shared/env", "value"],
      ["apps/frontend/proxy.ts", "@repo/shared/logger", "value"],
      // 画面側の shared/（apps/frontend/shared/）は apps/shared ではない。
      [
        "apps/frontend/features/todo/components/x.tsx",
        "@/shared/request-log/request-log",
        "value",
      ],
      // 前方一致だけが同じ別パッケージ（@repo/shared-extra）はパッケージの参照。
      ["apps/frontend/app/page.tsx", "@repo/shared-extra/x", "value"],
      // backend は対象外（層の規則が見る）。
      ["apps/backend/shared/infra/database.ts", "@repo/shared/env", "value"],
    ],
  },
  "feature-api-to-backend": {
    violating: [
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "value",
      ],
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/todo/domain/todo",
        "type",
      ],
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/other/presentation/list-others.api",
        "type",
      ],
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/todo/presentation/list-todos",
        "type",
      ],
    ],
    allowed: [
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "type",
      ],
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "../../../../backend/todo/presentation/get-todo.api",
        "type",
      ],
      [
        "apps/frontend/features/todo/api/todo-api.ts",
        "@repo/backend/shared/presentation/http-error",
        "type",
      ],
    ],
  },
  "feature-to-feature": {
    violating: [
      [
        "apps/frontend/features/other/components/x.ts",
        "@/features/todo/components/todo-item",
        "value",
      ],
      [
        "apps/frontend/features/other/components/x.ts",
        "../../todo/api/todo-api",
        "type",
      ],
      [
        "apps/frontend/features/todo/components/x.ts",
        "@/features/todo-extra/components/y",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend/features/other/components/x.ts",
        "@/features/todo",
        "value",
      ],
      [
        "apps/frontend/features/other/components/x.ts",
        "@/features/todo/index",
        "value",
      ],
      [
        "apps/frontend/features/todo/screens/todo-screen/todo-screen.tsx",
        "../../components/todo-item",
        "value",
      ],
    ],
  },
  "screen-to-app": {
    violating: [
      ["apps/frontend/features/todo/components/x.ts", "@/app/page", "value"],
      ["apps/frontend/shared/x.ts", "@/app/layout", "type"],
      [
        "apps/frontend/features/todo/screens/s/s.tsx",
        "../../../../app/api/todos/route",
        "value",
      ],
    ],
    allowed: [
      ["apps/frontend/features/todo/components/x.ts", "next/link", "value"],
      ["apps/frontend/features/todo/components/x.ts", "@/shared/x", "value"],
      ["apps/frontend/shared/x.ts", "./y", "value"],
    ],
  },
  "shared-to-features": {
    violating: [
      ["apps/frontend/shared/x.ts", "@/features/todo", "value"],
      [
        "apps/frontend/shared/ui/x.tsx",
        "../../features/todo/components/todo-item",
        "value",
      ],
      ["apps/frontend/shared/x.ts", "@/features/todo/api/todo-api", "type"],
    ],
    allowed: [
      ["apps/frontend/shared/x.ts", "react", "value"],
      ["apps/frontend/shared/ui/x.tsx", "../x", "value"],
      [
        "apps/frontend/features/todo/components/x.ts",
        "@/features/todo/api/todo-api",
        "value",
      ],
    ],
  },
  domain: {
    violating: [
      ["apps/backend/todo/domain/x.ts", "next/server", "value"],
      ["apps/backend/todo/domain/x.ts", "react/jsx-runtime", "value"],
      [
        "apps/backend/todo/domain/x.ts",
        "../application/create-todo.command",
        "value",
      ],
      ["apps/backend/todo/domain/x.ts", "../../other/domain/other", "type"],
      [
        "apps/backend/todo/domain/x.ts",
        "../../shared/presentation/http-error",
        "value",
      ],
      ["apps/backend/todo/domain/x.ts", "@/features/todo", "value"],
      ["apps/backend/todo/domain/x.ts", "@/shared/x", "value"],
      // apps/shared の env・logger は domain から使わない（Issue #90。SHARED_MODULES_BY_LAYER）。
      ["apps/backend/todo/domain/x.ts", "@repo/shared/logger", "value"],
      ["apps/backend/shared/domain/x.ts", "@repo/shared/env", "type"],
    ],
    allowed: [
      ["apps/backend/todo/domain/x.ts", "./todo", "value"],
      ["apps/backend/todo/domain/x.ts", "./todo", "type"],
      [
        "apps/backend/todo/domain/x.ts",
        "../../shared/domain/domain-error",
        "value",
      ],
      ["apps/backend/todo/domain/x.ts", "node:crypto", "value"],
    ],
  },
  "core-to-persistence": {
    violating: [
      ["apps/backend/todo/domain/x.ts", "drizzle-orm", "type"],
      ["apps/backend/todo/domain/x.ts", "pg", "value"],
      ["apps/backend/todo/application/x.ts", "drizzle-orm/pg-core", "value"],
      ["apps/backend/todo/application/x.ts", "pg", "type"],
      ["apps/backend/shared/domain/x.ts", "drizzle-orm/node-postgres", "type"],
      ["apps/backend/shared/application/x.ts", "drizzle-orm", "value"],
    ],
    allowed: [
      // infra / presentation は対象外（infra は永続化の実装を持つ層）。
      ["apps/backend/todo/infra/schema.ts", "drizzle-orm/pg-core", "value"],
      ["apps/backend/shared/infra/database.ts", "pg", "value"],
      ["apps/backend/todo/presentation/x.api.ts", "drizzle-orm", "type"],
      // 名前の前方一致だけが同じ別のパッケージは対象外（パッケージ名で比べる）。
      ["apps/backend/todo/domain/x.ts", "pg-format", "value"],
      ["apps/backend/todo/application/x.ts", "drizzle-orm-extra", "value"],
      // 自前コードのパスに pg / drizzle-orm を含んでも、パッケージではない。
      ["apps/backend/todo/domain/x.ts", "./pg", "value"],
      ["apps/backend/todo/domain/x.ts", "node:crypto", "value"],
    ],
  },
  application: {
    violating: [
      ["apps/backend/todo/application/x.ts", "../infra/container", "value"],
      [
        "apps/backend/todo/application/x.ts",
        "../presentation/list-todos.api",
        "type",
      ],
      ["apps/backend/todo/application/x.ts", "react", "value"],
      ["apps/backend/todo/application/x.ts", "@/features/todo", "value"],
      [
        "apps/backend/todo/application/x.ts",
        "../../other/domain/other",
        "type",
      ],
      [
        "apps/backend/todo/application/x.ts",
        "../../other/application/other.query",
        "value",
      ],
      [
        "apps/backend/todo/application/x.ts",
        "../../../frontend/shared/x",
        "value",
      ],
      // apps/shared の env・logger は application から使わない（Issue #90。SHARED_MODULES_BY_LAYER）。
      ["apps/backend/todo/application/x.ts", "@repo/shared/env", "value"],
      ["apps/backend/todo/application/x.ts", "@repo/shared/logger", "value"],
    ],
    allowed: [
      [
        "apps/backend/todo/application/x.ts",
        "../domain/todo-repository",
        "type",
      ],
      ["apps/backend/todo/application/x.ts", "../domain/todo", "value"],
      ["apps/backend/todo/application/x.ts", "./other.command", "value"],
      ["apps/backend/todo/application/x.ts", "node:crypto", "value"],
      [
        "apps/backend/todo/application/x.ts",
        "../../shared/domain/domain-error",
        "value",
      ],
    ],
  },
  presentation: {
    violating: [
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../infra/todo-repository.in-memory",
        "value",
      ],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../infra/container-helper",
        "value",
      ],
      ["apps/backend/todo/presentation/x.api.ts", "next/server", "value"],
      ["apps/backend/todo/presentation/x.api.ts", "../domain/todo", "value"],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../../other/infra/container",
        "type",
      ],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../../other/application/other.query",
        "type",
      ],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../../other/domain/other",
        "type",
      ],
      ["apps/backend/todo/presentation/x.api.ts", "@/shared/x", "value"],
      [
        "apps/backend/shared/presentation/x.ts",
        "../../todo/infra/container",
        "value",
      ],
      // backend/shared の infra は container という名前でも不可（presentation が受け取ってよいのは自 feature の container だけ）。
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../../shared/infra/container",
        "value",
      ],
      // infra は自 feature の container だけ。自 feature の infra の logger、backend/shared/infra のファイル（Issue #90 で
      //   logger を移した後の旧パスを含む）は不可（Issue #85・#90）。
      ["apps/backend/todo/presentation/x.api.ts", "../infra/logger", "value"],
      ["apps/backend/shared/presentation/x.ts", "../infra/database", "type"],
      [
        "apps/backend/shared/presentation/http-error.ts",
        "../infra/logger",
        "value",
      ],
      // apps/shared で使ってよいのは logger だけ。env、前方一致だけが同じ別ファイル、パッケージ名だけ（apps/shared）は不可（Issue #90）。
      ["apps/backend/todo/presentation/x.api.ts", "@repo/shared/env", "value"],
      [
        "apps/backend/shared/presentation/x.ts",
        "@repo/shared/logger-helper",
        "value",
      ],
      ["apps/backend/todo/presentation/x.api.ts", "@repo/shared", "value"],
    ],
    allowed: [
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../infra/container",
        "value",
      ],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../infra/container",
        "value",
      ],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../application/list-todos.query",
        "type",
      ],
      ["apps/backend/todo/presentation/x.api.ts", "./get-todo.api", "value"],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../../shared/presentation/http-error",
        "value",
      ],
      ["apps/backend/todo/presentation/x.api.ts", "../domain/todo", "type"],
      [
        "apps/backend/shared/presentation/http-error.ts",
        "../domain/domain-error",
        "value",
      ],
      // ログの唯一の出口（Issue #85。Issue #90 で apps/shared に移した）。http-error.ts が想定外の例外を logger.error で残す。
      //   feature の presentation からも使える。相対パスで書いても参照先は同じ（書き方は backend-relative-only が見る）。
      [
        "apps/backend/shared/presentation/http-error.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "@repo/shared/logger",
        "value",
      ],
      [
        "apps/backend/todo/presentation/x.api.ts",
        "../../../shared/logger",
        "value",
      ],
    ],
  },
  infra: {
    violating: [
      [
        "apps/backend/todo/infra/x.ts",
        "../presentation/list-todos.api",
        "type",
      ],
      ["apps/backend/todo/infra/x.ts", "../../other/domain/other", "type"],
      ["apps/backend/todo/infra/x.ts", "@/features/todo", "value"],
      ["apps/backend/todo/infra/x.ts", "@/shared/x", "value"],
      ["apps/backend/todo/infra/x.ts", "@/app/page", "value"],
      ["apps/backend/todo/infra/x.ts", "next/server", "value"],
      // apps/shared で使ってよいのは env・logger だけ。前方一致だけが同じ別ファイル、パッケージ名だけは不可（Issue #90）。
      ["apps/backend/todo/infra/x.ts", "@repo/shared/env-helper", "value"],
      ["apps/backend/shared/infra/x.ts", "@repo/shared", "value"],
    ],
    allowed: [
      ["apps/backend/todo/infra/x.ts", "../domain/todo", "value"],
      [
        "apps/backend/todo/infra/x.ts",
        "../application/create-todo.command",
        "value",
      ],
      [
        "apps/backend/todo/infra/x.ts",
        "../../shared/domain/domain-error",
        "value",
      ],
      [
        "apps/backend/todo/infra/container.ts",
        "./todo-repository.in-memory",
        "value",
      ],
      ["apps/backend/todo/infra/x.ts", "node:crypto", "value"],
      // 環境変数の入口とログの出口（Issue #90 で apps/shared に移した）。
      ["apps/backend/shared/infra/database.ts", "@repo/shared/env", "value"],
      ["apps/backend/shared/infra/database.ts", "@repo/shared/logger", "value"],
      ["apps/backend/todo/infra/x.ts", "../../../shared/env", "type"],
    ],
  },
  "backend-shared": {
    violating: [
      [
        "apps/backend/shared/presentation/x.ts",
        "../../todo/domain/todo",
        "type",
      ],
      [
        "apps/backend/shared/presentation/x.ts",
        "../../todo/infra/container",
        "value",
      ],
      ["apps/backend/shared/presentation/x.ts", "@/features/todo", "value"],
      ["apps/backend/shared/x.ts", "@/app/page", "value"],
      ["apps/backend/shared/domain/x.ts", "@/shared/x", "value"],
      ["apps/backend/shared/presentation/x.ts", "next/server", "value"],
      // 前方一致だけが同じ別ディレクトリ（apps/shared-x）は apps/shared ではない（Issue #90）。
      ["apps/backend/shared/infra/x.ts", "../../../shared-x/y", "value"],
    ],
    allowed: [
      [
        "apps/backend/shared/presentation/x.ts",
        "../domain/domain-error",
        "value",
      ],
      [
        "apps/backend/shared/presentation/json-body.ts",
        "./http-error",
        "value",
      ],
      ["apps/backend/shared/domain/x.ts", "node:crypto", "value"],
      ["apps/backend/shared/presentation/x.ts", "some-package/sub", "value"],
      // apps/shared（frontend と backend で共通の基盤。Issue #90）。
      ["apps/backend/shared/infra/database.ts", "@repo/shared/env", "value"],
      [
        "apps/backend/shared/presentation/http-error.ts",
        "@repo/shared/logger",
        "value",
      ],
    ],
  },
  app: {
    violating: [
      [
        "apps/frontend/app/page.tsx",
        "@repo/backend/todo/presentation/list-todos.api",
        "value",
      ],
      [
        "apps/frontend/app/page.tsx",
        "@/features/todo/components/todo-item",
        "value",
      ],
      [
        "apps/frontend/app/todo/[id]/page.tsx",
        "../../../features/todo/api/todo-api",
        "type",
      ],
    ],
    allowed: [
      ["apps/frontend/app/page.tsx", "@/features/todo", "value"],
      [
        "apps/frontend/app/todo/[id]/page.tsx",
        "../../../features/todo/index",
        "value",
      ],
      ["apps/frontend/app/page.tsx", "@/shared/x", "value"],
      ["apps/frontend/app/layout.tsx", "./globals.css", "value"],
      ["apps/frontend/app/page.tsx", "react", "value"],
    ],
  },
  "app-api": {
    violating: [
      [
        "apps/frontend/app/api/todos/route.ts",
        "@repo/backend/todo/infra/container",
        "value",
      ],
      ["apps/frontend/app/api/todos/route.ts", "next/server", "value"],
      [
        "apps/frontend/app/api/todos/route.ts",
        "@repo/backend/todo/presentation/list-todos",
        "value",
      ],
    ],
    allowed: [
      [
        "apps/frontend/app/api/todos/route.ts",
        "@repo/backend/todo/presentation/list-todos.api",
        "value",
      ],
      [
        "apps/frontend/app/api/todos/[id]/route.ts",
        "../../../../../backend/todo/presentation/get-todo.api",
        "value",
      ],
      [
        "apps/frontend/app/api/todos/route.ts",
        "@repo/backend/todo/presentation/create-todo.api",
        "type",
      ],
    ],
  },
};

function judge(id: RuleId, [from, specifier, kind]: Example): boolean {
  const rule = RULES.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`規則 ${id} が RULES にない`);
  }
  const ref = toReference(from, { specifier, typeOnly: kind === "type" });
  return rule.appliesTo(ref.from) && rule.isViolation(ref);
}

// 置き場所の規則（BACKEND_PLACEMENT / FRONTEND_PLACEMENT）の判定例。参照ではなくファイルの置き場所で決まるので別に持つ。
const PLACEMENT_EXAMPLES: { misplaced: string[]; placed: string[] } = {
  misplaced: [
    "apps/backend/.lib/x.ts",
    "apps/backend/todo/p-root.ts",
    "apps/backend/todo/lib/x.ts",
    "apps/backend/shared/bad-root.ts",
    "apps/backend/x.ts",
    "apps/backend/todo/domainx/x.ts",
  ],
  placed: [
    "apps/backend/todo/domain/todo.ts",
    "apps/backend/shared/presentation/http-error.ts",
    "apps/backend/todo/infra/container.ts",
    "apps/backend/todo/presentation/nested/x.api.ts",
    "apps/backend/drizzle.config.ts",
    "apps/frontend/features/todo/lib/x.ts",
    // backend の規則の対象外（apps/e2e は E2E の workspace パッケージ @repo/e2e。Issue #84）。
    "apps/e2e/database.ts",
    "apps/e2e/playwright.config.ts",
    "apps/e2e/todo.spec.ts",
    // apps/shared（@repo/shared。Issue #90）も backend の規則の対象外（SHARED_PLACEMENT が見る）。
    "apps/shared/env.ts",
    "apps/shared/extra.ts",
  ],
};

const FRONTEND_PLACEMENT_EXAMPLES: { misplaced: string[]; placed: string[] } = {
  misplaced: [
    "apps/frontend/lib/db.ts",
    "apps/frontend/.lib/x.ts",
    "apps/frontend/x.ts",
    "apps/frontend/next.config.mjs",
    // 前方一致だけが同じ別ディレクトリ・別ファイル。
    "apps/frontend/app-x/page.tsx",
    "apps/frontend/featuresx/todo/x.ts",
    "apps/frontend/instrumentation-node.helper.ts",
    "apps/frontend/proxy.helper.ts",
    // proxy.ts の旧名（Next 16 で非推奨）と、proxy の別の拡張子（許すのは proxy.ts だけ）。
    "apps/frontend/middleware.ts",
    "apps/frontend/proxy.js",
    // 許可された名前でも、直下でなければ例外にしない。
    "apps/frontend/lib/next.config.ts",
    "apps/frontend/lib/proxy.ts",
  ],
  placed: [
    "apps/frontend/app/page.tsx",
    "apps/frontend/app/api/todos/route.ts",
    "apps/frontend/features/todo/lib/x.ts",
    "apps/frontend/shared/ui/button.tsx",
    "apps/frontend/next.config.ts",
    "apps/frontend/instrumentation.ts",
    "apps/frontend/instrumentation-node.ts",
    "apps/frontend/proxy.ts",
    "apps/frontend/next-env.d.ts",
    // frontend の規則の対象外（apps/backend は BACKEND_PLACEMENT が見る）。
    "apps/backend/lib/x.ts",
    // apps/e2e（E2E の workspace パッケージ @repo/e2e。Issue #84）も frontend の規則の対象外。
    "apps/e2e/database.ts",
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
    "apps/shared/package.json",
    "apps/shared/tsconfig.json",
    // apps/shared の外は対象外（前方一致だけが同じ別ディレクトリ・backend の shared/・画面側の shared/）。
    "apps/shared-x/extra.ts",
    "apps/backend/shared/infra/database.ts",
    "apps/frontend/shared/request-log/request-log.ts",
    "apps/e2e/database.ts",
  ],
};

describe("backend の置き場所の判定", () => {
  it.each(PLACEMENT_EXAMPLES.misplaced)("%s は置き場所の違反", (file) => {
    expect(BACKEND_PLACEMENT.isMisplaced(file)).toBe(true);
  });
  it.each(PLACEMENT_EXAMPLES.placed)("%s は置き場所の違反ではない", (file) => {
    expect(BACKEND_PLACEMENT.isMisplaced(file)).toBe(false);
  });
});

describe("apps/shared の置き場所の判定", () => {
  it.each(SHARED_PLACEMENT_EXAMPLES.misplaced)(
    "%s は置き場所の違反",
    (file) => {
      expect(SHARED_PLACEMENT.isMisplaced(file)).toBe(true);
    },
  );
  it.each(SHARED_PLACEMENT_EXAMPLES.placed)(
    "%s は置き場所の違反ではない",
    (file) => {
      expect(SHARED_PLACEMENT.isMisplaced(file)).toBe(false);
    },
  );
});

describe("frontend の置き場所の判定", () => {
  it.each(FRONTEND_PLACEMENT_EXAMPLES.misplaced)(
    "%s は置き場所の違反",
    (file) => {
      expect(FRONTEND_PLACEMENT.isMisplaced(file)).toBe(true);
    },
  );
  it.each(FRONTEND_PLACEMENT_EXAMPLES.placed)(
    "%s は置き場所の違反ではない",
    (file) => {
      expect(FRONTEND_PLACEMENT.isMisplaced(file)).toBe(false);
    },
  );
});

// 環境変数の直参照の規則（ENV_DIRECT_ACCESS）の判定例。参照ではなく [ファイル, ソース] で決まるので別に持つ。
const ENV_ACCESS_EXAMPLES: {
  violating: [file: string, source: string][];
  allowed: [file: string, source: string][];
} = {
  violating: [
    ["apps/backend/todo/infra/x.ts", "const url = process.env.DATABASE_URL;"],
    ["apps/e2e/x.ts", 'const url = process["env"].DATABASE_URL;'],
    ["apps/e2e/playwright.config.ts", "const ci = !process . env . CI;"],
    [
      "apps/frontend/features/todo/api/x.tsx",
      "const v = globalThis.process.env.X;",
    ],
    ["apps/backend/drizzle.config.ts", "const v = process\n  .env\n  .X;"],
    ["apps/frontend/app/page.jsx", "const v = process?.env.X;"],
    ["vitest.config.mts", "const v = process['env'];"],
    // env.ts と名前の前方一致だけが同じ別ファイル。
    ["apps/shared/env-helper.ts", "export const v = process.env;"],
    // Issue #90 で移す前の場所（apps/backend/shared/infra/env.ts）は、もう例外ではない。
    [
      "apps/backend/shared/infra/env.ts",
      "export const v = process.env.DATABASE_URL;",
    ],
    ["apps/shared/logger.ts", "const v = process.env.X;"],
    ["apps/frontend/shared/x.cjs", "module.exports = process[`env`];"],
    // 括弧で囲んだ process と、global 経由。
    ["apps/backend/todo/infra/x.ts", "const v = (process).env.X;"],
    ["apps/e2e/x.ts", 'const v = ( process )["env"];'],
    ["apps/backend/todo/infra/x.ts", "const v = global.process.env.X;"],
    // instrumentation.ts の例外は NEXT_RUNTIME だけで、ほかの変数・名前を取れない書き方・ほかのファイルは違反。
    [
      "apps/frontend/instrumentation.ts",
      "const url = process.env.DATABASE_URL;",
    ],
    [
      "apps/frontend/instrumentation.ts",
      "const r = process.env.NEXT_RUNTIME_X;",
    ],
    [
      "apps/frontend/instrumentation.ts",
      'const r = process.env["NEXT_RUNTIME"];',
    ],
    ["apps/frontend/instrumentation.ts", "const all = process.env;"],
    ["apps/backend/todo/infra/x.ts", "const r = process.env.NEXT_RUNTIME;"],
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
    ["apps/backend/todo/infra/x.ts", "// process.env.DATABASE_URL は読まない"],
    ["apps/backend/todo/infra/x.ts", "/* process.env */ export const a = 1;"],
    ["apps/backend/todo/infra/x.ts", 'const s = "process.env.DATABASE_URL";'],
    // process.env ではない識別子・プロパティ。
    [
      "apps/backend/todo/infra/x.ts",
      "const processEnv = read(); processEnv.X;",
    ],
    [
      "apps/backend/todo/infra/x.ts",
      "const v = myprocess.env; process.envelope;",
    ],
    // テストと、対象外の場所のファイル。
    ["apps/backend/todo/infra/x.test.ts", "const path = process.env.PATH;"],
    ["architecture.test.ts", "const path = process.env.PATH;"],
    ["scripts/x.ts", "const path = process.env.PATH;"],
    ["README.md", "process.env.DATABASE_URL"],
    // instrumentation.ts の NEXT_RUNTIME（Next.js の規約。改行を挟んでも同じ）。
    [
      "apps/frontend/instrumentation.ts",
      'if (process.env.NEXT_RUNTIME === "nodejs") { await import("./instrumentation-node"); }',
    ],
    [
      "apps/frontend/instrumentation.ts",
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

describe("環境変数の直参照の判定", () => {
  it("違反例・許可例はそれぞれ 4 件以上ある", () => {
    expect(ENV_ACCESS_EXAMPLES.violating.length).toBeGreaterThanOrEqual(4);
    expect(ENV_ACCESS_EXAMPLES.allowed.length).toBeGreaterThanOrEqual(4);
  });
  it.each(ENV_ACCESS_EXAMPLES.violating)("%s の %j は違反", (...example) => {
    expect(judgeEnvAccess(example)).toBe(true);
  });
  it.each(ENV_ACCESS_EXAMPLES.allowed)(
    "%s の %j は違反ではない",
    (...example) => {
      expect(judgeEnvAccess(example)).toBe(false);
    },
  );
});

describe("環境変数の直参照の抽出（findProcessEnvAccesses）", () => {
  it("参照ごとに、読んだ変数の名前を返す（.NAME / ?.NAME の形だけ。取れない形は undefined）", () => {
    const source = [
      "const a = process.env.NEXT_RUNTIME;",
      "const b = process?.env?.DATABASE_URL;",
      'const c = process["env"].X;',
      'const d = process.env["Y"];',
      "const e = process.env;",
    ].join("\n");
    expect(
      findProcessEnvAccesses(source).map(({ variable }) => variable),
    ).toEqual(["NEXT_RUNTIME", "DATABASE_URL", "X", undefined, undefined]);
  });

  it("参照ごとに、書かれた行番号を返す（コメントを消しても行はずれない）", () => {
    const source = [
      "/*",
      " * process.env は読まない",
      " */",
      "const a = process.env.A; const b = process.env.B;",
      "// process.env",
      'const c = process["env"].C;',
    ].join("\n");
    expect(findProcessEnvAccesses(source).map(({ line }) => line)).toEqual([
      4, 4, 6,
    ]);
  });

  it("分割代入・別名・Reflect.get・node:process の default import 経由の参照は拾わない（見逃す方向の限界。Biome の noProcessEnv も検出しない）", () => {
    const source = [
      "const { env } = process;",
      "const p = process; p.env;",
      'const e = Reflect.get(process, "env");',
      'import proc from "node:process"; proc.env.X;',
    ].join("\n");
    expect(findProcessEnvAccesses(source)).toEqual([]);
  });

  it('node:process の名前付き import（import { env } from "node:process"）は拾わない（見逃す方向の限界。Biome の noProcessEnv が検出する）', () => {
    const source = [
      'import { env } from "node:process";',
      "export const u = env.X;",
    ].join("\n");
    expect(findProcessEnvAccesses(source)).toEqual([]);
  });

  it("テンプレートリテラルの埋め込み式の中の参照は拾わない（見逃す方向の限界。Biome の noProcessEnv が検出する）", () => {
    // WHY テンプレートリテラルで書く: 普通の文字列の中に埋め込み式の形を書くと Biome の noTemplateCurlyInString が
    //   書き間違いとして検出するため、\${ でエスケープして同じ文字列を作る。
    const source = `const url = \`db: \${process.env.DATABASE_URL}\`;`;
    expect(findProcessEnvAccesses(source)).toEqual([]);
  });
});

// console を直接書く規則（CONSOLE_DIRECT_ACCESS）の判定例。ENV_ACCESS_EXAMPLES と同じく [ファイル, ソース] で決まる。
const CONSOLE_ACCESS_EXAMPLES: {
  violating: [file: string, source: string][];
  allowed: [file: string, source: string][];
} = {
  violating: [
    // 書き方（メソッド・?.・[]・空白と改行・globalThis / global 経由・括弧）。
    ["apps/backend/todo/presentation/x.api.ts", 'console.log("x");'],
    ["apps/backend/shared/presentation/x.ts", "console.error(error);"],
    ["apps/backend/shared/infra/database.ts", 'console.warn("retry");'],
    ["apps/backend/todo/infra/x.ts", 'console?.info("x");'],
    ["apps/backend/todo/infra/x.ts", 'console["log"]("x");'],
    ["apps/backend/todo/infra/x.ts", "console\n  .log(1);"],
    ["apps/frontend/proxy.ts", "globalThis.console.log(line);"],
    ["apps/frontend/instrumentation-node.ts", "global.console.error(e);"],
    ["apps/frontend/features/todo/components/x.tsx", "(console).log(1);"],
    // 呼び出し以外の参照（別名・分割代入・引数に渡す）も、console という名前を書いた時点で違反。
    ["apps/frontend/app/page.tsx", "const c = console; c.log(1);"],
    ["apps/frontend/shared/x.ts", "const { log } = console;"],
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
    ["apps/backend/todo/infra/logger.ts", "console.log(1);"],
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
    ["apps/backend/todo/infra/x.ts", '// console.log("x") は書かない'],
    ["apps/backend/todo/infra/x.ts", "/* console.error */ export const a = 1;"],
    ["apps/backend/todo/infra/x.ts", 'const s = "console.log(1)";'],
    ["apps/backend/todo/infra/x.ts", "const t = `console.log`;"],
    // console ではない識別子・プロパティ。
    [
      "apps/backend/todo/infra/x.ts",
      "const consoleLog = read(); consoleLog.x;",
    ],
    ["apps/backend/todo/infra/x.ts", "myconsole.log(1); console_.log(2);"],
    ["apps/backend/todo/infra/x.ts", 'logger.error({ message: "x" });'],
    // テストと、対象外の場所・種類のファイル。
    ["apps/backend/todo/infra/x.test.ts", "console.log(1);"],
    ["apps/frontend/features/todo/components/x.test.tsx", "console.log(1);"],
    ["scripts/hooks/guard-git.test.ts", "console.log(1);"],
    ["architecture.test.ts", "console.log(1);"],
    ["docs/x.ts", "console.log(1);"],
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

describe("console を直接書く規則の判定", () => {
  it("違反例・許可例はそれぞれ 4 件以上ある", () => {
    expect(CONSOLE_ACCESS_EXAMPLES.violating.length).toBeGreaterThanOrEqual(4);
    expect(CONSOLE_ACCESS_EXAMPLES.allowed.length).toBeGreaterThanOrEqual(4);
  });
  it.each(CONSOLE_ACCESS_EXAMPLES.violating)(
    "%s の %j は違反",
    (...example) => {
      expect(judgeConsoleAccess(example)).toBe(true);
    },
  );
  it.each(CONSOLE_ACCESS_EXAMPLES.allowed)(
    "%s の %j は違反ではない",
    (...example) => {
      expect(judgeConsoleAccess(example)).toBe(false);
    },
  );
});

describe("console の参照の抽出（findConsoleAccesses）", () => {
  it("参照ごとに、書かれた行番号を返す（コメントを消しても行はずれない）", () => {
    const source = [
      "/*",
      " * console.log は書かない",
      " */",
      "console.log(1); console.error(2);",
      "// console.warn",
      'globalThis.console["info"](3);',
    ].join("\n");
    expect(findConsoleAccesses(source)).toEqual([4, 4, 6]);
  });

  it('node:console の import（import { log } from "node:console" / import c from "node:console"）は拾わない（見逃す方向の限界。Biome の noConsole も検出しない）', () => {
    const source = [
      'import { log } from "node:console";',
      'import c from "node:console";',
      "log(1); c.log(2);",
    ].join("\n");
    expect(findConsoleAccesses(source)).toEqual([]);
  });

  it("テンプレートリテラルの埋め込み式の中の console は拾わない（見逃す方向の限界。Biome の noConsole が検出する）", () => {
    // WHY テンプレートリテラルで書く: 環境変数の抽出のテストと同じく、noTemplateCurlyInString を避けるため。
    const source = `const s = \`x: \${console.log(1)}\`;`;
    expect(findConsoleAccesses(source)).toEqual([]);
  });
});

describe("規則ごとの判定", () => {
  // WHY: 規則を足したのに判定の例を足し忘れると、その規則の判定は下の it.each で 1 度も確かめられない（Issue #68 で 3 規則を足した）。
  it("RULES のすべての規則に判定の例があり、RULES に無い規則の例は無い", () => {
    expect(Object.keys(RULE_EXAMPLES).sort()).toEqual(
      RULES.map((rule) => rule.id).sort(),
    );
  });

  // WHY 件数をそろえる: 例が 1 件だけだと、規則の書き方を少し崩した（条件を 1 つ落とした）ときに気づけない。
  //   違反・許可の両側に複数の例を置き、境界の両側を固定する。
  it.each(Object.keys(RULE_EXAMPLES))(
    "%s の違反例・許可例はそれぞれ 3 件以上ある",
    (id) => {
      const { violating, allowed } = RULE_EXAMPLES[id as RuleId];
      expect(violating.length).toBeGreaterThanOrEqual(3);
      expect(allowed.length).toBeGreaterThanOrEqual(3);
    },
  );

  for (const [id, { violating, allowed }] of Object.entries(RULE_EXAMPLES) as [
    RuleId,
    { violating: Example[]; allowed: Example[] },
  ][]) {
    describe(id, () => {
      it.each(violating)("%s → %s（%s）は違反", (...example) => {
        expect(judge(id, example)).toBe(true);
      });
      it.each(allowed)("%s → %s（%s）は違反ではない", (...example) => {
        expect(judge(id, example)).toBe(false);
      });
    });
  }
});

// --- exports の判定（BACKEND_EXPORTS・SHARED_EXPORTS）の仕様 ---
// 参照 1 件ごとではなく、exports の中身と参照の集まりで決まるので、RULES の外で例を持つ。

const EXPORT_KEY_EXAMPLES: {
  keys: string[];
  resolved: [specifier: string, key: string][];
  unresolved: string[];
} = {
  keys: [
    "./todo/presentation/*.api",
    "./todo/presentation/*",
    "./shared/infra/env",
  ],
  resolved: [
    // "*" の前が同じ長さのパターンが 2 つ当たるときは、キーが長い方（Node.js の解決と同じ）。
    [
      "@repo/backend/todo/presentation/list-todos.api",
      "./todo/presentation/*.api",
    ],
    // "*" は "/" を含んでもよい。
    [
      "@repo/backend/todo/presentation/nested/x.api",
      "./todo/presentation/*.api",
    ],
    ["@repo/backend/todo/presentation/list-todos", "./todo/presentation/*"],
    ["@repo/backend/shared/infra/env", "./shared/infra/env"],
  ],
  unresolved: [
    // 完全一致のキーの前方一致だけ・拡張子つきは当たらない。
    "@repo/backend/shared/infra/env-helper",
    "@repo/backend/shared/infra/env.ts",
    // "*" は 1 文字以上。
    "@repo/backend/todo/presentation/",
    // パターンの "*" の前が一致しない（前方一致だけが同じ別ディレクトリ）。
    "@repo/backend/todo/presentationx/a.api",
    "@repo/backend/todo/infra/container",
    // パッケージ名だけ（"."）はキーに無い。
    "@repo/backend",
  ],
};

describe("exports のキーの照合（resolveExportKey）", () => {
  it("当たる例・当たらない例はそれぞれ 3 件以上ある", () => {
    expect(EXPORT_KEY_EXAMPLES.resolved.length).toBeGreaterThanOrEqual(3);
    expect(EXPORT_KEY_EXAMPLES.unresolved.length).toBeGreaterThanOrEqual(3);
  });

  it.each(EXPORT_KEY_EXAMPLES.resolved)(
    "%s は %s に当たる",
    (specifier, key) => {
      expect(
        resolveExportKey(
          exportSubpath(BACKEND_EXPORTS, specifier),
          EXPORT_KEY_EXAMPLES.keys,
        ),
      ).toBe(key);
    },
  );

  it.each(EXPORT_KEY_EXAMPLES.unresolved)(
    "%s はどのキーにも当たらない",
    (specifier) => {
      expect(
        resolveExportKey(
          exportSubpath(BACKEND_EXPORTS, specifier),
          EXPORT_KEY_EXAMPLES.keys,
        ),
      ).toBeUndefined();
    },
  );
});

describe("exports の違反の検出（findExportsViolations）", () => {
  const ref = (from: string, specifier: string): Reference =>
    toReference(from, { specifier, typeOnly: false });
  const backendFiles = [
    "apps/backend/todo/presentation/list-todos.api.ts",
    "apps/backend/shared/infra/env.ts",
    "apps/backend/unused.ts",
    "apps/backend/mismatch.ts",
    "apps/backend/object.ts",
  ];

  it("すべての参照がキーに当たり、すべてのキーが使われ、値がキーのパスの .ts でファイルがあれば、違反は 0 件", () => {
    expect(
      findExportsViolations(
        BACKEND_EXPORTS,
        {
          "./todo/presentation/*.api": "./todo/presentation/*.api.ts",
          "./shared/infra/env": "./shared/infra/env.ts",
        },
        [
          ref(
            "apps/frontend/app/api/todos/route.ts",
            "@repo/backend/todo/presentation/list-todos.api",
          ),
          ref("apps/e2e/database.ts", "@repo/backend/shared/infra/env"),
          // backend の中の参照（backend-relative-only が見る）と、前方一致だけが同じ別パッケージは数えない。
          ref(
            "apps/backend/todo/infra/x.ts",
            "@repo/backend/todo/infra/container",
          ),
          ref("apps/frontend/app/page.tsx", "@repo/backend-extra/x"),
        ],
        backendFiles,
      ),
    ).toEqual([]);
  });

  it("キーに当たらない参照、使われないキー、キーと違う値、ファイルの無いキーを、それぞれ検出する", () => {
    expect(
      findExportsViolations(
        BACKEND_EXPORTS,
        {
          "./todo/presentation/*.api": "./todo/presentation/*.api.ts",
          "./unused": "./unused.ts",
          "./mismatch": "./todo/presentation/list-todos.api.ts",
          "./object": { import: "./object.ts" },
          "./missing": "./missing.ts",
          "./todo/domain/*": "./todo/domain/*.ts",
        },
        [
          ref(
            "apps/frontend/app/api/todos/route.ts",
            "@repo/backend/todo/presentation/list-todos.api",
          ),
          ref(
            "apps/frontend/features/todo/api/x.ts",
            "@repo/backend/todo/infra/container",
          ),
          ref("apps/e2e/playwright.config.ts", "@repo/backend"),
          ref("apps/e2e/a.ts", "@repo/backend/mismatch"),
          ref("apps/e2e/a.ts", "@repo/backend/object"),
          ref("apps/e2e/a.ts", "@repo/backend/missing"),
          ref("apps/e2e/a.ts", "@repo/backend/todo/domain/todo"),
        ],
        backendFiles,
      ),
    ).toEqual([
      "apps/frontend/features/todo/api/x.ts → @repo/backend/todo/infra/container",
      "apps/e2e/playwright.config.ts → @repo/backend",
      'apps/backend/package.json の exports "./unused" はどこからも参照されていない',
      'apps/backend/package.json の exports "./mismatch" の値 "./todo/presentation/list-todos.api.ts" は、キーのパスに .ts を付けたものではない',
      'apps/backend/package.json の exports "./object" の値 {"import":"./object.ts"} は、キーのパスに .ts を付けたものではない',
      'apps/backend/package.json の exports "./missing" が指すファイルが無い',
      'apps/backend/package.json の exports "./todo/domain/*" が指すファイルが無い',
    ]);
  });

  it('キーが "./" で始まらないものは、値の形の違反にする', () => {
    expect(
      findExportsViolations(
        BACKEND_EXPORTS,
        { "./x": "./x.ts", x: "x.ts" },
        [ref("apps/e2e/a.ts", "@repo/backend/x")],
        ["apps/backend/x.ts"],
      ),
    ).toEqual([
      'apps/backend/package.json の exports "x" はどこからも参照されていない',
      'apps/backend/package.json の exports "x" の値 "x.ts" は、キーのパスに .ts を付けたものではない',
      'apps/backend/package.json の exports "x" が指すファイルが無い',
    ]);
  });
});

describe("apps/shared の exports の違反の検出（findExportsViolations と SHARED_EXPORTS。Issue #90）", () => {
  const ref = (from: string, specifier: string): Reference =>
    toReference(from, { specifier, typeOnly: false });
  const sharedFiles = ["apps/shared/env.ts", "apps/shared/logger.ts"];
  const exports = {
    "./env": "./env.ts",
    "./logger": "./logger.ts",
  };

  it("frontend 直下・backend・apps/e2e/・リポジトリ直下の参照がすべてキーに当たり、すべてのキーが使われていれば、違反は 0 件", () => {
    expect(
      findExportsViolations(
        SHARED_EXPORTS,
        exports,
        [
          ref("apps/frontend/proxy.ts", "@repo/shared/logger"),
          ref("apps/backend/shared/infra/database.ts", "@repo/shared/env"),
          ref("apps/e2e/database.ts", "@repo/shared/env"),
          ref("vitest.global-setup.ts", "@repo/shared/env"),
          // apps/shared の中の参照と、前方一致だけが同じ別パッケージ・@repo/backend の参照は数えない。
          ref("apps/shared/x.ts", "@repo/shared/missing"),
          ref("apps/frontend/app/page.tsx", "@repo/shared-extra/x"),
          ref("apps/e2e/a.ts", "@repo/backend/env"),
        ],
        sharedFiles,
      ),
    ).toEqual([]);
  });

  it("キーに当たらない参照（backend からのものも）、使われないキー、キーと違う値、ファイルの無いキーを検出し、apps/shared/package.json の名前で出す", () => {
    expect(
      findExportsViolations(
        SHARED_EXPORTS,
        {
          ...exports,
          "./unused": "./unused.ts",
          "./mismatch": "./env.ts",
        },
        [
          ref("apps/frontend/proxy.ts", "@repo/shared/logger"),
          ref("apps/backend/shared/infra/database.ts", "@repo/shared/env"),
          ref("apps/backend/shared/infra/database.ts", "@repo/shared/database"),
          ref("apps/e2e/a.ts", "@repo/shared"),
          ref("apps/e2e/a.ts", "@repo/shared/mismatch"),
        ],
        sharedFiles,
      ),
    ).toEqual([
      "apps/backend/shared/infra/database.ts → @repo/shared/database",
      "apps/e2e/a.ts → @repo/shared",
      'apps/shared/package.json の exports "./unused" はどこからも参照されていない',
      'apps/shared/package.json の exports "./unused" が指すファイルが無い',
      'apps/shared/package.json の exports "./mismatch" の値 "./env.ts" は、キーのパスに .ts を付けたものではない',
      'apps/shared/package.json の exports "./mismatch" が指すファイルが無い',
    ]);
  });
});

// --- 抽出 → 正規化 → 判定を通した fixture テスト ---
// 上の「規則ごとの判定」は、正規化済みの参照 1 件を規則に渡すだけで、ファイルの列挙・import の抽出・相対パスの解決を
// 通らない。抽出の取りこぼし（書き方によって import を拾えない）は、規則が正しくても違反の見逃しになる。
// 一時ディレクトリに架空のツリーを作って実ファイルを置き、本番と同じ collectViolations に通して、検出される違反の
// 集合を丸ごと比較する（余分な検出も見逃しも失敗にする）。規則を足す・変えるときは、ここの must-reject / must-pass も直す。

const lines = (...source: string[]) => source.join("\n");

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
// apps/shared の規則（Issue #90。frontend-to-shared-specifier・screen-to-shared・SHARED_PLACEMENT・SHARED_EXPORTS と、層の規則の
// apps/shared の許可 SHARED_MODULES_BY_LAYER）の違反も置く。
// 規則は全部で 26（RULES の 19 + 置き場所 3 + 環境変数の直参照 + console + exports 2）。Issue #68 で RULES に 3 規則（backend-to-frontend・
// backend-relative-only・frontend-root-to-backend）を足し、段階 2 で frontend-to-backend-specifier と BACKEND_EXPORTS を足した。
// Issue #90 で frontend-to-shared-specifier・screen-to-shared・SHARED_PLACEMENT・SHARED_EXPORTS を足した。
const MUST_REJECT_FILES: Record<string, string> = {
  // screen-to-backend: apps/frontend/features/<f>/ の api/ 以外から backend への参照は、型でも相対でも違反。
  "apps/frontend/features/todo/components/bad-backend.ts": lines(
    'import { GET } from "@repo/backend/todo/presentation/list-todos.api";',
    'import type { Todo } from "../../../../backend/todo/domain/todo";',
    'import { type GetTodoResponse } from "@repo/backend/todo/presentation/get-todo.api";',
    'import * as updateApi from "@repo/backend/todo/presentation/update-todo.api";',
    'import deleteApi from "../../../../backend/todo/presentation/delete-todo.api";',
    'export { POST } from "@repo/backend/todo/presentation/create-todo.api";',
    'export type { ErrorResponse } from "@repo/backend/shared/presentation/http-error";',
    // セミコロンの無い文の直後の複数行の import type も拾う。
    "export enum Kind { A }",
    "import type {",
    "  TodoContainer,",
    '} from "@repo/backend/todo/infra/container";',
    'const lazy = import("../../../../backend/shared/presentation/json-body");',
  ),
  // screen-to-backend / shared-to-features / screen-to-app: 画面側の shared/ から。
  "apps/frontend/shared/bad-shared.tsx": lines(
    'import { GET } from "../../backend/todo/presentation/list-todos.api";',
    'import type { DomainError } from "@repo/backend/shared/domain/domain-error";',
    'import { TodoScreen } from "@/features/todo";',
    'import type { TodoDto } from "../features/todo/api/todo-api";',
    'export { TodoItem } from "@/features/todo/components/todo-item";',
    'export { default } from "@/app/page";',
    'const layout = import("../app/layout");',
  ),
  // feature-api-to-backend: 値の参照、presentation 以外、他 feature、.api でないファイル、inline type の混在。
  "apps/frontend/features/todo/api/bad-api.ts": lines(
    'import { listTodosApi } from "@repo/backend/todo/presentation/list-todos.api";',
    'import type { Todo } from "../../../../backend/todo/domain/todo";',
    'import type { ListOthersResponse } from "@repo/backend/other/presentation/list-others.api";',
    'import { type TodoDto, GET } from "@repo/backend/todo/presentation/get-todo.api";',
    'export { toErrorResponse } from "../../../../backend/shared/presentation/http-error";',
    'import type { X } from "@repo/backend/todo/presentation/list-todos";',
    'import type { DomainError } from "@repo/backend/shared/domain/domain-error";',
    'const m = import("@repo/backend/todo/presentation/update-todo.api");',
  ),
  // feature-to-feature: 別 feature の深いパスは、型でも re-export でも dynamic でも違反。
  "apps/frontend/features/other/components/bad-feature.js": lines(
    'import { TodoItem } from "@/features/todo/components/todo-item";',
    'import { useTodoScreen } from "../../todo/screens/todo-screen/todo-screen.hook";',
    'export { fetchTodos } from "@/features/todo/api/todo-api";',
    'import type { TodoDto } from "../../todo/api/todo-api";',
    'const c = import("@/features/todo/components");',
  ),
  // feature-to-feature: 名前の前方一致だけが同じ別 feature（todo と todo-extra）を同じ feature と誤認しない。
  "apps/frontend/features/todo/components/bad-prefix.jsx": lines(
    'import { X } from "@/features/todo-extra/components/x";',
  ),
  // screen-to-app
  "apps/frontend/features/todo/screens/s/bad-app.tsx": lines(
    'import Page from "@/app/page";',
    'import { GET } from "../../../../app/api/todos/route";',
    'export type { Metadata } from "@/app/layout";',
  ),
  // domain: フレームワークのサブパス、自 feature の外側の層、他 feature の domain、shared の presentation、画面側。
  "apps/backend/todo/domain/bad-domain.ts": lines(
    'import { NextResponse } from "next/server";',
    'import { jsx } from "react/jsx-runtime";',
    'import { createRoot } from "react-dom/client";',
    'import { CreateTodoCommand } from "../application/create-todo.command";',
    'import type { TodoContainer } from "../infra/container";',
    'import type { TodoDto } from "../presentation/list-todos.api";',
    'import type { Other } from "../../other/domain/other";',
    'import { toErrorResponse } from "../../shared/presentation/http-error";',
    'export type { TodoDto as Dto } from "@/features/todo";',
    'const s = import("@/shared/x");',
    'import "@/app/globals.css";',
  ),
  // domain: backend/shared/domain から backend/shared/presentation（shared の中でも向きが逆）。
  "apps/backend/shared/domain/bad-shared-domain.ts": lines(
    'import { InvalidRequestError } from "../presentation/http-error";',
  ),
  // application
  "apps/backend/todo/application/bad-application.ts": lines(
    'import { todoContainer } from "../infra/container";',
    'import type { TodoDto } from "../presentation/list-todos.api";',
    'import { InvalidRequestError } from "../../shared/presentation/http-error";',
    'import { useState } from "react";',
    'import { notFound } from "next/navigation";',
    'import { flushSync } from "react-dom";',
    'export { TodoItem } from "@/features/todo/components/todo-item";',
    'const r = import("../../../frontend/app/page");',
  ),
  // presentation: container 以外の infra（名前が container で始まる別ファイルも）、domain の値の参照（inline type の混在、
  //   re-export）、フレームワーク、画面側、他 feature の infra。
  "apps/backend/todo/presentation/bad-presentation.api.ts": lines(
    'import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";',
    'import { helper } from "../infra/container-helper";',
    'import { Todo } from "../domain/todo";',
    'import { TodoFactory, type TodoId } from "../domain/todo-factory";',
    'export { Todo as Entity } from "../domain/todo-entity";',
    'import { NextResponse } from "next/server";',
    'import { cache } from "react";',
    'export type { TodoDto } from "@/features/todo/api/todo-api";',
    'const c = import("../../other/infra/other-repository.in-memory");',
    'import "../../../frontend/app/globals.css";',
  ),
  // infra
  "apps/backend/todo/infra/bad-infra.ts": lines(
    'import { listTodosApi } from "../presentation/list-todos.api";',
    'import type { GetTodoResponse } from "../presentation/get-todo.api";',
    'import type { Other } from "../../other/domain/other";',
    'import { OtherQuery } from "../../other/application/other.query";',
    'import { TodoScreen } from "@/features/todo";',
    'import { x } from "@/shared/x";',
    'export { default } from "../../../frontend/app/page";',
    'import { headers } from "next/headers";',
    'import { renderToString } from "react-dom/server";',
    'const c = import("../../other/infra/container");',
  ),
  // backend-shared（presentation 層のファイルなので presentation の規則にも同時にかかるものがある）
  "apps/backend/shared/presentation/bad-backend-shared.ts": lines(
    'import type { Todo } from "../../todo/domain/todo";',
    'import { todoContainer } from "../../todo/infra/container";',
    'import { TodoFactory } from "../../todo/domain/todo-factory";',
    'export { TodoScreen } from "@/features/todo";',
    'const p = import("@/app/page");',
    'import "../../todo/infra/todo-repository.in-memory";',
  ),
  // application: 他 feature の domain / application、画面側の shared/。
  "apps/backend/todo/application/bad-application-2.ts": lines(
    'import type { Other } from "../../other/domain/other";',
    'import { x } from "../../../frontend/shared/x";',
    'export { OtherQuery } from "../../other/application/other.query";',
  ),
  // presentation: 他 feature の container / application / domain は import type でも違反。画面側の shared/。
  "apps/backend/todo/presentation/bad-presentation-2.api.ts": lines(
    'import type { OtherContainer } from "../../other/infra/container";',
    'import type { OtherQuery } from "../../other/application/other.query";',
    'import type { Other } from "../../other/domain/other";',
    'import { x } from "@/shared/x";',
  ),
  // domain / backend-shared: backend/shared から画面側の shared/。
  "apps/backend/shared/domain/bad-shared-screen.ts": lines(
    'import { x } from "@/shared/x";',
  ),
  // backend-placement: apps/backend/<x>/ の 4 層の外のファイル（import の有無に関係なく違反）。
  "apps/backend/todo/p-root.ts": lines('import { x } from "@/shared/x";'),
  "apps/backend/todo/lib/x.ts": lines("export const x = 1;"),
  "apps/backend/x.ts": lines("export const x = 1;"),
  // 前方一致の境界: backend/shared-x は backend/shared ではなく shared-x という feature。
  "apps/backend/shared-x/domain/x.ts": lines(
    'import { TodoScreen } from "@/features/todo";',
  ),
  // 前方一致の境界: app/api-x は app/api ではない（app の規則がかかる）。
  "apps/frontend/app/api-x/route.ts": lines(
    'export { GET } from "@repo/backend/todo/presentation/list-todos.api";',
  ),
  // パスに test を含むがテストファイルではない本番のファイル。
  "apps/frontend/features/todo/components/test-helper.tsx": lines(
    'import { Todo } from "@repo/backend/todo/domain/todo";',
  ),
  // 拡張子 .mts / .cts / .mjs / .cjs と、テンプレートリテラル・第 2 引数つきの dynamic import。
  "apps/frontend/features/todo/components/bad-ext.mts": lines(
    "const a = import(`@repo/backend/todo/domain/todo`);",
    'const b = import("@repo/backend/todo/infra/container", { with: { type: "json" } });',
  ),
  "apps/frontend/features/todo/components/bad-ext.cts": lines(
    'import { GET } from "@repo/backend/todo/presentation/get-todo.api";',
  ),
  "apps/frontend/features/todo/components/bad-ext.mjs": lines(
    'export { x } from "../../../../backend/shared/presentation/http-error";',
  ),
  "apps/frontend/features/todo/components/bad-ext.cjs": lines(
    'import "@repo/backend/todo/infra/todo-repository.in-memory";',
  ),
  // backend-shared / backend-placement: 層に属さない backend/shared 直下のファイルから。
  "apps/backend/shared/bad-root.ts": lines(
    'import { CreateTodoCommand } from "../todo/application/create-todo.command";',
  ),
  // app
  "apps/frontend/app/bad-page.tsx": lines(
    'import { TodoItem } from "@/features/todo/components/todo-item";',
    'import { useTodoScreen } from "../features/todo/screens/todo-screen/todo-screen.hook";',
    'import type { TodoDto } from "@repo/backend/todo/presentation/list-todos.api";',
    'export { GET } from "../../backend/todo/presentation/get-todo.api";',
    'const x = import("@/features/todo/api/todo-api");',
    'import { Y } from "@/features/todo-extra/components/y";',
  ),
  "apps/frontend/app/todo/[id]/bad.jsx": lines(
    'import { TodoItem } from "../../../features/todo/components/todo-item";',
  ),
  // app-api: api ファイル以外（.api の付かない presentation、shared の presentation を含む）、パッケージ、画面側。
  "apps/frontend/app/api/todos/bad-route.ts": lines(
    'export { GET } from "@repo/backend/todo/infra/container";',
    'export { POST } from "../../../../backend/todo/application/create-todo.command";',
    'import { NextResponse } from "next/server";',
    'import { TodoScreen } from "@/features/todo";',
    'export { PUT } from "@repo/backend/todo/presentation/update-todo";',
    'export { DELETE } from "@repo/backend/shared/presentation/http-error";',
    'const x = import("@/shared/x");',
  ),
  // Issue #57: backend/shared/infra（プール・Drizzle）と feature の infra（スキーマ・Postgres の実装）への参照。
  //   infra は domain / application / presentation（自 feature の container 以外）から参照できない。
  "apps/backend/todo/domain/bad-domain-infra.ts": lines(
    'import type { Executor } from "../../shared/infra/database";',
    'import type { DrizzleTransactionRunner } from "../../shared/infra/drizzle-transaction-runner";',
  ),
  "apps/backend/shared/domain/bad-shared-domain-infra.ts": lines(
    'import type { Executor } from "../infra/database";',
  ),
  "apps/backend/todo/application/bad-application-infra.ts": lines(
    'import { getDatabase } from "../../shared/infra/database";',
  ),
  "apps/backend/todo/presentation/bad-presentation-infra.api.ts": lines(
    'import { getDatabase } from "../../shared/infra/database";',
    'import { todos } from "../infra/schema";',
    'import { PostgresTodoRepository } from "../infra/todo-repository.postgres";',
  ),
  // core-to-persistence: domain / application から DB のパッケージ（drizzle-orm とそのサブパス、pg）。型だけの参照・re-export・
  //   dynamic import も違反。名前の前方一致だけが同じ別パッケージ（pg-format）は対象外。
  "apps/backend/todo/domain/bad-domain-db.ts": lines(
    'import type { PgTable } from "drizzle-orm/pg-core";',
    'import { eq } from "drizzle-orm";',
    'import type { Pool } from "pg";',
    'import format from "pg-format";',
  ),
  "apps/backend/todo/application/bad-application-db.command.ts": lines(
    'import { sql } from "drizzle-orm";',
    'const lazy = import("drizzle-orm/node-postgres");',
    'export type { PoolConfig } from "pg";',
  ),
  "apps/backend/shared/domain/bad-shared-domain-db.ts": lines(
    'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
  ),
  //   backend/shared/infra は feature の infra を参照できず、next も参照できない。backend/shared/presentation も参照できない（infra の規則）。
  "apps/backend/shared/infra/bad-shared-infra.ts": lines(
    'import { todos } from "../../todo/infra/schema";',
    'import { NextResponse } from "next/server";',
    'import { toErrorResponse } from "../presentation/http-error";',
  ),
  // env-direct-access: env.ts 以外で process.env を読む。書き方ごとに 1 行ずつ置き、行番号で検出を比べる。
  //   コメント・文字列の中（7・8 行目）は拾わない。
  "apps/backend/todo/infra/bad-env.ts": lines(
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
  "apps/frontend/instrumentation.ts": lines(
    'if (process.env.NEXT_RUNTIME === "nodejs") {}',
    "export const url = process.env.DATABASE_URL;",
  ),
  //   apps/e2e/ とルート直下の設定ファイル（.ts / .mjs / .cjs）、env.ts と名前の前方一致だけが同じ別ファイル。
  "apps/e2e/bad-env.ts": lines("export const url = process.env.DATABASE_URL;"),
  "bad.config.ts": lines("export const ci = !process['env'].CI;"),
  "bad.config.mjs": lines("export default { ci: process.env.CI };"),
  "bad.config.cjs": lines("module.exports = process . env;"),
  "apps/backend/shared/infra/env-helper.ts": lines(
    "export const e = process.env;",
  ),
  // console-direct-access（Issue #85）: logger.ts 以外で console を書く。書き方ごとに 1 行ずつ置き、行番号で検出を比べる。
  //   コメント・文字列の中（6・7 行目）は拾わない。別名に入れる（8 行目）のも違反。
  "apps/backend/todo/presentation/bad-console.api.ts": lines(
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
  "apps/frontend/features/todo/components/bad-console.tsx": lines(
    "export const C = () => { console.log(1); return null; };",
  ),
  "apps/e2e/bad-console.spec.ts": lines("console.log(line);"),
  "scripts/bad-console.ts": lines("console.log(1);"),
  "bad-console.config.mjs": lines("console.log(1);"),
  "apps/backend/shared/infra/logger-helper.ts": lines(
    "export const l = () => console.log(1);",
  ),
  // Issue #68: backend-relative-only。層の規則では許される参照先（自 feature の domain・application、backend/shared）でも、
  //   "@repo/backend/" で書くと違反。import type・re-export・dynamic import・パッケージ名だけの import も同じ。
  //   パッケージ名だけの "@repo/backend" は apps/backend 直下を指し、層に属さないので application の規則にもかかる。
  "apps/backend/todo/application/bad-alias.command.ts": lines(
    'import { Todo } from "@repo/backend/todo/domain/todo";',
    'import type { TodoRepository } from "@repo/backend/todo/domain/todo-repository";',
    'export { DomainError } from "@repo/backend/shared/domain/domain-error";',
    'const q = import("@repo/backend/todo/application/list-todos.query");',
    'import "@repo/backend";',
  ),
  // backend-to-frontend: 層に属さない apps/backend 直下の設定ファイルから frontend（相対パスと "@/"）。
  //   置き場所の規則の例外（<name>.config.ts）なので、置き場所の違反にはならない。
  "apps/backend/bad.config.ts": lines(
    'import nextConfig from "../frontend/next.config";',
    'import type { TodoDto } from "@/features/todo/api/todo-api";',
    'export { TodoScreen } from "../frontend/features/todo";',
  ),
  // backend-placement: <name>.config.ts の例外は apps/backend 直下だけ。feature の直下に置くと違反。
  "apps/backend/todo/drizzle.config.ts": lines("export default {};"),
  // frontend-root-to-backend: apps/frontend 直下のファイルから、env 以外の backend（alias と相対、型、re-export、dynamic、
  //   名前の前方一致だけが同じ env-helper）。
  // 置き場所の規則（frontend-placement）で許される名前（next.config.ts）に置き、frontend-root-to-backend だけを確かめる。
  "apps/frontend/next.config.ts": lines(
    'import { todoContainer } from "@repo/backend/todo/infra/container";',
    'import type { Executor } from "../backend/shared/infra/database";',
    'export { GET } from "@repo/backend/todo/presentation/list-todos.api";',
    'const e = import("@repo/backend/shared/infra/env-helper");',
  ),
  // frontend-placement（reviewer 指摘。Issue #68）: apps/frontend の app/・features/・shared/ の外と、直下の許可された名前
  //   以外のファイル。lib/ のファイルはどの依存の規則もかからないので、backend の container を値で import しても置き場所の
  //   違反だけが出る（置き場所の規則が無いと 0 件で素通りしていた）。"." で始まるディレクトリも検査する。
  "apps/frontend/lib/db.ts": lines(
    'import { todoContainer } from "@repo/backend/todo/infra/container";',
    "export const db = todoContainer;",
  ),
  "apps/frontend/.lib/x.ts": lines("export const x = 1;"),
  "apps/frontend/next.config.mjs": lines("export default {};"),
  // backend-placement: "." で始まるディレクトリ（apps/backend/.lib/）も検査し、4 層の外として違反にする（除外するのは
  //   node_modules と .next だけ）。"@/" で frontend を参照しているので、backend-to-frontend と backend-relative-only にもかかる。
  "apps/backend/.lib/x.ts": lines(
    'import { TodoScreen } from "@/features/todo";',
  ),
  // frontend-to-backend-specifier（Issue #68 の段階 2）: 参照先はほかの規則で許される（自 feature の api ファイルの型、
  //   app/api からの api ファイル、直下からの env）が、相対パスや "@/../backend/" で書いたもの。この規則だけにかかる。
  //   apps/e2e/ とリポジトリ直下のファイル（.ts / .mts）からの相対パスも同じ。
  "apps/frontend/features/todo/api/bad-specifier.ts": lines(
    'import type { TodoDto } from "../../../../backend/todo/presentation/list-todos.api";',
    'export type { GetTodoResponse } from "@/../backend/todo/presentation/get-todo.api";',
  ),
  "apps/frontend/app/api/todos/[id]/bad-relative.ts": lines(
    'export { PUT } from "../../../../../backend/todo/presentation/update-todo.api";',
  ),
  "apps/frontend/instrumentation-node.ts": lines(
    'const env = import("../backend/shared/infra/env");',
  ),
  "apps/e2e/bad-relative.ts": lines(
    'import { env } from "../backend/shared/infra/env";',
  ),
  // 例外（vitest.global-setup.ts → database.test-support の相対パス）は名前まで一致したときだけ。.mts の別ファイルは違反。
  "vitest.global-setup.mts": lines(
    'import { cleanupTestSchemas } from "./apps/backend/shared/infra/database.test-support";',
  ),
  // vitest.global-setup.ts でも、test-support 以外（env）を相対パスで参照するのは違反（test-support の相対参照は許される）。
  "vitest.global-setup.ts": lines(
    'import { cleanupTestSchemas } from "./apps/backend/shared/infra/database.test-support";',
    'import { env } from "./apps/backend/shared/infra/env";',
  ),
  // backend-exports（Issue #68 の段階 2）: exports の過不足。
  //   "./todo/presentation/*.api" は上の fixture の *.api への参照で使われ、bad-presentation.api.ts などに当たる（違反なし）。
  //   "./shared/presentation/http-error" は使われるが、指すファイルが無い。"./todo/domain/bad-domain" は使われない。
  //   "./mismatch" は使われるが、値が別のファイル（キーのパスのファイルも無い）。
  //   exports に無い参照（上の fixture の container・domain など）は、参照ごとに違反になる（下の MUST_REJECT_VIOLATIONS）。
  "apps/backend/package.json": JSON.stringify({
    name: "@repo/backend",
    exports: {
      "./todo/presentation/*.api": "./todo/presentation/*.api.ts",
      "./shared/presentation/http-error": "./shared/presentation/http-error.ts",
      "./todo/domain/bad-domain": "./todo/domain/bad-domain.ts",
      "./mismatch": "./todo/domain/bad-domain.ts",
    },
  }),
  "apps/e2e/bad-exports.ts": lines(
    'import { x } from "@repo/backend/mismatch";',
    'import { todoContainer } from "@repo/backend/todo/infra/container";',
    'import { env } from "@repo/backend";',
  ),
  // Issue #90: apps/shared（@repo/shared）。
  // screen-to-shared: 画面側（features/・app/・shared/）から apps/shared は、alias でも相対パスでも、型でも dynamic でも違反。
  //   相対パスのものは frontend-to-shared-specifier にもかかる。"@repo/shared/logger" は fixture の exports に無いので
  //   shared-exports にもかかる。
  "apps/frontend/features/todo/components/bad-shared-base.tsx": lines(
    'import { logger } from "@repo/shared/logger";',
    'import type { Env } from "@repo/shared/env";',
    'const e = import("../../../../shared/env");',
  ),
  "apps/frontend/app/bad-shared-page.tsx": lines(
    'import { env } from "@repo/shared/env";',
  ),
  "apps/frontend/shared/bad-shared-base.ts": lines(
    'export { logger } from "@repo/shared/mismatch";',
  ),
  // frontend-to-shared-specifier: frontend 直下・apps/e2e/・リポジトリ直下から相対パス・"@/../shared/" で apps/shared を指す。
  //   参照先は許される（直下のサーバ側のファイルの env・logger）ので、この規則だけにかかる。
  "apps/frontend/proxy.ts": lines(
    'import { logger } from "../shared/logger";',
    'import { env } from "@/../shared/env";',
  ),
  "apps/e2e/bad-shared.ts": lines('import { env } from "../shared/env";'),
  "bad-shared.config.mts": lines('import { env } from "./apps/shared/env";'),
  // shared-placement: 決めた名前以外のファイル（ソース・Markdown・テストだけのもの・入れ子のディレクトリの中）。
  //   入れ子の lib/logger.ts は例外の apps/shared/logger.ts ではないので、process.env と console も違反。
  "apps/shared/extra.ts": lines("export const x = 1;"),
  "apps/shared/README.md": "# shared",
  "apps/shared/lib/logger.ts": lines("console.log(process.env.X);"),
  "apps/shared/extra.test.ts": lines("console.log(1);"),
  // 例外の env.ts（process.env を読んでも違反にならない）と、shared-exports の違反を置いた package.json。
  //   "./env" は上の参照で使われ、ファイルもある（違反なし）。"./mismatch" は使われるが、値が別のファイルでキーのファイルも無い。
  //   "./unused" は使われず、ファイルも無い。
  "apps/shared/env.ts": lines("export const env = process.env;"),
  "apps/shared/package.json": JSON.stringify({
    name: "@repo/shared",
    exports: {
      "./env": "./env.ts",
      "./mismatch": "./env.ts",
      "./unused": "./unused.ts",
    },
  }),
  // 層の規則の apps/shared の許可（SHARED_MODULES_BY_LAYER）: domain / application は使えない、presentation は logger だけ
  //   （移す前の backend/shared/infra/logger も、もう使えない）、infra は env・logger だけ。
  "apps/backend/todo/domain/bad-domain-shared.ts": lines(
    'import { logger } from "@repo/shared/logger";',
  ),
  "apps/backend/todo/application/bad-application-shared.command.ts": lines(
    'import { env } from "../../../shared/env";',
  ),
  "apps/backend/todo/presentation/bad-presentation-shared.api.ts": lines(
    'import { env } from "@repo/shared/env";',
    'import { logger } from "../../shared/infra/logger";',
  ),
  //   backend-relative-only: "@/" と相対パスで apps/shared を指すのは違反（"@repo/shared/..." だけを許す。Issue #90）。
  //   logger は infra で使ってよいので、相対パスの行は backend-relative-only だけにかかる。
  "apps/backend/shared/infra/bad-shared-infra-base.ts": lines(
    'import { helper } from "@repo/shared/env-helper";',
    'import { env } from "@/../shared/env";',
    'import { logger } from "../../../shared/logger";',
  ),
};

const MUST_REJECT_VIOLATIONS = [
  "frontend-placement: apps/frontend/lib/db.ts",
  "frontend-placement: apps/frontend/.lib/x.ts",
  "frontend-placement: apps/frontend/next.config.mjs",
  "backend-placement: apps/backend/.lib/x.ts",
  "backend-to-frontend: apps/backend/.lib/x.ts → apps/frontend/features/todo",
  "backend-relative-only: apps/backend/.lib/x.ts → apps/frontend/features/todo",
  // Issue #68: 新しい 3 規則のための fixture（上の最後の 4 ファイル）。
  ...[
    "apps/backend/todo/domain/todo",
    "apps/backend/todo/domain/todo-repository",
    "apps/backend/shared/domain/domain-error",
    "apps/backend/todo/application/list-todos.query",
    "apps/backend",
  ].map(
    (to) =>
      `backend-relative-only: apps/backend/todo/application/bad-alias.command.ts → ${to}`,
  ),
  "application: apps/backend/todo/application/bad-alias.command.ts → apps/backend",
  ...[
    "apps/frontend/next.config",
    "apps/frontend/features/todo/api/todo-api",
    "apps/frontend/features/todo",
  ].map((to) => `backend-to-frontend: apps/backend/bad.config.ts → ${to}`),
  "backend-relative-only: apps/backend/bad.config.ts → apps/frontend/features/todo/api/todo-api",
  "backend-placement: apps/backend/todo/drizzle.config.ts",
  ...[
    "apps/backend/todo/infra/container",
    "apps/backend/shared/infra/database",
    "apps/backend/todo/presentation/list-todos.api",
    "apps/backend/shared/infra/env-helper",
  ].map(
    (to) => `frontend-root-to-backend: apps/frontend/next.config.ts → ${to}`,
  ),
  // Issue #90 で frontend-root-to-backend の例外（backend/shared/infra の env・logger）を無くしたので、相対パスの env も違反。
  "frontend-root-to-backend: apps/frontend/instrumentation-node.ts → apps/backend/shared/infra/env",
  // Issue #90: apps/shared の規則。
  ...[
    "apps/frontend/features/todo/components/bad-shared-base.tsx → apps/shared/logger",
    "apps/frontend/features/todo/components/bad-shared-base.tsx → apps/shared/env",
    "apps/frontend/features/todo/components/bad-shared-base.tsx → apps/shared/env",
    "apps/frontend/app/bad-shared-page.tsx → apps/shared/env",
    "apps/frontend/shared/bad-shared-base.ts → apps/shared/mismatch",
  ].map((line) => `screen-to-shared: ${line}`),
  ...[
    "apps/frontend/features/todo/components/bad-shared-base.tsx → apps/shared/env",
    "apps/frontend/proxy.ts → apps/shared/logger",
    "apps/frontend/proxy.ts → apps/shared/env",
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
  "console-direct-access: apps/shared/lib/logger.ts:1",
  "domain: apps/backend/todo/domain/bad-domain-shared.ts → apps/shared/logger",
  "application: apps/backend/todo/application/bad-application-shared.command.ts → apps/shared/env",
  "presentation: apps/backend/todo/presentation/bad-presentation-shared.api.ts → apps/shared/env",
  "presentation: apps/backend/todo/presentation/bad-presentation-shared.api.ts → apps/backend/shared/infra/logger",
  "infra: apps/backend/shared/infra/bad-shared-infra-base.ts → apps/shared/env-helper",
  "backend-relative-only: apps/backend/shared/infra/bad-shared-infra-base.ts → apps/shared/env",
  "backend-relative-only: apps/backend/shared/infra/bad-shared-infra-base.ts → apps/shared/logger",
  "backend-relative-only: apps/backend/todo/application/bad-application-shared.command.ts → apps/shared/env",
  ...[
    "apps/frontend/features/todo/components/bad-shared-base.tsx → @repo/shared/logger",
    "apps/backend/todo/domain/bad-domain-shared.ts → @repo/shared/logger",
    "apps/backend/shared/infra/bad-shared-infra-base.ts → @repo/shared/env-helper",
    'apps/shared/package.json の exports "./mismatch" の値 "./env.ts" は、キーのパスに .ts を付けたものではない',
    'apps/shared/package.json の exports "./mismatch" が指すファイルが無い',
    'apps/shared/package.json の exports "./unused" はどこからも参照されていない',
    'apps/shared/package.json の exports "./unused" が指すファイルが無い',
  ].map((line) => `shared-exports: ${line}`),
  // Issue #68: 既存の fixture のうち、backend から画面側（features / shared / app）を参照している行は、層の規則に加えて
  //   backend-to-frontend にかかる。"@/" で書いたものは backend-relative-only にもかかる（相対パスで書いたものはかからない）。
  ...[
    "apps/backend/shared-x/domain/x.ts → apps/frontend/features/todo",
    "apps/backend/shared/domain/bad-shared-screen.ts → apps/frontend/shared/x",
    "apps/backend/shared/presentation/bad-backend-shared.ts → apps/frontend/app/page",
    "apps/backend/shared/presentation/bad-backend-shared.ts → apps/frontend/features/todo",
    "apps/backend/todo/application/bad-application.ts → apps/frontend/features/todo/components/todo-item",
    "apps/backend/todo/domain/bad-domain.ts → apps/frontend/app/globals.css",
    "apps/backend/todo/domain/bad-domain.ts → apps/frontend/features/todo",
    "apps/backend/todo/domain/bad-domain.ts → apps/frontend/shared/x",
    "apps/backend/todo/infra/bad-infra.ts → apps/frontend/features/todo",
    "apps/backend/todo/infra/bad-infra.ts → apps/frontend/shared/x",
    "apps/backend/todo/p-root.ts → apps/frontend/shared/x",
    "apps/backend/todo/presentation/bad-presentation-2.api.ts → apps/frontend/shared/x",
    "apps/backend/todo/presentation/bad-presentation.api.ts → apps/frontend/features/todo/api/todo-api",
  ].flatMap((line) => [
    `backend-to-frontend: ${line}`,
    `backend-relative-only: ${line}`,
  ]),
  ...[
    "apps/backend/todo/application/bad-application-2.ts → apps/frontend/shared/x",
    "apps/backend/todo/application/bad-application.ts → apps/frontend/app/page",
    "apps/backend/todo/infra/bad-infra.ts → apps/frontend/app/page",
    "apps/backend/todo/presentation/bad-presentation.api.ts → apps/frontend/app/globals.css",
  ].map((line) => `backend-to-frontend: ${line}`),
  "env-direct-access: apps/frontend/instrumentation.ts:2",
  ...[1, 2, 4, 5, 6, 9, 10].map(
    (line) => `env-direct-access: apps/backend/todo/infra/bad-env.ts:${line}`,
  ),
  "env-direct-access: apps/e2e/bad-env.ts:1",
  "env-direct-access: bad.config.ts:1",
  "env-direct-access: bad.config.mjs:1",
  "env-direct-access: bad.config.cjs:1",
  "env-direct-access: apps/backend/shared/infra/env-helper.ts:1",
  ...[1, 2, 3, 4, 5, 8, 9].map(
    (line) =>
      `console-direct-access: apps/backend/todo/presentation/bad-console.api.ts:${line}`,
  ),
  "console-direct-access: apps/frontend/features/todo/components/bad-console.tsx:1",
  "console-direct-access: apps/e2e/bad-console.spec.ts:1",
  "console-direct-access: scripts/bad-console.ts:1",
  "console-direct-access: bad-console.config.mjs:1",
  "console-direct-access: apps/backend/shared/infra/logger-helper.ts:1",
  ...[
    "apps/backend/todo/presentation/list-todos.api",
    "apps/backend/todo/domain/todo",
    "apps/backend/todo/presentation/get-todo.api",
    "apps/backend/todo/presentation/update-todo.api",
    "apps/backend/todo/presentation/delete-todo.api",
    "apps/backend/todo/presentation/create-todo.api",
    "apps/backend/shared/presentation/http-error",
    "apps/backend/todo/infra/container",
    "apps/backend/shared/presentation/json-body",
  ].map(
    (to) =>
      `screen-to-backend: apps/frontend/features/todo/components/bad-backend.ts → ${to}`,
  ),
  "screen-to-backend: apps/frontend/shared/bad-shared.tsx → apps/backend/todo/presentation/list-todos.api",
  "screen-to-backend: apps/frontend/shared/bad-shared.tsx → apps/backend/shared/domain/domain-error",
  "shared-to-features: apps/frontend/shared/bad-shared.tsx → apps/frontend/features/todo",
  "shared-to-features: apps/frontend/shared/bad-shared.tsx → apps/frontend/features/todo/api/todo-api",
  "shared-to-features: apps/frontend/shared/bad-shared.tsx → apps/frontend/features/todo/components/todo-item",
  "screen-to-app: apps/frontend/shared/bad-shared.tsx → apps/frontend/app/page",
  "screen-to-app: apps/frontend/shared/bad-shared.tsx → apps/frontend/app/layout",
  ...[
    "apps/backend/todo/presentation/list-todos.api",
    "apps/backend/todo/domain/todo",
    "apps/backend/other/presentation/list-others.api",
    "apps/backend/todo/presentation/get-todo.api",
    "apps/backend/shared/presentation/http-error",
    "apps/backend/todo/presentation/list-todos",
    "apps/backend/shared/domain/domain-error",
    "apps/backend/todo/presentation/update-todo.api",
  ].map(
    (to) =>
      `feature-api-to-backend: apps/frontend/features/todo/api/bad-api.ts → ${to}`,
  ),
  ...[
    "apps/frontend/features/todo/components/todo-item",
    "apps/frontend/features/todo/screens/todo-screen/todo-screen.hook",
    "apps/frontend/features/todo/api/todo-api",
    "apps/frontend/features/todo/api/todo-api",
    "apps/frontend/features/todo/components",
  ].map(
    (to) =>
      `feature-to-feature: apps/frontend/features/other/components/bad-feature.js → ${to}`,
  ),
  "feature-to-feature: apps/frontend/features/todo/components/bad-prefix.jsx → apps/frontend/features/todo-extra/components/x",
  "screen-to-app: apps/frontend/features/todo/screens/s/bad-app.tsx → apps/frontend/app/page",
  "screen-to-app: apps/frontend/features/todo/screens/s/bad-app.tsx → apps/frontend/app/api/todos/route",
  "screen-to-app: apps/frontend/features/todo/screens/s/bad-app.tsx → apps/frontend/app/layout",
  ...[
    "next/server",
    "react/jsx-runtime",
    "react-dom/client",
    "apps/backend/todo/application/create-todo.command",
    "apps/backend/todo/infra/container",
    "apps/backend/todo/presentation/list-todos.api",
    "apps/backend/other/domain/other",
    "apps/backend/shared/presentation/http-error",
    "apps/frontend/features/todo",
    "apps/frontend/shared/x",
    "apps/frontend/app/globals.css",
  ].map((to) => `domain: apps/backend/todo/domain/bad-domain.ts → ${to}`),
  "domain: apps/backend/shared/domain/bad-shared-domain.ts → apps/backend/shared/presentation/http-error",
  ...[
    "apps/backend/todo/infra/container",
    "apps/backend/todo/presentation/list-todos.api",
    "apps/backend/shared/presentation/http-error",
    "react",
    "next/navigation",
    "react-dom",
    "apps/frontend/features/todo/components/todo-item",
    "apps/frontend/app/page",
  ].map(
    (to) =>
      `application: apps/backend/todo/application/bad-application.ts → ${to}`,
  ),
  ...[
    "apps/backend/todo/infra/todo-repository.in-memory",
    "apps/backend/todo/infra/container-helper",
    "apps/backend/todo/domain/todo",
    "apps/backend/todo/domain/todo-factory",
    "apps/backend/todo/domain/todo-entity",
    "next/server",
    "react",
    "apps/frontend/features/todo/api/todo-api",
    "apps/backend/other/infra/other-repository.in-memory",
    "apps/frontend/app/globals.css",
  ].map(
    (to) =>
      `presentation: apps/backend/todo/presentation/bad-presentation.api.ts → ${to}`,
  ),
  ...[
    "apps/backend/todo/presentation/list-todos.api",
    "apps/backend/todo/presentation/get-todo.api",
    "apps/backend/other/domain/other",
    "apps/backend/other/application/other.query",
    "apps/frontend/features/todo",
    "apps/frontend/shared/x",
    "apps/frontend/app/page",
    "next/headers",
    "react-dom/server",
    "apps/backend/other/infra/container",
  ].map((to) => `infra: apps/backend/todo/infra/bad-infra.ts → ${to}`),
  ...[
    "apps/backend/todo/domain/todo",
    "apps/backend/todo/infra/container",
    "apps/backend/todo/domain/todo-factory",
    "apps/frontend/features/todo",
    "apps/frontend/app/page",
    "apps/backend/todo/infra/todo-repository.in-memory",
  ].map(
    (to) =>
      `backend-shared: apps/backend/shared/presentation/bad-backend-shared.ts → ${to}`,
  ),
  ...[
    "apps/backend/todo/domain/todo",
    "apps/backend/todo/infra/container",
    "apps/backend/todo/domain/todo-factory",
    "apps/frontend/features/todo",
    "apps/frontend/app/page",
    "apps/backend/todo/infra/todo-repository.in-memory",
  ].map(
    (to) =>
      `presentation: apps/backend/shared/presentation/bad-backend-shared.ts → ${to}`,
  ),
  ...[
    "apps/backend/other/domain/other",
    "apps/frontend/shared/x",
    "apps/backend/other/application/other.query",
  ].map(
    (to) =>
      `application: apps/backend/todo/application/bad-application-2.ts → ${to}`,
  ),
  ...[
    "apps/backend/other/infra/container",
    "apps/backend/other/application/other.query",
    "apps/backend/other/domain/other",
    "apps/frontend/shared/x",
  ].map(
    (to) =>
      `presentation: apps/backend/todo/presentation/bad-presentation-2.api.ts → ${to}`,
  ),
  "domain: apps/backend/shared/domain/bad-shared-screen.ts → apps/frontend/shared/x",
  "backend-shared: apps/backend/shared/domain/bad-shared-screen.ts → apps/frontend/shared/x",
  "backend-placement: apps/backend/todo/p-root.ts",
  "backend-placement: apps/backend/todo/lib/x.ts",
  "backend-placement: apps/backend/x.ts",
  "backend-placement: apps/backend/shared/bad-root.ts",
  "domain: apps/backend/shared-x/domain/x.ts → apps/frontend/features/todo",
  "app: apps/frontend/app/api-x/route.ts → apps/backend/todo/presentation/list-todos.api",
  "screen-to-backend: apps/frontend/features/todo/components/test-helper.tsx → apps/backend/todo/domain/todo",
  "screen-to-backend: apps/frontend/features/todo/components/bad-ext.mts → apps/backend/todo/domain/todo",
  "screen-to-backend: apps/frontend/features/todo/components/bad-ext.mts → apps/backend/todo/infra/container",
  "screen-to-backend: apps/frontend/features/todo/components/bad-ext.cts → apps/backend/todo/presentation/get-todo.api",
  "screen-to-backend: apps/frontend/features/todo/components/bad-ext.mjs → apps/backend/shared/presentation/http-error",
  "screen-to-backend: apps/frontend/features/todo/components/bad-ext.cjs → apps/backend/todo/infra/todo-repository.in-memory",
  "backend-shared: apps/backend/shared/bad-root.ts → apps/backend/todo/application/create-todo.command",
  ...[
    "apps/frontend/features/todo/components/todo-item",
    "apps/frontend/features/todo/screens/todo-screen/todo-screen.hook",
    "apps/backend/todo/presentation/list-todos.api",
    "apps/backend/todo/presentation/get-todo.api",
    "apps/frontend/features/todo/api/todo-api",
    "apps/frontend/features/todo-extra/components/y",
  ].map((to) => `app: apps/frontend/app/bad-page.tsx → ${to}`),
  "app: apps/frontend/app/todo/[id]/bad.jsx → apps/frontend/features/todo/components/todo-item",
  ...[
    "apps/backend/todo/infra/container",
    "apps/backend/todo/application/create-todo.command",
    "next/server",
    "apps/frontend/features/todo",
    "apps/backend/todo/presentation/update-todo",
    "apps/backend/shared/presentation/http-error",
    "apps/frontend/shared/x",
  ].map((to) => `app-api: apps/frontend/app/api/todos/bad-route.ts → ${to}`),
  "domain: apps/backend/todo/domain/bad-domain-infra.ts → apps/backend/shared/infra/database",
  "domain: apps/backend/todo/domain/bad-domain-infra.ts → apps/backend/shared/infra/drizzle-transaction-runner",
  "domain: apps/backend/shared/domain/bad-shared-domain-infra.ts → apps/backend/shared/infra/database",
  "application: apps/backend/todo/application/bad-application-infra.ts → apps/backend/shared/infra/database",
  ...[
    "apps/backend/shared/infra/database",
    "apps/backend/todo/infra/schema",
    "apps/backend/todo/infra/todo-repository.postgres",
  ].map(
    (to) =>
      `presentation: apps/backend/todo/presentation/bad-presentation-infra.api.ts → ${to}`,
  ),
  "infra: apps/backend/shared/infra/bad-shared-infra.ts → apps/backend/todo/infra/schema",
  "backend-shared: apps/backend/shared/infra/bad-shared-infra.ts → apps/backend/todo/infra/schema",
  "infra: apps/backend/shared/infra/bad-shared-infra.ts → next/server",
  "backend-shared: apps/backend/shared/infra/bad-shared-infra.ts → next/server",
  "infra: apps/backend/shared/infra/bad-shared-infra.ts → apps/backend/shared/presentation/http-error",
  ...["drizzle-orm/pg-core", "drizzle-orm", "pg"].map(
    (to) =>
      `core-to-persistence: apps/backend/todo/domain/bad-domain-db.ts → ${to}`,
  ),
  ...["drizzle-orm", "drizzle-orm/node-postgres", "pg"].map(
    (to) =>
      `core-to-persistence: apps/backend/todo/application/bad-application-db.command.ts → ${to}`,
  ),
  "core-to-persistence: apps/backend/shared/domain/bad-shared-domain-db.ts → drizzle-orm/node-postgres",
  // Issue #68 の段階 2: frontend-to-backend-specifier。上の fixture のうち、frontend・apps/e2e/・リポジトリ直下から相対パス
  //   （と "@/../backend/"）で backend を指すものは、ほかの規則の結果に関係なくすべてかかる。
  ...[
    "apps/frontend/app/api/todos/[id]/bad-relative.ts → apps/backend/todo/presentation/update-todo.api",
    "apps/frontend/app/api/todos/bad-route.ts → apps/backend/todo/application/create-todo.command",
    "apps/frontend/app/bad-page.tsx → apps/backend/todo/presentation/get-todo.api",
    "apps/frontend/features/todo/api/bad-api.ts → apps/backend/shared/presentation/http-error",
    "apps/frontend/features/todo/api/bad-api.ts → apps/backend/todo/domain/todo",
    "apps/frontend/features/todo/api/bad-specifier.ts → apps/backend/todo/presentation/get-todo.api",
    "apps/frontend/features/todo/api/bad-specifier.ts → apps/backend/todo/presentation/list-todos.api",
    "apps/frontend/features/todo/components/bad-backend.ts → apps/backend/shared/presentation/json-body",
    "apps/frontend/features/todo/components/bad-backend.ts → apps/backend/todo/domain/todo",
    "apps/frontend/features/todo/components/bad-backend.ts → apps/backend/todo/presentation/delete-todo.api",
    "apps/frontend/features/todo/components/bad-ext.mjs → apps/backend/shared/presentation/http-error",
    "apps/frontend/instrumentation-node.ts → apps/backend/shared/infra/env",
    "apps/frontend/next.config.ts → apps/backend/shared/infra/database",
    "apps/frontend/shared/bad-shared.tsx → apps/backend/todo/presentation/list-todos.api",
    "apps/e2e/bad-relative.ts → apps/backend/shared/infra/env",
    "vitest.global-setup.mts → apps/backend/shared/infra/database.test-support",
    "vitest.global-setup.ts → apps/backend/shared/infra/env",
  ].map((line) => `frontend-to-backend-specifier: ${line}`),
  // Issue #68 の段階 2: backend-exports。"@repo/backend/..." の参照のうち、fixture の exports のどのキーにも当たらないもの
  //   （container・domain・application・他 feature・.api の付かない presentation・パッケージ名だけ）と、exports の各キーの違反。
  ...[
    "apps/frontend/app/api/todos/bad-route.ts → @repo/backend/todo/infra/container",
    "apps/frontend/app/api/todos/bad-route.ts → @repo/backend/todo/presentation/update-todo",
    "apps/frontend/features/todo/api/bad-api.ts → @repo/backend/other/presentation/list-others.api",
    "apps/frontend/features/todo/api/bad-api.ts → @repo/backend/shared/domain/domain-error",
    "apps/frontend/features/todo/api/bad-api.ts → @repo/backend/todo/presentation/list-todos",
    "apps/frontend/features/todo/components/bad-backend.ts → @repo/backend/todo/infra/container",
    "apps/frontend/features/todo/components/bad-ext.cjs → @repo/backend/todo/infra/todo-repository.in-memory",
    "apps/frontend/features/todo/components/bad-ext.mts → @repo/backend/todo/domain/todo",
    "apps/frontend/features/todo/components/bad-ext.mts → @repo/backend/todo/infra/container",
    "apps/frontend/features/todo/components/test-helper.tsx → @repo/backend/todo/domain/todo",
    "apps/frontend/lib/db.ts → @repo/backend/todo/infra/container",
    "apps/frontend/next.config.ts → @repo/backend/shared/infra/env-helper",
    "apps/frontend/next.config.ts → @repo/backend/todo/infra/container",
    "apps/frontend/shared/bad-shared.tsx → @repo/backend/shared/domain/domain-error",
    "apps/e2e/bad-exports.ts → @repo/backend",
    "apps/e2e/bad-exports.ts → @repo/backend/todo/infra/container",
    'apps/backend/package.json の exports "./mismatch" が指すファイルが無い',
    'apps/backend/package.json の exports "./mismatch" の値 "./todo/domain/bad-domain.ts" は、キーのパスに .ts を付けたものではない',
    'apps/backend/package.json の exports "./shared/presentation/http-error" が指すファイルが無い',
    'apps/backend/package.json の exports "./todo/domain/bad-domain" はどこからも参照されていない',
  ].map((line) => `backend-exports: ${line}`),
];

// must-pass: 許可される参照を網羅する。今のリポジトリの本番コードにある import の形
// （`git grep -h "from \"" -- '*.ts' '*.tsx'` で列挙したもの）をすべて含め、alias と相対の両方を置く。
// コメント・文字列の中の import 風の文字列、from の無い `export type {...};`、テストファイル・TS 以外のファイルも置く。
const MUST_PASS_FILES: Record<string, string> = {
  "apps/frontend/app/layout.tsx": lines(
    'import type { Metadata } from "next";',
    'import { Inter } from "next/font/google";',
    'import "./globals.css";',
  ),
  "apps/frontend/app/globals.css": "body { margin: 0; }",
  "apps/frontend/app/page.tsx": lines(
    'import { TodoScreen } from "@/features/todo";',
    "const lazy = import(`@/features/todo`);",
    'import { x } from "@/shared/x";',
    'import { useState } from "react";',
    'import Link from "next/link";',
  ),
  "apps/frontend/app/todo/[id]/page.tsx": lines(
    'import { TodoDetailScreen } from "@/features/todo";',
    'import { TodoScreen } from "../../../features/todo/index";',
  ),
  "apps/frontend/app/api/todos/route.ts": lines(
    'export { POST } from "@repo/backend/todo/presentation/create-todo.api";',
    'export { GET } from "@repo/backend/todo/presentation/list-todos.api";',
  ),
  "apps/frontend/app/api/todos/[id]/route.ts": lines(
    'export { DELETE } from "@repo/backend/todo/presentation/delete-todo.api";',
    'export { GET } from "@repo/backend/todo/presentation/get-todo.api";',
    'export { PUT } from "@repo/backend/todo/presentation/update-todo.api";',
  ),
  "apps/frontend/features/todo/index.ts": lines(
    'export { TodoDetailScreen } from "./screens/todo-detail-screen/todo-detail-screen";',
    'export { TodoScreen } from "./screens/todo-screen/todo-screen";',
  ),
  "apps/frontend/features/todo/api/todo-api.ts": lines(
    'import type { ErrorResponse } from "@repo/backend/shared/presentation/http-error";',
    "import type {",
    "  CreateTodoRequest,",
    "  CreateTodoResponse,",
    '} from "@repo/backend/todo/presentation/create-todo.api";',
    'import type { GetTodoResponse } from "@repo/backend/todo/presentation/get-todo.api";',
    "import type {",
    "  ListTodosResponse,",
    "  TodoDto,",
    '} from "@repo/backend/todo/presentation/list-todos.api";',
    "import type {",
    "  UpdateTodoRequest,",
    "  UpdateTodoResponse,",
    '} from "@repo/backend/todo/presentation/update-todo.api";',
    'import { type UpdateTodoRequest as Req, type UpdateTodoResponse as Res } from "@repo/backend/todo/presentation/update-todo.api";',
    'export type { DeleteTodoResponse } from "@repo/backend/todo/presentation/delete-todo.api";',
    "export type {",
    "  CreateTodoRequest,",
    "  CreateTodoResponse,",
    "  ErrorResponse,",
    "};",
    'const BASE_PATH = "/api/todos";',
  ),
  "apps/frontend/features/todo/components/todo-item.tsx": lines(
    'import Link from "next/link";',
    'import type { TodoDto } from "@/features/todo/api/todo-api";',
  ),
  "apps/frontend/features/todo/screens/todo-screen/todo-screen.tsx": lines(
    '"use client";',
    'import { TodoItem } from "../../components/todo-item";',
    'import { useTodoScreen } from "./todo-screen.hook";',
  ),
  "apps/frontend/features/todo/screens/todo-screen/todo-screen.hook.ts": lines(
    'import { useCallback, useEffect, useRef, useState } from "react";',
    "import {",
    "  listTodos,",
    "  type TodoDto,",
    "  updateTodo,",
    '} from "@/features/todo/api/todo-api";',
  ),
  "apps/frontend/features/todo/screens/todo-detail-screen/todo-detail-screen.tsx":
    lines(
      '"use client";',
      'import Link from "next/link";',
      'import { useTodoDetailScreen } from "./todo-detail-screen.hook";',
    ),
  "apps/frontend/features/todo/screens/todo-detail-screen/todo-detail-screen.hook.ts":
    lines(
      'import { useCallback, useEffect, useRef, useState } from "react";',
      "import {",
      "  getTodo,",
      "  type TodoDto,",
      "  updateTodo,",
      '} from "@/features/todo/api/todo-api";',
    ),
  // 別 feature からは index だけ（alias と相対、index の明示あり・なし）。画面側の shared/ は参照してよい。
  "apps/frontend/features/other/components/uses-todo.jsx": lines(
    'import { TodoScreen } from "@/features/todo";',
    'import { TodoDetailScreen } from "../../todo/index";',
    'import { x } from "@/shared/x";',
  ),
  "apps/frontend/shared/x.js": lines('import { useState } from "react";'),
  "apps/frontend/shared/ui/button.tsx": lines('import { x } from "../x";'),
  // コメント・文字列の中の import 風の文字列は参照ではない。
  "apps/frontend/features/todo/components/notes.ts": lines(
    '// import { GET } from "@repo/backend/todo/presentation/list-todos.api";',
    '/* export { x } from "@/app/page"; */',
    "/**",
    ' * 例: import("@repo/backend/todo/infra/container")',
    ' * import "@repo/backend/todo/domain/todo";',
    " */",
    "export const single = 'import { GET } from \"@/backend/x\";';",
    "export const double = \"import('@repo/backend/y')\";",
    "export const side = 'import \"@/backend/z\"';",
    "export const template = `",
    'import { a } from "@/app/page";',
    "`;",
    'export const url = "https://example.com/import/from"; import { useState } from "react";',
  ),
  "apps/backend/shared/domain/domain-error.ts": lines(
    "export class DomainError extends Error {}",
  ),
  "apps/backend/shared/presentation/http-error.ts": lines(
    "import {",
    "  DomainError,",
    "  type DomainErrorCode,",
    '} from "../domain/domain-error";',
    // Issue #85: 想定外の例外はログの唯一の出口（Issue #90 で apps/shared に移した logger）で残す。
    'import { logger } from "@repo/shared/logger";',
    'logger.error({ message: "x" });',
  ),
  // console を直接書いてよいのは logger.ts だけ（Issue #85。Issue #90 で apps/shared に移した）。
  "apps/shared/logger.ts": lines(
    "export const logger = {",
    "  info: (line: string) => console.log(line),",
    "  warn: (line: string) => console.warn(line),",
    "  error: (line: string) => globalThis.console.error(line),",
    "};",
  ),
  // logger.ts 以外の、console に見えるが参照ではないもの（コメント・文字列・別の識別子）。
  "apps/backend/todo/infra/console-lookalikes.ts": lines(
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
  "apps/frontend/features/todo/components/x.test.tsx":
    lines("console.error(1);"),
  "scripts/tool.sh": lines("console.log(1)"),
  "apps/backend/shared/presentation/json-body.ts": lines(
    'import { InvalidRequestError } from "./http-error";',
    'import { toErrorResponse } from "./http-error";',
  ),
  "apps/backend/todo/domain/todo.ts": lines(
    'import { randomUUID } from "node:crypto";',
    'import { DomainError } from "../../shared/domain/domain-error";',
    'import { DomainError as E } from "../../shared/domain/domain-error";',
  ),
  "apps/backend/todo/domain/todo-repository.ts": lines(
    'import type { Todo } from "./todo";',
    'import { Todo as T } from "./todo";',
  ),
  "apps/backend/todo/application/create-todo.command.ts": lines(
    'import { Todo } from "../domain/todo";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  "apps/backend/todo/application/get-todo.query.ts": lines(
    'import { DomainError } from "../../shared/domain/domain-error";',
    'import type { Todo } from "../domain/todo";',
    'import { DomainError as E } from "../../shared/domain/domain-error";',
    'import { ListTodosQuery } from "./list-todos.query";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  "apps/backend/todo/application/list-todos.query.ts": lines(
    'import type { Todo } from "../domain/todo";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  "apps/backend/todo/application/update-todo.command.ts": lines(
    'import { DomainError } from "../../shared/domain/domain-error";',
    'import type { Todo } from "../domain/todo";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  "apps/backend/todo/application/delete-todo.command.ts": lines(
    'import { DomainError } from "../../shared/domain/domain-error";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  "apps/backend/todo/presentation/list-todos.api.ts": lines(
    'import { toErrorResponse } from "../../shared/presentation/http-error";',
    'import type { Todo } from "../domain/todo";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "../infra/container";',
  ),
  "apps/backend/todo/presentation/create-todo.api.ts": lines(
    "import {",
    "  InvalidRequestError,",
    "  toErrorResponse,",
    '} from "../../shared/presentation/http-error";',
    'import { readJsonObject } from "../../shared/presentation/json-body";',
    'import { todoContainer } from "../infra/container";',
    'import { DomainError } from "../../shared/domain/domain-error";',
    'export type { Todo } from "../domain/todo";',
    'import { type Todo as T } from "../domain/todo";',
  ),
  "apps/backend/todo/presentation/reexport.api.ts": lines(
    'import type { GetTodoResponse } from "./get-todo.api";',
    'import type { ListTodosQuery } from "../application/list-todos.query";',
    'import { GetTodoQuery } from "../application/get-todo.query";',
    'export { toErrorResponse } from "../../shared/presentation/http-error";',
  ),
  "apps/frontend/shared/y.mts": lines(
    'import { x } from "./x";',
    'const lazy = import(`./x`, { with: { type: "json" } });',
  ),
  "apps/backend/todo/presentation/get-todo.api.ts": lines(
    'import { toErrorResponse } from "../../shared/presentation/http-error";',
    'import type { Todo } from "../domain/todo";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "../infra/container";',
  ),
  "apps/backend/todo/presentation/update-todo.api.ts": lines(
    "import {",
    "  InvalidRequestError,",
    "  toErrorResponse,",
    '} from "../../shared/presentation/http-error";',
    'import { readJsonObject } from "../../shared/presentation/json-body";',
    'import type { Todo } from "../domain/todo";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "../infra/container";',
  ),
  "apps/backend/todo/presentation/delete-todo.api.ts": lines(
    'import { toErrorResponse } from "../../shared/presentation/http-error";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "../infra/container";',
  ),
  "apps/backend/todo/infra/container.ts": lines(
    'import { CreateTodoCommand } from "../application/create-todo.command";',
    'import { DeleteTodoCommand } from "../application/delete-todo.command";',
    'import { GetTodoQuery } from "../application/get-todo.query";',
    'import { ListTodosQuery } from "../application/list-todos.query";',
    'import { UpdateTodoCommand } from "../application/update-todo.command";',
    'import type { TodoRepository } from "../domain/todo-repository";',
    'import { Todo } from "../domain/todo";',
    'import { InMemoryTodoRepository } from "./todo-repository.in-memory";',
    'import { InMemoryTodoRepository as R } from "./todo-repository.in-memory";',
    'import { DomainError } from "../../shared/domain/domain-error";',
    'import { randomUUID } from "node:crypto";',
    // Issue #57: container.ts が backend/shared/infra（プール・Drizzle の runner）と自 feature の Postgres / InMemory の実装、
    //   backend/shared/domain の TransactionRunner の型、application の入力の型（inline の type）を参照する。
    'import type { TransactionRunner } from "../../shared/domain/transaction-runner";',
    "import {",
    "  type Database,",
    "  type Executor,",
    "  getDatabase,",
    '} from "../../shared/infra/database";',
    'import { DrizzleTransactionRunner } from "../../shared/infra/drizzle-transaction-runner";',
    'import { getDatabase as g } from "../../shared/infra/database";',
    "import {",
    "  CreateTodoCommand,",
    "  type CreateTodoInput,",
    '} from "../application/create-todo.command";',
    'import type { Todo } from "../domain/todo";',
    'import { InMemoryTransactionRunner } from "./in-memory-transaction-runner";',
    'import { PostgresTodoRepository } from "./todo-repository.postgres";',
  ),
  // Issue #57: 永続化（Drizzle + Postgres）とトランザクション。backend の infra からパッケージ（drizzle-orm / pg）への参照、
  //   backend/shared/infra → backend/shared/domain、自 feature の infra → backend/shared/infra。
  "apps/backend/shared/domain/transaction-runner.ts": lines(
    "export interface TransactionRunner<Tx> {}",
  ),
  "apps/backend/shared/infra/database.ts": lines(
    'import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";',
    'import { Pool, type PoolConfig } from "pg";',
    // Issue #59: 設定は env.ts から、ログは logger から取る（Issue #90 で apps/shared に移した。backend の infra から apps/shared）。
    //   apps/shared へは "@repo/shared/..." だけ（相対パスは backend-relative-only の違反）。
    'import { env } from "@repo/shared/env";',
    'import { logger } from "@repo/shared/logger";',
    'import { env as e } from "@repo/shared/env";',
  ),
  // Issue #59: process.env を読んでよいのは env.ts だけ（Issue #90 で apps/shared に移した）。
  "apps/shared/env.ts": lines(
    'process.loadEnvFile(".env");',
    "export const env = readEnv(process.env);",
    "export const toolEnv = readToolEnv(process . env);",
  ),
  // env.ts 以外の、process.env に見えるが参照ではないもの（コメント・文字列・別の識別子）。
  "apps/backend/todo/infra/env-lookalikes.ts": lines(
    "// process.env.DATABASE_URL は env.ts から読む",
    "/* process['env'] */",
    'const s = "process.env.X";',
    "const t = 'process[\"env\"]';",
    "const processEnv = read(); processEnv.X;",
    "const v = myprocess.env; process.envelope;",
  ),
  // テスト、対象外の場所（scripts/・ルート直下のディレクトリの中）、TS / JS 以外のファイルは検査しない。
  "apps/shared/env.test.ts": lines("const p = process.env.PATH;"),
  // apps/shared の package.json・tsconfig.json は置いてよい。依存のディレクトリ（node_modules）の中は置き場所の規則でも見ない。
  "apps/shared/package.json": JSON.stringify({
    name: "@repo/shared",
    exports: {
      "./env": "./env.ts",
      "./logger": "./logger.ts",
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
  // Issue #68: next build の生成物（apps/frontend/.next/）と、workspace パッケージの依存（apps/backend/node_modules/）は
  //   自前のコードではないので、違反を書いても検査しない。
  "apps/frontend/.next/server/chunk.js": lines(
    "module.exports = process.env;",
    'import "@repo/backend/todo/infra/container";',
  ),
  "apps/frontend/node_modules/pkg/index.js": lines(
    "module.exports = process.env;",
    'import "@repo/backend/todo/infra/container";',
  ),
  // next build / next dev が生成する型の宣言（.gitignore 済み）。直下の許可された名前で、.next の中を import する。
  "apps/frontend/next-env.d.ts": lines(
    '/// <reference types="next" />',
    'import "./.next/types/routes.d.ts";',
  ),
  "apps/backend/node_modules/pkg/index.js": lines(
    "module.exports = process.env;",
    'import "../../../frontend/app/page";',
  ),
  // apps/frontend 直下の Next の設定（パッケージの参照だけ）と、backend の中から前方一致だけが同じ別パッケージの参照。
  "apps/frontend/next.config.ts": lines(
    'import type { NextConfig } from "next";',
    "export default {} satisfies NextConfig;",
  ),
  "apps/backend/todo/infra/uses-packages.ts": lines(
    'import extra from "@repo/backend-extra/x";',
    'import { eq } from "drizzle-orm";',
  ),
  "README.md": "process.env.DATABASE_URL",
  // instrumentation.ts は NEXT_RUNTIME だけを読み、Node.js 用の処理（instrumentation-node.ts）が env.ts を読み込む。
  "apps/frontend/instrumentation.ts": lines(
    "export async function register() {",
    '  if (process.env.NEXT_RUNTIME === "nodejs") {',
    '    const { verifyEnvAtStartup } = await import("./instrumentation-node");',
    "    await verifyEnvAtStartup();",
    "  }",
    "}",
  ),
  "apps/frontend/instrumentation-node.ts": lines(
    'import { logger } from "@repo/shared/logger";',
    "export async function verifyEnvAtStartup() {",
    '  await import("@repo/shared/env");',
    "}",
  ),
  // proxy.ts（Next の規約ファイル。リクエストログ。Issue #80）は直下に置き、1 行の組み立てを frontend の shared/ から使う。
  //   出力はログの唯一の出口（apps/shared/logger。Issue #85・#90）を通す。
  "apps/frontend/proxy.ts": lines(
    'import { logger } from "@repo/shared/logger";',
    'import { type NextRequest, NextResponse } from "next/server";',
    'import { buildRequestLog } from "@/shared/request-log/request-log";',
    "logger.info(buildRequestLog());",
  ),
  "apps/frontend/shared/request-log/request-log.ts": lines(
    "export function buildRequestLog() {}",
  ),
  // env.ts は apps/shared（@repo/shared。Issue #90）にあり、apps/backend の設定ファイル（apps/backend/drizzle.config.ts）・apps/e2e/・
  //   リポジトリ直下の設定ファイルは "@repo/shared/env" で import する。
  "apps/backend/drizzle.config.ts": lines(
    'import { env } from "@repo/shared/env";',
    "export default { url: env.DATABASE_URL };",
  ),
  "apps/e2e/database.ts": lines(
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
    'import { resetTodos } from "./database";',
  ),
  // テスト基盤の vitest.global-setup.ts だけは、database.test-support を相対パスで参照する（exports に含めない例外）。
  "vitest.global-setup.ts": lines(
    'import { env, toolEnv } from "@repo/shared/env";',
    "import {",
    "  cleanupTestSchemas,",
    "  testSchemaPrefix,",
    '} from "./apps/backend/shared/infra/database.test-support";',
  ),
  // exports（Issue #68 の段階 2）: 外が "@repo/backend/..." で参照するものだけを、キーのパスの .ts で公開する。
  //   すべてのキーが上の参照で使われ、指すファイルがある（パターンは *.api の 5 ファイルに当たる）。
  "apps/backend/package.json": JSON.stringify({
    name: "@repo/backend",
    exports: {
      "./todo/presentation/*.api": "./todo/presentation/*.api.ts",
      "./shared/presentation/http-error": "./shared/presentation/http-error.ts",
    },
  }),
  "apps/backend/shared/infra/drizzle-transaction-runner.ts": lines(
    'import type { TransactionRunner } from "../domain/transaction-runner";',
    'import type { Database, Executor } from "./database";',
    'import type { TransactionRunner as T } from "../domain/transaction-runner";',
    'import type { Executor as E } from "./database";',
  ),
  "apps/backend/shared/infra/database.test-support.ts": lines(
    'import { randomUUID } from "node:crypto";',
    'import { drizzle } from "drizzle-orm/node-postgres";',
    'import { migrate } from "drizzle-orm/node-postgres/migrator";',
    'import { Pool } from "pg";',
    'import type { Database } from "./database";',
    'import { env } from "@repo/shared/env";',
  ),
  "apps/backend/todo/infra/schema.ts": lines(
    'import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";',
  ),
  "apps/backend/todo/infra/todo-repository.postgres.ts": lines(
    'import { asc, eq } from "drizzle-orm";',
    'import type { Executor } from "../../shared/infra/database";',
    'import { Todo } from "../domain/todo";',
    'import type { TodoRepository } from "../domain/todo-repository";',
    'import { todos } from "./schema";',
    'import { todos as t } from "./schema";',
  ),
  "apps/backend/todo/infra/in-memory-transaction-runner.ts": lines(
    'import type { TransactionRunner } from "../../shared/domain/transaction-runner";',
    'import type { InMemoryTodoRepository } from "./todo-repository.in-memory";',
  ),
  "apps/backend/todo/infra/todo-repository.in-memory.ts": lines(
    'import type { Todo } from "../domain/todo";',
    'import type { TodoRepository } from "../domain/todo-repository";',
  ),
  // テストファイルと TS / JS 以外のファイルは検査しない。
  "apps/backend/todo/presentation/list-todos.api.test.ts": lines(
    'import { InMemoryTodoRepository } from "../infra/todo-repository.in-memory";',
  ),
  "apps/frontend/features/todo/components/todo-item.test.tsx": lines(
    'import { listTodosApi } from "@repo/backend/todo/presentation/list-todos.api";',
  ),
  "apps/frontend/features/todo/README.md":
    'import { GET } from "@repo/backend/todo/infra/container";',
};

describe("fixture のツリーを検査したときに検出される違反", () => {
  it("must-reject: 置いた違反がすべて、置いたとおりの規則で検出され、それ以外は検出されない", () => {
    expect(violationsOfFixture(MUST_REJECT_FILES)).toEqual(
      [...MUST_REJECT_VIOLATIONS].sort(),
    );
  });

  it("must-pass: 許可される参照だけのツリーでは違反が 0 件", () => {
    expect(violationsOfFixture(MUST_PASS_FILES)).toEqual([]);
  });
});

describe("参照の抽出（extractImports）", () => {
  it("複数行にまたがる import を 1 つの参照として取り出す", () => {
    const source = [
      "import {",
      "  CreateTodoCommand,",
      "  DeleteTodoCommand,",
      '} from "@/backend/todo/application/x";',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "@/backend/todo/application/x", typeOnly: false },
    ]);
  });

  it("import type / export type は型だけの参照、export { X } from は値の参照になる", () => {
    const source = [
      'import type { A } from "a";',
      'export type { B } from "b";',
      'export { GET } from "c";',
      'export * from "d";',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "a", typeOnly: true },
      { specifier: "b", typeOnly: true },
      { specifier: "c", typeOnly: false },
      { specifier: "d", typeOnly: false },
    ]);
  });

  it("inline の type は、すべての名前に付いているときだけ型だけの参照になる", () => {
    const source = [
      'import { type A, type B } from "all-type";',
      'import { type A, B } from "mixed";',
      'import Default, { type A } from "with-default";',
      'import {} from "empty";',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "all-type", typeOnly: true },
      { specifier: "mixed", typeOnly: false },
      { specifier: "with-default", typeOnly: false },
      { specifier: "empty", typeOnly: false },
    ]);
  });

  it("副作用だけの import と dynamic import を値の参照として取り出す", () => {
    const source = [
      'import "./globals.css";',
      'const mod = await import("@/features/todo");',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "./globals.css", typeOnly: false },
      { specifier: "@/features/todo", typeOnly: false },
    ]);
  });

  it("コメントの中の import は拾わず、文字列の中の // でその後ろを消さない", () => {
    const source = [
      '// 例: import { GET } from "@/backend/line-comment";',
      "/*",
      ' * import { GET } from "@/backend/block-comment";',
      " */",
      'const url = "https://example.com"; import { a } from "after-string";',
      "const s = '/* not a comment */'; import { b } from \"after-quote\";",
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "after-string", typeOnly: false },
      { specifier: "after-quote", typeOnly: false },
    ]);
  });

  it("セミコロンの無い文の直後の import type を、前の文とつなげずに型だけの参照として取り出す", () => {
    const source = [
      "export enum E { A }",
      'import type { X } from "after-enum";',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "after-enum", typeOnly: true },
    ]);
  });

  it("文字列リテラル（テンプレートリテラルを含む）の中の import 風の文字列は拾わない", () => {
    const source = [
      "const a = 'import(\"@/backend/x\")';",
      "const b = 'import \"@/backend/y\"';",
      "const t = `",
      'import { c } from "@/backend/z";',
      "`;",
      'import { real } from "real";',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "real", typeOnly: false },
    ]);
  });

  it("埋め込み式（ドル記号と波かっこ）を含むテンプレートリテラルの import() は、参照先を静的に決められないので拾わない（見逃す方向の限界）", () => {
    // WHY テンプレートリテラルで書く: 普通の文字列の中に埋め込み式の形を書くと Biome の noTemplateCurlyInString が
    //   書き間違いとして検出するため、\${ でエスケープして同じ文字列を作る。
    const source = [
      `const m = import(\`@/backend/\${name}/presentation/x.api\`);`,
      'import { real } from "real";',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "real", typeOnly: false },
    ]);
  });

  it("from を持たない export 文から、後ろの文の from まで一致を伸ばさない", () => {
    const source = [
      "export const GET = listTodosApi(todoContainer);",
      "export default function Page() {",
      "  return null",
      "}",
      'import { x } from "real";',
    ].join("\n");
    expect(extractImports(source)).toEqual([
      { specifier: "real", typeOnly: false },
    ]);
  });
});

describe("参照先の正規化（toReference）", () => {
  const from =
    "apps/frontend/features/todo/screens/todo-screen/todo-screen.tsx";

  it('"@/" は apps/frontend からのパスにする（tsconfig の paths の "@/*" は apps/frontend/*）', () => {
    expect(
      toReference(from, {
        specifier: "@/features/todo/api/todo-api",
        typeOnly: true,
      }),
    ).toEqual({
      from,
      specifier: "@/features/todo/api/todo-api",
      to: "apps/frontend/features/todo/api/todo-api",
      own: true,
      typeOnly: true,
    });
  });

  it('"@repo/backend/" と "@repo/backend" は apps/backend からのパスにする', () => {
    expect(
      toReference(from, {
        specifier: "@repo/backend/todo/presentation/list-todos.api.ts",
        typeOnly: true,
      }),
    ).toEqual({
      from,
      specifier: "@repo/backend/todo/presentation/list-todos.api.ts",
      to: "apps/backend/todo/presentation/list-todos.api",
      own: true,
      typeOnly: true,
    });
    expect(
      toReference(from, { specifier: "@repo/backend", typeOnly: false }).to,
    ).toBe("apps/backend");
  });

  it('"@repo/shared/" と "@repo/shared" は apps/shared からのパスにし、"@repo/shared-extra/x" は自前のコードにしない（Issue #90）', () => {
    expect(
      toReference(from, { specifier: "@repo/shared/env.ts", typeOnly: false }),
    ).toEqual({
      from,
      specifier: "@repo/shared/env.ts",
      to: "apps/shared/env",
      own: true,
      typeOnly: false,
    });
    expect(
      toReference(from, { specifier: "@repo/shared", typeOnly: false }).to,
    ).toBe("apps/shared");
    expect(
      toReference(from, {
        specifier: "@repo/shared/../backend/x",
        typeOnly: false,
      }).to,
    ).toBe("apps/backend/x");
    expect(
      toReference(from, { specifier: "@repo/shared-extra/x", typeOnly: false }),
    ).toEqual({
      from,
      specifier: "@repo/shared-extra/x",
      to: "@repo/shared-extra/x",
      own: false,
      typeOnly: false,
    });
  });

  it('"@/" と "@repo/backend/" の後ろの ".." は解決する（"@/../backend/x" は apps/backend/x）', () => {
    expect(
      toReference(from, {
        specifier: "@/../backend/todo/presentation/list-todos.api",
        typeOnly: true,
      }).to,
    ).toBe("apps/backend/todo/presentation/list-todos.api");
    expect(
      toReference(from, {
        specifier: "@repo/backend/../frontend/features/todo",
        typeOnly: false,
      }).to,
    ).toBe("apps/frontend/features/todo");
  });

  it('名前の前方一致だけが同じ別パッケージ（"@repo/backend-extra/x"）は自前のコードにしない', () => {
    expect(
      toReference(from, {
        specifier: "@repo/backend-extra/x",
        typeOnly: false,
      }),
    ).toEqual({
      from,
      specifier: "@repo/backend-extra/x",
      to: "@repo/backend-extra/x",
      own: false,
      typeOnly: false,
    });
  });

  it("相対パスは参照元の位置から解決し、拡張子を外す", () => {
    expect(
      toReference(from, {
        specifier: "../../components/todo-item.tsx",
        typeOnly: false,
      }),
    ).toEqual({
      from,
      specifier: "../../components/todo-item.tsx",
      to: "apps/frontend/features/todo/components/todo-item",
      own: true,
      typeOnly: false,
    });
    // apps をまたぐ相対パスも、リポジトリ相対のパスに解決する。
    expect(
      toReference(from, {
        specifier: "../../../../../backend/todo/domain/todo",
        typeOnly: false,
      }).to,
    ).toBe("apps/backend/todo/domain/todo");
  });

  it("それ以外はパッケージとして specifier のまま扱う", () => {
    expect(
      toReference(from, { specifier: "next/link", typeOnly: false }),
    ).toEqual({
      from,
      specifier: "next/link",
      to: "next/link",
      own: false,
      typeOnly: false,
    });
  });
});
