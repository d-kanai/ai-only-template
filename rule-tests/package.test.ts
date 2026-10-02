// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは JSON を読むだけで DOM を使わないため、
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
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect } from "vitest";
import { casesByName } from "./case-table";

// 依存の版は package.json 上でも完全固定する（.claude/rules/dependencies.md）。
// 対象は pnpm workspace のすべての package.json（リポジトリ直下と、pnpm-workspace.yaml の packages に当たる apps/* など。Issue #68）。
// lockfile だけに頼ると、`pnpm update` や lockfile の再生成で範囲内の別の版に解決し直されうるため、
// package.json 側でも範囲指定（^ ~ >= など）を禁止し、このテストで機械的に担保する。
//
// ルール検査テスト（.claude/rules/testing.md）なので、判定（isPinnedVersion）・列挙（listDependencies）を関数に切り出し、
// 許可される例（must pass）と違反の例（must reject）の両方で固定する。今の package.json に違反が無いことだけでは、
// 判定が常に「固定済み」を返す壊れ方を検出できないため。
// .feature（package.feature）と step の実装（このファイル）に分けた（Issue #282）。

const repoRoot = join(import.meta.dirname, "..");

// WHY x.y.z の数字 3 つだけを許す（プレリリース 1.2.3-beta.1 とビルドメタ 1.2.3+build も拒否する）:
//   完全固定の狙いは「意図した版だけが入る」ことで、x.y.z はそれ自体は満たす。ただしプレリリースは安定版の前提
//   （semver の互換性の約束）から外れ、ビルドメタは npm の版の比較で無視される（同じ x.y.z の別ビルドを区別できない）。
//   どちらも通常の依存では使わないので拒否に倒し、使う必要が出たら Issue で決める（.claude/rules/dependencies.md）。
//   `=1.2.3` や `v1.2.3` も npm は完全一致として解釈するが、書き方を 1 通りにするため拒否する。
//   先頭が 0 の数（`01.2.3`）は semver で不正なので拒否する（0 そのものは許す）。
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function isPinnedVersion(spec: string): boolean {
  return EXACT_VERSION.test(spec);
}

// workspace の中のパッケージ（@repo/backend など）への依存の書き方。完全固定の例外として、この 1 通りだけを許す（Issue #68）。
// WHY 例外にする: workspace: は npm レジストリの版ではなく、同じリポジトリの中のパッケージ（apps/backend）に symlink する。
//   入る中身は常にリポジトリの中のソースそのもので、「範囲内の別の版が入る」ことが起きないので、完全固定の狙いは満たす。
// WHY "workspace:*" だけ（workspace:^ / workspace:~ / workspace:1.2.3 を拒否する）: 書き方を 1 通りにするため。
//   ^ / ~ / 版は、公開（pnpm publish）のときに版の範囲に置き換わる書き方で、公開しない private のパッケージでは意味がない。
//   workspace:1.2.3 は、参照先の package.json の version と一致しないと install が失敗し、version を書かない方針の
//   apps/* では使えない。
const WORKSPACE_PROTOCOL = "workspace:*";

function isAllowedVersion(spec: string): boolean {
  return isPinnedVersion(spec) || spec === WORKSPACE_PROTOCOL;
}

// WHY dependencies と devDependencies の 2 つ: .claude/rules/dependencies.md の対象がこの 2 つ。
//   片方だけを見る壊れ方（書き間違い・消し忘れ）をテストで検出するため、定数で持って両方の例を用意する。
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies"] as const;
type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

type Manifest = Partial<Record<DependencyField, Record<string, string>>>;

type Dependency = { field: DependencyField; name: string; spec: string };

function listDependencies(manifest: Manifest): Dependency[] {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([name, spec]) => ({
      field,
      name,
      spec,
    })),
  );
}

function findNonPinnedVersions(manifest: Manifest): Dependency[] {
  return listDependencies(manifest).filter(
    (dependency) => !isAllowedVersion(dependency.spec),
  );
}

type Occurrence = { path: string; field: DependencyField; spec: string };
type Inconsistency = { name: string; occurrences: Occurrence[] };

