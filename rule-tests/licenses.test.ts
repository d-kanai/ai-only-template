// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは pnpm の出力（JSON）を読むだけで
//   DOM を使わないため、node 環境で動かす。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";

// 依存パッケージ（推移的な依存・devDependencies を含む）のライセンスを許可リストで検査するテスト（Issue #368）。
//   決定と採用しなかった案（Trivy・OSV-Scanner・日次のジョブ）は ADR docs/adr/quality/20261003-dependency-license-allow-list.md。
// WHY: 使えないライセンス（GPL / AGPL のような強いコピーレフト・商用の制限付き・ライセンス無し）の依存が、依存の追加や更新で
//   推移的に入っても気づけない。人が lockfile の差分を読んで止めるのは続かないので、機械で止める（CLAUDE.md の原則 7。daiki の希望 2026-10-03）。
// WHY pnpm test（ルール検査テスト）で行う: CI の ci ジョブ（Ruleset protect-main の required status check）が pnpm test を実行するので、
//   lockfile を変えた PR は必ずここを通る（変えていない PR も通るが、pnpm licenses list はインストール済みの node_modules を読むだけで
//   0.2 秒ほど。2026-10-03 実測）。手元の pnpm test でも同じ結果になり、CI のワークフローを変えずに済む。
// 違反にするもの（規則）:
//   - license-not-allowed: `pnpm -r licenses list --json` が返す依存のうち、ライセンスが許可リスト ALLOWED_LICENSES に無く、
//     例外 LICENSE_EXCEPTIONS（名前とライセンスの組）にも無いもの。違反は `<名前>@<版>` とライセンスで返す。
//     式の読み方: 許可リストの ID 1 つか、許可リストの ID だけを ` OR ` でつないだ式（外側のかっこ 1 組は外す）だけを許可する。
//     `AND`（両方の条件を守る）・`WITH`（例外条項付き）・入れ子のかっこ・空・pnpm がライセンスを読めなかったときの `Unknown` は
//     許可しない（中身を確かめて、要るなら例外に書く）。WHY 保守的にする: 式を細かく解釈して誤って通すより、人が 1 件ずつ見るほうが安全。
// 限界:
//   - pnpm licenses list はインストール済みのパッケージだけを返す。lockfile にあっても、今の OS / CPU で入らない optional の依存
//     （@img/sharp-libvips-darwin-arm64 などのプラットフォーム別のバイナリ）は見ない。CI（ubuntu-latest, linux x64）と本番（Cloud Run の
//     linux x64 のイメージ）が同じプラットフォームなので、本番に入るものは見られる。手元（macOS など）で別のプラットフォームのものが
//     入るので、例外にはプラットフォーム別の名前をすべて書く（2026-10-03 に lockfile の全パッケージのうち入っていない 178 件の
//     license を npm レジストリで引き、MIT / Apache-2.0 と、下の例外の LGPL-3.0-or-later・MPL-2.0 だけだったことを確認）。
//   - ライセンスは各パッケージの package.json の license（pnpm が読んだ値）だけを見る。同梱のファイルに別のライセンスのコードが
//     入っていても見ない（パッケージの申告を信じる）。
//   - 許可したライセンスの義務（著作権表示の同梱など）を守っているかは見ない。
// 日次のジョブを置かない理由: npm は公開済みの <名前>@<版> を差し替えられない（unpublish しても同じ版は二度と使えない。
//   https://docs.npmjs.com/policies/unpublish ）。lockfile が版と integrity を固定するので、lockfile が変わらなければ依存のライセンスも
//   変わらない。lockfile が変わる PR では毎回このテストが動く。

// 許可するライセンス（SPDX の ID）。どれも、使う・改変する・配る（ソースを公開せずに本番のイメージに入れる）ことを許し、
//   求めるのは著作権表示とライセンス文の同梱（か何も求めない）だけの許容型（permissive）のライセンス。
// WHY 今の依存にあるものだけにする: 使っていないライセンスまで先に許可すると、中身を確かめないまま通る。新しいライセンスの依存が
//   入ったら、このテストが落ちたところで中身を確かめて足す。
const ALLOWED_LICENSES = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "CC0-1.0",
  "BlueOak-1.0.0",
]);

// 許可リストに無いが、名前を限って許可する依存。名前とライセンスの組で許可する（同じ名前でもライセンスが変われば、落ちて見直す）。
//   reason に、何に使われ、なぜこのライセンスで問題ないかを書く。
// WHY 名前を限る: ライセンスごと許可すると、同じライセンスの別の依存（使われ方が違う）が黙って通る。
type LicenseException = {
  readonly names: readonly string[];
  readonly license: string;
  readonly reason: string;
};

