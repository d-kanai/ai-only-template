// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはソースを文字列として読むだけで DOM を使わないため、
//   jsdom の初期化を省き、ブラウザ相当の globals が Node の API と混ざる余地をなくすため node 環境で動かす。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
//   TypeScript の構文木までは要らない。依存（dependency-cruiser など）を足すほどの必要がない（rules/code/architecture.md の
//   入力検証と同じ判断）。抽出の限界は stripComments / extractImports の WHY に書き、仕様を下の describe で固定する。

const repoRoot = import.meta.dirname;

// 検査の対象にするディレクトリ（rules/code/architecture.md の「全体像」）。shared/ はまだ無いが、作ったときに自動で対象になるよう入れる。
const SOURCE_DIRS = ["app", "features", "backend", "shared"];

// WHY テストを対象外にする: テストは組み立てのために規則の外側を参照する（例: presentation のテストが
//   infra の InMemory リポジトリを new して createTodoContainer に渡す。rules/code/architecture.md の「テストの置き方」）。
//   規則は本番のコードの依存の向きを縛るもので、テストの組み立てまで縛ると正当なテストが書けなくなる。
// WHY .js / .jsx も対象にする: tsconfig.json が allowJs: true で、JS のファイルも同じビルドに入り、同じ規則の対象になるため。
const SOURCE_FILE = /\.[jt]sx?$/;
const TEST_FILE = /\.test\.[jt]sx?$/;

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
const SIDE_EFFECT_IMPORT = /\bimport\s*["']([^"']+)["']/g;
// `import("x")`（dynamic import）。文字列以外（変数）を渡したものは参照先を静的に決められないため拾わない。
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

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

function findValueImports(code: string, pattern: RegExp): Located[] {
  return [...code.matchAll(pattern)].map((match) => ({
    index: match.index,
    specifier: match[1] ?? "",
    typeOnly: false,
  }));
}

// ソースから import / re-export / dynamic import の参照を、書かれた順に取り出す。
// 限界（仕様として受け入れる）: 文字列リテラルの中に import 文の形の文字列があると参照として拾う（本番のコードに書くことはまれで、
//   拾った場合は多く検出する方向＝見逃さない方向に働く）。`require()` と `import x = require()` は拾わない（本リポジトリは ESM だけ）。
function extractImports(source: string): ImportStatement[] {
  const code = stripComments(source);
  return [
    ...findFromStatements(code),
    ...findValueImports(code, SIDE_EFFECT_IMPORT),
    ...findValueImports(code, DYNAMIC_IMPORT),
  ]
    .sort((a, b) => a.index - b.index)
    .map(({ specifier, typeOnly }) => ({ specifier, typeOnly }));
}

// WHY 拡張子を外す: 参照先の規則（`backend/<x>/presentation/*.api` など）を拡張子なしの形で 1 通りに書くため。
//   import には通常拡張子を書かないが、書いた場合（"./x.ts"）も同じ参照として扱う。
const CODE_EXTENSION = /\.(?:tsx?|jsx?|mjs|cjs)$/;

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
    const absolute = resolve(repoRoot, dirname(from), specifier);
    const to = toPosix(relative(repoRoot, absolute)).replace(
      CODE_EXTENSION,
      "",
    );
    return { from, to, own: true, typeOnly };
  }
  return { from, to: specifier, own: false, typeOnly };
}

function listSourceFiles(dir: string): string[] {
  if (!existsSync(join(repoRoot, dir))) {
    return [];
  }
  return readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
    .map((path) => toPosix(join(dir, path)))
    .filter((path) => SOURCE_FILE.test(path) && !TEST_FILE.test(path));
}