// workspace の package.json をまたいで、同じ名前の依存が 2 通り以上の版で書かれているものを返す（Issue #68 の段階 2）。
//   dependencies と devDependencies を区別せずに比べる（同じ package.json の中でのずれも検出する）。
//   occurrences は、その依存が出てくる場所を manifests の順・フィールドの順に並べたもの（ずれていない場所も含める。
//   失敗時に、どこをそろえればよいかが出力に出るように）。
// WHY 版の文字列をそのまま比べる: 版は完全固定（x.y.z か workspace:*）なので、文字列が違えば入る版も違う。
function findInconsistentVersions(
  manifests: { path: string; manifest: Manifest }[],
): Inconsistency[] {
  const byName = new Map<string, Occurrence[]>();
  for (const { path, manifest } of manifests) {
    for (const { field, name, spec } of listDependencies(manifest)) {
      byName.set(name, [...(byName.get(name) ?? []), { path, field, spec }]);
    }
  }
  return [...byName]
    .filter(
      ([, occurrences]) =>
        new Set(occurrences.map((occurrence) => occurrence.spec)).size > 1,
    )
    .map(([name, occurrences]) => ({ name, occurrences }));
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

// pnpm-workspace.yaml の packages（workspace に含めるディレクトリのパターン）を読む。
// WHY yaml パーサを依存に加えない: rule-tests/pnpm-workspace.test.ts と同じ理由（読みたいのはトップレベルの packages のリストだけ）。
// 読み取りの仕様: 行頭の `packages:` の後ろの、インデントされた `- <パターン>` の行（クォートあり・なし、行末のコメント可）を
//   次のトップレベルのキーまで読む。コメントの行と空行は飛ばす。
function readWorkspacePackagePatterns(yaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) {
      continue;
    }
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*(?:#.*)?$/.test(line);
      continue;
    }
    const item = /^\s+-\s+(["']?)([^"'\s#]+)\1\s*(?:#.*)?$/.exec(line);
    if (inPackages && item !== null) {
      patterns.push(item[2] ?? "");
    }
  }
  return patterns;
}

// パターン（"apps/*"）に当たる、package.json を持つディレクトリ（リポジトリ相対）。
// WHY "<ディレクトリ>/*" の形だけを扱い、それ以外は例外にする: 今の pnpm-workspace.yaml が使うのはこの形だけ。
//   "**" や "!" の除外などを黙って読み落とすと、そのパッケージの package.json が検査から漏れるため、読めない形は止める。
function expandWorkspacePattern(root: string, pattern: string): string[] {
  const match = /^([\w.-]+(?:\/[\w.-]+)*)\/\*$/.exec(pattern);
  if (match === null) {
    throw new Error(
      `pnpm-workspace.yaml の packages の "${pattern}" は読めない形（"<ディレクトリ>/*" だけを扱う）`,
    );
  }
  const dir = match[1] ?? "";
  if (!existsSync(join(root, dir))) {
    return [];
  }
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, dir, entry.name, "package.json")),
    )
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

// workspace のすべての package.json（リポジトリ相対）。リポジトリ直下の package.json（workspace のルート）を先頭に置く。
function listWorkspaceManifests(root: string): string[] {
  const workspaceYaml = join(root, "pnpm-workspace.yaml");
  const patterns = existsSync(workspaceYaml)
    ? readWorkspacePackagePatterns(readFileSync(workspaceYaml, "utf8"))
    : [];
  return [
    "package.json",
    ...patterns.flatMap((pattern) =>
      expandWorkspacePattern(root, pattern).map((dir) => `${dir}/package.json`),
    ),
  ];
}

let dir: string;

