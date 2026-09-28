// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは JSON を読むだけで DOM を使わないため、
//   jsdom の初期化を省き、ブラウザ相当の globals が Node の API と混ざる余地をなくすため node 環境で動かす。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 依存の版は package.json 上でも完全固定する（rules/code/dependencies.md）。
// lockfile だけに頼ると、`pnpm update` や lockfile の再生成で範囲内の別の版に解決し直されうるため、
// package.json 側でも範囲指定（^ ~ >= など）を禁止し、このテストで機械的に担保する。
//
// ルール検査テスト（rules/code/test.md）なので、判定（isPinnedVersion）・列挙（listDependencies）を関数に切り出し、
// 許可される例（must pass）と違反の例（must reject）の両方で固定する。今の package.json に違反が無いことだけでは、
// 判定が常に「固定済み」を返す壊れ方を検出できないため。

const repoRoot = import.meta.dirname;

// WHY x.y.z の数字 3 つだけを許す（プレリリース 1.2.3-beta.1 とビルドメタ 1.2.3+build も拒否する）:
//   完全固定の狙いは「意図した版だけが入る」ことで、x.y.z はそれ自体は満たす。ただしプレリリースは安定版の前提
//   （semver の互換性の約束）から外れ、ビルドメタは npm の版の比較で無視される（同じ x.y.z の別ビルドを区別できない）。
//   どちらも通常の依存では使わないので拒否に倒し、使う必要が出たら Issue で決める（rules/code/dependencies.md）。
//   `=1.2.3` や `v1.2.3` も npm は完全一致として解釈するが、書き方を 1 通りにするため拒否する。
//   先頭が 0 の数（`01.2.3`）は semver で不正なので拒否する（0 そのものは許す）。
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function isPinnedVersion(spec: string): boolean {
  return EXACT_VERSION.test(spec);
}

// WHY dependencies と devDependencies の 2 つ: rules/code/dependencies.md の対象がこの 2 つ。
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
    (dependency) => !isPinnedVersion(dependency.spec),
  );
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

describe("版の判定（isPinnedVersion）", () => {
  it.each([["1.2.3"], ["0.0.1"], ["10.20.30"]])(
    "完全固定の %s は許可する",
    (spec) => {
      expect(isPinnedVersion(spec)).toBe(true);
    },
  );

  it.each([
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
    ["workspace:*", "workspace プロトコル"],
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
  ])("%s（%s）は拒否する", (spec) => {
    expect(isPinnedVersion(spec)).toBe(false);
  });
});

describe("範囲指定の検出（findNonPinnedVersions）", () => {
  it("dependencies の範囲指定を検出する", () => {
    expect(
      findNonPinnedVersions({
        dependencies: { a: "1.0.0", b: "^1.0.0" },
        devDependencies: { c: "1.0.0" },
      }),
    ).toEqual([{ field: "dependencies", name: "b", spec: "^1.0.0" }]);
  });

  it("devDependencies の範囲指定を検出する", () => {
    expect(
      findNonPinnedVersions({
        dependencies: { a: "1.0.0" },
        devDependencies: { c: "1.0.0", d: "~1.0.0" },
      }),
    ).toEqual([{ field: "devDependencies", name: "d", spec: "~1.0.0" }]);
  });

  it("すべて完全固定なら何も検出しない", () => {
    expect(
      findNonPinnedVersions({
        dependencies: { a: "1.0.0" },
        devDependencies: { c: "2.3.4" },
      }),
    ).toEqual([]);
  });

  it("dependencies / devDependencies が無い package.json は依存 0 件として扱う", () => {
    expect(listDependencies({})).toEqual([]);
  });
});

describe("package.json の実ファイル", () => {
  let dir: string;

  beforeAll(() => {
    // WHY: fixture をリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残る。OS の一時ディレクトリに置いて afterAll で消す。
    dir = mkdtempSync(join(tmpdir(), "package-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 読み込み → 列挙 → 判定を、本番と同じ readManifest で実ファイルから通す（判定だけ正しくても、読み込みや列挙が
  //   漏れれば違反は見逃されるため。rules/code/test.md の「判定だけでなく、実ファイルで end-to-end に通す」）。
  it("範囲指定を含む package.json からは、違反の依存をすべて検出する", () => {
    const file = join(dir, "package.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "fixture",
        dependencies: { pinned: "1.0.0", caret: "^1.0.0", tag: "latest" },
        devDependencies: { tilde: "~2.0.0", pre: "3.0.0-rc.1", ok: "4.5.6" },
        // 対象外のフィールド（scripts）の値は判定しない。
        scripts: { build: "^not-a-version" },
      }),
    );

    expect(findNonPinnedVersions(readManifest(file))).toEqual([
      { field: "dependencies", name: "caret", spec: "^1.0.0" },
      { field: "dependencies", name: "tag", spec: "latest" },
      { field: "devDependencies", name: "tilde", spec: "~2.0.0" },
      { field: "devDependencies", name: "pre", spec: "3.0.0-rc.1" },
    ]);
  });

  const manifest = readManifest(join(repoRoot, "package.json"));

  // WHY: 列挙が 0 件なら違反も 0 件になり、下の「完全固定」のテストが常に緑になる（読むファイルや
  //   フィールド名の書き間違いで起きる）。dependencies と devDependencies の両方から 1 件以上拾えていることを先に確かめる。
  it.each(DEPENDENCY_FIELDS)("%s から 1 件以上の依存を列挙できる", (field) => {
    expect(
      listDependencies(manifest).filter(
        (dependency) => dependency.field === field,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("dependencies / devDependencies はすべて完全固定（x.y.z）で書かれている", () => {
    // 失敗時にどのパッケージがどの値かが出力に出るよう、条件を満たさない依存を集めて空配列と比較する。
    expect(findNonPinnedVersions(manifest)).toEqual([]);
  });
});
