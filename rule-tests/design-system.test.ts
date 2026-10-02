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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ExportSpecifier,
  type ImportDeclaration,
  type ImportSpecifier,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isJsxAttribute,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  isTypeAliasDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, describe, expect, it } from "vitest";

// 画面の見た目を Mantine のテーマ（apps/frontend_customer/shared/ui/themes/**）だけに置くことを、機械的に検査するテスト（Issue #292）。
// WHY 検査する: テーマを差し替えるだけで全体の見た目が切り替わるようにしたい。画面（app/・features/）が style・className や
//   Mantine の style props（`mt="md"`・`c="red"`）で見た目を直接書くと、その箇所はテーマを替えても変わらず、見た目の正が
//   テーマと画面の 2 か所に分かれる。画面は部品を置くだけにし、見た目はデザインシステム（shared/ui/）が持つ。
//   文章の規則だけだと、Mantine の書き慣れた書き方（`<Box p="md">`）が既定のように書かれる。
// 違反にするもの（規則）:
//   - design-system-no-direct-style: apps/frontend_customer の下のテスト以外のソース（shared/ui/ の中を除く）の JSX 属性のうち、
//     名前が style / className / classNames / styles / vars（Mantine の Styles API と素の React の見た目の口）か、Mantine の
//     style props（@mantine/core の実行時の値 STYLE_PROPS_DATA のキー。m・mt・p・bg・c・fz・w・h・pos・display・flex など）のもの。
//     加えて、Mantine の部品の見た目を選ぶ props（LOOK_PROPS: color / variant / size / radius / autoContrast / gradient / shadow /
//     withBorder / underline）も違反。WHY: <Button color="red" variant="light"> はテーマを差し替えてもその見た目のまま残る。
//     部品ごとの既定の見た目はテーマの components の defaultProps に書く（shared/ui/themes/calm/calm.theme.ts）。
//     値の形（文字列・式・テーマの値の参照）は問わない。要素は問わない（素の <div style> も <Button mt="md"> も違反）。
//     WHY style props の一覧を @mantine/core から読む: 手で写すと Mantine の更新で増えた名前（mis / mie など）を見逃す。
//     @mantine/core は apps/frontend_customer だけの依存なので、そこの package.json から解決する（createRequire）。
//     WHY shared/ui/ を除く: デザインシステム自身（Provider・テーマ・テーマの上の部品）は見た目を書く場所。
//   - design-system-css-placement: apps/frontend_customer の下の .css（*.module.css も）は shared/ui/ の下だけに置く。
//     shared/ui/ の外のテスト以外のソースから .css を import しない（import / export … from / import() / require() /
//     import x = require()）。WHY: CSS を画面の近くに置くと、テーマの外に見た目の正ができる。Mantine の styles.css は
//     shared/ui/ の Provider が import する（app/layout.tsx も import しない）。
//   - design-system-themed-components: shared/ui/ の外のテスト以外のソースが @mantine/core から値として import する名前
//     （import { X }・export { X } from。`import type` と inline の `type X` は除く）は、shared/ui/themes/theme-definition.ts の
//     型 ThemedComponent（文字列リテラルの union）にあるものだけ。既定の import・名前空間の import（`* as M`）・`export * from`・
//     import() / require() は、使う名前が決まらないので名前 `*` / `default` の違反にする。
//     WHY: ThemedComponent はすべてのテーマに部品ごとの見た目を型で書かせる一覧で、そこに無い部品を画面が使うと Mantine の既定の
//     見た目のまま残り、テーマを差し替えても変わらない。部品を画面で使い始めたら、一覧とすべてのテーマに足すことを強制する。
//     一覧は theme-definition.ts を構文木で読む（手で写すとずれる）。読めた名前が 0 件なら実ファイルのテストで失敗させる。
// 対象: apps/frontend_customer の下のソース（.ts .tsx .js .jsx .mjs .cjs .mts .cts）のうち、テスト（*.test.*）と shared/ui/ の中を除いたもの。
//   node_modules と .next（依存と生成物）は列挙で入らない。test-support/ はテスト以外のソースとして対象にする（見た目を書く理由が無い）。
// 検査の対象の列挙（テスト以外のソース）と style props の一覧が 0 件なら、実ファイルのテストで失敗させる
//   （0 件なら違反も 0 件で常に緑になるため）。
// 限界: 属性は名前で見るので、スプレッド（`<Box {...{ mt: "md" }} />`・`{...props}`）、名前空間付きの属性、
//   React.createElement / cloneElement の props、useMantineTheme で値を取り出して別の口から当てる書き方は見ない（レビューで見る）。
//   style props・LOOK_PROPS と同じ名前の素の属性（SVG の <path opacity="0.5">・display、HTML の <input size>・<font color>）も
//   違反と数える（安全側。今の画面は素の要素でこれらを使わない）。
//   design-system-themed-components は @mantine/core の名前だけを見る（部品の中身・別のパッケージ（@mantine/dates など）・
//   shared/ui/ を経由した再公開は見ない。ThemedComponent の union は文字列リテラルだけを読み、別の型の参照は展開しない）。
//   部品でない値（ColorSchemeScript・mantineHtmlProps・hook）も名前が一覧に無ければ違反と数える（shared/ui/ に置く）。
//   .css の import は参照先の文字列が `.css` で終わるもの（大文字小文字は区別しない）だけを見る（`?inline` などのクエリ付き・
//   テンプレートリテラルに埋め込み式のある import()・.scss などほかの書き方は見ない）。