beforeAll(() => {
  // WHY: fixture をリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残る。OS の一時ディレクトリに置いて afterAll で消す。
  dir = mkdtempSync(join(tmpdir(), "package-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const manifestPaths = listWorkspaceManifests(repoRoot);
const manifests = manifestPaths.map((path) => ({
  path,
  manifest: readManifest(join(repoRoot, path)),
}));

const feature = await loadFeature("./package.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("版の判定（isPinnedVersion）", ({ And }) => {
    And("完全固定の版は許可する（1.2.3・0.0.1・10.20.30）", () => {
      // given
      const cases: [string][] = [["1.2.3"], ["0.0.1"], ["10.20.30"]];

      // when
      const result = casesByName(cases, ([spec]) => isPinnedVersion(spec));

      // then
      expect(result).toEqual(casesByName(cases, () => true));
    });

    And(
      "完全固定でない書き方は拒否する（キャレット・チルダ・比較演算子・範囲・x・メジャーだけ・先頭が 0・任意の版・dist-tag・workspace プロトコル・npm: の別名・パス・git・URL・空文字・= と v 付き・空白・プレリリース・ビルドメタ）",
      () => {
        // given
        const cases: [string, string][] = [
          ["^1.2.3", "キャレット（マイナー・パッチの更新を許す）"],
          ["~1.2.3", "チルダ（パッチの更新を許す）"],
          [">=1.2.3", "比較演算子"],
          ["1.2.3 - 2.0.0", "ハイフンの範囲"],
          ["1.2.3 || 2.0.0", "OR の範囲"],
          ["1.2.x", "x のワイルドカード"],
          ["1.2", "メジャー.マイナーだけ（1.2.x と同じ範囲）"],
          ["1", "メジャーだけ（1.x.x と同じ範囲）"],
          ["~1", "チルダとメジャーだけ"],
          ["01.2.3", "先頭が 0 の数（semver で不正）"],
          ["1.02.3", "先頭が 0 の数（マイナー）"],
          ["1.2.03", "先頭が 0 の数（パッチ）"],
          ["*", "任意の版"],
          ["latest", "dist-tag"],
          [
            "workspace:*",
            "workspace プロトコル（完全固定ではない。例外は isAllowedVersion で許す）",
          ],
          ["npm:pkg@1.2.3", "npm: の別名"],
          ["file:../pkg", "ローカルのパス"],
          ["github:owner/repo", "git リポジトリ"],
          ["https://example.com/pkg.tgz", "URL の tarball"],
          ["", "空文字"],
          ["=1.2.3", "= 付き（npm は完全一致と解釈するが書き方を揃える）"],
          ["v1.2.3", "v 付き（同上）"],
          [" 1.2.3", "前後の空白"],
          ["1.2.3-beta.1", "プレリリース（安定版の前提から外れる）"],
          ["1.2.3+build", "ビルドメタ（版の比較で無視される）"],
        ];

        // when
        const result = casesByName(cases, ([spec]) => isPinnedVersion(spec));

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("許可する書き方の判定（isAllowedVersion）", ({ And }) => {
    And(
      "完全固定の版と workspace: の星印は許可する（1.2.3・0.0.1・workspace: の星印）",
      () => {
        // given
        const cases: [string][] = [["1.2.3"], ["0.0.1"], ["workspace:*"]];

        // when
        const result = casesByName(cases, ([spec]) => isAllowedVersion(spec));

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    And(
      "星印以外の workspace: と完全固定でない版は拒否する（workspace: の ^・~・版・範囲・空・星印 2 つ・前後の空白、キャレット、任意の版）",
      () => {
        // given
        const cases: [string, string][] = [
          ["workspace:^", "公開時に ^ の範囲になる書き方"],
          ["workspace:~", "公開時に ~ の範囲になる書き方"],
          ["workspace:1.2.3", "版の指定（参照先に version が要る）"],
          ["workspace:^1.2.3", "範囲の指定"],
          ["workspace:", "* の無い workspace:"],
          ["workspace:**", "* 以外の文字"],
          [" workspace:*", "前後の空白"],
          ["^1.2.3", "キャレット（完全固定でもない）"],
          ["*", "任意の版"],
        ];

        // when
        const result = casesByName(cases, ([spec]) => isAllowedVersion(spec));

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("範囲指定の検出（findNonPinnedVersions）", ({ And }) => {
    And("dependencies の範囲指定を検出する", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const result = findNonPinnedVersions({
        dependencies: { a: "1.0.0", b: "^1.0.0" },
        devDependencies: { c: "1.0.0" },
      });

      // then
      expect(result).toEqual([
        { field: "dependencies", name: "b", spec: "^1.0.0" },
      ]);
    });

    And("devDependencies の範囲指定を検出する", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const result = findNonPinnedVersions({
        dependencies: { a: "1.0.0" },
        devDependencies: { c: "1.0.0", d: "~1.0.0" },
      });

      // then
      expect(result).toEqual([
        { field: "devDependencies", name: "d", spec: "~1.0.0" },
      ]);
    });

    And("すべて完全固定なら何も検出しない", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const result = findNonPinnedVersions({
        dependencies: { a: "1.0.0" },
        devDependencies: { c: "2.3.4" },
      });

      // then
      expect(result).toEqual([]);
    });

    And("workspace: の星印は検出せず、それ以外の workspace: は検出する", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const result = findNonPinnedVersions({
        dependencies: { "@repo/a": "workspace:*", "@repo/b": "workspace:^" },
        devDependencies: { "@repo/c": "workspace:1.0.0" },
      });

      // then
      expect(result).toEqual([
        { field: "dependencies", name: "@repo/b", spec: "workspace:^" },
        { field: "devDependencies", name: "@repo/c", spec: "workspace:1.0.0" },
      ]);
    });

    And(
      "dependencies / devDependencies が無い package.json は依存 0 件として扱う",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const result = listDependencies({});

        // then
        expect(result).toEqual([]);
      },
    );
  });

  Scenario(
    "workspace の中での版のずれの検出（findInconsistentVersions）",
    ({ And }) => {
      const root = (manifest: Manifest) => ({ path: "package.json", manifest });
      const backend = (manifest: Manifest) => ({
        path: "apps/backend/package.json",
        manifest,
      });

      And(
        "同じ名前の依存が、すべての package.json で同じ版なら何も検出しない",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const result = findInconsistentVersions([
            root({ devDependencies: { pg: "8.23.0", "@types/pg": "8.23.1" } }),
            backend({
              dependencies: { pg: "8.23.0" },
              devDependencies: { "@types/pg": "8.23.1" },
            }),
          ]);

          // then
          expect(result).toEqual([]);
        },
      );

      And(
        "名前が違えば版が違っても検出しない（前方一致だけが同じ別パッケージも別名）",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const result = findInconsistentVersions([
            root({ devDependencies: { pg: "8.23.0" } }),
            backend({
              dependencies: { "pg-format": "1.0.4", "@types/pg": "8.23.1" },
            }),
          ]);

          // then
          expect(result).toEqual([]);
        },
      );

      And("片方の package.json にだけある依存は検出しない", () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const result = findInconsistentVersions([
          root({ devDependencies: { vitest: "5.0.1" } }),
          backend({ dependencies: { "drizzle-orm": "0.45.3" } }),
        ]);

        // then
        expect(result).toEqual([]);
      });

      And(
        "リポジトリ直下と app で版が違う依存を、出てくる場所ごとに検出する",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const result = findInconsistentVersions([
            root({ devDependencies: { pg: "8.23.0", typescript: "7.0.2" } }),
            backend({ dependencies: { pg: "8.22.0" } }),
          ]);

          // then
          expect(result).toEqual([
            {
              name: "pg",
              occurrences: [
                {
                  path: "package.json",
                  field: "devDependencies",
                  spec: "8.23.0",
                },
                {
                  path: "apps/backend/package.json",
                  field: "dependencies",
                  spec: "8.22.0",
                },
              ],
            },
          ]);
        },
      );

      And(
        "同じ package.json の dependencies と devDependencies で版が違う依存も検出する",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const result = findInconsistentVersions([
            backend({
              dependencies: { pg: "8.23.0" },
              devDependencies: { pg: "8.23.1" },
            }),
          ]);

          // then
          expect(result).toEqual([
            {
              name: "pg",
              occurrences: [
                {
                  path: "apps/backend/package.json",
                  field: "dependencies",
                  spec: "8.23.0",
                },
                {
                  path: "apps/backend/package.json",
                  field: "devDependencies",
                  spec: "8.23.1",
                },
              ],
            },
          ]);
        },
      );
    },
  );

  Scenario("package.json の実ファイル", ({ And }) => {
    // 読み込み → 列挙 → 判定を、本番と同じ readManifest で実ファイルから通す（判定だけ正しくても、読み込みや列挙が
    //   漏れれば違反は見逃されるため。.claude/rules/testing.md の「ルール検査テスト」）。
    And(
      "範囲指定を含む package.json からは、違反の依存をすべて検出する",
      () => {
        // given
        const file = join(dir, "package.json");
        writeFileSync(
          file,
          JSON.stringify({
            name: "fixture",
            dependencies: { pinned: "1.0.0", caret: "^1.0.0", tag: "latest" },
            devDependencies: {
              tilde: "~2.0.0",
              pre: "3.0.0-rc.1",
              ok: "4.5.6",
            },
            // 対象外のフィールド（scripts）の値は判定しない。
            scripts: { build: "^not-a-version" },
          }),
        );

        // when
        const violations = findNonPinnedVersions(readManifest(file));

        // then
        expect(violations).toEqual([
          { field: "dependencies", name: "caret", spec: "^1.0.0" },
          { field: "dependencies", name: "tag", spec: "latest" },
          { field: "devDependencies", name: "tilde", spec: "~2.0.0" },
          { field: "devDependencies", name: "pre", spec: "3.0.0-rc.1" },
        ]);
      },
    );

    // workspace の package.json の列挙を、一時ディレクトリの架空のツリーで固定する（列挙が漏れると、そのパッケージの
    //   範囲指定は検査されないまま通るため）。
    And(
      "pnpm-workspace.yaml の packages に当たり package.json を持つディレクトリを、リポジトリ直下の package.json と合わせて列挙する",
      () => {
        // given
        const root = join(dir, "workspace");
        const files: Record<string, string> = {
          "package.json": "{}",
          "pnpm-workspace.yaml": [
            "# コメント",
            "packages:",
            '  - "apps/*"',
            "  - libs/* # 行末のコメント",
            "  # - skipped/*",
            "",
            "allowBuilds:",
            "  - notpackages/*",
          ].join("\n"),
          "apps/b/package.json": "{}",
          "apps/a/package.json": "{}",
          "libs/x/package.json": "{}",
          // package.json の無いディレクトリ・パターンの外・コメントアウトしたパターンは数えない。
          "apps/no-manifest/index.ts": "",
          "skipped/y/package.json": "{}",
          "notpackages/z/package.json": "{}",
          "apps/a/nested/package.json": "{}",
        };
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(join(root, path, ".."), { recursive: true });
          writeFileSync(join(root, path), content);
        }

        // when
        const listed = listWorkspaceManifests(root);

        // then
        expect(listed).toEqual([
          "package.json",
          "apps/a/package.json",
          "apps/b/package.json",
          "libs/x/package.json",
        ]);
      },
    );

    And(
      "pnpm-workspace.yaml の packages が <ディレクトリ>/ の後が星印 1 つの形以外なら、読み落とさずに例外にする",
      () => {
        // given
        const root = join(dir, "unsupported");
        mkdirSync(root, { recursive: true });
        writeFileSync(
          join(root, "pnpm-workspace.yaml"),
          "packages:\n  - apps/**\n",
        );

        // when
        const action = () => listWorkspaceManifests(root);

        // then
        expect(action).toThrow(
          new Error(
            'pnpm-workspace.yaml の packages の "apps/**" は読めない形（"<ディレクトリ>/*" だけを扱う）',
          ),
        );
      },
    );

    // WHY: 列挙が漏れる（pnpm-workspace.yaml の読み違い・パターンの書き換え）と、そのパッケージの範囲指定は検査されない。
    //   今の workspace のパッケージ（リポジトリ直下・apps/backend・apps/e2e・apps/frontend_customer・apps/shared）がすべて入っていることを確かめる。
    And("リポジトリ直下と apps の下の package.json をすべて列挙できる", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const result = manifestPaths;

      // then
      expect(result).toEqual(
        expect.arrayContaining([
          "package.json",
          "apps/backend/package.json",
          "apps/e2e/package.json",
          "apps/frontend_customer/package.json",
          "apps/shared/package.json",
        ]),
      );
    });

    // WHY: 列挙が 0 件なら違反も 0 件になり、下の「完全固定」のテストが常に緑になる（読むファイルや
    //   フィールド名の書き間違いで起きる）。dependencies と devDependencies の両方から 1 件以上拾えていることを先に確かめる。
    And(
      "workspace の package.json の dependencies と devDependencies のそれぞれから 1 件以上の依存を列挙できる",
      () => {
        // given
        const cases: [DependencyField][] = DEPENDENCY_FIELDS.map((field) => [
          field,
        ]);

        // when
        const result = casesByName(
          cases,
          ([field]) =>
            manifests
              .flatMap(({ manifest }) => listDependencies(manifest))
              .filter((dependency) => dependency.field === field).length > 0,
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    // WHY: 同じパッケージを複数の package.json に置く（pg / @types/pg は E2E 用の apps/e2e と apps/backend の両方）と、
    //   片方だけ版を上げたときに、同じ workspace に同じパッケージの 2 つの版が入り、どちらのコードがどちらの版で動くかが
    //   package.json を見ても分からなくなる。版を上げるときに両方を上げ忘れないよう、機械的に止める（.claude/rules/dependencies.md）。
    And(
      "workspace の package.json をまたいで、同じ名前の依存は同じ版で書かれている",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const result = findInconsistentVersions(manifests);

        // then
        expect(result).toEqual([]);
      },
    );

    // WHY: 上の検査は 2 か所以上に出てくる依存が無いと何も比べない。今のリポジトリで比べる対象（pg）が列挙できていることを確かめる。
    And(
      "2 つ以上の package.json に出てくる依存（pg）を、比べる対象として列挙できる",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const result = manifests.filter(({ manifest }) =>
          listDependencies(manifest).some(
            (dependency) => dependency.name === "pg",
          ),
        ).length;

        // then
        expect(result).toBeGreaterThanOrEqual(2);
      },
    );

    And(
      "workspace のすべての package.json の dependencies / devDependencies は完全固定（x.y.z）か workspace: の星印で書かれている",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const result = manifests.flatMap(({ path, manifest }) =>
          findNonPinnedVersions(manifest).map((dependency) => ({
            path,
            ...dependency,
          })),
        );

        // then
        // 失敗時にどの package.json のどのパッケージがどの値かが出力に出るよう、条件を満たさない依存を集めて空配列と比較する。
        expect(result).toEqual([]);
      },
    );
  });
});
