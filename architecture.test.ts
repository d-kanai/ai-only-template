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
import { dirname, join, posix, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ディレクトリ構成ルール（rules/code/architecture.md）の依存の向きを、仕様として機械的に検査するテスト。
// 対象は「依存の向き（全体）」「画面側とサーバ側の境界」「backend の 4 層の依存してよい先」。
//
// WHY 自前のテストにする（Biome の noRestrictedImports を使わない）:
//   「features/<f>/api/ から backend へは import type だけ許す」を表現できない。Biome 2.5.13 の noRestrictedImports は
//   型だけの import（import type）も同じく違反にすることを実測した（Issue #47 の調査）。また、パスの制限を
//   「どのディレクトリからの import か」で変えるには feature ごと・層ごとに overrides を書く必要があり、feature を
//   足すたびに biome.json を直すことになる。ここでは参照元のパスから feature 名・層を取り出して、規則を 1 か所で書く。
//
// WHY 依存を増やさず正規表現で抽出する: 検査に必要なのは import / export の参照先と「型だけか」の 2 つで、
//   TypeScript の構文木までは要らない。dependency-cruiser は 18.4.0 の supportedTranspilers.typescript が <7.0.0 で、
//   本リポジトリの TypeScript 7.0.2 に対応していない（rules/code/architecture.md の「採用しなかった案」）。
//   抽出の限界は stripComments / extractImports の WHY に書き、仕様を下の describe と fixture テストで固定する。

const repoRoot = import.meta.dirname;

// 検査の対象にするディレクトリ（rules/code/architecture.md の「全体像」）。shared/ はまだ無いが、作ったときに自動で対象になるよう入れる。
const SOURCE_DIRS = ["app", "features", "backend", "shared"];

// WHY テストを対象外にする: テストは組み立てのために規則の外側を参照する（例: presentation のテストが
//   infra の InMemory リポジトリを new して createTodoContainer に渡す。rules/code/architecture.md の「テストの置き方」）。
//   規則は本番のコードの依存の向きを縛るもので、テストの組み立てまで縛ると正当なテストが書けなくなる。
// WHY .js / .jsx / .mjs / .cjs と .mts / .cts も対象にする: tsconfig.json が allowJs: true で、include が **/*.ts / **/*.tsx /
//   **/*.mts を含み、JS のファイルや ESM / CJS を明示した拡張子のファイルも同じビルドに入り、同じ規則の対象になるため。
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|[jt]sx)$/;

type ImportStatement = {
  // import / export の from に書かれた文字列そのもの（"@/backend/..."、"../x"、"next/link" など）。
  specifier: string;
  // 型だけの参照か（import type / export type / すべての名前に inline の type が付いた import）。
  typeOnly: boolean;
};

type Reference = {
  // 参照元のファイル（リポジトリ相対、"/" 区切り、拡張子つき）。
  from: string;
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

// 参照先を、規則で比べる形にそろえる。
//   "@/x" → "x"（tsconfig の paths で "@/*" はリポジトリ直下 "./*"）
//   相対パス → 参照元のファイルの位置から解決したリポジトリ相対のパス
//   それ以外 → パッケージ（specifier のまま）
function toReference(
  from: string,
  { specifier, typeOnly }: ImportStatement,
): Reference {
  if (specifier.startsWith("@/")) {
    return {
      from,
      to: specifier.slice(2).replace(CODE_EXTENSION, ""),
      own: true,
      typeOnly,
    };
  }
  if (specifier.startsWith(".")) {
    // WHY posix で文字列として解決する: from がリポジトリ相対の "/" 区切りなので、ルートの場所（本番のリポジトリ直下か、
    //   fixture の一時ディレクトリか）に関係なく同じ結果になる。
    const to = posix
      .join(posix.dirname(from), specifier)
      .replace(CODE_EXTENSION, "");
    return { from, to, own: true, typeOnly };
  }
  return { from, to: specifier, own: false, typeOnly };
}

// WHY root を引数で受け取る: 本番の検査（リポジトリ直下）と、fixture の一時ディレクトリに置いた架空のツリーの検査で、
//   列挙 → 抽出 → 正規化 → 判定の同じ経路を通すため。
function listSourceFiles(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) {
    return [];
  }
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .map((path) => toPosix(join(dir, path)))
    .filter((path) => SOURCE_FILE.test(path) && !TEST_FILE.test(path));
}

function listAllSourceFiles(root: string): string[] {
  return SOURCE_DIRS.flatMap((dir) => listSourceFiles(root, dir));
}

function referencesOf(root: string, files: string[]): Reference[] {
  return files.flatMap((file) =>
    extractImports(readFileSync(join(root, file), "utf8")).map((statement) =>
      toReference(file, statement),
    ),
  );
}

function collectReferences(root: string): Reference[] {
  return referencesOf(root, listAllSourceFiles(root));
}

// --- 規則で使う判定 ---

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function ownUnder(ref: Reference, dir: string): boolean {
  return ref.own && isUnder(ref.to, dir);
}

// "features/todo/..." → "todo"
function featureOf(path: string): string | undefined {
  return /^features\/([^/]+)\//.exec(path)?.[1];
}

type BackendLayer = "domain" | "application" | "presentation" | "infra";
type BackendLocation = { feature: string; layer: BackendLayer };