// @mantine/core から取り込む値 1 つ（名前と、行を出す節）。
type MantineImport = { node: Node; name: string };

type RuleId =
  | "design-system-no-direct-style"
  | "design-system-css-placement"
  | "design-system-themed-components";

const repoRoot = join(import.meta.dirname, "..");

// biome-ignore lint/complexity/noStaticOnlyClass: 判定をクラスの static メソッドにまとめる（Issue #292 の依頼。本番の class-based と同じ形）。rule-tests/ は biome.json の override の外なので行ごとに許す。
class DesignSystemRule {
  static readonly FRONTEND_ROOT = "apps/frontend_customer";
  // デザインシステムの置き場所。見た目（テーマ・CSS・style）を書いてよいのはここだけ。
  static readonly DESIGN_SYSTEM_DIR =
    `${DesignSystemRule.FRONTEND_ROOT}/shared/ui`;
  // テーマが見た目を必ず書く部品の一覧（型 ThemedComponent）を宣言するファイル。
  static readonly THEME_DEFINITION =
    `${DesignSystemRule.DESIGN_SYSTEM_DIR}/themes/theme-definition.ts`;
  static readonly THEMED_COMPONENT_TYPE = "ThemedComponent";
  static readonly MANTINE_CORE = "@mantine/core";
  // Mantine の部品の見た目を選ぶ props（WHY は冒頭の design-system-no-direct-style）。c は style props に含まれる。
  static readonly LOOK_PROPS = [
    "color",
    "variant",
    "size",
    "radius",
    "autoContrast",
    "gradient",
    "shadow",
    "withBorder",
    "underline",
  ];

  // Mantine の style props の名前（@mantine/core の STYLE_PROPS_DATA のキー）。
  static mantineStyleProps(root: string): string[] {
    const requireFromFrontend = createRequire(
      join(root, DesignSystemRule.FRONTEND_ROOT, "package.json"),
    );
    const mantine = requireFromFrontend("@mantine/core") as {
      STYLE_PROPS_DATA?: Record<string, unknown>;
    };
    return Object.keys(mantine.STYLE_PROPS_DATA ?? {});
  }

  // 見た目を直接書く JSX 属性の名前（style props の一覧に、Styles API と素の React の口と、見た目を選ぶ props を足したもの）。
  static forbiddenAttributes(styleProps: readonly string[]): Set<string> {
    return new Set([
      "style",
      "className",
      "classNames",
      "styles",
      "vars",
      ...DesignSystemRule.LOOK_PROPS,
      ...styleProps,
    ]);
  }

  // WHY 前方一致に `/` を付ける: shared/ui-x/ や shared/uix/ を取り違えない。
  static isInDesignSystem(path: string): boolean {
    return path.startsWith(`${DesignSystemRule.DESIGN_SYSTEM_DIR}/`);
  }

