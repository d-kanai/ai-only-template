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
const SOURCE_FILE = /\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;

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
// 限界（仕様として受け入れる）: 正規表現リテラル（/"/ や /\/\//）は文字列やコメントの開始と誤認しうる。テンプレートリテラルの
//   ${} の中にさらに ` がある入れ子は正しく区切れない。どちらも import 文の近くに書くことはまれで、誤認しても
//   多く拾う（違反を見逃す）方向ではなく、コメントを残す・消しすぎる方向に働く。失敗したときに出る「ファイル → 参照先」を
//   見て判断できる。
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
const IMPORT_EXPORT_FROM =
  /\b(?:import|export)\s+(type\s+)?([\w\s{},*$]*?)\s*\bfrom\s*["']([^"']+)["']/g;
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

type Rule = {
  // テスト名。rules/code/architecture.md の文言に対応する仕様文。
  name: string;
  appliesTo: (from: string) => boolean;
  isViolation: (ref: Reference) => boolean;
};

// 1 規則 = 1 テスト。規則を足す・変えるときは rules/code/architecture.md と合わせてここを直す。
const RULES: Rule[] = [
  {
    // 「`features/<feature>/` の `api/` 以外は backend を参照せず、`api/` が re-export した型を使う」
    name: "features/<f>/ の api/ 以外は backend/ を参照しない",
    appliesTo: (from) =>
      featureOf(from) !== undefined && !/^features\/[^/]+\/api\//.test(from),
    isViolation: (ref) => ownUnder(ref, "backend"),
  },
  {
    // 「画面側で backend を参照してよいのは `features/<feature>/api/` だけ。参照先は presentation の api ファイルと
    //   `backend/shared/presentation/` で、いずれも `import type` のみ」
    // WHY 型だけに限る: import type はビルド時に消えるので、サーバ専用のコードが画面のバンドルに入らない。
    name: "features/<f>/api/ から backend/ への参照は型だけで、参照先は backend/<x>/presentation/*.api か backend/shared/presentation/ だけ",
    appliesTo: (from) => /^features\/[^/]+\/api\//.test(from),
    isViolation: (ref) =>
      ownUnder(ref, "backend") &&
      !(
        ref.typeOnly &&
        (PRESENTATION_API.test(ref.to) ||
          isUnder(ref.to, "backend/shared/presentation"))
      ),
  },
  {
    // 「feature 同士は原則 import しない。必要なときは相手の `index.ts` だけを import する」
    name: "別の feature を参照するときは features/<other>（index）だけ",
    appliesTo: (from) => featureOf(from) !== undefined,
    isViolation: (ref) =>
      ownUnder(ref, "features") &&
      featureOf(`${ref.to}/`) !== featureOf(ref.from) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「`shared/` は `features/` を import しない（逆向きの依存を作らない）」
    name: "shared/ は features/ を参照しない",
    appliesTo: (from) => isUnder(from, "shared"),
    isViolation: (ref) => ownUnder(ref, "features"),
  },
  {
    // 「domain は Next・React・DB に依存させない」「依存してよい先は backend/shared だけ」
    // WHY node:* は許す: Entity の id の生成（node:crypto の randomUUID）などに使い、フレームワークや永続化の都合ではないため。
    name: "backend/**/domain/ は next・react・画面側・自 feature の application / presentation / infra を参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "domain",
    isViolation: (ref) => {
      const target = backendLayerOf(ref.to);
      const sameFeatureOuterLayer =
        ref.own &&
        target !== undefined &&
        target.feature === backendLayerOf(ref.from)?.feature &&
        target.layer !== "domain";
      return usesFramework(ref) || usesScreenSide(ref) || sameFeatureOuterLayer;
    },
  },
  {
    // 「application の依存してよい先は domain と backend/shared」「依存の向き: presentation → application → domain」
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
    // WHY next も禁止する: api ファイルは Web 標準の Request / Response で書き、Next を起動せずにテストできるようにしているため
    //   （rules/code/architecture.md の「テストの置き方」）。
    name: "backend/**/presentation/ は infra のうち infra/container 以外・next・react・画面側を参照しない",
    appliesTo: (from) => backendLayerOf(from)?.layer === "presentation",
    isViolation: (ref) => {
      const infraOtherThanContainer =
        ref.own &&
        backendLayerOf(ref.to)?.layer === "infra" &&
        !/^backend\/[^/]+\/infra\/container$/.test(ref.to);
      return (
        infraOtherThanContainer || usesFramework(ref) || usesScreenSide(ref)
      );
    },
  },
  {
    // 「backend/shared/: feature をまたいで使う型や処理」。各 feature が shared に依存するので、逆向きにすると循環する。
    name: "backend/shared/ は backend/<feature>/・画面側を参照しない",
    appliesTo: (from) => isUnder(from, "backend/shared"),
    isViolation: (ref) =>
      (ownUnder(ref, "backend") && !isUnder(ref.to, "backend/shared")) ||
      usesScreenSide(ref),
  },
  {
    // 「`app/` はルーティングだけ。`page.tsx` は screen を返すだけ」「feature の外から import してよいのは index.ts だけ」
    // WHY 自前のコード（features/ backend/ shared/）への参照だけを検査する: 画面の組み立ては feature の公開 API に閉じ込め、
    //   app/ から feature の内部や backend・shared を直接使ってロジックを書くのを防ぐため。
    // WHY パッケージと app/ の中の相対参照は検査しない: レイアウトが next/font や他のパッケージを使うこと、Next の慣例どおり
    //   import "./globals.css" のように app/ のファイルを読むことはルーティングの範囲で正当で、許可の一覧で縛ると
    //   追加のたびに規則を直すことになる（オーケストレータの判断。Issue #47）。
    name: "app/（app/api 以外）が features/・backend/・shared/ を参照するときは features/<f>（index）だけ",
    appliesTo: (from) => isUnder(from, "app") && !isUnder(from, "app/api"),
    isViolation: (ref) =>
      ["features", "backend", "shared"].some((dir) => ownUnder(ref, dir)) &&
      !FEATURE_INDEX.test(ref.to),
  },
  {
    // 「`app/api/**/route.ts` は backend の api ファイルが export する HTTP メソッド名の関数を re-export するだけ」
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