const LICENSE_EXCEPTIONS: readonly LicenseException[] = [
  {
    // sharp（next の依存。next/image の画像の最適化）が読み込む libvips のビルド済みのバイナリ。プラットフォーム別に分かれている。
    names: [
      "@img/sharp-libvips-darwin-arm64",
      "@img/sharp-libvips-darwin-x64",
      "@img/sharp-libvips-linux-arm",
      "@img/sharp-libvips-linux-arm64",
      "@img/sharp-libvips-linux-ppc64",
      "@img/sharp-libvips-linux-riscv64",
      "@img/sharp-libvips-linux-s390x",
      "@img/sharp-libvips-linux-x64",
      "@img/sharp-libvips-linuxmusl-arm64",
      "@img/sharp-libvips-linuxmusl-x64",
    ],
    license: "LGPL-3.0-or-later",
    reason:
      "libvips を改変せず共有ライブラリとして読み込むだけで、利用者が差し替えられる形のまま使う（LGPL の弱いコピーレフトはライブラリ自身の改変にかかり、使う側のコードの公開は求めない）。Next.js の標準の依存。",
  },
  {
    // lightningcss（CSS の変換。vite の依存で、テストと開発のときだけ使う）と、プラットフォーム別のビルド済みのバイナリ。
    names: [
      "lightningcss",
      "lightningcss-android-arm64",
      "lightningcss-darwin-arm64",
      "lightningcss-darwin-x64",
      "lightningcss-freebsd-x64",
      "lightningcss-linux-arm-gnueabihf",
      "lightningcss-linux-arm64-gnu",
      "lightningcss-linux-arm64-musl",
      "lightningcss-linux-x64-gnu",
      "lightningcss-linux-x64-musl",
      "lightningcss-win32-arm64-msvc",
      "lightningcss-win32-x64-msvc",
    ],
    license: "MPL-2.0",
    reason:
      "MPL-2.0 のコピーレフトはファイル単位で、改変したそのファイルだけに公開を求める。改変せずにツールとして使うだけ。",
  },
  {
    // caniuse-lite（ブラウザの対応表のデータ。browserslist が読み、ビルドのときに対象のブラウザを決める）。
    names: ["caniuse-lite"],
    license: "CC-BY-4.0",
    reason:
      "コードではなくデータのライセンスで、求めるのは出典の表示だけ。ビルドの道具が読むデータとして使う。",
  },
];

// `pnpm licenses list --json` の形（ライセンス → そのライセンスの依存の一覧）。使う項目だけを書く。
type LicenseReport = Record<
  string,
  readonly { readonly name: string; readonly versions: readonly string[] }[]
>;

// ---- 判定 ----

function isAllowedLicenseExpression(expression: string): boolean {
  const trimmed = expression.trim();
  const unwrapped =
    trimmed.startsWith("(") && trimmed.endsWith(")")
      ? trimmed.slice(1, -1)
      : trimmed;
  return unwrapped
    .split(" OR ")
    .every((license) => ALLOWED_LICENSES.has(license.trim()));
}

function isExcepted(
  name: string,
  license: string,
  exceptions: readonly LicenseException[],
): boolean {
  return exceptions.some(
    (exception) =>
      exception.license === license && exception.names.includes(name),
  );
}

function findLicenseViolations(
  report: LicenseReport,
  exceptions: readonly LicenseException[],
): string[] {
  return Object.entries(report)
    .flatMap(([license, packages]) =>
      isAllowedLicenseExpression(license)
        ? []
        : packages
            .filter(({ name }) => !isExcepted(name, license, exceptions))
            .flatMap(({ name, versions }) =>
              versions.map(
                (version) =>
                  `license-not-allowed: ${name}@${version} のライセンス ${license} は許可リストにも例外にも無い`,
              ),
            ),
    )
    .sort();
}

// ---- 実際の依存の読み取り ----