  // 検査の対象のソースか（path は apps/frontend_customer の下のリポジトリ相対パス）。
  static isCheckedSource(path: string): boolean {
    return (
      /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) &&
      !/\.test\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) &&
      !DesignSystemRule.isInDesignSystem(path)
    );
  }

  static isCssPath(pathOrSpecifier: string): boolean {
    return /\.css$/i.test(pathOrSpecifier);
  }

  // .css のファイルが置き場所の外にあるか。
  static isMisplacedCss(path: string): boolean {
    return (
      DesignSystemRule.isCssPath(path) &&
      !DesignSystemRule.isInDesignSystem(path)
    );
  }

  static lineOf(sourceFile: SourceFile, node: Node): number {
    return sourceFile.text.slice(0, node.getStart(sourceFile)).split("\n")
      .length;
  }

  static visit(node: Node, onNode: (node: Node) => void): void {
    onNode(node);
    node.forEachChild((child) => {
      DesignSystemRule.visit(child, onNode);
    });
  }

  // 見た目を直接書く JSX 属性の行（1 始まり、書かれた順）。
  static findDirectStyles(
    sourceFile: SourceFile,
    forbidden: ReadonlySet<string>,
  ): number[] {
    const lines: number[] = [];
    DesignSystemRule.visit(sourceFile, (node) => {
      if (
        isJsxAttribute(node) &&
        isIdentifier(node.name) &&
        forbidden.has(node.name.text)
      ) {
        lines.push(DesignSystemRule.lineOf(sourceFile, node));
      }
    });
    return lines;
  }

  // 文字列リテラル（埋め込み式の無いテンプレートリテラルも）の値。それ以外は undefined。
  static literalText(node: Node | undefined): string | undefined {
    return node !== undefined &&
      (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  }

  // モジュールの参照先（import / export … from / import() / require() / import x = require()）。
  static moduleSpecifierOf(node: Node): string | undefined {
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      return DesignSystemRule.literalText(node.moduleSpecifier);
    }
    if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference)
    ) {
      return DesignSystemRule.literalText(node.moduleReference.expression);
    }
    if (
      isCallExpression(node) &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      return DesignSystemRule.literalText(node.arguments[0]);
    }
    return undefined;
  }

  // .css を import する行（1 始まり、書かれた順）。
  static findCssImports(sourceFile: SourceFile): number[] {
    const lines: number[] = [];
    DesignSystemRule.visit(sourceFile, (node) => {
      const specifier = DesignSystemRule.moduleSpecifierOf(node);
      if (specifier !== undefined && DesignSystemRule.isCssPath(specifier)) {
        lines.push(DesignSystemRule.lineOf(sourceFile, node));
      }
    });
    return lines;
  }

  // theme-definition.ts の型 ThemedComponent の union に書かれた文字列リテラル（書かれた順）。型が無ければ空。
  static themedComponents(sourceFile: SourceFile | undefined): string[] {
    const names: string[] = [];
    if (sourceFile === undefined) {
      return names;
    }
    DesignSystemRule.visit(sourceFile, (node) => {
      if (
        isTypeAliasDeclaration(node) &&
        node.name.text === DesignSystemRule.THEMED_COMPONENT_TYPE
      ) {
        DesignSystemRule.visit(node.type, (child) => {
          if (isStringLiteral(child)) {
            names.push(child.text);
          }
        });
      }
    });
    return names;
  }

  // 名前の付いた取り込み・再公開の要素のうち、値のもの（`type X` を除く）。名前は別名ではなく元の名前（`Text as T` は Text）。
  static valueSpecifiers(
    elements: readonly (ImportSpecifier | ExportSpecifier)[],
  ): MantineImport[] {
    return elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => ({
        node: element,
        name: (element.propertyName ?? element.name).text,
      }));
  }

  // import 文で @mantine/core から値として取り込むもの。型だけ（`import type`）・副作用だけの import は空。
  static importedValues(node: ImportDeclaration): MantineImport[] {
    const clause = node.importClause;
    if (
      clause === undefined ||
      clause.phaseModifier === SyntaxKind.TypeKeyword
    ) {
      return [];
    }
    const bindings = clause.namedBindings;
    return [
      ...(clause.name === undefined
        ? []
        : [{ node: clause.name, name: "default" }]),
      ...(bindings !== undefined && isNamespaceImport(bindings)
        ? [{ node: bindings, name: "*" }]
        : []),
      ...(bindings !== undefined && isNamedImports(bindings)
        ? DesignSystemRule.valueSpecifiers(bindings.elements)
        : []),
    ];
  }

  // 参照先が @mantine/core の節が取り込む値。export * / import() / require() / import x = require() は名前が決まらないので `*`。
  static mantineValuesOf(node: Node): MantineImport[] {
    if (isImportDeclaration(node)) {
      return DesignSystemRule.importedValues(node);
    }
    if (isExportDeclaration(node)) {
      if (node.isTypeOnly) {
        return [];
      }
      const clause = node.exportClause;
      return clause !== undefined && isNamedExports(clause)
        ? DesignSystemRule.valueSpecifiers(clause.elements)
        : [{ node, name: "*" }];
    }
    return [{ node, name: "*" }];
  }

  // @mantine/core から値として取り込む名前のうち、themed に無いもの（書かれた順。行は名前の節の行）。
  static findUnthemedMantineImports(
    sourceFile: SourceFile,
    themed: ReadonlySet<string>,
  ): { line: number; name: string }[] {
    const found: { line: number; name: string }[] = [];
    DesignSystemRule.visit(sourceFile, (node) => {
      if (
        DesignSystemRule.moduleSpecifierOf(node) !==
        DesignSystemRule.MANTINE_CORE
      ) {
        return;
      }
      for (const { node: at, name } of DesignSystemRule.mantineValuesOf(node)) {
        if (!themed.has(name)) {
          found.push({ line: DesignSystemRule.lineOf(sourceFile, at), name });
        }
      }
    });
    return found;
  }

  // files（リポジトリ相対のパス → ソース）を 1 回の tsgo の起動でまとめて構文解析する。
  // WHY 仮想のファイルシステムに置く・まとめて解析する・見つからなければ例外: architecture.test.ts の parseSourceFiles と同じ
  //   （tsconfig の include や node_modules に左右されない、tsgo の起動は 1 回 100ms ほど、黙って飛ばすと素通りする）。
  static parse(files: Record<string, string>): Map<string, SourceFile> {
    const paths = Object.keys(files);
    if (paths.length === 0) {
      return new Map();
    }
    const virtualRoot = "/design-system-test-virtual";
    const tsconfig = `${virtualRoot}/tsconfig.json`;
    const api = new API({
      cwd: virtualRoot,
      fs: createVirtualFileSystem({
        ...Object.fromEntries(
          paths.map((path) => [`${virtualRoot}/${path}`, files[path]]),
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
  // WHY node_modules と .next に入らない: 依存と生成物は検査の対象ではない（test-support.test.ts の walk と同じ）。
  // WHY symlink をたどらない（Dirent の isDirectory / isFile は symlink を見ない）: 循環する symlink で止まらなくなるのを避ける。
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
          : DesignSystemRule.walk(root, path);
      }
      return entry.isFile() ? [path] : [];
    });
  }

  static listFrontendFiles(root: string): string[] {
    return DesignSystemRule.walk(root, DesignSystemRule.FRONTEND_ROOT).sort();
  }

  static listCheckedSources(root: string): string[] {
    return DesignSystemRule.listFrontendFiles(root).filter(
      DesignSystemRule.isCheckedSource,
    );
  }

  // 規則ごとの違反を「<規則>: <パス>:<行>」（置き場所の違反は「<規則>: <パス>」）で返す。
  static collectViolations(
    root: string,
    styleProps: readonly string[],
  ): Record<RuleId, string[]> {
    const forbidden = DesignSystemRule.forbiddenAttributes(styleProps);
    const sources = DesignSystemRule.listCheckedSources(root);
    // WHY theme-definition.ts も同じ起動で解析する: tsgo の起動を 1 回にする。無ければ一覧は空（すべての取り込みが違反）。
    const themeDefinition = DesignSystemRule.listFrontendFiles(root).filter(
      (path) => path === DesignSystemRule.THEME_DEFINITION,
    );
    const parsed = DesignSystemRule.parse(
      Object.fromEntries(
        [...sources, ...themeDefinition].map((path) => [
          path,
          readFileSync(join(root, path), "utf8"),
        ]),
      ),
    );
    const themed = new Set(
      DesignSystemRule.themedComponents(
        parsed.get(DesignSystemRule.THEME_DEFINITION),
      ),
    );
    const linesIn = (
      find: (sourceFile: SourceFile) => number[],
      rule: RuleId,
    ) =>
      sources.flatMap((path) =>
        find(parsed.get(path) as SourceFile).map(
          (line) => `${rule}: ${path}:${line}`,
        ),
      );
    return {
      "design-system-no-direct-style": linesIn(
        (sourceFile) =>
          DesignSystemRule.findDirectStyles(sourceFile, forbidden),
        "design-system-no-direct-style",
      ),
      "design-system-css-placement": [
        ...DesignSystemRule.listFrontendFiles(root)
          .filter(DesignSystemRule.isMisplacedCss)
          .map((path) => `design-system-css-placement: ${path}`),
        ...linesIn(
          DesignSystemRule.findCssImports,
          "design-system-css-placement",
        ),
      ],
      "design-system-themed-components": sources.flatMap((path) =>
        DesignSystemRule.findUnthemedMantineImports(
          parsed.get(path) as SourceFile,
          themed,
        ).map(
          ({ line, name }) =>
            `design-system-themed-components: ${path}:${line} ${name}`,
        ),
      ),
    };
  }
}

// 架空の Mantine の style props（実物の一覧に依存せず判定を固定する）。
const FAKE_STYLE_PROPS = ["mt", "p", "c", "bg", "display"];

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

// 例（ファイル名 → ソース）をまとめて構文解析し、例ごとの違反の行を返す。
function directStyleLines(sources: Record<string, string>) {
  const parsed = DesignSystemRule.parse(sources);
  const forbidden = DesignSystemRule.forbiddenAttributes(FAKE_STYLE_PROPS);
  return Object.fromEntries(
    Object.keys(sources).map((path) => [
      path,
      DesignSystemRule.findDirectStyles(
        parsed.get(path) as SourceFile,
        forbidden,
      ),
    ]),
  );
}

function cssImportLines(sources: Record<string, string>) {
  const parsed = DesignSystemRule.parse(sources);
  return Object.fromEntries(
    Object.keys(sources).map((path) => [
      path,
      DesignSystemRule.findCssImports(parsed.get(path) as SourceFile),
    ]),
  );
}

describe("見た目を直接書く JSX 属性（findDirectStyles）", () => {
  it("must pass: 部品を置くだけの JSX・見た目と関係の無い属性・コメントと文字列の中の style は違反にしない", () => {
    // given
    const sources = {
      "a.tsx": lines(
        "export const A = () => (",
        '  <Stack gap="md" aria-label="x" data-style="x" data-variant="filled">',
        "    {/* <div style={{ color: 'red' }} /> */}",
        '    <Text title="mt=1 style className">style className mt</Text>',
        '    <Button onClick={() => {}} type="submit">ok</Button>',
        "  </Stack>",
        ");",
      ),
      // 名前が似ているだけの属性（前方一致・大文字小文字の境界）。
      "b.tsx": lines(
        "export const B = () => (",
        '  <Box mtx={1} pad={1} Style={1} classname="x" styleName="x" bgColor="x" />',
        '  <Box colors="x" variants="x" sizes="x" Radius="x" shadowX="x" withBorders underlined />',
        ");",
      ),
      // .ts の <x> は型アサーションで JSX ではない。オブジェクトのキーの style も属性ではない。
      "c.ts": lines(
        "const x = <unknown>{ style: 1, className: 'x', mt: 1 };",
        "export const y = x;",
      ),
    };

    // when
    const result = directStyleLines(sources);

    // then
    expect(result).toEqual({ "a.tsx": [], "b.tsx": [], "c.ts": [] });
  });

  it("must reject: style / className / classNames / styles / vars・style props・見た目を選ぶ props は、要素・値の形・拡張子を問わず違反", () => {
    // given
    const sources = {
      "a.tsx": lines(
        "export const A = () => (",
        "  <div style={{ color: 'red' }}>", // 2
        '    <span className="x" />', // 3
        "    <Button classNames={{ root: 'x' }} styles={{ root: {} }} vars={() => ({})} />", // 4 x3
        '    <Box mt="md" p={4} c="red" bg="blue" display="flex" />', // 5 x5
        "    <Stack",
        '      gap="md"',
        '      mt="xl"', // 8
        "    />",
        '    <Button color="red" variant="light" size="xs" radius="xl" autoContrast />', // 10 x5
        '    <Paper gradient={{ from: "a", to: "b" }} shadow="md" withBorder />', // 11 x3
        '    <Anchor underline="always" />', // 12
        "  </div>",
        ");",
      ),
      // 自己終了・入れ子の式の中・.jsx も見る。
      "b.jsx": lines(
        "export const B = (on) => on && <p style={s} />;", // 1
        "const s = {};",
      ),
    };

    // when
    const result = directStyleLines(sources);

    // then
    expect(result).toEqual({
      "a.tsx": [
        2, 3, 4, 4, 4, 5, 5, 5, 5, 5, 8, 10, 10, 10, 10, 10, 11, 11, 11, 12,
      ],
      "b.jsx": [1],
    });
  });
});

// 例をまとめて構文解析し、例ごとの「行 名前」を返す（一覧は架空の Button と Text）。
function unthemedImports(sources: Record<string, string>) {
  const parsed = DesignSystemRule.parse(sources);
  const themed = new Set(["Button", "Text"]);
  return Object.fromEntries(
    Object.keys(sources).map((path) => [
      path,
      DesignSystemRule.findUnthemedMantineImports(
        parsed.get(path) as SourceFile,
        themed,
      ).map(({ line, name }) => `${line} ${name}`),
    ]),
  );
}

describe("テーマの部品の一覧（themedComponents）", () => {
  it("型 ThemedComponent の union の文字列リテラルを書かれた順に読み、ほかの型・コメント・文字列は読まない", () => {
    // given
    const file = "apps/frontend_customer/shared/ui/themes/theme-definition.ts";
    const source = lines(
      '// "Comment"',
      'export type Other = "Other";',
      'const s = "Str";',
      'export type ThemedComponent = | "Button" | "Text"',
      '  | "TextInput";',
      'export type ThemedComponentX = "X";',
    );

    // when
    const result = DesignSystemRule.themedComponents(
      DesignSystemRule.parse({ [file]: source }).get(file),
    );

    // then
    expect(result).toEqual(["Button", "Text", "TextInput"]);
  });

  it("ファイルが無い・型が無ければ空", () => {
    // given
    const file = "a.ts";

    // when
    const missing = DesignSystemRule.themedComponents(undefined);
    const noType = DesignSystemRule.themedComponents(
      DesignSystemRule.parse({ [file]: 'export type X = "Button";\n' }).get(
        file,
      ),
    );

    // then
    expect(missing).toEqual([]);
    expect(noType).toEqual([]);
  });
});

describe("@mantine/core の部品の取り込み（findUnthemedMantineImports）", () => {
  it("must pass: 一覧にある名前の値の import・型だけの import・ほかのパッケージ・サブパスは違反にしない", () => {
    // given
    const sources = {
      "a.tsx": lines(
        'import { Button, Text as T } from "@mantine/core";',
        'import type { Box, MantineTheme } from "@mantine/core";',
        'import { type Stack, Button as B } from "@mantine/core";',
        'export type { Group } from "@mantine/core";',
        'export { Text } from "@mantine/core";',
        'import { Box as X } from "@mantine/dates";',
        'import "@mantine/core/styles.css";',
        'import { Box as Y } from "@mantine/core-x";',
        '// import { Box } from "@mantine/core";',
        "export const z = [Button, T, B, X, Y];",
      ),
    };

    // when
    const result = unthemedImports(sources);

    // then
    expect(result).toEqual({ "a.tsx": [] });
  });

  it("must reject: 一覧に無い名前（別名の元の名前で見る）、既定・名前空間・export *・import()・require() は違反", () => {
    // given
    const sources = {
      "a.tsx": lines(
        'import { Button, Box, Text as Stack } from "@mantine/core";', // 1 Box
        'import { Group as Text } from "@mantine/core";', // 2 Group
        "import {",
        "  Button as B,",
        "  ColorSchemeScript,", // 5
        '} from "@mantine/core";',
        'import Mantine from "@mantine/core";', // 7 default
        'import * as M from "@mantine/core";', // 8 *
        'export { Paper } from "@mantine/core";', // 9 Paper
        'export * from "@mantine/core";', // 10 *
        'export const d = import("@mantine/core");', // 11 *
        "export const r = require(`@mantine/core`);", // 12 *
        "export const z = [Button, Box, Stack, Text, B, ColorSchemeScript, Mantine, M];",
      ),
      "b.ts": lines(
        "import M = require('@mantine/core');", // 1 *
        "export const y = M;",
      ),
    };

    // when
    const result = unthemedImports(sources);

    // then
    expect(result).toEqual({
      "a.tsx": [
        "1 Box",
        "2 Group",
        "5 ColorSchemeScript",
        "7 default",
        "8 *",
        "9 Paper",
        "10 *",
        "11 *",
        "12 *",
      ],
      "b.ts": ["1 *"],
    });
  });
});

describe(".css の import（findCssImports）", () => {
  it("must pass: .css 以外の import・コメントと文字列の中の .css は違反にしない", () => {
    // given
    const sources = {
      "a.tsx": lines(
        'import { Button } from "@mantine/core";',
        'import x from "./x.css.ts";',
        'import "./cssx";',
        '// import "@mantine/core/styles.css";',
        'const path = "a.css";',
        'export { y } from "./y.css-like";',
        "export const z = [x, path];",
      ),
    };

    // when
    const result = cssImportLines(sources);

    // then
    expect(result).toEqual({ "a.tsx": [] });
  });

  it("must reject: 副作用・既定・名前空間の import、export … from、import()、require()、import x = require() の .css は違反", () => {
    // given
    const sources = {
      "a.tsx": lines(
        'import "@mantine/core/styles.css";', // 1
        'import classes from "./a.module.css";', // 2
        'import * as all from "./b.CSS";', // 3
        'export { default as c } from "./c.css";', // 4
        'export const d = import("./d.css");', // 5
        "export const e = require(`./e.css`);", // 6
        "export const k = [classes, all];",
      ),
      "b.ts": lines(
        "import x = require('./x.css');", // 1
        "export const y = x;",
      ),
    };

    // when
    const result = cssImportLines(sources);

    // then
    expect(result).toEqual({ "a.tsx": [1, 2, 3, 4, 5, 6], "b.ts": [1] });
  });
});

describe("対象のソースと .css の置き場所（isCheckedSource・isMisplacedCss）", () => {
  it("must pass: テスト・shared/ui/ の中・ソースでないファイルは検査の対象外、shared/ui/ の下の .css は置いてよい", () => {
    // given
    const notChecked = [
      "apps/frontend_customer/features/x/x.test.tsx",
      "apps/frontend_customer/features/x/x.test.ts",
      "apps/frontend_customer/shared/ui/provider.tsx",
      "apps/frontend_customer/shared/ui/themes/default/theme.ts",
      "apps/frontend_customer/README.md",
      "apps/frontend_customer/package.json",
    ];
    const placedCss = [
      "apps/frontend_customer/shared/ui/global.css",
      "apps/frontend_customer/shared/ui/themes/x/button.module.css",
    ];

    // when
    const checked = notChecked.filter(DesignSystemRule.isCheckedSource);
    const misplaced = placedCss.filter(DesignSystemRule.isMisplacedCss);

    // then
    expect(checked).toEqual([]);
    expect(misplaced).toEqual([]);
  });

  it("must reject: shared/ui/ の外（前方一致の境界 shared/ui-x/・shared/uix/ も）のソースは対象、.css は置き場所の違反", () => {
    // given
    const sources = [
      "apps/frontend_customer/app/layout.tsx",
      "apps/frontend_customer/features/x/x.tsx",
      "apps/frontend_customer/shared/ui-x/a.ts",
      "apps/frontend_customer/shared/uix/a.jsx",
      "apps/frontend_customer/test-support/i18n.tsx",
      "apps/frontend_customer/next.config.mjs",
      "apps/frontend_customer/x.cts",
    ];
    const css = [
      "apps/frontend_customer/app/globals.css",
      "apps/frontend_customer/features/x/x.module.css",
      "apps/frontend_customer/shared/ui-x/a.css",
      "apps/frontend_customer/shared/A.CSS",
    ];

    // when
    const checked = sources.filter(DesignSystemRule.isCheckedSource);
    const misplaced = css.filter(DesignSystemRule.isMisplacedCss);

    // then
    expect(checked).toEqual(sources);
    expect(misplaced).toEqual(css);
  });
});

describe("列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "design-system-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const designSystemFiles = {
    "apps/frontend_customer/shared/ui/provider.tsx": lines(
      'import "@mantine/core/styles.css";',
      'import classes from "./themes/x/x.module.css";',
      'export const P = () => <div className={classes.root} style={{}} mt="md" />;',
    ),
    "apps/frontend_customer/shared/ui/themes/x/x.module.css": ".root {}\n",
    "apps/frontend_customer/shared/ui/themes/theme-definition.ts":
      'export type ThemedComponent = "Button" | "Text";\n',
    // shared/ui/ の中は一覧に無い部品を import してよい。
    "apps/frontend_customer/shared/ui/provider-x.tsx":
      'import { MantineProvider } from "@mantine/core";\nexport const p = MantineProvider;\n',
    // テストは対象外。
    "apps/frontend_customer/features/x/x.test.tsx":
      'import "./x.css";\nexport const T = () => <div style={{}} />;\n',
    // 依存と生成物の中は見ない。
    "apps/frontend_customer/node_modules/x/index.tsx":
      'import "./x.css";\nexport const T = () => <div style={{}} />;\n',
    "apps/frontend_customer/node_modules/x/x.css": "a {}\n",
    "apps/frontend_customer/.next/static/x.css": "a {}\n",
  };

  it("違反の無いツリーは違反 0 件（列挙はテスト以外のソース）", () => {
    // given
    const root = fixture({
      ...designSystemFiles,
      "apps/frontend_customer/app/layout.tsx":
        'import { UiProvider } from "@/shared/ui/provider";\nexport default function L() { return <UiProvider />; }\n',
      "apps/frontend_customer/features/x/x.tsx": lines(
        'import { Button, type MantineTheme } from "@mantine/core";',
        "export const X = () => <Button>x</Button>;",
      ),
    });

    // when
    const sources = DesignSystemRule.listCheckedSources(root);
    const violations = DesignSystemRule.collectViolations(
      root,
      FAKE_STYLE_PROPS,
    );

    // then
    expect(sources).toEqual([
      "apps/frontend_customer/app/layout.tsx",
      "apps/frontend_customer/features/x/x.tsx",
    ]);
    expect(violations).toEqual({
      "design-system-no-direct-style": [],
      "design-system-css-placement": [],
      "design-system-themed-components": [],
    });
  });

  it("すべての規則の違反を「規則: パス:行」で返す（置き場所の違反は「規則: パス」）", () => {
    // given
    const root = fixture({
      ...designSystemFiles,
      "apps/frontend_customer/app/layout.tsx": lines(
        'import "@mantine/core/styles.css";',
        'export default function L() { return <body className="x" />; }',
        'import { ColorSchemeScript } from "@mantine/core";',
      ),
      "apps/frontend_customer/app/globals.css": "body {}\n",
      "apps/frontend_customer/features/x/x.tsx": lines(
        'import classes from "./x.module.css";',
        "export const X = () => (",
        '  <Box mt="md" classNames={classes} color="red" />',
        ");",
        'import { Box, Text } from "@mantine/core";',
      ),
      "apps/frontend_customer/features/x/x.module.css": ".a {}\n",
    });

    // when
    const violations = DesignSystemRule.collectViolations(
      root,
      FAKE_STYLE_PROPS,
    );

    // then
    expect(violations).toEqual({
      "design-system-no-direct-style": [
        "design-system-no-direct-style: apps/frontend_customer/app/layout.tsx:2",
        "design-system-no-direct-style: apps/frontend_customer/features/x/x.tsx:3",
        "design-system-no-direct-style: apps/frontend_customer/features/x/x.tsx:3",
        "design-system-no-direct-style: apps/frontend_customer/features/x/x.tsx:3",
      ],
      "design-system-css-placement": [
        "design-system-css-placement: apps/frontend_customer/app/globals.css",
        "design-system-css-placement: apps/frontend_customer/features/x/x.module.css",
        "design-system-css-placement: apps/frontend_customer/app/layout.tsx:1",
        "design-system-css-placement: apps/frontend_customer/features/x/x.tsx:1",
      ],
      "design-system-themed-components": [
        "design-system-themed-components: apps/frontend_customer/app/layout.tsx:3 ColorSchemeScript",
        "design-system-themed-components: apps/frontend_customer/features/x/x.tsx:5 Box",
      ],
    });
  });

  it("theme-definition.ts が無ければ一覧は空で、@mantine/core の値の import はすべて違反", () => {
    // given
    const root = fixture({
      "apps/frontend_customer/features/x/x.tsx":
        'import { Button } from "@mantine/core";\nexport const b = Button;\n',
    });

    // when
    const violations = DesignSystemRule.collectViolations(
      root,
      FAKE_STYLE_PROPS,
    );

    // then
    expect(violations["design-system-themed-components"]).toEqual([
      "design-system-themed-components: apps/frontend_customer/features/x/x.tsx:1 Button",
    ]);
  });

  it("apps/frontend_customer が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    // given
    const root = fixture({ "README.md": "# x\n" });

    // when
    const sources = DesignSystemRule.listCheckedSources(root);
    const violations = DesignSystemRule.collectViolations(
      root,
      FAKE_STYLE_PROPS,
    );

    // then
    expect(sources).toEqual([]);
    expect(violations).toEqual({
      "design-system-no-direct-style": [],
      "design-system-css-placement": [],
      "design-system-themed-components": [],
    });
  });
});

