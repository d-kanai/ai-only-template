// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは git の属性を読むだけで DOM を使わないため、node 環境で動かす。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";

// PR の差分で最初から畳むファイル（ルート の .gitattributes の linguist-generated）を検査するテスト（Issue #411）。
// WHY 畳む: GitHub は linguist-generated のファイルを PR の「Files changed」で最初から畳む（"hidden by default in diffs"。
//   https://docs.github.com/en/repositories/working-with-files/managing-files/customizing-how-changed-files-appear-on-github）。
//   lockfile や生成物の大きな差分が、人が読むべき変更（ソース・テスト・.feature の仕様）を埋めないようにする。
//   畳んだファイルも「Load diff」で開けるので、見えなくなるわけではない。
// WHY 判定（shouldCollapse）を .gitattributes と別に持つ: .gitattributes は glob の一覧で、どのファイルに効くかは git が決める。
//   ここで「畳むファイル」を仕様として書き、`git check-attr` の結果と全ファイルで比べることで、
//   (1) .gitattributes の行の消し忘れ・書き間違い（畳むはずのファイルが開いたまま）と、
//   (2) glob が広すぎて手で書くファイル（例: マイグレーションの SQL）まで畳む誤り、の両方を止める。
//   新しい種類の生成物を足すときは、ここの判定と .gitattributes の両方を直す。
// 限界: GitHub の画面で実際に畳まれるかは見ない（git の属性までを検査する。GitHub 側の読み方は上の公式ドキュメントに従う）。
//   GitHub（linguist）が既定で生成物と見なすファイル（例: *.min.js）は、.gitattributes に書かなくても畳まれることがあるが、ここでは数えない。

// 畳むファイル。正規表現はリポジトリ相対の / 区切りのパスに当てる。
const COLLAPSED: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /(^|\/)pnpm-lock\.yaml$/,
    why: "pnpm が書く lockfile。版の変更は package.json の差分で読む",
  },
  {
    pattern: /(^|\/)\.terraform\.lock\.hcl$/,
    why: "terraform init が書くプロバイダの lockfile（infra/envs/<環境>/）",
  },
  {
    pattern: /^apps\/backend\/shared\/drizzle\/migrations\/meta\//,
    why: "drizzle-kit generate が書くスナップショットと journal。読むのは同じディレクトリの SQL（スキル db-migration）",
  },
  {
    pattern: /^docs\/work-logs\//,
    why: "作業ログ。PR ごとに CI が差分を必須にしていて毎回載るが、PR の「実装経緯」から見出しで辿れる",
  },
  {
    pattern: /^docs\/diagrams\/[^/]+\.(mmd|png)$/,
    why: "スキル infra-diagram が Terraform と deploy.yml から生成する構成図（.mmd と .png）。README.md は図の説明で人が直すので畳まない",
  },
];

function shouldCollapse(path: string): boolean {
  return COLLAPSED.some(({ pattern }) => pattern.test(path));
}

// files のうち、root の .gitattributes で linguist-generated が付いているもの（名前順）。
// WHY set と true だけを畳むと読む: `path linguist-generated` は set、`linguist-generated=true` は true を返す。
//   `-linguist-generated` は unset、`=false` は false、指定なしは unspecified で、GitHub はどれも畳まない。
// WHY -z: パスに空白や改行があっても区切りを取り違えない（出力は path NUL attr NUL value NUL の繰り返し）。
function listCollapsedByGit(root: string, files: readonly string[]): string[] {
  const output = execFileSync(
    "git",
    ["check-attr", "-z", "--stdin", "linguist-generated"],
    { cwd: root, encoding: "utf8", input: files.map((f) => `${f}\0`).join("") },
  );
  const fields = output.split("\0");
  const collapsed: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === "set" || fields[i + 2] === "true") {
      collapsed.push(fields[i]);
    }
  }
  return collapsed.sort();
}