// "backend/todo/presentation/..." → { feature: "todo", layer: "presentation" }
function backendLayerOf(path: string): BackendLocation | undefined {
  const match =
    /^backend\/([^/]+)\/(domain|application|presentation|infra)(?:\/|$)/.exec(
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

// backend の api ファイル（1 API = 1 ファイル `backend/<x>/presentation/<verb>-<noun>.api.ts`）。
const PRESENTATION_API = /^backend\/[^/]+\/presentation\/[^/]+\.api$/;

// feature の公開 API（`features/<f>/index.ts`）。"features/todo" と "features/todo/index" のどちらの書き方も同じファイルを指す。
const FEATURE_INDEX = /^features\/[^/]+(?:\/index)?$/;

function isFeatureApi(path: string): boolean {
  return /^features\/[^/]+\/api\//.test(path);
}

// features/<f>/api/ から、同じ feature の api ファイル（backend/<f>/presentation/*.api）への参照か。
function isOwnFeatureApiFile(ref: Reference): boolean {
  return (
    PRESENTATION_API.test(ref.to) &&
    backendLayerOf(ref.to)?.feature === featureOf(ref.from)
  );
}

// 参照元の層ごとに、自 feature と backend/shared の中で参照してよい層（rules/code/architecture.md の 4 層の表）。
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
//     コンテナからだけ受け取る。Repository の実装を直接 new しない」）。
//   - feature の domain は import type だけ（「domain（Entity の型の参照のみ）」）。Entity の生成や操作は application を通す。
//     backend/shared/domain（DomainError）はエラーの変換（instanceof）に値として使うので対象外。
function presentationAllows(
  ref: Reference,
  self: BackendLocation,
  target: BackendLocation,
): boolean {
  if (target.layer === "infra") {
    return ref.to === `backend/${self.feature}/infra/container`;
  }
  if (target.layer === "domain" && target.feature !== "shared") {
    return ref.typeOnly;
  }
  return true;
}

// backend の層にあるファイルから、自前コードへの参照が許可の一覧に入っているか。
// 許すのは、自 feature か backend/shared の、参照元の層が参照してよい層だけ。他 feature のどの層も、画面側
// （features/ app/ shared/）も、層に属さない場所も許さない。
function backendMayUse(ref: Reference): boolean {
  const self = backendLayerOf(ref.from);
  const target = backendLayerOf(ref.to);
  if (self === undefined || target === undefined) {
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
  | "screen-to-backend"
  | "feature-api-to-backend"
  | "feature-to-feature"
  | "screen-to-app"
  | "shared-to-features"
  | "domain"
  | "application"
  | "presentation"
  | "infra"
  | "backend-shared"
  | "app"
  | "app-api";

type Rule = {
  id: RuleId;
  // テスト名。rules/code/architecture.md の文言に対応する仕様文。
  name: string;
  appliesTo: (from: string) => boolean;
  isViolation: (ref: Reference) => boolean;
};

// 1 規則 = 1 テスト。規則を足す・変えるときは rules/code/architecture.md と合わせてここと RULE_EXAMPLES（判定の例）を直す。
const RULES: Rule[] = [
  {
    // 「`features/<feature>/` の `api/` 以外は backend を参照せず、`api/` が re-export した型を使う」
    // WHY 画面側の shared/ も含める: 画面側で backend を参照してよいのは features/<f>/api/ だけ（「画面側とサーバ側の境界」）で、
    //   shared/ から参照すると境界が api/ の 1 か所に集まらなくなるため。
    id: "screen-to-backend",
    name: "features/<f>/ の api/ 以外と shared/ は backend/ を参照しない",
    appliesTo: (from) =>
      (isUnder(from, "features") && !isFeatureApi(from)) ||
      isUnder(from, "shared"),
    isViolation: (ref) => ownUnder(ref, "backend"),
  },
  {
    // 「画面側で backend を参照してよいのは `features/<feature>/api/` だけ。参照先は
    //   `backend/<feature>/presentation/<name>.api.ts` と `backend/shared/presentation/` で、いずれも `import type` のみ」
    // WHY 型だけに限る: import type はビルド時に消えるので、サーバ専用のコードが画面のバンドルに入らない。
    // WHY 自 feature の api ファイルに限る: 別 feature の API の契約を使うなら、その feature の api/ を通すべきで、
    //   feature 同士は index 経由でしか参照しない（規則 feature-to-feature）方針と揃えるため。
    id: "feature-api-to-backend",
    name: "features/<f>/api/ から backend/ への参照は型だけで、参照先は自 feature の backend/<f>/presentation/*.api か backend/shared/presentation/ だけ",
    appliesTo: isFeatureApi,
    isViolation: (ref) =>
      ownUnder(ref, "backend") &&
      !(
        ref.typeOnly &&
        (isOwnFeatureApiFile(ref) ||
          isUnder(ref.to, "backend/shared/presentation"))
      ),
  },
  {
    // 「feature 同士は原則 import しない。必要なときは相手の `index.ts` だけを import する」
    id: "feature-to-feature",
    name: "別の feature を参照するときは features/<other>（index）だけ",
    appliesTo: (from) => featureOf(from) !== undefined,
    isViolation: (ref) =>
      ownUnder(ref, "features") &&
      featureOf(`${ref.to}/`) !== featureOf(ref.from) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「画面側: `app → features → shared`」。app/ はルーティングで、features / shared から参照すると向きが逆になる。
    id: "screen-to-app",
    name: "features/ と shared/ は app/ を参照しない",
    appliesTo: (from) => isUnder(from, "features") || isUnder(from, "shared"),
    isViolation: (ref) => ownUnder(ref, "app"),
  },
  {
    // 「`shared/` は `features/` を import しない（逆向きの依存を作らない）」
    id: "shared-to-features",
    name: "shared/ は features/ を参照しない",
    appliesTo: (from) => isUnder(from, "shared"),
    isViolation: (ref) => ownUnder(ref, "features"),
  },
  {
    // 「domain は Next・React・DB に依存させない」「依存してよい先は backend/shared だけ」
    //   自 feature の domain/ の中の参照（Repository の interface が Entity を参照するなど）は許す。
    id: "domain",
    name: "backend/<f>/domain/ が参照してよい自前コードは自 feature と backend/shared/ の domain/ だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "domain",
    isViolation: violatesBackendLayer,
  },
  {
    // 「application の依存してよい先は domain と backend/shared」「依存の向き: presentation → application → domain」
    //   同じ application の中の参照（ユースケースの共通処理など）は許す。
    id: "application",
    name: "backend/<f>/application/ が参照してよい自前コードは自 feature と backend/shared/ の domain/・application/ だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "application",
    isViolation: violatesBackendLayer,
  },
  {
    // 「presentation の依存してよい先: application、domain（Entity の型の参照のみ）、infra/container.ts、backend/shared」
    //   同じ presentation の中の参照（api ファイル間の re-export など）は許す。
    // WHY next も禁止する: api ファイルは Web 標準の Request / Response で書き、Next を起動せずにテストできるようにしているため
    //   （rules/code/architecture.md の「テストの置き方」）。
    id: "presentation",
    name: "backend/<f>/presentation/ が参照してよい自前コードは自 feature と backend/shared/ の application/・domain/（feature の domain は型だけ）・presentation/ と自 feature の infra/container だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "presentation",
    isViolation: violatesBackendLayer,
  },
  {
    // 「infra: Repository の実装、container.ts（組み立て = DI）」「依存してよい先: domain（interface を実装する）、
    //   application（container で組み立てる）」。container.ts が同じ infra の Repository の実装を組み立てるので、infra/ の中の
    //   参照も許す。
    id: "infra",
    name: "backend/<f>/infra/ が参照してよい自前コードは自 feature と backend/shared/ の domain/・application/・infra/ だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "infra",
    isViolation: violatesBackendLayer,
  },
  {
    // 「backend/shared/: feature をまたいで使う型や処理」。各 feature が shared に依存するので、逆向きにすると循環する。
    //   画面側の shared/ も含め、backend/shared/ の外の自前コードは参照しない。
    id: "backend-shared",
    name: "backend/shared/ が参照してよい自前コードは backend/shared/ の中だけで、next・react も参照しない",
    appliesTo: (from) => isUnder(from, "backend/shared"),
    isViolation: (ref) =>
      usesFramework(ref) || (ref.own && !isUnder(ref.to, "backend/shared")),
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
    name: "app/（app/api 以外）が features/・backend/・shared/ を参照するときは features/<f>（index）か shared/ だけ",
    appliesTo: (from) => isUnder(from, "app") && !isUnder(from, "app/api"),
    isViolation: (ref) =>
      (ownUnder(ref, "features") || ownUnder(ref, "backend")) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「`app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ」
    id: "app-api",
    name: "app/api/ は backend/<x>/presentation/*.api だけを参照する",
    appliesTo: (from) => isUnder(from, "app/api"),
    isViolation: (ref) => !(ref.own && PRESENTATION_API.test(ref.to)),
  },
];

// backend のソースファイルは、backend/<x>/ の 4 層（domain / application / presentation / infra）のどれかの下に置く。
// WHY 置き場所そのものを規則にする: 層に属さない場所（backend/todo/lib/ や backend/todo/ 直下）のファイルは、どの層の規則も
//   かからず、そこから何を参照しても検査を素通りする。層を決めて置かせることで、すべての backend のコードに依存の向きの
//   検査がかかるようにする。
// WHY backend/shared/ も同じに扱う（直下を許さない）: backend/shared/ も domain / presentation の層に分けて置いており
//   （rules/code/architecture.md の「backend/shared/」）、直下を許すと同じ抜け道になるため。
const BACKEND_LAYER_DIR =
  /^backend\/[^/]+\/(?:domain|application|presentation|infra)\//;

const BACKEND_PLACEMENT = {
  id: "backend-placement",
  name: "backend/ のソースファイルは backend/<x>/ の domain/・application/・presentation/・infra/ のどれかの下に置く",
  isMisplaced: (file: string) =>
    isUnder(file, "backend") && !BACKEND_LAYER_DIR.test(file),
};

function findViolations(references: Reference[], rule: Rule): string[] {
  return references
    .filter((ref) => rule.appliesTo(ref.from) && rule.isViolation(ref))
    .map((ref) => `${ref.from} → ${ref.to}`);
}

// root の下のツリー全体の違反を「<規則の id>: ファイル → 参照先」の一覧（並べ替え済み）で返す。
//   1 つの参照が複数の規則に違反するときは、規則ごとに 1 行ずつ出す。
//   置き場所の違反は「backend-placement: ファイル」の 1 行で出す。
function collectViolations(root: string): string[] {
  const files = listAllSourceFiles(root);
  const references = referencesOf(root, files);
  return [
    ...RULES.flatMap((rule) =>
      findViolations(references, rule).map((line) => `${rule.id}: ${line}`),
    ),
    ...files
      .filter(BACKEND_PLACEMENT.isMisplaced)
      .map((file) => `${BACKEND_PLACEMENT.id}: ${file}`),
  ].sort();
}

describe("依存の向き（rules/code/architecture.md）", () => {
  const references = collectReferences(repoRoot);

  it("検査の対象から参照を取り出せている（抽出が壊れて 0 件になり、すべての規則が素通りするのを防ぐ）", () => {
    expect(references.length).toBeGreaterThan(0);
  });

  it(BACKEND_PLACEMENT.name, () => {
    expect(
      listAllSourceFiles(repoRoot).filter(BACKEND_PLACEMENT.isMisplaced),
    ).toEqual([]);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      // 失敗時にどのファイルがどこを参照しているかが出力に出るよう、違反を「ファイル → 参照先」の一覧にして空配列と比較する。
      expect(findViolations(references, rule)).toEqual([]);
    });
  }
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
  "screen-to-backend": {
    violating: [
      [
        "features/todo/components/x.ts",
        "@/backend/todo/presentation/list-todos.api",
        "type",
      ],
      [
        "features/todo/screens/s/s.hook.ts",
        "../../../../backend/todo/domain/todo",
        "value",
      ],
      ["shared/x.ts", "@/backend/shared/presentation/http-error", "type"],
    ],
    allowed: [
      ["features/todo/components/x.ts", "@/features/todo/api/todo-api", "type"],
      [
        "features/todo/api/todo-api.ts",
        "@/backend/todo/presentation/list-todos.api",
        "type",
      ],
      ["shared/x.ts", "react", "value"],
    ],
  },
  "feature-api-to-backend": {
    violating: [
      [
        "features/todo/api/todo-api.ts",
        "@/backend/todo/presentation/list-todos.api",
        "value",
      ],
      ["features/todo/api/todo-api.ts", "@/backend/todo/domain/todo", "type"],
      [
        "features/todo/api/todo-api.ts",
        "@/backend/other/presentation/list-others.api",
        "type",
      ],
      [
        "features/todo/api/todo-api.ts",
        "@/backend/todo/presentation/list-todos",
        "type",
      ],
    ],
    allowed: [
      [
        "features/todo/api/todo-api.ts",
        "@/backend/todo/presentation/list-todos.api",
        "type",
      ],
      [
        "features/todo/api/todo-api.ts",
        "../../../backend/todo/presentation/get-todo.api",
        "type",
      ],
      [
        "features/todo/api/todo-api.ts",
        "@/backend/shared/presentation/http-error",
        "type",
      ],
    ],
  },
  "feature-to-feature": {
    violating: [
      [
        "features/other/components/x.ts",
        "@/features/todo/components/todo-item",
        "value",
      ],
      ["features/other/components/x.ts", "../../todo/api/todo-api", "type"],
      [
        "features/todo/components/x.ts",
        "@/features/todo-extra/components/y",
        "value",
      ],
    ],
    allowed: [
      ["features/other/components/x.ts", "@/features/todo", "value"],
      ["features/other/components/x.ts", "@/features/todo/index", "value"],
      [
        "features/todo/screens/todo-screen/todo-screen.tsx",
        "../../components/todo-item",
        "value",
      ],
    ],
  },
  "screen-to-app": {
    violating: [
      ["features/todo/components/x.ts", "@/app/page", "value"],
      ["shared/x.ts", "@/app/layout", "type"],
      [
        "features/todo/screens/s/s.tsx",
        "../../../../app/api/todos/route",
        "value",
      ],
    ],
    allowed: [
      ["features/todo/components/x.ts", "next/link", "value"],
      ["features/todo/components/x.ts", "@/shared/x", "value"],
      ["shared/x.ts", "./y", "value"],
    ],
  },
  "shared-to-features": {
    violating: [
      ["shared/x.ts", "@/features/todo", "value"],
      ["shared/ui/x.tsx", "../../features/todo/components/todo-item", "value"],
      ["shared/x.ts", "@/features/todo/api/todo-api", "type"],
    ],
    allowed: [
      ["shared/x.ts", "react", "value"],
      ["shared/ui/x.tsx", "../x", "value"],
      [
        "features/todo/components/x.ts",
        "@/features/todo/api/todo-api",
        "value",
      ],
    ],
  },
  domain: {
    violating: [
      ["backend/todo/domain/x.ts", "next/server", "value"],
      ["backend/todo/domain/x.ts", "react/jsx-runtime", "value"],
      [
        "backend/todo/domain/x.ts",
        "../application/create-todo.command",
        "value",
      ],
      ["backend/todo/domain/x.ts", "@/backend/other/domain/other", "type"],
      [
        "backend/todo/domain/x.ts",
        "@/backend/shared/presentation/http-error",
        "value",
      ],
      ["backend/todo/domain/x.ts", "@/features/todo", "value"],
      ["backend/todo/domain/x.ts", "@/shared/x", "value"],
    ],
    allowed: [
      ["backend/todo/domain/x.ts", "@/backend/todo/domain/todo", "value"],
      ["backend/todo/domain/x.ts", "./todo", "type"],
      [
        "backend/todo/domain/x.ts",
        "@/backend/shared/domain/domain-error",
        "value",
      ],
      ["backend/todo/domain/x.ts", "node:crypto", "value"],
    ],
  },
  application: {
    violating: [
      [
        "backend/todo/application/x.ts",
        "@/backend/todo/infra/container",
        "value",
      ],
      [
        "backend/todo/application/x.ts",
        "../presentation/list-todos.api",
        "type",
      ],
      ["backend/todo/application/x.ts", "react", "value"],
      ["backend/todo/application/x.ts", "@/features/todo", "value"],
      ["backend/todo/application/x.ts", "@/backend/other/domain/other", "type"],
      [
        "backend/todo/application/x.ts",
        "@/backend/other/application/other.query",
        "value",
      ],
      ["backend/todo/application/x.ts", "../../../shared/x", "value"],
    ],
    allowed: [
      [
        "backend/todo/application/x.ts",
        "@/backend/todo/domain/todo-repository",
        "type",
      ],
      ["backend/todo/application/x.ts", "../domain/todo", "value"],
      ["backend/todo/application/x.ts", "./other.command", "value"],
      ["backend/todo/application/x.ts", "node:crypto", "value"],
      [
        "backend/todo/application/x.ts",
        "@/backend/shared/domain/domain-error",
        "value",
      ],
    ],
  },
  presentation: {
    violating: [
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/todo/infra/todo-repository.in-memory",
        "value",
      ],
      [
        "backend/todo/presentation/x.api.ts",
        "../infra/container-helper",
        "value",
      ],
      ["backend/todo/presentation/x.api.ts", "next/server", "value"],
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/todo/domain/todo",
        "value",
      ],
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/other/infra/container",
        "type",
      ],
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/other/application/other.query",
        "type",
      ],
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/other/domain/other",
        "type",
      ],
      ["backend/todo/presentation/x.api.ts", "@/shared/x", "value"],
      [
        "backend/shared/presentation/x.ts",
        "@/backend/todo/infra/container",
        "value",
      ],
      // backend/shared の infra は container という名前でも不可（presentation が受け取ってよいのは自 feature の container だけ）。
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/shared/infra/container",
        "value",
      ],
    ],
    allowed: [
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/todo/infra/container",
        "value",
      ],
      ["backend/todo/presentation/x.api.ts", "../infra/container", "value"],
      [
        "backend/todo/presentation/x.api.ts",
        "../application/list-todos.query",
        "type",
      ],
      ["backend/todo/presentation/x.api.ts", "./get-todo.api", "value"],
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/shared/presentation/http-error",
        "value",
      ],
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/todo/domain/todo",
        "type",
      ],
      [
        "backend/shared/presentation/http-error.ts",
        "@/backend/shared/domain/domain-error",
        "value",
      ],
    ],
  },
  infra: {
    violating: [
      [
        "backend/todo/infra/x.ts",
        "@/backend/todo/presentation/list-todos.api",
        "type",
      ],
      ["backend/todo/infra/x.ts", "@/backend/other/domain/other", "type"],
      ["backend/todo/infra/x.ts", "@/features/todo", "value"],
      ["backend/todo/infra/x.ts", "@/shared/x", "value"],
      ["backend/todo/infra/x.ts", "@/app/page", "value"],
      ["backend/todo/infra/x.ts", "next/server", "value"],
    ],
    allowed: [
      ["backend/todo/infra/x.ts", "@/backend/todo/domain/todo", "value"],
      [
        "backend/todo/infra/x.ts",
        "@/backend/todo/application/create-todo.command",
        "value",
      ],
      [
        "backend/todo/infra/x.ts",
        "@/backend/shared/domain/domain-error",
        "value",
      ],
      [
        "backend/todo/infra/container.ts",
        "./todo-repository.in-memory",
        "value",
      ],
      ["backend/todo/infra/x.ts", "node:crypto", "value"],
    ],
  },
  "backend-shared": {
    violating: [
      [
        "backend/shared/presentation/x.ts",
        "@/backend/todo/domain/todo",
        "type",
      ],
      [
        "backend/shared/presentation/x.ts",
        "../../todo/infra/container",
        "value",
      ],
      ["backend/shared/presentation/x.ts", "@/features/todo", "value"],
      ["backend/shared/x.ts", "@/app/page", "value"],
      ["backend/shared/domain/x.ts", "@/shared/x", "value"],
      ["backend/shared/presentation/x.ts", "next/server", "value"],
    ],
    allowed: [
      [
        "backend/shared/presentation/x.ts",
        "@/backend/shared/domain/domain-error",
        "value",
      ],
      ["backend/shared/presentation/json-body.ts", "./http-error", "value"],
      ["backend/shared/domain/x.ts", "node:crypto", "value"],
      ["backend/shared/presentation/x.ts", "some-package/sub", "value"],
    ],
  },
  app: {
    violating: [
      ["app/page.tsx", "@/backend/todo/presentation/list-todos.api", "value"],
      ["app/page.tsx", "@/features/todo/components/todo-item", "value"],
      ["app/todo/[id]/page.tsx", "../../../features/todo/api/todo-api", "type"],
    ],
    allowed: [
      ["app/page.tsx", "@/features/todo", "value"],
      ["app/todo/[id]/page.tsx", "../../../features/todo/index", "value"],
      ["app/page.tsx", "@/shared/x", "value"],
      ["app/layout.tsx", "./globals.css", "value"],
      ["app/page.tsx", "react", "value"],
    ],
  },
  "app-api": {
    violating: [
      ["app/api/todos/route.ts", "@/backend/todo/infra/container", "value"],
      ["app/api/todos/route.ts", "next/server", "value"],
      [
        "app/api/todos/route.ts",
        "@/backend/todo/presentation/list-todos",
        "value",
      ],
    ],
    allowed: [
      [
        "app/api/todos/route.ts",
        "@/backend/todo/presentation/list-todos.api",
        "value",
      ],
      [
        "app/api/todos/[id]/route.ts",
        "../../../../backend/todo/presentation/get-todo.api",
        "value",
      ],
      [
        "app/api/todos/route.ts",
        "@/backend/todo/presentation/create-todo.api",
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

// backend の置き場所の規則（BACKEND_PLACEMENT）の判定例。参照ではなくファイルの置き場所で決まるので別に持つ。
const PLACEMENT_EXAMPLES: { misplaced: string[]; placed: string[] } = {
  misplaced: [
    "backend/todo/p-root.ts",
    "backend/todo/lib/x.ts",
    "backend/shared/bad-root.ts",
    "backend/x.ts",
    "backend/todo/domainx/x.ts",
  ],
  placed: [
    "backend/todo/domain/todo.ts",
    "backend/shared/presentation/http-error.ts",
    "backend/todo/infra/container.ts",
    "backend/todo/presentation/nested/x.api.ts",
    "features/todo/lib/x.ts",
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

describe("規則ごとの判定", () => {
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

// must-reject: 12 規則それぞれについて、alias（@/）と相対パス、値の import / import type / inline の type /
// export { X } from / export type { X } from / dynamic import() / 副作用だけの import のうち規則に関係する形と、
// .ts / .tsx / .js / .jsx の各拡張子、境界ぎりぎりのケース（他 feature の深いパス、自 feature の禁止層、
// 名前の前方一致だけが同じ別ディレクトリ、next / react / react-dom のサブパス）を置く。
const MUST_REJECT_FILES: Record<string, string> = {
  // screen-to-backend: features/<f>/ の api/ 以外から backend への参照は、型でも相対でも違反。
  "features/todo/components/bad-backend.ts": lines(
    'import { GET } from "@/backend/todo/presentation/list-todos.api";',
    'import type { Todo } from "../../../backend/todo/domain/todo";',
    'import { type GetTodoResponse } from "@/backend/todo/presentation/get-todo.api";',
    'import * as updateApi from "@/backend/todo/presentation/update-todo.api";',
    'import deleteApi from "../../../backend/todo/presentation/delete-todo.api";',
    'export { POST } from "@/backend/todo/presentation/create-todo.api";',
    'export type { ErrorResponse } from "@/backend/shared/presentation/http-error";',
    // セミコロンの無い文の直後の複数行の import type も拾う。
    "export enum Kind { A }",
    "import type {",
    "  TodoContainer,",
    '} from "@/backend/todo/infra/container";',
    'const lazy = import("../../../backend/shared/presentation/json-body");',
  ),
  // screen-to-backend / shared-to-features / screen-to-app: 画面側の shared/ から。
  "shared/bad-shared.tsx": lines(
    'import { GET } from "../backend/todo/presentation/list-todos.api";',
    'import type { DomainError } from "@/backend/shared/domain/domain-error";',
    'import { TodoScreen } from "@/features/todo";',
    'import type { TodoDto } from "../features/todo/api/todo-api";',
    'export { TodoItem } from "@/features/todo/components/todo-item";',
    'export { default } from "@/app/page";',
    'const layout = import("../app/layout");',
  ),
  // feature-api-to-backend: 値の参照、presentation 以外、他 feature、.api でないファイル、inline type の混在。
  "features/todo/api/bad-api.ts": lines(
    'import { listTodosApi } from "@/backend/todo/presentation/list-todos.api";',
    'import type { Todo } from "../../../backend/todo/domain/todo";',
    'import type { ListOthersResponse } from "@/backend/other/presentation/list-others.api";',
    'import { type TodoDto, GET } from "@/backend/todo/presentation/get-todo.api";',
    'export { toErrorResponse } from "../../../backend/shared/presentation/http-error";',
    'import type { X } from "@/backend/todo/presentation/list-todos";',
    'import type { DomainError } from "@/backend/shared/domain/domain-error";',
    'const m = import("@/backend/todo/presentation/update-todo.api");',
  ),
  // feature-to-feature: 別 feature の深いパスは、型でも re-export でも dynamic でも違反。
  "features/other/components/bad-feature.js": lines(
    'import { TodoItem } from "@/features/todo/components/todo-item";',
    'import { useTodoScreen } from "../../todo/screens/todo-screen/todo-screen.hook";',
    'export { fetchTodos } from "@/features/todo/api/todo-api";',
    'import type { TodoDto } from "../../todo/api/todo-api";',
    'const c = import("@/features/todo/components");',
  ),
  // feature-to-feature: 名前の前方一致だけが同じ別 feature（todo と todo-extra）を同じ feature と誤認しない。
  "features/todo/components/bad-prefix.jsx": lines(
    'import { X } from "@/features/todo-extra/components/x";',
  ),
  // screen-to-app
  "features/todo/screens/s/bad-app.tsx": lines(
    'import Page from "@/app/page";',
    'import { GET } from "../../../../app/api/todos/route";',
    'export type { Metadata } from "@/app/layout";',
  ),
  // domain: フレームワークのサブパス、自 feature の外側の層、他 feature の domain、shared の presentation、画面側。
  "backend/todo/domain/bad-domain.ts": lines(
    'import { NextResponse } from "next/server";',
    'import { jsx } from "react/jsx-runtime";',
    'import { createRoot } from "react-dom/client";',
    'import { CreateTodoCommand } from "../application/create-todo.command";',
    'import type { TodoContainer } from "@/backend/todo/infra/container";',
    'import type { TodoDto } from "../presentation/list-todos.api";',
    'import type { Other } from "@/backend/other/domain/other";',
    'import { toErrorResponse } from "../../shared/presentation/http-error";',
    'export type { TodoDto as Dto } from "@/features/todo";',
    'const s = import("@/shared/x");',
    'import "@/app/globals.css";',
  ),
  // domain: backend/shared/domain から backend/shared/presentation（shared の中でも向きが逆）。
  "backend/shared/domain/bad-shared-domain.ts": lines(
    'import { InvalidRequestError } from "../presentation/http-error";',
  ),
  // application
  "backend/todo/application/bad-application.ts": lines(
    'import { todoContainer } from "@/backend/todo/infra/container";',
    'import type { TodoDto } from "../presentation/list-todos.api";',
    'import { InvalidRequestError } from "@/backend/shared/presentation/http-error";',
    'import { useState } from "react";',
    'import { notFound } from "next/navigation";',
    'import { flushSync } from "react-dom";',
    'export { TodoItem } from "@/features/todo/components/todo-item";',
    'const r = import("../../../app/page");',
  ),
  // presentation: container 以外の infra（名前が container で始まる別ファイルも）、domain の値の参照（inline type の混在、
  //   re-export）、フレームワーク、画面側、他 feature の infra。
  "backend/todo/presentation/bad-presentation.api.ts": lines(
    'import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";',
    'import { helper } from "../infra/container-helper";',
    'import { Todo } from "@/backend/todo/domain/todo";',
    'import { TodoFactory, type TodoId } from "../domain/todo-factory";',
    'export { Todo as Entity } from "@/backend/todo/domain/todo-entity";',
    'import { NextResponse } from "next/server";',
    'import { cache } from "react";',
    'export type { TodoDto } from "@/features/todo/api/todo-api";',
    'const c = import("@/backend/other/infra/other-repository.in-memory");',
    'import "../../../app/globals.css";',
  ),
  // infra
  "backend/todo/infra/bad-infra.ts": lines(
    'import { listTodosApi } from "@/backend/todo/presentation/list-todos.api";',
    'import type { GetTodoResponse } from "../presentation/get-todo.api";',
    'import type { Other } from "@/backend/other/domain/other";',
    'import { OtherQuery } from "../../other/application/other.query";',
    'import { TodoScreen } from "@/features/todo";',
    'import { x } from "@/shared/x";',
    'export { default } from "../../../app/page";',
    'import { headers } from "next/headers";',
    'import { renderToString } from "react-dom/server";',
    'const c = import("@/backend/other/infra/container");',
  ),
  // backend-shared（presentation 層のファイルなので presentation の規則にも同時にかかるものがある）
  "backend/shared/presentation/bad-backend-shared.ts": lines(
    'import type { Todo } from "@/backend/todo/domain/todo";',
    'import { todoContainer } from "../../todo/infra/container";',
    'import { TodoFactory } from "@/backend/todo/domain/todo-factory";',
    'export { TodoScreen } from "@/features/todo";',
    'const p = import("@/app/page");',
    'import "@/backend/todo/infra/todo-repository.in-memory";',
  ),
  // application: 他 feature の domain / application、画面側の shared/。
  "backend/todo/application/bad-application-2.ts": lines(
    'import type { Other } from "@/backend/other/domain/other";',
    'import { x } from "../../../shared/x";',
    'export { OtherQuery } from "@/backend/other/application/other.query";',
  ),
  // presentation: 他 feature の container / application / domain は import type でも違反。画面側の shared/。
  "backend/todo/presentation/bad-presentation-2.api.ts": lines(
    'import type { OtherContainer } from "@/backend/other/infra/container";',
    'import type { OtherQuery } from "../../other/application/other.query";',
    'import type { Other } from "@/backend/other/domain/other";',
    'import { x } from "@/shared/x";',
  ),
  // domain / backend-shared: backend/shared から画面側の shared/。
  "backend/shared/domain/bad-shared-screen.ts": lines(
    'import { x } from "@/shared/x";',
  ),
  // backend-placement: backend/<x>/ の 4 層の外のファイル（import の有無に関係なく違反）。
  "backend/todo/p-root.ts": lines('import { x } from "@/shared/x";'),
  "backend/todo/lib/x.ts": lines("export const x = 1;"),
  "backend/x.ts": lines("export const x = 1;"),
  // 前方一致の境界: backend/shared-x は backend/shared ではなく shared-x という feature。
  "backend/shared-x/domain/x.ts": lines(
    'import { TodoScreen } from "@/features/todo";',
  ),
  // 前方一致の境界: app/api-x は app/api ではない（app の規則がかかる）。
  "app/api-x/route.ts": lines(
    'export { GET } from "@/backend/todo/presentation/list-todos.api";',
  ),
  // パスに test を含むがテストファイルではない本番のファイル。
  "features/todo/components/test-helper.tsx": lines(
    'import { Todo } from "@/backend/todo/domain/todo";',
  ),
  // 拡張子 .mts / .cts / .mjs / .cjs と、テンプレートリテラル・第 2 引数つきの dynamic import。
  "features/todo/components/bad-ext.mts": lines(
    "const a = import(`@/backend/todo/domain/todo`);",
    'const b = import("@/backend/todo/infra/container", { with: { type: "json" } });',
  ),
  "features/todo/components/bad-ext.cts": lines(
    'import { GET } from "@/backend/todo/presentation/get-todo.api";',
  ),
  "features/todo/components/bad-ext.mjs": lines(
    'export { x } from "../../../backend/shared/presentation/http-error";',
  ),
  "features/todo/components/bad-ext.cjs": lines(
    'import "@/backend/todo/infra/todo-repository.in-memory";',
  ),
  // backend-shared / backend-placement: 層に属さない backend/shared 直下のファイルから。
  "backend/shared/bad-root.ts": lines(
    'import { CreateTodoCommand } from "@/backend/todo/application/create-todo.command";',
  ),
  // app
  "app/bad-page.tsx": lines(
    'import { TodoItem } from "@/features/todo/components/todo-item";',
    'import { useTodoScreen } from "../features/todo/screens/todo-screen/todo-screen.hook";',
    'import type { TodoDto } from "@/backend/todo/presentation/list-todos.api";',
    'export { GET } from "../backend/todo/presentation/get-todo.api";',
    'const x = import("@/features/todo/api/todo-api");',
    'import { Y } from "@/features/todo-extra/components/y";',
  ),
  "app/todo/[id]/bad.jsx": lines(
    'import { TodoItem } from "../../../features/todo/components/todo-item";',
  ),
  // app-api: api ファイル以外（.api の付かない presentation、shared の presentation を含む）、パッケージ、画面側。
  "app/api/todos/bad-route.ts": lines(
    'export { GET } from "@/backend/todo/infra/container";',
    'export { POST } from "../../../backend/todo/application/create-todo.command";',
    'import { NextResponse } from "next/server";',
    'import { TodoScreen } from "@/features/todo";',
    'export { PUT } from "@/backend/todo/presentation/update-todo";',
    'export { DELETE } from "@/backend/shared/presentation/http-error";',
    'const x = import("@/shared/x");',
  ),
};

const MUST_REJECT_VIOLATIONS = [
  ...[
    "backend/todo/presentation/list-todos.api",
    "backend/todo/domain/todo",
    "backend/todo/presentation/get-todo.api",
    "backend/todo/presentation/update-todo.api",
    "backend/todo/presentation/delete-todo.api",
    "backend/todo/presentation/create-todo.api",
    "backend/shared/presentation/http-error",
    "backend/todo/infra/container",
    "backend/shared/presentation/json-body",
  ].map(
    (to) =>
      `screen-to-backend: features/todo/components/bad-backend.ts → ${to}`,
  ),
  "screen-to-backend: shared/bad-shared.tsx → backend/todo/presentation/list-todos.api",
  "screen-to-backend: shared/bad-shared.tsx → backend/shared/domain/domain-error",
  "shared-to-features: shared/bad-shared.tsx → features/todo",
  "shared-to-features: shared/bad-shared.tsx → features/todo/api/todo-api",
  "shared-to-features: shared/bad-shared.tsx → features/todo/components/todo-item",
  "screen-to-app: shared/bad-shared.tsx → app/page",
  "screen-to-app: shared/bad-shared.tsx → app/layout",
  ...[
    "backend/todo/presentation/list-todos.api",
    "backend/todo/domain/todo",
    "backend/other/presentation/list-others.api",
    "backend/todo/presentation/get-todo.api",
    "backend/shared/presentation/http-error",
    "backend/todo/presentation/list-todos",
    "backend/shared/domain/domain-error",
    "backend/todo/presentation/update-todo.api",
  ].map((to) => `feature-api-to-backend: features/todo/api/bad-api.ts → ${to}`),
  ...[
    "features/todo/components/todo-item",
    "features/todo/screens/todo-screen/todo-screen.hook",
    "features/todo/api/todo-api",
    "features/todo/api/todo-api",
    "features/todo/components",
  ].map(
    (to) =>
      `feature-to-feature: features/other/components/bad-feature.js → ${to}`,
  ),
  "feature-to-feature: features/todo/components/bad-prefix.jsx → features/todo-extra/components/x",
  "screen-to-app: features/todo/screens/s/bad-app.tsx → app/page",
  "screen-to-app: features/todo/screens/s/bad-app.tsx → app/api/todos/route",
  "screen-to-app: features/todo/screens/s/bad-app.tsx → app/layout",
  ...[
    "next/server",
    "react/jsx-runtime",
    "react-dom/client",
    "backend/todo/application/create-todo.command",
    "backend/todo/infra/container",
    "backend/todo/presentation/list-todos.api",
    "backend/other/domain/other",
    "backend/shared/presentation/http-error",
    "features/todo",
    "shared/x",
    "app/globals.css",
  ].map((to) => `domain: backend/todo/domain/bad-domain.ts → ${to}`),
  "domain: backend/shared/domain/bad-shared-domain.ts → backend/shared/presentation/http-error",
  ...[
    "backend/todo/infra/container",
    "backend/todo/presentation/list-todos.api",
    "backend/shared/presentation/http-error",
    "react",
    "next/navigation",
    "react-dom",
    "features/todo/components/todo-item",
    "app/page",
  ].map(
    (to) => `application: backend/todo/application/bad-application.ts → ${to}`,
  ),
  ...[
    "backend/todo/infra/todo-repository.in-memory",
    "backend/todo/infra/container-helper",
    "backend/todo/domain/todo",
    "backend/todo/domain/todo-factory",
    "backend/todo/domain/todo-entity",
    "next/server",
    "react",
    "features/todo/api/todo-api",
    "backend/other/infra/other-repository.in-memory",
    "app/globals.css",
  ].map(
    (to) =>
      `presentation: backend/todo/presentation/bad-presentation.api.ts → ${to}`,
  ),
  ...[
    "backend/todo/presentation/list-todos.api",
    "backend/todo/presentation/get-todo.api",
    "backend/other/domain/other",
    "backend/other/application/other.query",
    "features/todo",
    "shared/x",
    "app/page",
    "next/headers",
    "react-dom/server",
    "backend/other/infra/container",
  ].map((to) => `infra: backend/todo/infra/bad-infra.ts → ${to}`),
  ...[
    "backend/todo/domain/todo",
    "backend/todo/infra/container",
    "backend/todo/domain/todo-factory",
    "features/todo",
    "app/page",
    "backend/todo/infra/todo-repository.in-memory",
  ].map(
    (to) =>
      `backend-shared: backend/shared/presentation/bad-backend-shared.ts → ${to}`,
  ),
  ...[
    "backend/todo/domain/todo",
    "backend/todo/infra/container",
    "backend/todo/domain/todo-factory",
    "features/todo",
    "app/page",
    "backend/todo/infra/todo-repository.in-memory",
  ].map(
    (to) =>
      `presentation: backend/shared/presentation/bad-backend-shared.ts → ${to}`,
  ),
  ...[
    "backend/other/domain/other",
    "shared/x",
    "backend/other/application/other.query",
  ].map(
    (to) =>
      `application: backend/todo/application/bad-application-2.ts → ${to}`,
  ),
  ...[
    "backend/other/infra/container",
    "backend/other/application/other.query",
    "backend/other/domain/other",
    "shared/x",
  ].map(
    (to) =>
      `presentation: backend/todo/presentation/bad-presentation-2.api.ts → ${to}`,
  ),
  "domain: backend/shared/domain/bad-shared-screen.ts → shared/x",
  "backend-shared: backend/shared/domain/bad-shared-screen.ts → shared/x",
  "backend-placement: backend/todo/p-root.ts",
  "backend-placement: backend/todo/lib/x.ts",
  "backend-placement: backend/x.ts",
  "backend-placement: backend/shared/bad-root.ts",
  "domain: backend/shared-x/domain/x.ts → features/todo",
  "app: app/api-x/route.ts → backend/todo/presentation/list-todos.api",
  "screen-to-backend: features/todo/components/test-helper.tsx → backend/todo/domain/todo",
  "screen-to-backend: features/todo/components/bad-ext.mts → backend/todo/domain/todo",
  "screen-to-backend: features/todo/components/bad-ext.mts → backend/todo/infra/container",
  "screen-to-backend: features/todo/components/bad-ext.cts → backend/todo/presentation/get-todo.api",
  "screen-to-backend: features/todo/components/bad-ext.mjs → backend/shared/presentation/http-error",
  "screen-to-backend: features/todo/components/bad-ext.cjs → backend/todo/infra/todo-repository.in-memory",
  "backend-shared: backend/shared/bad-root.ts → backend/todo/application/create-todo.command",
  ...[
    "features/todo/components/todo-item",
    "features/todo/screens/todo-screen/todo-screen.hook",
    "backend/todo/presentation/list-todos.api",
    "backend/todo/presentation/get-todo.api",
    "features/todo/api/todo-api",
    "features/todo-extra/components/y",
  ].map((to) => `app: app/bad-page.tsx → ${to}`),
  "app: app/todo/[id]/bad.jsx → features/todo/components/todo-item",
  ...[
    "backend/todo/infra/container",
    "backend/todo/application/create-todo.command",
    "next/server",
    "features/todo",
    "backend/todo/presentation/update-todo",
    "backend/shared/presentation/http-error",
    "shared/x",
  ].map((to) => `app-api: app/api/todos/bad-route.ts → ${to}`),
];

// must-pass: 許可される参照を網羅する。今のリポジトリの本番コードにある import の形
// （`git grep -h "from \"" -- '*.ts' '*.tsx'` で列挙したもの）をすべて含め、alias と相対の両方を置く。
// コメント・文字列の中の import 風の文字列、from の無い `export type {...};`、テストファイル・TS 以外のファイルも置く。
const MUST_PASS_FILES: Record<string, string> = {
  "app/layout.tsx": lines(
    'import type { Metadata } from "next";',
    'import { Inter } from "next/font/google";',
    'import "./globals.css";',
  ),
  "app/globals.css": "body { margin: 0; }",
  "app/page.tsx": lines(
    'import { TodoScreen } from "@/features/todo";',
    "const lazy = import(`@/features/todo`);",
    'import { x } from "@/shared/x";',
    'import { useState } from "react";',
    'import Link from "next/link";',
  ),
  "app/todo/[id]/page.tsx": lines(
    'import { TodoDetailScreen } from "@/features/todo";',
    'import { TodoScreen } from "../../../features/todo/index";',
  ),
  "app/api/todos/route.ts": lines(
    'export { POST } from "@/backend/todo/presentation/create-todo.api";',
    'export { GET } from "@/backend/todo/presentation/list-todos.api";',
  ),
  "app/api/todos/[id]/route.ts": lines(
    'export { DELETE } from "@/backend/todo/presentation/delete-todo.api";',
    'export { GET } from "@/backend/todo/presentation/get-todo.api";',
    'export { PUT } from "@/backend/todo/presentation/update-todo.api";',
    'export { PUT as PUT2 } from "../../../../backend/todo/presentation/update-todo.api";',
  ),
  "features/todo/index.ts": lines(
    'export { TodoDetailScreen } from "./screens/todo-detail-screen/todo-detail-screen";',
    'export { TodoScreen } from "./screens/todo-screen/todo-screen";',
  ),
  "features/todo/api/todo-api.ts": lines(
    'import type { ErrorResponse } from "@/backend/shared/presentation/http-error";',
    "import type {",
    "  CreateTodoRequest,",
    "  CreateTodoResponse,",
    '} from "@/backend/todo/presentation/create-todo.api";',
    'import type { GetTodoResponse } from "@/backend/todo/presentation/get-todo.api";',
    "import type {",
    "  ListTodosResponse,",
    "  TodoDto,",
    '} from "@/backend/todo/presentation/list-todos.api";',
    "import type {",
    "  UpdateTodoRequest,",
    "  UpdateTodoResponse,",
    '} from "@/backend/todo/presentation/update-todo.api";',
    'import { type UpdateTodoRequest as Req, type UpdateTodoResponse as Res } from "../../../backend/todo/presentation/update-todo.api";',
    'export type { DeleteTodoResponse } from "@/backend/todo/presentation/delete-todo.api";',
    "export type {",
    "  CreateTodoRequest,",
    "  CreateTodoResponse,",
    "  ErrorResponse,",
    "};",
    'const BASE_PATH = "/api/todos";',
  ),
  "features/todo/components/todo-item.tsx": lines(
    'import Link from "next/link";',
    'import type { TodoDto } from "@/features/todo/api/todo-api";',
  ),
  "features/todo/screens/todo-screen/todo-screen.tsx": lines(
    '"use client";',
    'import { TodoItem } from "../../components/todo-item";',
    'import { useTodoScreen } from "./todo-screen.hook";',
  ),
  "features/todo/screens/todo-screen/todo-screen.hook.ts": lines(
    'import { useCallback, useEffect, useRef, useState } from "react";',
    "import {",
    "  listTodos,",
    "  type TodoDto,",
    "  updateTodo,",
    '} from "@/features/todo/api/todo-api";',
  ),
  "features/todo/screens/todo-detail-screen/todo-detail-screen.tsx": lines(
    '"use client";',
    'import Link from "next/link";',
    'import { useTodoDetailScreen } from "./todo-detail-screen.hook";',
  ),
  "features/todo/screens/todo-detail-screen/todo-detail-screen.hook.ts": lines(
    'import { useCallback, useEffect, useRef, useState } from "react";',
    "import {",
    "  getTodo,",
    "  type TodoDto,",
    "  updateTodo,",
    '} from "@/features/todo/api/todo-api";',
  ),
  // 別 feature からは index だけ（alias と相対、index の明示あり・なし）。画面側の shared/ は参照してよい。
  "features/other/components/uses-todo.jsx": lines(
    'import { TodoScreen } from "@/features/todo";',
    'import { TodoDetailScreen } from "../../todo/index";',
    'import { x } from "@/shared/x";',
  ),
  "shared/x.js": lines('import { useState } from "react";'),
  "shared/ui/button.tsx": lines('import { x } from "../x";'),
  // コメント・文字列の中の import 風の文字列は参照ではない。
  "features/todo/components/notes.ts": lines(
    '// import { GET } from "@/backend/todo/presentation/list-todos.api";',
    '/* export { x } from "@/app/page"; */',
    "/**",
    ' * 例: import("@/backend/todo/infra/container")',
    ' * import "@/backend/todo/domain/todo";',
    " */",
    "export const single = 'import { GET } from \"@/backend/x\";';",
    "export const double = \"import('@/backend/y')\";",
    "export const side = 'import \"@/backend/z\"';",
    "export const template = `",
    'import { a } from "@/app/page";',
    "`;",
    'export const url = "https://example.com/import/from"; import { useState } from "react";',
  ),
  "backend/shared/domain/domain-error.ts": lines(
    "export class DomainError extends Error {}",
  ),
  "backend/shared/presentation/http-error.ts": lines(
    "import {",
    "  DomainError,",
    "  type DomainErrorCode,",
    '} from "@/backend/shared/domain/domain-error";',
  ),
  "backend/shared/presentation/json-body.ts": lines(
    'import { InvalidRequestError } from "@/backend/shared/presentation/http-error";',
    'import { toErrorResponse } from "./http-error";',
  ),
  "backend/todo/domain/todo.ts": lines(
    'import { randomUUID } from "node:crypto";',
    'import { DomainError } from "@/backend/shared/domain/domain-error";',
    'import { DomainError as E } from "../../shared/domain/domain-error";',
  ),
  "backend/todo/domain/todo-repository.ts": lines(
    'import type { Todo } from "@/backend/todo/domain/todo";',
    'import { Todo as T } from "./todo";',
  ),
  "backend/todo/application/create-todo.command.ts": lines(
    'import { Todo } from "@/backend/todo/domain/todo";',
    'import type { TodoRepository } from "@/backend/todo/domain/todo-repository";',
  ),
  "backend/todo/application/get-todo.query.ts": lines(
    'import { DomainError } from "@/backend/shared/domain/domain-error";',
    'import type { Todo } from "../domain/todo";',
    'import { DomainError as E } from "../../shared/domain/domain-error";',
    'import { ListTodosQuery } from "./list-todos.query";',
    'import type { TodoRepository } from "@/backend/todo/domain/todo-repository";',
  ),
  "backend/todo/application/list-todos.query.ts": lines(
    'import type { Todo } from "@/backend/todo/domain/todo";',
    'import type { TodoRepository } from "@/backend/todo/domain/todo-repository";',
  ),
  "backend/todo/application/update-todo.command.ts": lines(
    'import { DomainError } from "@/backend/shared/domain/domain-error";',
    'import type { Todo } from "@/backend/todo/domain/todo";',
    'import type { TodoRepository } from "@/backend/todo/domain/todo-repository";',
  ),
  "backend/todo/application/delete-todo.command.ts": lines(
    'import { DomainError } from "@/backend/shared/domain/domain-error";',
    'import type { TodoRepository } from "@/backend/todo/domain/todo-repository";',
  ),
  "backend/todo/presentation/list-todos.api.ts": lines(
    'import { toErrorResponse } from "@/backend/shared/presentation/http-error";',
    'import type { Todo } from "@/backend/todo/domain/todo";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "@/backend/todo/infra/container";',
  ),
  "backend/todo/presentation/create-todo.api.ts": lines(
    "import {",
    "  InvalidRequestError,",
    "  toErrorResponse,",
    '} from "@/backend/shared/presentation/http-error";',
    'import { readJsonObject } from "@/backend/shared/presentation/json-body";',
    'import { todoContainer } from "../infra/container";',
    'import { DomainError } from "../../shared/domain/domain-error";',
    'export type { Todo } from "../domain/todo";',
    'import { type Todo as T } from "@/backend/todo/domain/todo";',
  ),
  "backend/todo/presentation/reexport.api.ts": lines(
    'import type { GetTodoResponse } from "./get-todo.api";',
    'import type { ListTodosQuery } from "@/backend/todo/application/list-todos.query";',
    'import { GetTodoQuery } from "../application/get-todo.query";',
    'export { toErrorResponse } from "../../shared/presentation/http-error";',
  ),
  "shared/y.mts": lines(
    'import { x } from "./x";',
    'const lazy = import(`./x`, { with: { type: "json" } });',
  ),
  "backend/todo/presentation/get-todo.api.ts": lines(
    'import { toErrorResponse } from "@/backend/shared/presentation/http-error";',
    'import type { Todo } from "@/backend/todo/domain/todo";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "@/backend/todo/infra/container";',
  ),
  "backend/todo/presentation/update-todo.api.ts": lines(
    "import {",
    "  InvalidRequestError,",
    "  toErrorResponse,",
    '} from "@/backend/shared/presentation/http-error";',
    'import { readJsonObject } from "@/backend/shared/presentation/json-body";',
    'import type { Todo } from "@/backend/todo/domain/todo";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "@/backend/todo/infra/container";',
  ),
  "backend/todo/presentation/delete-todo.api.ts": lines(
    'import { toErrorResponse } from "@/backend/shared/presentation/http-error";',
    "import {",
    "  type TodoContainer,",
    "  todoContainer,",
    '} from "@/backend/todo/infra/container";',
  ),
  "backend/todo/infra/container.ts": lines(
    'import { CreateTodoCommand } from "@/backend/todo/application/create-todo.command";',
    'import { DeleteTodoCommand } from "@/backend/todo/application/delete-todo.command";',
    'import { GetTodoQuery } from "../application/get-todo.query";',
    'import { ListTodosQuery } from "@/backend/todo/application/list-todos.query";',
    'import { UpdateTodoCommand } from "@/backend/todo/application/update-todo.command";',
    'import type { TodoRepository } from "@/backend/todo/domain/todo-repository";',
    'import { Todo } from "../domain/todo";',
    'import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";',
    'import { InMemoryTodoRepository as R } from "./todo-repository.in-memory";',
    'import { DomainError } from "@/backend/shared/domain/domain-error";',
    'import { randomUUID } from "node:crypto";',
  ),
  "backend/todo/infra/todo-repository.in-memory.ts": lines(
    'import type { Todo } from "@/backend/todo/domain/todo";',
    'import type { TodoRepository } from "@/backend/todo/domain/todo-repository";',
  ),
  // テストファイルと TS / JS 以外のファイルは検査しない。
  "backend/todo/presentation/list-todos.api.test.ts": lines(
    'import { InMemoryTodoRepository } from "@/backend/todo/infra/todo-repository.in-memory";',
  ),
  "features/todo/components/todo-item.test.tsx": lines(
    'import { listTodosApi } from "@/backend/todo/presentation/list-todos.api";',
  ),
  "features/todo/README.md":
    'import { GET } from "@/backend/todo/infra/container";',
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
  const from = "features/todo/screens/todo-screen/todo-screen.tsx";

  it('"@/" はリポジトリ直下からのパスにする', () => {
    expect(
      toReference(from, {
        specifier: "@/backend/todo/presentation/list-todos.api",
        typeOnly: true,
      }),
    ).toEqual({
      from,
      to: "backend/todo/presentation/list-todos.api",
      own: true,
      typeOnly: true,
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
      to: "features/todo/components/todo-item",
      own: true,
      typeOnly: false,
    });
  });

  it("それ以外はパッケージとして specifier のまま扱う", () => {
    expect(
      toReference(from, { specifier: "next/link", typeOnly: false }),
    ).toEqual({ from, to: "next/link", own: false, typeOnly: false });
  });
});