describe("デザインシステム（実ファイル）", () => {
  it("Mantine の style props の一覧を @mantine/core の STYLE_PROPS_DATA から読める（空でない）", () => {
    // given: apps/frontend_customer の依存の @mantine/core（実物）

    // when
    const styleProps = DesignSystemRule.mantineStyleProps(repoRoot);

    // then
    expect(styleProps).toEqual(
      expect.arrayContaining(["m", "mt", "p", "bg", "c", "w", "h", "display"]),
    );
  });

  it("テーマの部品の一覧（theme-definition.ts の ThemedComponent）を読める（空でない）", () => {
    // given
    const file = DesignSystemRule.THEME_DEFINITION;
    const source = readFileSync(join(repoRoot, file), "utf8");

    // when
    const themed = DesignSystemRule.themedComponents(
      DesignSystemRule.parse({ [file]: source }).get(file),
    );

    // then
    expect(themed).toEqual(expect.arrayContaining(["Button", "Text"]));
  });

  describe("規則ごとの検査", () => {
    const styleProps = DesignSystemRule.mantineStyleProps(repoRoot);
    const sources = DesignSystemRule.listCheckedSources(repoRoot);
    const violations = DesignSystemRule.collectViolations(repoRoot, styleProps);

    it("列挙: apps/frontend_customer のテスト以外のソース（shared/ui/ の外）が 1 件以上ある", () => {
      // given: describe の冒頭で listCheckedSources(repoRoot) 済み（実ファイル）

      // when
      const count = sources.length;

      // then
      expect(count).toBeGreaterThan(0);
    });

    it("design-system-no-direct-style: shared/ui/ の外で style・className・Styles API・Mantine の style props を書かない", () => {
      // given: describe の冒頭で collectViolations(repoRoot) 済み（実ファイル）

      // when
      const result = violations["design-system-no-direct-style"];

      // then
      expect(result).toEqual([]);
    });

    it("design-system-css-placement: .css は shared/ui/ の下だけに置き、shared/ui/ の外から import しない", () => {
      // given: describe の冒頭で collectViolations(repoRoot) 済み（実ファイル）

      // when
      const result = violations["design-system-css-placement"];

      // then
      expect(result).toEqual([]);
    });

    it("design-system-themed-components: shared/ui/ の外で @mantine/core から値で取り込むのは ThemedComponent にある部品だけ", () => {
      // given: describe の冒頭で collectViolations(repoRoot) 済み（実ファイル）

      // when
      const result = violations["design-system-themed-components"];

      // then
      expect(result).toEqual([]);
    });
  });
});