function collectReferences(): Reference[] {
  return SOURCE_DIRS.flatMap(listSourceFiles).flatMap((file) =>
    extractImports(readFileSync(join(repoRoot, file), "utf8")).map(
      (statement) => toReference(file, statement),
    ),
  );
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

// "backend/todo/presentation/..." → { feature: "todo", layer: "presentation" }
function backendLayerOf(
  path: string,
): { feature: string; layer: string } | undefined {
  const match =
    /^backend\/([^/]+)\/(domain|application|presentation|infra)(?:\/|$)/.exec(
      path,
    );
  return match === null
    ? undefined
    : { feature: match[1] ?? "", layer: match[2] ?? "" };
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

// 画面側（features / app）への参照。backend の各層はこれを参照しない（依存の向きは app → features、app/api → backend の一方向）。
function usesScreenSide(ref: Reference): boolean {
  return ownUnder(ref, "features") || ownUnder(ref, "app");
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

// backend/shared/ のうち、domain（DomainError など）と層に属さないものか。
// WHY backend/shared/ の presentation などを外す: domain / infra から presentation を参照すると、backend/shared の中でも
//   依存の向き（presentation → application → domain）が逆になるため。
function isBackendSharedInner(path: string): boolean {
  const layer = backendLayerOf(path)?.layer;
  return (
    isUnder(path, "backend/shared") &&
    (layer === undefined || layer === "domain")
  );
}

function domainMayUse(ref: Reference): boolean {
  const self = backendLayerOf(ref.from)?.feature;
  return (
    isUnder(ref.to, `backend/${self}/domain`) || isBackendSharedInner(ref.to)
  );
}

const INFRA_MAY_USE_LAYERS = new Set(["domain", "application", "infra"]);

function infraMayUse(ref: Reference): boolean {
  const target = backendLayerOf(ref.to);
  const sameFeature =
    target !== undefined &&
    target.feature === backendLayerOf(ref.from)?.feature &&
    INFRA_MAY_USE_LAYERS.has(target.layer);
  return sameFeature || isUnder(ref.to, "backend/shared");
}

function isInfraOtherThanContainer(ref: Reference): boolean {
  return (
    ref.own &&
    backendLayerOf(ref.to)?.layer === "infra" &&
    !/^backend\/[^/]+\/infra\/container$/.test(ref.to)
  );
}

// feature の domain（backend/shared/domain 以外）への値の参照か。
function isValueImportOfFeatureDomain(ref: Reference): boolean {
  const target = ref.own ? backendLayerOf(ref.to) : undefined;
  return (
    !ref.typeOnly && target?.layer === "domain" && target.feature !== "shared"
  );
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
    // WHY 自前コードを許可の一覧で書く: domain はビジネスルールだけを持ち、他 feature のどの層や画面側にも依存させないため。
    //   自 feature の domain/ の中の参照（Repository の interface が Entity を参照するなど）は許す。
    // WHY node:* などのパッケージは next・react 以外許す: Entity の id の生成（node:crypto の randomUUID）などに使い、
    //   フレームワークや永続化の都合ではないため。
    id: "domain",
    name: "backend/<f>/domain/ が参照してよい自前コードは backend/<f>/domain/ と backend/shared/ だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "domain",
    isViolation: (ref) => usesFramework(ref) || (ref.own && !domainMayUse(ref)),
  },
  {
    // 「application の依存してよい先は domain と backend/shared」「依存の向き: presentation → application → domain」
    id: "application",
    name: "backend/**/application/ は presentation・infra・next・react・画面側を参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "application",
    isViolation: (ref) => {
      const layer = ref.own ? backendLayerOf(ref.to)?.layer : undefined;
      return (
        layer === "presentation" ||
        layer === "infra" ||
        usesFramework(ref) ||
        usesScreenSide(ref)
      );
    },
  },
  {
    // 「presentation は query / command を infra/container.ts で組み立てたコンテナからだけ受け取る。Repository の実装を直接 new しない」
    // 「domain（Entity の型の参照のみ。query / command が返す Entity を DTO に変換するため `import type { Todo }` する）」
    // WHY domain は型だけ: Entity の生成や操作は application（query / command）を通し、presentation が domain のロジックを
    //   直接呼ばないようにするため。backend/shared/domain（DomainError）は「依存してよい先」の backend/shared に含まれ、
    //   エラーの変換（instanceof DomainError）に値として使うため対象外にする。
    // WHY next も禁止する: api ファイルは Web 標準の Request / Response で書き、Next を起動せずにテストできるようにしているため
    //   （rules/code/architecture.md の「テストの置き方」）。
    id: "presentation",
    name: "backend/**/presentation/ は infra のうち infra/container 以外・next・react・画面側を参照せず、domain は型だけを参照する",
    appliesTo: (from) => backendLayerOf(from)?.layer === "presentation",
    isViolation: (ref) =>
      isInfraOtherThanContainer(ref) ||
      isValueImportOfFeatureDomain(ref) ||
      usesFramework(ref) ||
      usesScreenSide(ref),
  },
  {
    // 「infra: Repository の実装、container.ts（組み立て = DI）」「依存してよい先: domain（interface を実装する）、
    //   application（container で組み立てる）」。container.ts が同じ infra の Repository の実装を組み立てるので、自 feature の
    //   infra/ の中の参照も許す。backend/shared/ は他の層と同じく feature をまたぐ共通部品として許す。
    id: "infra",
    name: "backend/<f>/infra/ が参照してよい自前コードは backend/<f>/ の domain・application・infra と backend/shared/ だけで、next・react も参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "infra",
    isViolation: (ref) => usesFramework(ref) || (ref.own && !infraMayUse(ref)),
  },
  {
    // 「backend/shared/: feature をまたいで使う型や処理」。各 feature が shared に依存するので、逆向きにすると循環する。
    id: "backend-shared",
    name: "backend/shared/ は backend/<feature>/・画面側を参照しない",
    appliesTo: (from) => isUnder(from, "backend/shared"),
    isViolation: (ref) =>
      (ownUnder(ref, "backend") && !isUnder(ref.to, "backend/shared")) ||
      usesScreenSide(ref),
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

describe("依存の向き（rules/code/architecture.md）", () => {
  const references = collectReferences();

  it("検査の対象から参照を取り出せている（抽出が壊れて 0 件になり、すべての規則が素通りするのを防ぐ）", () => {
    expect(references.length).toBeGreaterThan(0);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      // 失敗時にどのファイルがどこを参照しているかが出力に出るよう、違反を「ファイル → 参照先」の一覧にして空配列と比較する。
      const violations = references
        .filter((ref) => rule.appliesTo(ref.from) && rule.isViolation(ref))
        .map((ref) => `${ref.from} → ${ref.to}`);
      expect(violations).toEqual([]);
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
        "@/backend/todo/domain/todo",
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
    ],
    allowed: [
      [
        "features/todo/api/todo-api.ts",
        "@/backend/todo/presentation/list-todos.api",
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
    ],
    allowed: [["features/todo/components/x.ts", "next/link", "value"]],
  },
  "shared-to-features": {
    violating: [["shared/x.ts", "@/features/todo", "value"]],
    allowed: [["shared/x.ts", "react", "value"]],
  },
  domain: {
    violating: [
      ["backend/todo/domain/x.ts", "next/server", "value"],
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
    ],
    allowed: [
      ["backend/todo/domain/x.ts", "@/backend/todo/domain/todo", "value"],
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
        "@/backend/todo/presentation/list-todos.api",
        "type",
      ],
      ["backend/todo/application/x.ts", "react", "value"],
    ],
    allowed: [
      [
        "backend/todo/application/x.ts",
        "@/backend/todo/domain/todo-repository",
        "type",
      ],
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
      ["backend/todo/presentation/x.api.ts", "next/server", "value"],
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/todo/domain/todo",
        "value",
      ],
    ],
    allowed: [
      [
        "backend/todo/presentation/x.api.ts",
        "@/backend/todo/infra/container",
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
      ["backend/shared/presentation/x.ts", "@/features/todo", "value"],
    ],
    allowed: [
      [
        "backend/shared/presentation/x.ts",
        "@/backend/shared/domain/domain-error",
        "value",
      ],
    ],
  },
  app: {
    violating: [
      ["app/page.tsx", "@/backend/todo/presentation/list-todos.api", "value"],
      ["app/page.tsx", "@/features/todo/components/todo-item", "value"],
    ],
    allowed: [
      ["app/page.tsx", "@/features/todo", "value"],
      ["app/page.tsx", "@/shared/x", "value"],
      ["app/layout.tsx", "./globals.css", "value"],
      ["app/page.tsx", "react", "value"],
    ],
  },
  "app-api": {
    violating: [
      ["app/api/todos/route.ts", "@/backend/todo/infra/container", "value"],
      ["app/api/todos/route.ts", "next/server", "value"],
    ],
    allowed: [
      [
        "app/api/todos/route.ts",
        "@/backend/todo/presentation/list-todos.api",
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
  const ref = toReference(from, { specifier, typeOnly: kind === "type" });
  return rule.appliesTo(ref.from) && rule.isViolation(ref);
}

describe("規則ごとの判定", () => {
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
