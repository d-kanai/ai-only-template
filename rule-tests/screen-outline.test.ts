// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはソースを文字列として読んで構文解析するだけで
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
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import {
  type FunctionDeclaration,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxSelfClosingElement,
  isJsxText,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceExport,
  isParenthesizedExpression,
  isReturnStatement,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type ReturnStatement,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";

// 画面のファイル（apps/frontend_customer/features/<f>/screens/<name>-screen/<name>-screen.tsx）を、最初の関数を読めば画面の
//   レイアウトが分かる形にそろえることを、機械的に検査するテスト（Issue #292）。
// 形（daiki の依頼 2026-10-02「screen の中身が、見て画面レイアウトが想像できるように、ファイル内で component private で
//   切り出して欲しい」）:
//   export function TodoScreen() {
//     const { ... } = useTodoScreen();
//     return (
//       <Layout>
//         <TitleSection />
//         <NewTodoForm ... />
//         <TodoListSection ... />
//       </Layout>
//     );
//   }
//   // ↓ ファイルの下の方に、export しない部品（Section / Form）を atom で描く。
// WHY 骨組みだけにする: 画面のファイルは atom を並べた JSX が長くなり、どこに何が並ぶかを JSX 全体を読まないと分からなかった。
//   最初の関数を `<Layout>` と Section / Form の名前の並びだけにすれば、ファイルを開いて最初の関数を見るだけで画面の
//   レイアウトが分かる。中身（atom の並べ方・出し分け）は名前の付いた部品に閉じる。
// 違反にするもの（規則）:
//   - screen-outline-placement: features/<f>/screens/ の下のコード（.ts / .tsx / .js / .jsx / .mts / .cts / .mjs / .cjs。
//     テストの `*.test.*` は除く）は、screens/<name>-screen/ の直下の `<name>-screen.tsx`（画面）・`<name>-screen.hook.ts`（hook）・
//     `<name>-screen.messages.ts`（辞書）だけ。screens の直下のファイル・`-screen` で終わらないディレクトリ・名前のそろって
//     いないファイル・入れ子・拡張子の違うファイル（`.hook.tsx` など）は違反。
//     WHY: 下の 5 規則は名前のそろった画面のファイルだけを対象に列挙するので、`screens/settings/settings.tsx` のような
//     名前のそろっていない画面は列挙されず、5 規則をすべてすり抜ける（reviewer の指摘）。置き方を止めて、画面を必ず列挙に載せる。
//     部品を別ファイルに切り出すのも違反（部品は画面のファイルの中の private か、features/<f>/components/ に置く）。
//   - screen-outline-single-export: 画面のファイルが export する値は、画面の関数 1 つ（`export function <Name>Screen`。
//     <Name> はファイル名の PascalCase）だけ。型（type / interface・export type）は数えない。
//     WHY: 部品を export すると画面の外から使われ、画面の中だけの部品（private）でなくなる。共有したい部品は
//     features/<f>/components/ に置く。`export default` と `export const` の画面を許さないのは、最初の関数の形を 1 つにそろえるため。
//   - screen-outline-layout-root: 画面の関数の return の根（かっこは外す）は、atom の Layout（`@/shared/ui/atoms/layout` から
//     名前 Layout で値として取り込んだもの。`import type { Layout }` と `import { type Layout }` は値でないので数えない）の要素。WHY: 骨組みの外枠を全画面で同じにし、atom を経ずに外枠を作らせない。
//   - screen-outline-layout-children: Layout の直下に置けるのは、同じファイルの最上位で定義した export しない部品
//     （function か const）のうち、名前が `<何か>Section` か `<何か>Form` のものの要素だけ。props は渡してよい。
//     空白と、中身がコメントだけの `{/* */}` は数えない。文字列・式（`{cond ? … : …}`・`.map`）・Fragment・atom・素の要素・
//     import した部品・export した部品・ほかの名前の部品は違反。
//     WHY: 骨組みに式や atom が混ざると、また JSX を読まないとレイアウトが分からなくなる。読み込み中・エラーの出し分けは Section の中に入れる。
//     WHY 名前を Section / Form で終わらせる: 骨組みを読んだときに、表示のまとまり（Section）と入力のまとまり（Form）が名前で分かる。
//   - screen-outline-single-return: 画面の関数の return は 1 つ（中で定義した関数の return は数えない）。0 個も違反。
//     WHY: 早期 return（`if (isLoading) return <Text />`）で骨組みを分けると、状態ごとに別のレイアウトになり、最初の関数を
//     見ても画面の形が 1 つに決まらない。
//   - screen-outline-use-client（Issue #332）: 画面のファイルの最初の文は "use client" のディレクティブ（`"use client";` か
//     `'use client';`。前にコメントがあってもよい）。無い・import や別のディレクティブ（"use strict"）の後・バッククォート・
//     かっこで包んだもの・式の一部（`"use client".trim()`）・エスケープを含むもの（`"use\u0020client"`）は違反。
//     WHY: 画面は hook（useState・useEffect）を使うので Client Component でなければならない（.claude/rules/code/frontend.md の
//     「画面の骨組み」の表の「画面の関数」）。"use client" が無いと、app/ の page.tsx（Server Component）から import したときに Server Component として
//     扱われ、hook の呼び出しでビルド・描画が失敗する。レビューでは書き忘れを見落としうる。
//     WHY 最初の文（コメントの後は可）: Next 16.3.6 の文書（node_modules/next/dist/docs/01-app/03-api-reference/01-directives/
//     index.md）は「must appear at the top of a file, before any imports」とする。コメントは文ではない（構文木の statements に
//     入らない）ので、前にあってもディレクティブの位置は変わらない。
//     WHY ソースの文字を比べる（文字列の値を比べない）: ディレクティブは引用符の中の文字がそのまま "use client" であるものだけ。
//     値で比べると `("use client")`（式）や `"use\u0020client"`（値は同じ）を通してしまう。エスケープを含むものを Next が
//     ディレクティブとみなすかは未確認で、多く検出する方向に倒す。
//     WHY 別のディレクティブの後を違反にする（JavaScript の仕様ではディレクティブの並びの 2 つ目以降もディレクティブ）: 画面に
//     ほかのディレクティブは要らず、「最初の文」の 1 つの形にそろえる（厳しい方向）。
// 対象: apps/frontend_customer/features/<f>/screens/<name>-screen/<name>-screen.tsx（ディレクトリとファイルの名前がそろったもの）。
//   0 件なら実ファイルのテストで失敗させる（0 件なら違反も 0 件で常に緑になるため）。置き方の規則は features/<f>/screens/ の
//   下のテスト以外のコードすべてを見る。
// 限界（見ないもの）: Section / Form の要素の子（`<XSection><Text /></XSection>`）は見ない（props の 1 つとして扱う）。部品の中身
//   （atom を使っているか）と、部品がファイルの下の方にあるか（並び順）は見ない（レビューで見る）。Layout は名前と取り込み元の
//   文字列で見る（atom の Layout が中で何を描くかは見ない）。画面の関数の return より前の文（hook の呼び出し以外の処理）は見ない。
//   features/<f>/components/ の部品（todo-item など）と app/ の page.tsx は対象外。置き方の規則はテストの名前・置き場所と、
//   コード以外のファイル（README・画像など）を見ない。シンボリックリンクはたどらない（walk と同じ）。

type RuleId =
  | "screen-outline-placement"
  | "screen-outline-single-export"
  | "screen-outline-layout-root"
  | "screen-outline-layout-children"
  | "screen-outline-single-return"
  | "screen-outline-use-client";

// 最上位の宣言 1 つ（名前と、行を出す節）。
type Declared = { node: Node; name: string };

const repoRoot = join(import.meta.dirname, "..");

// biome-ignore lint/complexity/noStaticOnlyClass: 判定をクラスの static メソッドにまとめる（design-system.test.ts と同じ形）。rule-tests/ は biome.json の override の外なので行ごとに許す。
class ScreenOutlineRule {
  static readonly FRONTEND_ROOT = "apps/frontend_customer";
  static readonly LAYOUT = "Layout";
  static readonly LAYOUT_MODULE = "@/shared/ui/atoms/layout";
  // WHY 前に 1 文字以上要る: 名前が `Form` だけの部品は atom の Form と見分けが付かない。
  static readonly PART_NAME = /^[A-Z]\w*(?:Section|Form)$/;
  // features/<f>/screens/<name>-screen/<name>-screen.tsx（\1 でディレクトリとファイルの名前がそろうことを見る）。
  static readonly SCREEN_FILE =
    /^apps\/frontend_customer\/features\/[^/]+\/screens\/([^/]+-screen)\/\1\.tsx$/;

  static isScreenFile(path: string): boolean {
    return ScreenOutlineRule.SCREEN_FILE.test(path);
  }

  // screens の下の、置き方を検査するファイル（features/<f>/screens/ の下のコード。テストは除く）。
  // WHY コードの拡張子だけ: README や画像まで止めると、画面と関係の無い置き物で落ちる（.DS_Store のような OS の生成物も）。
  //   すり抜けを塞ぎたいのは画面・hook・部品として動くコードなので、TS / JS の拡張子をすべて対象にする（.d.ts も含む）。
  // WHY テストを除く: テストの置き方は testing.md の「置き方」（対象の隣）の規則で、この規則は画面の側の名前をそろえる。
  static readonly PLACEMENT_TARGET =
    /^apps\/frontend_customer\/features\/[^/]+\/screens\/.+\.(?:[cm]?[jt]s|[jt]sx)$/;
  static readonly TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
  // 置いてよい形: screens/<name>-screen/ の直下の <name>-screen.tsx（画面）・.hook.ts（hook）・.messages.ts（辞書）。
  // WHY 辞書も許す: 画面の文言は隣の <name>-screen.messages.ts に置く（frontend.md の「i18n」。今の 2 画面とも持つ）。
  static readonly PLACED_FILE =
    /^apps\/frontend_customer\/features\/[^/]+\/screens\/([^/]+-screen)\/\1(?:\.tsx|\.hook\.ts|\.messages\.ts)$/;

  // screen-outline-placement: 置き方を検査するファイルのうち、置いてよい形でないもの（渡された順）。
  // WHY: 画面のファイルの列挙（SCREEN_FILE）は名前のそろったものだけを拾うので、`screens/settings/settings.tsx` のように
  //   名前のそろっていない画面は列挙されず、骨組みの 5 規則をすべてすり抜ける。置き方で止めて、列挙から漏れる画面を無くす。
  static findPlacementViolations(paths: readonly string[]): string[] {
    return paths.filter(
      (path) =>
        ScreenOutlineRule.PLACEMENT_TARGET.test(path) &&
        !ScreenOutlineRule.TEST_FILE.test(path) &&
        !ScreenOutlineRule.PLACED_FILE.test(path),
    );
  }

  // todo-detail-screen.tsx → TodoDetailScreen。
  static screenFunctionName(path: string): string {
    const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.tsx$/, "");
    return base
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
  }

  // 節が書かれた行（1 始まり）。JSX のテキストは前後の改行・インデントも節に含むので、最初の空白以外の文字の行にする
  //   （architecture.test.ts の lineOf と同じ）。
  static lineOf(sourceFile: SourceFile, node: Node): number {
    const start = isJsxText(node)
      ? node.pos + node.text.search(/\S/)
      : node.getStart(sourceFile);
    return sourceFile.text.slice(0, start).split("\n").length;
  }

  static textOf(sourceFile: SourceFile, node: Node): string {
    return sourceFile.text.slice(node.getStart(sourceFile), node.end);
  }

  static hasModifier(node: Node, kind: SyntaxKind): boolean {
    const modifiers = (node as { modifiers?: readonly Node[] }).modifiers;
    return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
  }

  static isExported(node: Node): boolean {
    return ScreenOutlineRule.hasModifier(node, SyntaxKind.ExportKeyword);
  }

  // ファイルの最上位で export する値（書かれた順）。型（type / interface・export type・inline の type）は数えない。
  // `export default` の名前は `default`、`export *` は `*`。
  static exportedValues(sourceFile: SourceFile): Declared[] {
    return sourceFile.statements.flatMap((statement): Declared[] => {
      if (isExportAssignment(statement)) {
        return [{ node: statement, name: "default" }];
      }
      if (isExportDeclaration(statement)) {
        return ScreenOutlineRule.reexportedValues(statement);
      }
      if (!ScreenOutlineRule.isExported(statement)) {
        return [];
      }
      if (ScreenOutlineRule.hasModifier(statement, SyntaxKind.DefaultKeyword)) {
        return [{ node: statement, name: "default" }];
      }
      return ScreenOutlineRule.declaredValues(statement);
    });
  }

  // export { a, b as c } / export * as ns from / export * from が export する値。
  static reexportedValues(statement: Node): Declared[] {
    if (!isExportDeclaration(statement) || statement.isTypeOnly) {
      return [];
    }
    const clause = statement.exportClause;
    if (clause === undefined) {
      return [{ node: statement, name: "*" }];
    }
    if (isNamespaceExport(clause)) {
      return [{ node: clause, name: clause.name.text }];
    }
    return isNamedExports(clause)
      ? clause.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => ({ node: element, name: element.name.text }))
      : [];
  }

  // 最上位の文が宣言する値の名前（function・class・enum・namespace・変数）。型の宣言は空。
  static declaredValues(statement: Node): Declared[] {
    if (
      isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isModuleDeclaration(statement)
    ) {
      const name = statement.name;
      return [
        {
          node: statement,
          name: name !== undefined && isIdentifier(name) ? name.text : "?",
        },
      ];
    }
    if (isVariableStatement(statement)) {
      return statement.declarationList.declarations.map((declaration) => ({
        node: declaration,
        name: isIdentifier(declaration.name) ? declaration.name.text : "?",
      }));
    }
    return [];
  }

  // 画面の関数（`export function <name>`。export default は除く）。
  static screenFunction(
    sourceFile: SourceFile,
    name: string,
  ): FunctionDeclaration | undefined {
    return sourceFile.statements.find(
      (statement): statement is FunctionDeclaration =>
        isFunctionDeclaration(statement) &&
        statement.name?.text === name &&
        ScreenOutlineRule.isExported(statement) &&
        !ScreenOutlineRule.hasModifier(statement, SyntaxKind.DefaultKeyword),
    );
  }

  // screen-outline-single-export: 画面の関数以外に export する値の「行 名前」と、画面の関数が無ければ「1 <名前> が無い」。
  static findSingleExportViolations(
    sourceFile: SourceFile,
    name: string,
  ): string[] {
    const screen = ScreenOutlineRule.screenFunction(sourceFile, name);
    return [
      ...(screen === undefined ? [`1 ${name} が無い`] : []),
      ...ScreenOutlineRule.exportedValues(sourceFile)
        .filter(({ node }) => node !== screen)
        .map(
          ({ node, name: exported }) =>
            `${ScreenOutlineRule.lineOf(sourceFile, node)} ${exported}`,
        ),
    ];
  }

  // 関数の本体の return（中で定義した関数・クラスの中は数えない。書かれた順）。
  static returnsOf(fn: FunctionDeclaration): ReturnStatement[] {
    const found: ReturnStatement[] = [];
    const visit = (node: Node) => {
      if (isReturnStatement(node)) {
        found.push(node);
      }
      if (ScreenOutlineRule.isNestedScope(node)) {
        return;
      }
      node.forEachChild(visit);
    };
    fn.body?.forEachChild(visit);
    return found;
  }

  // 中の return が画面の関数の return でない節（関数・オブジェクトのメソッドとアクセサ・クラス）。
  static isNestedScope(node: Node): boolean {
    return [
      SyntaxKind.FunctionDeclaration,
      SyntaxKind.FunctionExpression,
      SyntaxKind.ArrowFunction,
      SyntaxKind.MethodDeclaration,
      SyntaxKind.GetAccessor,
      SyntaxKind.SetAccessor,
      SyntaxKind.ClassDeclaration,
      SyntaxKind.ClassExpression,
    ].includes(node.kind);
  }

  // screen-outline-single-return: return が 1 つでなければ、各 return の行（0 個なら画面の関数の行と「return が無い」）。
  static findSingleReturnViolations(
    sourceFile: SourceFile,
    name: string,
  ): string[] {
    const screen = ScreenOutlineRule.screenFunction(sourceFile, name);
    if (screen === undefined) {
      return [];
    }
    const returns = ScreenOutlineRule.returnsOf(screen);
    if (returns.length === 0) {
      return [`${ScreenOutlineRule.lineOf(sourceFile, screen)} return が無い`];
    }
    return returns.length === 1
      ? []
      : returns.map((node) => `${ScreenOutlineRule.lineOf(sourceFile, node)}`);
  }

  static unwrapParentheses(node: Node | undefined): Node | undefined {
    return node !== undefined && isParenthesizedExpression(node)
      ? ScreenOutlineRule.unwrapParentheses(node.expression)
      : node;
  }

  // `import { Layout } from "@/shared/ui/atoms/layout"`（別名の Layout as X は名前が Layout でないので数えない。
  //   文全体・要素の type の import は値でないので数えない）があるか。
  static importsAtomLayout(sourceFile: SourceFile): boolean {
    return sourceFile.statements.some((statement) => {
      if (
        !isImportDeclaration(statement) ||
        !isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== ScreenOutlineRule.LAYOUT_MODULE
      ) {
        return false;
      }
      const bindings = statement.importClause?.namedBindings;
      // WHY 文全体の type も見る: `import type { Layout }` は値を取り込まず、要素の isTypeOnly は false のまま
      //   （typescript 7 の AST では文全体の type は ImportClause の phaseModifier に入る）。
      const typeOnlyStatement =
        statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword;
      return (
        bindings !== undefined &&
        isNamedImports(bindings) &&
        bindings.elements.some(
          (element) =>
            !typeOnlyStatement &&
            !element.isTypeOnly &&
            element.name.text === ScreenOutlineRule.LAYOUT &&
            (element.propertyName === undefined ||
              (isIdentifier(element.propertyName) &&
                element.propertyName.text === ScreenOutlineRule.LAYOUT)),
        )
      );
    });
  }

  // return の根が Layout の要素なら、その要素（子を見るため）。
  static layoutRootOf(node: ReturnStatement): Node | undefined {
    const root = ScreenOutlineRule.unwrapParentheses(node.expression);
    if (root === undefined) {
      return undefined;
    }
    const tagName = isJsxElement(root)
      ? root.openingElement.tagName
      : isJsxSelfClosingElement(root)
        ? root.tagName
        : undefined;
    return tagName !== undefined &&
      isIdentifier(tagName) &&
      tagName.text === ScreenOutlineRule.LAYOUT
      ? root
      : undefined;
  }

  // screen-outline-layout-root: 根が atom の Layout でない return の「行 根の書き方」（Layout を atom から取り込んでいなければ
  // 「行 Layout を @/shared/ui/atoms/layout から取り込んでいない」）。
  static findLayoutRootViolations(
    sourceFile: SourceFile,
    name: string,
  ): string[] {
    const screen = ScreenOutlineRule.screenFunction(sourceFile, name);
    if (screen === undefined) {
      return [];
    }
    const imported = ScreenOutlineRule.importsAtomLayout(sourceFile);
    return ScreenOutlineRule.returnsOf(screen).flatMap((node) => {
      const line = ScreenOutlineRule.lineOf(sourceFile, node);
      if (ScreenOutlineRule.layoutRootOf(node) === undefined) {
        const root = ScreenOutlineRule.unwrapParentheses(node.expression);
        return [
          `${line} ${root === undefined ? "値なし" : ScreenOutlineRule.describe(sourceFile, root)}`,
        ];
      }
      return imported
        ? []
        : [
            `${line} Layout を ${ScreenOutlineRule.LAYOUT_MODULE} から取り込んでいない`,
          ];
    });
  }

  // 根・子の書き方の短い説明（違反の行に添える）。
  static describe(sourceFile: SourceFile, node: Node): string {
    if (isJsxElement(node)) {
      return `<${ScreenOutlineRule.textOf(sourceFile, node.openingElement.tagName)}>`;
    }
    if (isJsxSelfClosingElement(node)) {
      return `<${ScreenOutlineRule.textOf(sourceFile, node.tagName)}>`;
    }
    if (isJsxFragment(node)) {
      return "Fragment";
    }
    if (isJsxText(node)) {
      return "文字列";
    }
    return "式";
  }

  // 同じファイルの最上位の export しない部品で、名前が Section / Form で終わるもの。
  static privateParts(sourceFile: SourceFile): Set<string> {
    const exported = new Set(
      ScreenOutlineRule.exportedValues(sourceFile).map(({ name }) => name),
    );
    return new Set(
      sourceFile.statements
        .filter(
          (statement) =>
            (isFunctionDeclaration(statement) ||
              isVariableStatement(statement)) &&
            !ScreenOutlineRule.isExported(statement),
        )
        .flatMap((statement) => ScreenOutlineRule.declaredValues(statement))
        .map(({ name }) => name)
        .filter(
          (name) =>
            ScreenOutlineRule.PART_NAME.test(name) && !exported.has(name),
        ),
    );
  }

  // Layout の直下の子が許されるか（空白・コメントだけの式・private の Section / Form の要素）。
  static isAllowedChild(child: Node, parts: ReadonlySet<string>): boolean {
    if (isJsxText(child)) {
      return child.containsOnlyTriviaWhiteSpaces;
    }
    if (isJsxExpression(child)) {
      return child.expression === undefined;
    }
    const tagName = isJsxElement(child)
      ? child.openingElement.tagName
      : isJsxSelfClosingElement(child)
        ? child.tagName
        : undefined;
    return (
      tagName !== undefined && isIdentifier(tagName) && parts.has(tagName.text)
    );
  }

  // screen-outline-layout-children: Layout の直下の許されない子の「行 書き方」（根が Layout の return だけを見る）。
  static findLayoutChildrenViolations(
    sourceFile: SourceFile,
    name: string,
  ): string[] {
    const screen = ScreenOutlineRule.screenFunction(sourceFile, name);
    if (screen === undefined) {
      return [];
    }
    const parts = ScreenOutlineRule.privateParts(sourceFile);
    return ScreenOutlineRule.returnsOf(screen).flatMap((node) => {
      const root = ScreenOutlineRule.layoutRootOf(node);
      if (root === undefined || !isJsxElement(root)) {
        return [];
      }
      return root.children
        .filter((child) => !ScreenOutlineRule.isAllowedChild(child, parts))
        .map(
          (child) =>
            `${ScreenOutlineRule.lineOf(sourceFile, child)} ${ScreenOutlineRule.describe(sourceFile, child)}`,
        );
    });
  }

  static readonly USE_CLIENT_DIRECTIVES = ['"use client"', "'use client'"];

  // screen-outline-use-client: 最初の文が "use client" のディレクティブでなければ「行 最初の文が "use client" でない」
  //   （行は最初の文の行。文が無ければ 1）。
  static findUseClientViolations(sourceFile: SourceFile): string[] {
    const first = sourceFile.statements[0];
    if (
      first !== undefined &&
      isExpressionStatement(first) &&
      ScreenOutlineRule.USE_CLIENT_DIRECTIVES.includes(
        ScreenOutlineRule.textOf(sourceFile, first.expression),
      )
    ) {
      return [];
    }
    const line =
      first === undefined ? 1 : ScreenOutlineRule.lineOf(sourceFile, first);
    return [`${line} 最初の文が "use client" でない`];
  }

  // files（リポジトリ相対のパス → ソース）を 1 回の tsgo の起動でまとめて構文解析する。
  // WHY 仮想のファイルシステムに置く・まとめて解析する・見つからなければ例外: design-system.test.ts の parse と同じ
  //   （tsconfig の include や node_modules に左右されない、tsgo の起動は 1 回 100ms ほど、黙って飛ばすと素通りする）。
  static parse(files: Record<string, string>): Map<string, SourceFile> {
    const paths = Object.keys(files);
    if (paths.length === 0) {
      return new Map();
    }
    const virtualRoot = "/screen-outline-test-virtual";
    const tsconfig = `${virtualRoot}/tsconfig.json`;
    const api = new API({
      cwd: virtualRoot,
      fs: createVirtualFileSystem({
        ...Object.fromEntries(
          paths.map((path) => [`${virtualRoot}/${path}`, files[path]]),
        ),
        [tsconfig]: JSON.stringify({
          compilerOptions: { jsx: "preserve", noLib: true, types: [] },
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
            `${virtualRoot}/${path}`,
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

  // dir の下のファイル（再帰、リポジトリ相対）。
  // WHY node_modules と .next に入らない・symlink をたどらない: design-system.test.ts の walk と同じ（依存と生成物は対象外、循環で止まらない）。
  static walk(root: string, dir: string): string[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === ".next"
          ? []
          : ScreenOutlineRule.walk(root, path);
      }
      return entry.isFile() ? [path] : [];
    });
  }

  static listScreenFiles(root: string): string[] {
    return ScreenOutlineRule.walk(root, ScreenOutlineRule.FRONTEND_ROOT)
      .filter(ScreenOutlineRule.isScreenFile)
      .sort();
  }

  static listPlacementViolations(root: string): string[] {
    return ScreenOutlineRule.findPlacementViolations(
      ScreenOutlineRule.walk(root, ScreenOutlineRule.FRONTEND_ROOT).sort(),
    );
  }

  // 規則ごとの違反を「<規則>: <パス>:<行> <内容>」（return の数の違反で内容が無ければ「<規則>: <パス>:<行>」、
  //   置き方の違反はファイルの単位なので「<規則>: <パス>」）で返す。
  static collectViolations(root: string): Record<RuleId, string[]> {
    const screens = ScreenOutlineRule.listScreenFiles(root);
    const parsed = ScreenOutlineRule.parse(
      Object.fromEntries(
        screens.map((path) => [path, readFileSync(join(root, path), "utf8")]),
      ),
    );
    const linesIn = (
      find: (sourceFile: SourceFile, name: string) => string[],
      rule: RuleId,
    ) =>
      screens.flatMap((path) =>
        find(
          parsed.get(path) as SourceFile,
          ScreenOutlineRule.screenFunctionName(path),
        ).map((found) => `${rule}: ${path}:${found}`),
      );
    return {
      "screen-outline-placement": ScreenOutlineRule.listPlacementViolations(
        root,
      ).map((path) => `screen-outline-placement: ${path}`),
      "screen-outline-single-export": linesIn(
        ScreenOutlineRule.findSingleExportViolations,
        "screen-outline-single-export",
      ),
      "screen-outline-layout-root": linesIn(
        ScreenOutlineRule.findLayoutRootViolations,
        "screen-outline-layout-root",
      ),
      "screen-outline-layout-children": linesIn(
        ScreenOutlineRule.findLayoutChildrenViolations,
        "screen-outline-layout-children",
      ),
      "screen-outline-single-return": linesIn(
        ScreenOutlineRule.findSingleReturnViolations,
        "screen-outline-single-return",
      ),
      "screen-outline-use-client": linesIn(
        ScreenOutlineRule.findUseClientViolations,
        "screen-outline-use-client",
      ),
    };
  }
}

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

// 画面のファイルの例で使う import（Layout は atom から取り込む）。
const LAYOUT_IMPORT = 'import { Layout } from "@/shared/ui/atoms/layout";';

// 例の表（[ケース名, ソース]）をまとめて構文解析し、ケース名 → find の結果にする。画面の関数の名前は XScreen。
function findIn(
  cases: readonly (readonly [string, string])[],
  find: (sourceFile: SourceFile, name: string) => string[],
): Record<string, string[]> {
  const parsed = ScreenOutlineRule.parse(
    Object.fromEntries(cases.map(([name, source]) => [`${name}.tsx`, source])),
  );
  return casesByName(cases, ([name]) =>
    find(parsed.get(`${name}.tsx`) as SourceFile, "XScreen"),
  );
}

// 違反の無い画面のファイル（骨組みの例）。
const OUTLINED_SCREEN = lines(
  '"use client";',
  "",
  LAYOUT_IMPORT,
  'import { Text } from "@/shared/ui/atoms/text";',
  "export type XScreenProps = { id: string };",
  "export function XScreen({ id }: XScreenProps) {",
  "  const x = useX(id);",
  "  return (",
  "    <Layout>",
  "      {/* 見出し */}",
  "      <TitleSection />",
  "      <EditForm value={x.value} onSubmit={() => x.save()} />",
  "    </Layout>",
  "  );",
  "}",
  "function TitleSection() {",
  "  return <Text>x</Text>;",
  "}",
  "const EditForm = (props: { value: string; onSubmit: () => void }) => <Text>{props.value}</Text>;",
);

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "screen-outline-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const SCREEN_DIR = "apps/frontend_customer/features/x/screens/x-screen";

const feature = await loadFeature("./screen-outline.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("画面のファイル（isScreenFile・screenFunctionName）", ({ And }) => {
    And(
      "must pass: features の下の screens の、ディレクトリと同じ名前の -screen.tsx は画面のファイルで、画面の関数の名前はファイル名の PascalCase",
      () => {
        // given
        const paths = [
          "apps/frontend_customer/features/todo/screens/todo-screen/todo-screen.tsx",
          "apps/frontend_customer/features/todo/screens/todo-detail-screen/todo-detail-screen.tsx",
        ];

        // when
        const result = paths.map((path) => [
          ScreenOutlineRule.isScreenFile(path),
          ScreenOutlineRule.screenFunctionName(path),
        ]);

        // then
        expect(result).toEqual([
          [true, "TodoScreen"],
          [true, "TodoDetailScreen"],
        ]);
      },
    );

    And(
      "must reject: テスト・hook・辞書・ディレクトリと名前の違うファイル・入れ子・screens の外・features の外・拡張子の違うファイルは画面のファイルでない",
      () => {
        // given
        const base = "apps/frontend_customer/features/todo";
        const cases = [
          ["テスト", `${base}/screens/todo-screen/todo-screen.test.tsx`],
          ["hook", `${base}/screens/todo-screen/todo-screen.hook.ts`],
          ["辞書", `${base}/screens/todo-screen/todo-screen.messages.ts`],
          ["名前の違うファイル", `${base}/screens/todo-screen/list-screen.tsx`],
          [
            "入れ子",
            `${base}/screens/todo-screen/x/todo-screen/todo-screen.tsx`,
          ],
          ["screens の外", `${base}/components/todo-screen/todo-screen.tsx`],
          [
            "features の外",
            "apps/frontend_customer/shared/screens/todo-screen/todo-screen.tsx",
          ],
          ["拡張子 .ts", `${base}/screens/todo-screen/todo-screen.ts`],
          ["拡張子 .jsx", `${base}/screens/todo-screen/todo-screen.jsx`],
          ["-screen で終わらない", `${base}/screens/todo/todo.tsx`],
        ] as const;

        // when
        const result = casesByName(cases, ([, path]) =>
          ScreenOutlineRule.isScreenFile(path),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("screens の下の置き方（findPlacementViolations）", ({ And }) => {
    And(
      "must pass: screens の下の、ディレクトリと同じ名前の -screen.tsx と hook と辞書とテストと、コード以外のファイルと screens の外は違反にしない",
      () => {
        // given
        const base = "apps/frontend_customer/features/todo";
        const paths = [
          `${base}/screens/todo-screen/todo-screen.tsx`,
          `${base}/screens/todo-screen/todo-screen.hook.ts`,
          `${base}/screens/todo-screen/todo-screen.messages.ts`,
          `${base}/screens/todo-screen/todo-screen.test.tsx`,
          `${base}/screens/todo-screen/todo-screen.hook.test.ts`,
          `${base}/screens/todo-detail-screen/todo-detail-screen.tsx`,
          // テストは名前と置き場所を問わない（画面のテストの置き方は testing.md の「置き方」で、この規則の対象外）。
          `${base}/screens/settings/settings.test.tsx`,
          // コード以外（画像・文書など）は対象外。
          `${base}/screens/todo-screen/README.md`,
          // screens の外は対象外（components の部品・app の page.tsx・shared）。
          `${base}/components/todo-item.tsx`,
          `${base}/api/todo-api.ts`,
          "apps/frontend_customer/app/page.tsx",
          "apps/frontend_customer/shared/screens/x/x.tsx",
        ];
        // when
        const result = ScreenOutlineRule.findPlacementViolations(paths);
        // then
        expect(result).toEqual([]);
      },
    );
    And(
      "must reject: screens の直下のファイル・名前のそろっていないディレクトリ・-screen で終わらないディレクトリ・入れ子・ほかの名前のファイル・拡張子の違うファイルは違反",
      () => {
        // given
        const base = "apps/frontend_customer/features/todo/screens";
        const cases = [
          ["screens の直下の画面", `${base}/settings-screen.tsx`],
          ["screens の直下の hook", `${base}/settings-screen.hook.ts`],
          ["-screen で終わらないディレクトリ", `${base}/settings/settings.tsx`],
          [
            "-screen で終わらないディレクトリの hook",
            `${base}/settings/settings.hook.ts`,
          ],
          [
            "ディレクトリと名前の違う画面",
            `${base}/todo-screen/list-screen.tsx`,
          ],
          [
            "ディレクトリと名前の違う hook",
            `${base}/todo-screen/list-screen.hook.ts`,
          ],
          ["入れ子", `${base}/todo-screen/parts/todo-screen.tsx`],
          ["ほかの名前の部品", `${base}/todo-screen/title-section.tsx`],
          ["ほかの名前の補助", `${base}/todo-screen/format.ts`],
          ["拡張子 .ts の画面", `${base}/todo-screen/todo-screen.ts`],
          ["拡張子 .jsx の画面", `${base}/todo-screen/todo-screen.jsx`],
          ["拡張子 .tsx の hook", `${base}/todo-screen/todo-screen.hook.tsx`],
          [
            "拡張子 .tsx の辞書",
            `${base}/todo-screen/todo-screen.messages.tsx`,
          ],
          ["拡張子 .mts", `${base}/todo-screen/todo-screen.hook.mts`],
          ["拡張子 .js", `${base}/todo-screen/todo-screen.hook.js`],
          ["拡張子 .cjs", `${base}/todo-screen/x.cjs`],
          ["拡張子 .mjs", `${base}/todo-screen/x.mjs`],
          ["拡張子 .cts", `${base}/todo-screen/x.cts`],
          ["型の宣言", `${base}/todo-screen/todo-screen.d.ts`],
        ] as const;
        // when
        const result = casesByName(cases, ([, path]) =>
          ScreenOutlineRule.findPlacementViolations([path]),
        );
        // then
        expect(result).toEqual(casesByName(cases, ([, path]) => [path]));
      },
    );
  });
  Scenario("export する値（findSingleExportViolations）", ({ And }) => {
    And(
      "must pass: 画面の関数だけを export function で export し、型の export と export しない部品はあってよい",
      () => {
        // given
        const cases = [
          ["骨組み", OUTLINED_SCREEN],
          [
            "型だけの export",
            lines(
              "export interface A { a: string }",
              "type B = string;",
              "export type { B };",
              "export { type B as C };",
              'export type { D } from "./d";',
              "export function XScreen() { return null; }",
              "function helper() { return 1; }",
              "const y = 1;",
            ),
          ],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findSingleExportViolations,
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "must reject: ほかの値の export・名前の違う画面の関数・export default・export const の画面・画面の関数が無いのは違反",
      () => {
        // given
        const screen = "export function XScreen() { return null; }";
        const cases = [
          ["部品の export", lines(screen, "export function ASection() {}")],
          ["const の export", lines(screen, "export const a = 1, b = 2;")],
          ["class の export", lines(screen, "export class A {}")],
          ["enum の export", lines(screen, "export enum E { A }")],
          ["namespace の export", lines(screen, "export namespace N {}")],
          [
            "export { }",
            lines(
              screen,
              "function ASection() {}",
              "export { ASection as B };",
            ),
          ],
          ["export from", lines(screen, 'export { y } from "./y";')],
          ["export * from", lines(screen, 'export * from "./y";')],
          ["export * as", lines(screen, 'export * as ns from "./y";')],
          ["export default", lines(screen, "export default XScreen;")],
          [
            "名前の違う画面の関数",
            "export function YScreen() { return null; }\n",
          ],
          [
            "export default function",
            "export default function XScreen() { return null; }\n",
          ],
          ["export const の画面", "export const XScreen = () => null;\n"],
          ["export しない画面の関数", "function XScreen() { return null; }\n"],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findSingleExportViolations,
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([name]) => {
            const expected: Record<string, string[]> = {
              "部品の export": ["2 ASection"],
              "const の export": ["2 a", "2 b"],
              "class の export": ["2 A"],
              "enum の export": ["2 E"],
              "namespace の export": ["2 N"],
              "export { }": ["3 B"],
              "export from": ["2 y"],
              "export * from": ["2 *"],
              "export * as": ["2 ns"],
              "export default": ["2 default"],
              名前の違う画面の関数: ["1 XScreen が無い", "1 YScreen"],
              "export default function": ["1 XScreen が無い", "1 default"],
              "export const の画面": ["1 XScreen が無い", "1 XScreen"],
              "export しない画面の関数": ["1 XScreen が無い"],
            };
            return expected[name];
          }),
        );
      },
    );
  });

  Scenario("Layout の根（findLayoutRootViolations）", ({ And }) => {
    And(
      "must pass: return の根が atom の Layout で、かっこで包んでも中身が無くてもよい",
      () => {
        // given
        const cases = [
          ["骨組み", OUTLINED_SCREEN],
          [
            "かっこを重ねる",
            lines(
              LAYOUT_IMPORT,
              "export function XScreen() { return ((<Layout></Layout>)); }",
            ),
          ],
          [
            "中身の無い Layout",
            lines(
              LAYOUT_IMPORT,
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "ほかの名前と一緒に取り込む",
            lines(
              'import { type LayoutProps, Layout } from "@/shared/ui/atoms/layout";',
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "画面の関数が無い（single-export が見る）",
            "export function YScreen() { return <div />; }\n",
          ],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findLayoutRootViolations,
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "must reject: 根が Layout でない要素・Fragment・式・別の場所から取り込んだ Layout・取り込んでいない Layout は違反",
      () => {
        // given
        const fn = (body: string) =>
          lines(LAYOUT_IMPORT, `export function XScreen() { ${body} }`);
        const cases = [
          ["atom の要素", fn("return <Stack><ASection /></Stack>;")],
          ["素の要素", fn("return <main />;")],
          ["Fragment", fn("return <><Layout /></>;")],
          ["null", fn("return null;")],
          ["条件の式", fn("return x ? <Layout /> : null;")],
          ["値の無い return", fn("return;")],
          ["名前空間付きの Layout", fn("return <ui.Layout />;")],
          [
            "別の場所から取り込んだ Layout",
            lines(
              'import { Layout } from "@/shared/ui/atoms/page";',
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "別名で取り込んだ Layout",
            lines(
              'import { Container as Layout } from "@/shared/ui/atoms/layout";',
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "型だけ取り込んだ Layout",
            lines(
              'import { type Layout } from "@/shared/ui/atoms/layout";',
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "文全体を型だけで取り込んだ Layout",
            lines(
              'import type { Layout } from "@/shared/ui/atoms/layout";',
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "既定の import の Layout",
            lines(
              'import Layout from "@/shared/ui/atoms/layout";',
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "同じファイルで定義した Layout",
            lines(
              "function Layout() { return null; }",
              "export function XScreen() { return <Layout />; }",
            ),
          ],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findLayoutRootViolations,
        );

        // then
        const notImported =
          "Layout を @/shared/ui/atoms/layout から取り込んでいない";
        expect(result).toEqual(
          casesByName(cases, ([name]) => {
            const expected: Record<string, string[]> = {
              "atom の要素": ["2 <Stack>"],
              素の要素: ["2 <main>"],
              Fragment: ["2 Fragment"],
              null: ["2 式"],
              条件の式: ["2 式"],
              "値の無い return": ["2 値なし"],
              "名前空間付きの Layout": ["2 <ui.Layout>"],
              "別の場所から取り込んだ Layout": [`2 ${notImported}`],
              "別名で取り込んだ Layout": [`2 ${notImported}`],
              "型だけ取り込んだ Layout": [`2 ${notImported}`],
              "文全体を型だけで取り込んだ Layout": [`2 ${notImported}`],
              "既定の import の Layout": [`2 ${notImported}`],
              "同じファイルで定義した Layout": [`2 ${notImported}`],
            };
            return expected[name];
          }),
        );
      },
    );
  });

  Scenario("Layout の直下（findLayoutChildrenViolations）", ({ And }) => {
    And(
      "must pass: 同じファイルの export しない Section と Form の部品の要素に、props と空白とコメントだけなら違反にしない",
      () => {
        // given
        const cases = [
          ["骨組み", OUTLINED_SCREEN],
          [
            "子の無い Layout",
            lines(
              LAYOUT_IMPORT,
              "export function XScreen() { return <Layout />; }",
            ),
          ],
          [
            "根が Layout でない（layout-root が見る）",
            "export function XScreen() { return <div>{x}</div>; }\n",
          ],
          [
            "画面の関数が無い（single-export が見る）",
            lines(
              LAYOUT_IMPORT,
              "export function YScreen() { return <Layout>x</Layout>; }",
            ),
          ],
          [
            "子と props のある部品",
            lines(
              LAYOUT_IMPORT,
              "export function XScreen() {",
              "  return (",
              "    <Layout>",
              "      <ListSection items={[1, 2].map((n) => n)} {...rest}>x</ListSection>",
              "      {/* コメント */}",
              "    </Layout>",
              "  );",
              "}",
              "function ListSection() { return null; }",
            ),
          ],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findLayoutChildrenViolations,
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "must reject: 文字列・式・Fragment・atom・素の要素・import した部品・export した部品・名前が Section か Form で終わらない部品は違反",
      () => {
        // given
        const screen = (child: string, ...rest: string[]) =>
          lines(
            LAYOUT_IMPORT,
            'import { Text } from "@/shared/ui/atoms/text";',
            'import { ImportedSection } from "./imported";',
            "export function XScreen() {",
            "  return (",
            "    <Layout>",
            `      ${child}`,
            "    </Layout>",
            "  );",
            "}",
            ...rest,
          );
        const cases = [
          ["文字列", screen("見出し")],
          ["文字列の式", screen('{"見出し"}')],
          [
            "条件の式",
            screen("{x ? <ASection /> : null}", "function ASection() {}"),
          ],
          [
            "map の式",
            screen(
              "{xs.map((x) => <ASection key={x} />)}",
              "function ASection() {}",
            ),
          ],
          ["Fragment", screen("<><ASection /></>", "function ASection() {}")],
          ["atom", screen("<Text>x</Text>")],
          ["素の要素", screen("<section />")],
          ["import した部品", screen("<ImportedSection />")],
          [
            "export した部品",
            screen("<ASection />", "export function ASection() {}"),
          ],
          [
            "export { } で export した部品",
            screen(
              "<ASection />",
              "function ASection() {}",
              "export { ASection };",
            ),
          ],
          [
            "名前が Section で終わらない部品",
            screen("<Title />", "function Title() {}"),
          ],
          ["名前が Form だけの部品", screen("<Form />", "function Form() {}")],
          [
            "名前が Section だけの部品",
            screen("<Section />", "const Section = () => null;"),
          ],
          [
            "名前の途中に Section がある部品",
            screen("<SectionTitle />", "function SectionTitle() {}"),
          ],
          ["定義していない部品", screen("<MissingSection />")],
          [
            "関数の中で定義した部品",
            lines(
              LAYOUT_IMPORT,
              "export function XScreen() {",
              "  function InnerSection() { return null; }",
              "  return <Layout><InnerSection /></Layout>;",
              "}",
            ),
          ],
          [
            "名前空間付きの部品",
            screen(
              "<parts.ASection />",
              "const parts = { ASection: () => null };",
            ),
          ],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findLayoutChildrenViolations,
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([name]) => {
            const expected: Record<string, string[]> = {
              文字列: ["7 文字列"],
              文字列の式: ["7 式"],
              条件の式: ["7 式"],
              "map の式": ["7 式"],
              Fragment: ["7 Fragment"],
              atom: ["7 <Text>"],
              素の要素: ["7 <section>"],
              "import した部品": ["7 <ImportedSection>"],
              "export した部品": ["7 <ASection>"],
              "export { } で export した部品": ["7 <ASection>"],
              "名前が Section で終わらない部品": ["7 <Title>"],
              "名前が Form だけの部品": ["7 <Form>"],
              "名前が Section だけの部品": ["7 <Section>"],
              "名前の途中に Section がある部品": ["7 <SectionTitle>"],
              定義していない部品: ["7 <MissingSection>"],
              関数の中で定義した部品: ["4 <InnerSection>"],
              名前空間付きの部品: ["7 <parts.ASection>"],
            };
            return expected[name];
          }),
        );
      },
    );
  });

  Scenario("return の数（findSingleReturnViolations）", ({ And }) => {
    And(
      "must pass: 画面の関数の return が 1 つなら違反にせず、中で定義した関数とほかの関数の return は数えない",
      () => {
        // given
        const cases = [
          ["骨組み", OUTLINED_SCREEN],
          [
            "中で定義した関数の return",
            lines(
              "export function XScreen() {",
              "  const f = () => { return 1; };",
              "  const g = function () { return 2; };",
              "  function h() { return 3; }",
              "  class C { m() { return 4; } }",
              "  const o = { m() { return 5; }, get a() { return 7; }, set a(v) { return; } };",
              "  const D = class { m() { return 6; } };",
              "  return <Layout />;",
              "}",
            ),
          ],
          [
            "ほかの関数の return",
            lines(
              "export function XScreen() { return <Layout />; }",
              "function ASection() { if (x) return null; return <div />; }",
            ),
          ],
          [
            "画面の関数が無い（single-export が見る）",
            "export function YScreen() { if (x) return 1; return 2; }\n",
          ],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findSingleReturnViolations,
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "must reject: 早期 return を含む複数の return と、return の無い画面の関数は違反",
      () => {
        // given
        const cases = [
          [
            "早期 return",
            lines(
              "export function XScreen() {",
              "  if (isLoading) return <Text />;",
              "  return <Layout />;",
              "}",
            ),
          ],
          [
            "ブロックの中の return",
            lines(
              "export function XScreen() {",
              "  if (x) {",
              "    for (const y of ys) { return <A />; }",
              "  }",
              "  try { return <B />; } catch { return <C />; }",
              "}",
            ),
          ],
          ["return が無い", "export function XScreen() {}\n"],
          ["本体の無い宣言", "export declare function XScreen(): void;\n"],
        ] as const;

        // when
        const result = findIn(
          cases,
          ScreenOutlineRule.findSingleReturnViolations,
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([name]) => {
            const expected: Record<string, string[]> = {
              "早期 return": ["2", "3"],
              "ブロックの中の return": ["3", "5", "5"],
              "return が無い": ["1 return が無い"],
              本体の無い宣言: ["1 return が無い"],
            };
            return expected[name];
          }),
        );
      },
    );
  });

  Scenario('最初の文の "use client"（findUseClientViolations）', ({ And }) => {
    And(
      'must pass: 最初の文が "use client" のディレクティブなら、一重引用符でも、前にコメントがあってもよい',
      () => {
        // given
        const screen = "export function XScreen() { return null; }";
        const cases = [
          ["骨組み", OUTLINED_SCREEN],
          ["二重引用符", lines('"use client";', screen)],
          ["一重引用符", lines("'use client';", screen)],
          ["セミコロンなし", lines('"use client"', LAYOUT_IMPORT, screen)],
          ["前に行コメント", lines("// 画面", '"use client";', screen)],
          ["前にブロックコメント", lines('/* 画面 */ "use client";', screen)],
        ] as const;

        // when
        const result = findIn(cases, ScreenOutlineRule.findUseClientViolations);

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      'must reject: "use client" が無い・import の後・ほかのディレクティブの後・バッククォート・かっこで包んだもの・式の一部・別の文字列・空のファイルは違反',
      () => {
        // given
        const screen = "export function XScreen() { return null; }";
        const cases = [
          ["無い", lines(LAYOUT_IMPORT, screen)],
          ["import の後", lines(LAYOUT_IMPORT, '"use client";', screen)],
          [
            "ほかのディレクティブの後",
            lines('"use strict";', '"use client";', screen),
          ],
          ["バッククォート", lines("`use client`;", screen)],
          ["かっこで包んだもの", lines('("use client");', screen)],
          ["式の一部", lines('"use client".trim();', screen)],
          ["use server", lines('"use server";', screen)],
          ["大文字", lines('"Use Client";', screen)],
          ["エスケープ", lines('"use\\u0020client";', screen)],
          ["コメントの中だけ", lines('// "use client";', screen)],
          ["空のファイル", ""],
        ] as const;

        // when
        const result = findIn(cases, ScreenOutlineRule.findUseClientViolations);

        // then
        const notFirst = '最初の文が "use client" でない';
        expect(result).toEqual(
          casesByName(cases, ([name]) => {
            const expected: Record<string, string[]> = {
              無い: [`1 ${notFirst}`],
              "import の後": [`1 ${notFirst}`],
              ほかのディレクティブの後: [`1 ${notFirst}`],
              バッククォート: [`1 ${notFirst}`],
              かっこで包んだもの: [`1 ${notFirst}`],
              式の一部: [`1 ${notFirst}`],
              "use server": [`1 ${notFirst}`],
              大文字: [`1 ${notFirst}`],
              エスケープ: [`1 ${notFirst}`],
              コメントの中だけ: [`2 ${notFirst}`],
              空のファイル: [`1 ${notFirst}`],
            };
            return expected[name];
          }),
        );
      },
    );
  });

  Scenario("列挙と検査（fixture）", ({ And }) => {
    And(
      "列挙は features の画面のファイルだけで、違反の無いツリーは違反 0 件",
      () => {
        // given
        const root = fixture({
          [`${SCREEN_DIR}/x-screen.tsx`]: OUTLINED_SCREEN,
          // 画面のファイルでないもの（テスト・hook・部品・page.tsx）は対象外。違反の形でも数えない。
          [`${SCREEN_DIR}/x-screen.test.tsx`]: "export const a = 1;\n",
          [`${SCREEN_DIR}/x-screen.hook.ts`]: "export const b = 1;\n",
          [`${SCREEN_DIR}/x-screen.messages.ts`]: "export const c = 1;\n",
          "apps/frontend_customer/features/x/components/x-item.tsx":
            "export const XItem = () => <div>x</div>;\n",
          "apps/frontend_customer/app/page.tsx":
            "export default function Page() { return <main />; }\n",
          // 依存と生成物の中は見ない（パスの形は画面のファイルに一致するが、列挙が node_modules と .next に入らない）。
          "apps/frontend_customer/features/node_modules/screens/y-screen/y-screen.tsx":
            "export const y = 1;\n",
          "apps/frontend_customer/features/.next/screens/y-screen/y-screen.tsx":
            "export const y = 1;\n",
        });

        // when
        const screens = ScreenOutlineRule.listScreenFiles(root);
        const violations = ScreenOutlineRule.collectViolations(root);

        // then
        expect(screens).toEqual([`${SCREEN_DIR}/x-screen.tsx`]);
        expect(violations).toEqual({
          "screen-outline-placement": [],
          "screen-outline-single-export": [],
          "screen-outline-layout-root": [],
          "screen-outline-layout-children": [],
          "screen-outline-single-return": [],
          "screen-outline-use-client": [],
        });
      },
    );

    And(
      "すべての規則の違反を「規則: パス:行 内容」で、置き方の違反は「規則: パス」で返す",
      () => {
        // given
        const ySource = lines(
          LAYOUT_IMPORT,
          "export function YDetailScreen() {",
          "  if (x) return <Layout>読み込み中</Layout>;",
          "  return <main />;",
          "}",
          "export function TitleSection() { return null; }",
        );
        const yDir =
          "apps/frontend_customer/features/y/screens/y-detail-screen";
        const misplaced = [
          "apps/frontend_customer/features/y/screens/settings/settings.tsx",
          `${yDir}/title-section.tsx`,
        ];
        const root = fixture({
          [`${SCREEN_DIR}/x-screen.tsx`]: OUTLINED_SCREEN,
          [`${yDir}/y-detail-screen.tsx`]: ySource,
          // 名前のそろっていない画面は、画面のファイルとして列挙されず骨組みの規則をすり抜けるので、置き方の規則で止める。
          ...Object.fromEntries(
            misplaced.map((path) => [path, "export const z = 1;\n"]),
          ),
        });

        // when
        const violations = ScreenOutlineRule.collectViolations(root);

        // then
        const y = `${yDir}/y-detail-screen.tsx`;
        expect(violations).toEqual({
          "screen-outline-placement": [
            `screen-outline-placement: ${misplaced[0]}`,
            `screen-outline-placement: ${misplaced[1]}`,
          ],
          "screen-outline-single-export": [
            `screen-outline-single-export: ${y}:6 TitleSection`,
          ],
          "screen-outline-layout-root": [
            `screen-outline-layout-root: ${y}:4 <main>`,
          ],
          "screen-outline-layout-children": [
            `screen-outline-layout-children: ${y}:3 文字列`,
          ],
          "screen-outline-single-return": [
            `screen-outline-single-return: ${y}:3`,
            `screen-outline-single-return: ${y}:4`,
          ],
          "screen-outline-use-client": [
            `screen-outline-use-client: ${y}:1 最初の文が "use client" でない`,
          ],
        });
      },
    );

    And(
      "apps/frontend_customer が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const root = fixture({ "README.md": "# x\n" });

        // when
        const screens = ScreenOutlineRule.listScreenFiles(root);
        const violations = ScreenOutlineRule.collectViolations(root);

        // then
        expect(screens).toEqual([]);
        expect(violations).toEqual({
          "screen-outline-placement": [],
          "screen-outline-single-export": [],
          "screen-outline-layout-root": [],
          "screen-outline-layout-children": [],
          "screen-outline-single-return": [],
          "screen-outline-use-client": [],
        });
      },
    );
  });

  Scenario("画面の骨組み（実ファイル）", ({ And }) => {
    const screens = ScreenOutlineRule.listScreenFiles(repoRoot);
    const violations = ScreenOutlineRule.collectViolations(repoRoot);

    And("列挙: features の画面のファイルが 1 件以上ある", () => {
      // given: Scenario の冒頭で listScreenFiles(repoRoot) 済み（実ファイル）

      // when
      const count = screens.length;

      // then
      expect(count).toBeGreaterThan(0);
    });

    And(
      "screen-outline-placement: screens の下のテスト以外のコードは、ディレクトリと同じ名前の画面と hook と辞書だけ",
      () => {
        // given: Scenario の冒頭で collectViolations(repoRoot) 済み（実ファイル）
        // when
        const result = violations["screen-outline-placement"];
        // then
        expect(result).toEqual([]);
      },
    );
    And(
      "screen-outline-single-export: 画面のファイルが export する値は画面の関数 1 つだけ",
      () => {
        // given: Scenario の冒頭で collectViolations(repoRoot) 済み（実ファイル）

        // when
        const result = violations["screen-outline-single-export"];

        // then
        expect(result).toEqual([]);
      },
    );

    And(
      "screen-outline-layout-root: 画面の関数の return の根は atom の Layout",
      () => {
        // given: Scenario の冒頭で collectViolations(repoRoot) 済み（実ファイル）

        // when
        const result = violations["screen-outline-layout-root"];

        // then
        expect(result).toEqual([]);
      },
    );

    And(
      "screen-outline-layout-children: Layout の直下は同じファイルの export しない Section と Form の部品の要素だけ",
      () => {
        // given: Scenario の冒頭で collectViolations(repoRoot) 済み（実ファイル）

        // when
        const result = violations["screen-outline-layout-children"];

        // then
        expect(result).toEqual([]);
      },
    );

    And("screen-outline-single-return: 画面の関数の return は 1 つだけ", () => {
      // given: Scenario の冒頭で collectViolations(repoRoot) 済み（実ファイル）

      // when
      const result = violations["screen-outline-single-return"];

      // then
      expect(result).toEqual([]);
    });

    And(
      'screen-outline-use-client: 画面のファイルの最初の文は "use client" のディレクティブ',
      () => {
        // given: Scenario の冒頭で collectViolations(repoRoot) 済み（実ファイル）

        // when
        const result = violations["screen-outline-use-client"];

        // then
        expect(result).toEqual([]);
      },
    );
  });
});