// リポジトリのファイル（追跡済みと、.gitignore に無い未追跡）。削除済みで作業ツリーに無いものは除く。
// WHY 未追跡も含める: コミット前に足したファイルも同じ条件で検査するため（rule-tests/instructions.test.ts の listRepoFiles と同じ）。
function listRepoFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(output.split("\n").filter((line) => line !== ""))]
    .filter((file) => existsSync(join(root, file)))
    .sort();
}

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const fixtureRoots: string[] = [];
afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function gitFixture(gitattributes: string): string {
  const root = mkdtempSync(join(tmpdir(), "gitattributes-"));
  fixtureRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitattributes"), gitattributes);
  return root;
}

const feature = await loadFeature("./gitattributes.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("畳むファイルの判定", ({ And }) => {
    And(
      "lockfile・drizzle-kit の生成物（meta）・作業ログ・構成図は畳む",
      () => {
        // given
        const cases: [string, string][] = [
          ["pnpm の lockfile", "pnpm-lock.yaml"],
          ["terraform の lockfile", "infra/envs/stg/.terraform.lock.hcl"],
          [
            "drizzle-kit のスナップショット",
            "apps/backend/shared/drizzle/migrations/meta/0000_snapshot.json",
          ],
          [
            "drizzle-kit の journal",
            "apps/backend/shared/drizzle/migrations/meta/_journal.json",
          ],
          ["作業ログ", "docs/work-logs/2026-10-03.md"],
          ["構成図の mermaid", "docs/diagrams/system.mmd"],
          ["構成図の画像", "docs/diagrams/system.png"],
        ];

        // when
        const result = casesByName(cases, ([, path]) => shouldCollapse(path));

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    And(
      "手で書くファイル（ソース・テスト・マイグレーションの SQL・ADR・構成図の説明・設定）は畳まない",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "マイグレーションの SQL",
            "apps/backend/shared/drizzle/migrations/0000_create_todos.sql",
          ],
          ["ソース", "apps/backend/shared/drizzle/writer.ts"],
          ["ルール検査テスト", "rule-tests/gitattributes.test.ts"],
          ["仕様", "rule-tests/gitattributes.feature"],
          ["ADR", "docs/adr/README.md"],
          ["構成図の説明（人が直す）", "docs/diagrams/README.md"],
          ["package.json", "package.json"],
          ["Terraform のソース", "infra/envs/stg/main.tf"],
          ["名前に lock を含む別のファイル", "pnpm-lock.yaml.md"],
          ["docs の直下", "docs/work-logs.md"],
          ["meta の名前の別のディレクトリ", "apps/backend/meta/x.json"],
        ];

        // when
        const result = casesByName(cases, ([, path]) => shouldCollapse(path));

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("git の属性の読み方（fixture）", ({ And }) => {
    And(
      "linguist-generated を付けた・true にしたファイルだけを畳むと読み、外した・false・指定なしは畳まないと読む",
      () => {
        // given
        const root = gitFixture(
          [
            "set.txt linguist-generated",
            "true.txt linguist-generated=true",
            "unset.txt -linguist-generated",
            "false.txt linguist-generated=false",
            "dir/** linguist-generated",
            "",
          ].join("\n"),
        );
        const files = [
          "set.txt",
          "true.txt",
          "unset.txt",
          "false.txt",
          "unspecified.txt",
          "dir/a b.txt",
        ];

        // when
        const result = listCollapsedByGit(root, files);

        // then
        expect(result).toEqual(["dir/a b.txt", "set.txt", "true.txt"]);
      },
    );
  });

  Scenario("実ファイル", ({ And }) => {
    And(
      "リポジトリのすべてのファイルで、.gitattributes で畳むファイルが判定と一致し、1 件以上ある",
      () => {
        // given
        const root = process.cwd();
        const files = listRepoFiles(root);

        // when
        const collapsed = listCollapsedByGit(root, files);

        // then
        expect(collapsed).toEqual(files.filter(shouldCollapse));
        expect(collapsed.length).toBeGreaterThan(0);
      },
    );
  });
});