// WHY -r: ルートで実行すると、ルートの package.json の依存しか返さない（2026-10-03 実測。-r なしは 277 件、-r ありは 381 件）。
//   apps/*（next・drizzle-orm などの本番の依存）を含めるため、ワークスペースのすべてのパッケージを対象にする。
// WHY --prod / --dev で絞らない: devDependencies もこのリポジトリの中で動き、ビルドの成果物に入るものもある（daiki の希望
//   「全体的にチェック」2026-10-03）。
function readLicenseReport(root: string): LicenseReport {
  const result = spawnSync("pnpm", ["-r", "licenses", "list", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm licenses list が失敗した（status ${result.status}）: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as LicenseReport;
}

function packageNames(report: LicenseReport): string[] {
  return Object.values(report).flatMap((packages) =>
    packages.map(({ name }) => name),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くとリポジトリのワークスペース（pnpm-workspace.yaml）に入り、Biome・git の差分にも混ざる。
//   afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "licenses-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

// fixture の依存をインストールする。依存は fixture の中のディレクトリ（file:）だけなので、レジストリに取りに行かない。
// --offline: レジストリに接続しない（つながらない環境でも動き、誤って外の同名のパッケージを取らない）。
// --no-frozen-lockfile: lockfile の無い fixture に lockfile を作らせる（CI=true のとき pnpm は既定で --frozen-lockfile になり、
//   lockfile が無いと失敗する）。
function install(root: string): void {
  const result = spawnSync(
    "pnpm",
    ["install", "--offline", "--no-frozen-lockfile"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `pnpm install が失敗した（status ${result.status}）: ${result.stdout}${result.stderr}`,
    );
  }
}

const pkg = (name: string, ...versions: string[]) => ({ name, versions });

const feature = await loadFeature("./licenses.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("ライセンスの式の判定", ({ And }) => {
    And(
      "許可リストのライセンスと、許可リストのライセンスだけを OR でつないだ式（外側のかっこを含む）は許可する",
      () => {
        // given
        const cases: [string, string][] = [
          ["MIT", "MIT"],
          ["Apache-2.0", "Apache-2.0"],
          ["BlueOak-1.0.0", "BlueOak-1.0.0"],
          ["OR の式（@biomejs/biome の形）", "MIT OR Apache-2.0"],
          ["外側のかっこ付きの OR の式（type-fest の形）", "(MIT OR CC0-1.0)"],
          ["3 つの OR", "MIT OR ISC OR 0BSD"],
        ];

        // when
        const result = casesByName(cases, ([, license]) =>
          isAllowedLicenseExpression(license),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );

    And(
      "許可リストに無いライセンス・OR の片方でも許可リストに無い式・AND と WITH の式・空と Unknown は許可しない",
      () => {
        // given
        const cases: [string, string][] = [
          ["GPL-3.0-only", "GPL-3.0-only"],
          ["AGPL-3.0-or-later", "AGPL-3.0-or-later"],
          [
            "LGPL（例外に書いたものも、式としては許可しない）",
            "LGPL-3.0-or-later",
          ],
          ["商用の制限付き", "BUSL-1.1"],
          ["大文字小文字の違い（SPDX の ID の綴りのまま書く）", "mit"],
          ["OR の片方が許可リストに無い", "MIT OR GPL-3.0-only"],
          ["かっこ付きで片方が許可リストに無い", "(GPL-2.0-only OR MIT-x)"],
          ["AND の式（両方の条件を守る）", "MIT AND Apache-2.0"],
          ["WITH の式（例外条項付き）", "Apache-2.0 WITH LLVM-exception"],
          ["入れ子のかっこ", "(MIT OR (ISC OR 0BSD))"],
          ["空", ""],
          ["pnpm が読めなかった", "Unknown"],
        ];

        // when
        const result = casesByName(cases, ([, license]) =>
          isAllowedLicenseExpression(license),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );
  });

  Scenario("依存の一覧の検査", ({ And }) => {
    And(
      "許可しないライセンスの依存を、名前と版とライセンスで違反として返す（例外の名前でもライセンスが違えば違反）",
      () => {
        // given
        const report: LicenseReport = {
          MIT: [pkg("react", "19.2.0"), pkg("next", "16.3.6")],
          "GPL-3.0-only": [pkg("gpl-lib", "1.0.0", "2.0.0")],
          Unknown: [pkg("no-license", "0.1.0")],
          // 例外の名前（lightningcss）でも、例外に書いたライセンス（MPL-2.0）と違う。
          "AGPL-3.0-only": [pkg("lightningcss", "9.0.0")],
        };

        // when
        const result = findLicenseViolations(report, LICENSE_EXCEPTIONS);

        // then
        expect(result).toEqual([
          "license-not-allowed: gpl-lib@1.0.0 のライセンス GPL-3.0-only は許可リストにも例外にも無い",
          "license-not-allowed: gpl-lib@2.0.0 のライセンス GPL-3.0-only は許可リストにも例外にも無い",
          "license-not-allowed: lightningcss@9.0.0 のライセンス AGPL-3.0-only は許可リストにも例外にも無い",
          "license-not-allowed: no-license@0.1.0 のライセンス Unknown は許可リストにも例外にも無い",
        ]);
      },
    );

    And(
      "例外に書いた名前とライセンスの組は、許可リストに無いライセンスでも違反にしない",
      () => {
        // given
        const exceptions: readonly LicenseException[] = [
          { names: ["a", "b"], license: "MPL-2.0", reason: "テスト" },
        ];
        const report: LicenseReport = {
          "MPL-2.0": [pkg("a", "1.0.0"), pkg("b", "2.0.0"), pkg("c", "3.0.0")],
          "LGPL-3.0-or-later": [pkg("a", "1.0.0")],
        };

        // when
        const result = findLicenseViolations(report, exceptions);

        // then: c は名前が、LGPL の a はライセンスが例外と違う。
        expect(result).toEqual([
          "license-not-allowed: a@1.0.0 のライセンス LGPL-3.0-or-later は許可リストにも例外にも無い",
          "license-not-allowed: c@3.0.0 のライセンス MPL-2.0 は許可リストにも例外にも無い",
        ]);
      },
    );

    And(
      "依存が 0 件なら違反も 0 件になる（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const report: LicenseReport = {};

        // when
        const result = findLicenseViolations(report, LICENSE_EXCEPTIONS);

        // then
        expect(result).toEqual([]);
      },
    );
  });

  Scenario("インストールした依存（fixture）", ({ And }) => {
    And(
      "ワークスペースのパッケージの devDependencies に許可しないライセンスの依存を入れると、インストールした依存から違反を返す",
      () => {
        // given: ルートは MIT の依存、ワークスペースのパッケージ apps/web は GPL の依存を devDependencies に持つ。
        const root = fixture({
          "package.json": {
            name: "fixture-root",
            version: "0.0.0",
            private: true,
            dependencies: { "mit-lib": "file:./libs/mit-lib" },
          },
          "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
          "apps/web/package.json": {
            name: "web",
            version: "0.0.0",
            private: true,
            devDependencies: { "gpl-lib": "file:../../libs/gpl-lib" },
          },
          "libs/mit-lib/package.json": {
            name: "mit-lib",
            version: "1.0.0",
            license: "MIT",
          },
          "libs/gpl-lib/package.json": {
            name: "gpl-lib",
            version: "1.0.0",
            license: "GPL-3.0-only",
          },
        });
        install(root);

        // when
        const report = readLicenseReport(root);
        const result = {
          names: packageNames(report).sort(),
          violations: findLicenseViolations(report, LICENSE_EXCEPTIONS),
        };

        // then: file: の依存の版は pnpm が file:<パス> と返す。
        expect(result).toEqual({
          names: ["gpl-lib", "mit-lib"],
          violations: [
            "license-not-allowed: gpl-lib@file:libs/gpl-lib のライセンス GPL-3.0-only は許可リストにも例外にも無い",
          ],
        });
      },
    );
  });

  Scenario("実際の依存", ({ And }) => {
    And(
      "pnpm licenses list はワークスペースのすべてのパッケージの依存（devDependencies を含む）を返す",
      () => {
        // given: 実際のリポジトリ（repoRoot）のインストール済みの依存
        // when
        const names = packageNames(readLicenseReport(repoRoot));

        // then
        // WHY 各パッケージの依存が入ることを見る: 読み取りが壊れて 0 件になる・ルートしか読まなくなると、違反も減って緑のままになる。
        //   next は apps/frontend_customer、drizzle-orm は apps/backend、@playwright/test は apps/e2e の dependencies / devDependencies、
        //   vitest はルートの devDependencies（どれも消える見込みの無い中心の依存）。
        expect(names).toEqual(
          expect.arrayContaining([
            "next",
            "drizzle-orm",
            "@playwright/test",
            "vitest",
          ]),
        );
      },
    );

    And("依存のライセンスはすべて許可リストか例外にある", () => {
      // given: 実際のリポジトリ（repoRoot）のインストール済みの依存
      // when
      const violations = findLicenseViolations(
        readLicenseReport(repoRoot),
        LICENSE_EXCEPTIONS,
      );

      // then
      expect(violations).toEqual([]);
    });
  });
});
