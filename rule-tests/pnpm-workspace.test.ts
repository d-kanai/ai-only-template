// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストはファイルを読むだけで
//   DOM を使わない。Node 環境で動かし、jsdom の初期化コストと無関係な差異を避ける。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect } from "vitest";
import { casesByName } from "./case-table";

// pnpm-workspace.yaml のサプライチェーン保護と版の書き方の設定（.claude/rules/tooling/dependencies.md）を仕様として固定するテスト。
// ルール検査テスト（.claude/rules/quality/testing.md）なので、読み取り（readTopLevelSettings）と判定（findWorkspaceSettingViolations）を
// 関数に切り出し、許可される例（must pass）と違反の例（must reject）の両方で固定する。
// あわせて、Renovate の設定（.github/renovate.json5）が pnpm-workspace.yaml と食い違わないことも検査する（Issue #111。下の readRenovateConfig）。
// .feature（pnpm-workspace.feature）と step の実装（このファイル）に分けた（Issue #282）。

const repoRoot = join(import.meta.dirname, "..");

// WHY yaml パーサを依存に加えない: 検査したいのはトップレベルのキーと、その 1 段下のキー（allowBuilds の中身）だけで、
//   行単位の読み取りで足りる（依存を増やすとサプライチェーンの対象も増える）。
// WHY `pnpm config list --json` で pnpm 自身の解釈を読まない: pnpm は環境変数（pnpm_config_minimum_release_age=1 など）を
//   pnpm-workspace.yaml より優先する（2026-09-28、pnpm 12.7.0 で実測）。検査したいのはリポジトリにコミットされたファイルの
//   中身なので、実行環境の影響を受けないファイルの読み取りにする。
// 読み取りの仕様（下の must reject / must pass で固定する）:
//   - `#` で始まる行（コメントアウトした設定を含む）は読まない。値の後ろの ` # ...` もコメントとして捨てる。
//   - 行頭（インデントなし）の `key: value` をトップレベルの設定とする。インデントされた行は直前のトップレベルのキー
//     （値が空の行）の子として読むので、ネストの中の同名キーはトップレベルの設定として数えない。
//   - 子は最初の子のインデントと同じ深さの `key: value` だけを読む。それより深い行やリストの行（`- x`）は読まない。
//   - 値は true / false を真偽値、整数を数、'...' / "..." を中身の文字列、それ以外をそのままの文字列にする。
//     フローの書き方（`allowBuilds: { lefthook: true }`）などは文字列のまま残り、期待値と一致せず違反になる
//     （見逃す方向ではなく、多く検出する方向に倒れる）。
//   - トップレベルのキーの重複は YAML の仕様で不正なので、例外にする。
// 限界: pnpm 自身が読めない YAML（タブのインデント、`minimumReleaseAge: 07200`、allowBuilds の値が空の子の下の孫）は、
//   ここでは「違反なし」になりうる。いずれも pnpm 12.7.0 の `pnpm config get` が「Failed to parse pnpm-workspace.yaml」で
//   止まる（2026-09-28 実測）ので、install も止まり実害はない。
//   逆に `minimumReleaseAge: "7200"`（クォートした文字列）と値の後ろの空白（`7200 `）は、pnpm は 7200 と読む（同じ実測）が、
//   ここでは安全側に倒して違反にする（must reject で固定）。
type Scalar = string | number | boolean;
type Settings = Record<string, Scalar | Record<string, Scalar>>;

// WHY キーの先頭に `#` を許さない: コメントの行（コメントアウトした設定 `# minimumReleaseAge: 7200` を含む）を
//   設定として読まないため。コメントの行はどちらの正規表現にも一致せず、読み飛ばされる。
//   CHILD_ENTRY は先頭の `-` も許さない（リストの行 `- x` を子として読まない）。
const TOP_LEVEL_ENTRY = /^([^\s#][^:]*):(?:\s+(.*))?$/;
const CHILD_ENTRY = /^(\s+)([^\s#-][^:]*):\s+(.*)$/;
const QUOTED = /^(['"])(.*)\1$/;
const INTEGER = /^-?\d+$/;
const TRAILING_COMMENT = /(?:^|\s+)#.*$/;

function unquote(text: string): string {
  return text.match(QUOTED)?.[2] ?? text;
}

function parseScalar(raw: string): Scalar {
  // WHY クォートの後ろのコメント（`'x' # 理由`）をここで除く: 子の値は CHILD_ENTRY から生のまま渡るため。
  //   トップレベルの値は splitTopLevelBlocks で先に ` #` 以降を除いてから渡る。そのため、トップレベルのクォートの中に
  //   ` #` があると値が途中で切れるが、検査する値（7200 / true / '' など）にその形は無く、切れた場合は期待値と一致せず
  //   違反になる（見逃す方向ではない）。
  const quoted = raw.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
  if (quoted) return quoted[2];
  const plain = raw.replace(TRAILING_COMMENT, "");
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (INTEGER.test(plain)) return Number(plain);
  return plain;
}

type TopLevelBlock = { key: string; value: string; childLines: string[] };

// トップレベルの行ごとに、続くインデントされた行（子の候補）をまとめる。
function splitTopLevelBlocks(yaml: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const top = line.match(TOP_LEVEL_ENTRY);
    if (top) {
      blocks.push({
        key: unquote(top[1].trim()),
        value: (top[2] ?? "").replace(TRAILING_COMMENT, ""),
        childLines: [],
      });
    } else {
      blocks.at(-1)?.childLines.push(line);
    }
  }
  return blocks;
}

// WHY 最初の子と同じ深さの `key: value` だけを読む: それより深い行は孫（子のマップの中身）で、
//   同名のキーがあっても子として数えないため。リストの行（`- x`）は CHILD_ENTRY に一致しないので読まない。
function readChildren(lines: string[]): Record<string, Scalar> {
  const children: Record<string, Scalar> = {};
  let indent: string | undefined;
  for (const line of lines) {
    const child = line.match(CHILD_ENTRY);
    if (!child) continue;
    indent ??= child[1];
    if (child[1] === indent) {
      children[unquote(child[2].trim())] = parseScalar(child[3]);
    }
  }
  return children;
}

// WHY 値が空のトップレベルのキーだけを子を持つマップとして読む: 値のあるキー（`minimumReleaseAge: 7200`）の後に
//   インデントされた行が続いても、YAML としては不正で、子として数えると誤った設定を「あり」と読んでしまうため。
function readTopLevelSettings(yaml: string): Settings {
  const settings: Settings = {};
  for (const block of splitTopLevelBlocks(yaml)) {
    if (block.key in settings) {
      throw new Error(`トップレベルのキー ${block.key} が重複しています`);
    }
    settings[block.key] =
      block.value === ""
        ? readChildren(block.childLines)
        : parseScalar(block.value);
  }
  return settings;
}

// WHY 各値（検査する設定と、その値にしている理由）:
//   - minimumReleaseAge: 7200（5 日）: 悪意あるリリースは公開から数日以内に検知・削除されることが多く、1 日では短い。
//     一方、開発機の safe-chain と同じ 14 日に揃えると Next.js などの更新に 2 週間遅れで追随することになるため、
//     ユーザーの判断で 5 日にした（Issue #32）。pnpm 側の設定は safe-chain の有無（クラウドセッション・CI）に
//     関係なく効く防御なので、値が意図せず下がっていないことをテストで担保する。
//   - minimumReleaseAgeStrict: true: 非 strict だと条件を満たす版がないときに古い版へ黙ってフォールバックし、
//     lockfile の内容が意図しない版に変わりうる。失敗させて人間・AI に気づかせる。
//   - savePrefix: ''（空文字）: `pnpm add <pkg>` で版を書き忘れても範囲指定（既定の '^'）にならないようにする
//     （依存は完全固定。.claude/rules/tooling/dependencies.md）。
//   - allowBuilds: 依存のビルドスクリプト（postinstall 等）は任意コードを実行できるため、許可・不許可をパッケージごとに
//     レビューして決めている（各パッケージの理由は pnpm-workspace.yaml のコメント）。許可（true）が黙って増えたり、
//     lefthook（pre-commit の導入に必要）が false になったりしないよう、中身を丸ごと比較する。
//     パッケージを足す・変えるときは、pnpm-workspace.yaml と一緒にここも直す。
const EXPECTED_SETTINGS: Settings = {
  minimumReleaseAge: 7200,
  minimumReleaseAgeStrict: true,
  savePrefix: "",
  allowBuilds: {
    esbuild: false,
    sharp: false,
    "unrs-resolver": false,
    lefthook: true,
  },
};

type SettingViolation = {
  key: string;
  expected: Settings[string];
  actual: Settings[string] | undefined;
};

function findWorkspaceSettingViolations(
  settings: Settings,
): SettingViolation[] {
  return Object.entries(EXPECTED_SETTINGS)
    .filter(([key, expected]) => !isDeepStrictEqual(settings[key], expected))
    .map(([key, expected]) => ({ key, expected, actual: settings[key] }));
}

function readWorkspaceSettings(path: string): Settings {
  return readTopLevelSettings(readFileSync(path, "utf8"));
}

function violationsOf(yaml: string): string[] {
  return findWorkspaceSettingViolations(readTopLevelSettings(yaml)).map(
    (violation) => violation.key,
  );
}

// Renovate（依存の自動更新の bot。.github/renovate.json5）の設定を、pnpm-workspace.yaml の設定と食い違わないように検査する（Issue #111）。
// WHY 待つ日数を pnpm の minimumReleaseAge と同じにする: Renovate が 5 日未満の版で PR を作ると、PR の中の pnpm install が
//   minimumReleaseAgeStrict で失敗し、赤い PR が並ぶ。Renovate の minimumReleaseAge で同じ日数を待たせる。片方だけ変えると食い違う。
// WHY internalChecksFilter を strict にする: strict でないと、待つ日数に達していない更新でも PR を作り、待つ間は保留の状態で置く
//   （Renovate の configuration-options の minimumReleaseAge・internalChecksFilter）。待つ間は PR を作らせない。
// WHY パッチを当てた依存（patchedDependencies）を更新させない: キーが「パッケージ@版」で固定なので、版が変わるとパッチが
//   当たらなくなる。パッチの要否は人が見直す（スキル dependency-update の 5.）。enabled: false の packageRules で止める。
// 読み取りの仕様: JSON に行頭の `//` のコメント行だけを足した形に限る（コメント行を除いて JSON.parse する）。JSON5 のほかの書き方
//   （値の後ろのコメント・末尾のカンマ・引用符の無いキー）は例外にする。WHY: JSON5 のパーサを依存に足さない（上の yaml と同じ）。
// 止めている規則として数えるのは、キーが matchPackageNames と enabled: false だけの規則（matchUpdateTypes などで絞ると一部の更新が
//   止まらず、否定のパターン `!<名前>` で外すと止まらない）。その規則より後ろに、同じパッケージに一致して enabled: true に戻す規則が
//   あれば止めていない（packageRules は後ろの規則が上書きする）。
// 限界: matchPackageNames はパッケージ名そのものと `<スコープ>/**` だけを見る（Renovate の glob・正規表現のほかの書き方は「止めていない」
//   と判定する）。後ろの規則が matchPackageNames 以外（matchDepNames など）で一致して enabled: true に戻すものは見ない。
//   待つ日数は `<n> days` の形だけを読む。
type RenovatePackageRule = Record<string, unknown> & {
  matchPackageNames?: string[];
  enabled?: boolean;
};
type RenovateConfig = {
  minimumReleaseAge?: unknown;
  internalChecksFilter?: unknown;
  packageRules?: RenovatePackageRule[];
};

const MINUTES_PER_DAY = 1440;

function readRenovateConfig(text: string): RenovateConfig {
  const json = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  return JSON.parse(json);
}

function minutesOf(age: unknown): number | undefined {
  const days = typeof age === "string" ? age.match(/^(\d+) days$/) : null;
  return days ? Number(days[1]) * MINUTES_PER_DAY : undefined;
}

// `@scope/pkg@1.0.0` → `@scope/pkg`（版の前の @ で切る。スコープの先頭の @ は残す）。
function packageNameOf(patchKey: string): string {
  return patchKey.slice(0, patchKey.lastIndexOf("@"));
}

function matchesPackage(pattern: string, name: string): boolean {
  if (pattern.endsWith("/**")) return name.startsWith(pattern.slice(0, -2));
  return pattern === name;
}

function isPureDisable(rule: RenovatePackageRule): boolean {
  const keys = Object.keys(rule).sort();
  return (
    isDeepStrictEqual(keys, ["enabled", "matchPackageNames"]) &&
    rule.enabled === false &&
    !(rule.matchPackageNames ?? []).some((p) => p.startsWith("!"))
  );
}

function findRenovateViolations(
  config: RenovateConfig,
  settings: Settings,
): string[] {
  const violations: string[] = [];
  const age = minutesOf(config.minimumReleaseAge);
  if (age === undefined || age !== settings.minimumReleaseAge) {
    violations.push("minimumReleaseAge");
  }
  if (config.internalChecksFilter !== "strict") {
    violations.push("internalChecksFilter");
  }
  const patched = settings.patchedDependencies;
  const rules = config.packageRules ?? [];
  for (const key of typeof patched === "object" ? Object.keys(patched) : []) {
    const name = packageNameOf(key);
    const matches = (rule: RenovatePackageRule) =>
      (rule.matchPackageNames ?? []).some((p) => matchesPackage(p, name));
    const stopAt = rules.findLastIndex(
      (rule) => isPureDisable(rule) && matches(rule),
    );
    const reenabled = rules
      .slice(stopAt + 1)
      .some((rule) => rule.enabled === true && matches(rule));
    if (stopAt === -1 || reenabled) {
      violations.push(`patchedDependencies:${name}`);
    }
  }
  return violations;
}

function renovateViolationsOf(json: string, yaml = VALID_YAML): string[] {
  return findRenovateViolations(
    readRenovateConfig(json),
    readTopLevelSettings(yaml),
  );
}

// 本物の pnpm-workspace.yaml と同じ形（コメント、他の設定、クォートしたキー）を持つ、許可される設定の例。
const VALID_YAML = [
  "# pnpm の設定ファイル",
  "allowBuilds:",
  "  esbuild: false",
  "  sharp: false",
  "  unrs-resolver: false",
  "  lefthook: true",
  "",
  "# ---- サプライチェーン保護設定 ----",
  "minimumReleaseAge: 7200",
  "",
  "minimumReleaseAgeStrict: true",
  "trustPolicy: no-downgrade",
  "savePrefix: ''",
  "",
  "patchedDependencies:",
  "  '@scope/pkg@1.0.0': patches/@scope__pkg@1.0.0.patch",
  "",
].join("\n");

// WHY 置換の対象が 1 か所だけ一致することを確かめる: 一致しないまま置換すると元の VALID_YAML のままになり、
//   must reject の例が「違反を含まない YAML」になって、テストが何を検査しているか分からなくなる（LEARNINGS.md）。
function replaceOnce(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}

// 本物の .github/renovate.json5 と同じ形（行頭のコメント、他の設定）を持つ、VALID_YAML に対して許可される設定の例。
const VALID_RENOVATE = [
  "// Renovate の設定",
  "{",
  '  "extends": ["config:recommended"],',
  "  // 5 日 = pnpm の 7200 分",
  '  "minimumReleaseAge": "5 days",',
  '  "internalChecksFilter": "strict",',
  '  "packageRules": [',
  '    { "matchPackageNames": ["@biomejs/**"], "groupName": "Biome" },',
  '    { "matchPackageNames": ["@scope/pkg"], "enabled": false }',
  "  ]",
  "}",
  "",
].join("\n");

let dir: string;

beforeAll(() => {
  // WHY: fixture をリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残る。OS の一時ディレクトリに置いて afterAll で消す。
  dir = mkdtempSync(join(tmpdir(), "pnpm-workspace-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const feature = await loadFeature("./pnpm-workspace.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("設定の読み取りと判定（must pass）", ({ And }) => {
    And("期待どおりの設定だけなら違反なし", () => {
      // given: VALID_YAML（モジュールの定数）
      // when
      const violations = violationsOf(VALID_YAML);

      // then
      expect(violations).toEqual([]);
    });

    And("値の後ろのコメントは値に含めない", () => {
      // given
      const yaml = replaceOnce(
        VALID_YAML,
        "minimumReleaseAge: 7200\n",
        "minimumReleaseAge: 7200 # 5 日\n",
      );

      // when
      const violations = violationsOf(yaml);

      // then
      expect(violations).toEqual([]);
    });

    And(
      "子の間・子の値の後ろのコメントは読まない（違反なし）（インデントされた key: value 形式のコメント行・行頭の key: value 形式のコメント行・子の値の後ろのコメント）",
      () => {
        // given
        const cases: [string, string, string][] = [
          [
            "子の間の、インデントされた `key: value` 形式のコメント行",
            "  sharp: false\n",
            "  sharp: false\n  # note: x\n",
          ],
          [
            "子の間の、行頭の `key: value` 形式のコメント行",
            "  sharp: false\n",
            "  sharp: false\n# a: b\n",
          ],
          [
            "子の値の後ろのコメント",
            "  lefthook: true\n",
            "  lefthook: true # 理由\n",
          ],
        ];

        // when
        const result = casesByName(cases, ([, from, to]) =>
          violationsOf(replaceOnce(VALID_YAML, from, to)),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And("改行が CRLF でも読める", () => {
      // given
      const yaml = VALID_YAML.replaceAll("\n", "\r\n");

      // when
      const violations = violationsOf(yaml);

      // then
      expect(violations).toEqual([]);
    });

    And("トップレベルと子の値を型付きで読む", () => {
      // given: VALID_YAML（モジュールの定数）
      // when
      const settings = readTopLevelSettings(VALID_YAML);

      // then
      expect(settings).toEqual({
        allowBuilds: {
          esbuild: false,
          sharp: false,
          "unrs-resolver": false,
          lefthook: true,
        },
        minimumReleaseAge: 7200,
        minimumReleaseAgeStrict: true,
        trustPolicy: "no-downgrade",
        savePrefix: "",
        patchedDependencies: {
          "@scope/pkg@1.0.0": "patches/@scope__pkg@1.0.0.patch",
        },
      });
    });
  });

  Scenario("設定の読み取りと判定（must reject）", ({ And }) => {
    And(
      "設定が無い・値が違う・コメントアウト・ネストの中にだけある設定は、違反の設定のキーで違反になる（minimumReleaseAge・minimumReleaseAgeStrict・savePrefix・allowBuilds の各形、クォートした文字列・値の後ろの空白、ファイルが空）",
      () => {
        // given
        const cases: [string, (yaml: string) => string, string[]][] = [
          [
            "minimumReleaseAge が無い",
            (yaml: string) =>
              replaceOnce(yaml, "minimumReleaseAge: 7200\n", ""),
            ["minimumReleaseAge"],
          ],
          [
            "minimumReleaseAge の値が違う（1440 = 1 日）",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "minimumReleaseAge: 7200\n",
                "minimumReleaseAge: 1440\n",
              ),
            ["minimumReleaseAge"],
          ],
          [
            "minimumReleaseAge がコメントアウトされている",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "minimumReleaseAge: 7200\n",
                "# minimumReleaseAge: 7200\n",
              ),
            ["minimumReleaseAge"],
          ],
          [
            "minimumReleaseAge が別のキーのネストの中にだけある",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "minimumReleaseAge: 7200\n",
                "overrides:\n  minimumReleaseAge: 7200\n",
              ),
            ["minimumReleaseAge"],
          ],
          [
            "minimumReleaseAge がインデントされて allowBuilds の子になっている",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "minimumReleaseAge: 7200\n",
                "  minimumReleaseAge: 7200\n",
              ),
            ["minimumReleaseAge", "allowBuilds"],
          ],
          [
            "minimumReleaseAgeStrict が false",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "minimumReleaseAgeStrict: true",
                "minimumReleaseAgeStrict: false",
              ),
            ["minimumReleaseAgeStrict"],
          ],
          [
            "minimumReleaseAgeStrict が無い",
            (yaml: string) =>
              replaceOnce(yaml, "minimumReleaseAgeStrict: true\n", ""),
            ["minimumReleaseAgeStrict"],
          ],
          [
            "savePrefix が '^'",
            (yaml: string) =>
              replaceOnce(yaml, "savePrefix: ''", "savePrefix: '^'"),
            ["savePrefix"],
          ],
          [
            "savePrefix が無い（pnpm の既定は '^'）",
            (yaml: string) => replaceOnce(yaml, "savePrefix: ''\n", ""),
            ["savePrefix"],
          ],
          [
            "allowBuilds の lefthook が false",
            (yaml: string) =>
              replaceOnce(yaml, "  lefthook: true", "  lefthook: false"),
            ["allowBuilds"],
          ],
          [
            "allowBuilds に許可（true）のパッケージが増えている",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "  lefthook: true\n",
                "  lefthook: true\n  evil: true\n",
              ),
            ["allowBuilds"],
          ],
          [
            "allowBuilds から不許可（false）のパッケージが消えている",
            (yaml: string) => replaceOnce(yaml, "  sharp: false\n", ""),
            ["allowBuilds"],
          ],
          [
            "allowBuilds の lefthook が、さらに深いネストの中にだけある",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "  lefthook: true",
                "  nested:\n    lefthook: true",
              ),
            ["allowBuilds"],
          ],
          [
            "allowBuilds の lefthook がコメントアウトされている",
            (yaml: string) =>
              replaceOnce(yaml, "  lefthook: true", "  # lefthook: true"),
            ["allowBuilds"],
          ],
          [
            "allowBuilds がフローの書き方で書かれている（読み取りの対象外）",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "allowBuilds:\n  esbuild: false\n  sharp: false\n  unrs-resolver: false\n  lefthook: true\n",
                "allowBuilds: { esbuild: false, sharp: false, unrs-resolver: false, lefthook: true }\n",
              ),
            ["allowBuilds"],
          ],
          [
            "allowBuilds が無い",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "allowBuilds:\n  esbuild: false\n  sharp: false\n  unrs-resolver: false\n  lefthook: true\n",
                "",
              ),
            ["allowBuilds"],
          ],
          // 安全側に倒して違反にするもの（pnpm は 7200 と読むが、書き方を 1 通りにする。上の「限界」）。
          [
            "minimumReleaseAge がクォートした文字列",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "minimumReleaseAge: 7200\n",
                'minimumReleaseAge: "7200"\n',
              ),
            ["minimumReleaseAge"],
          ],
          [
            "minimumReleaseAge の値の後ろに空白がある",
            (yaml: string) =>
              replaceOnce(
                yaml,
                "minimumReleaseAge: 7200\n",
                "minimumReleaseAge: 7200 \n",
              ),
            ["minimumReleaseAge"],
          ],
          // WHY: 読み取りが空（ファイルの取り違えなど）でも「違反なし」にならず、すべての設定が欠けていると報告すること。
          [
            "ファイルが空",
            () => "",
            [
              "minimumReleaseAge",
              "minimumReleaseAgeStrict",
              "savePrefix",
              "allowBuilds",
            ],
          ],
        ];

        // when
        const result = casesByName(cases, ([, mutate]) =>
          violationsOf(mutate(VALID_YAML)),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expectedKeys]) => expectedKeys),
        );
      },
    );

    And("トップレベルのキーが重複していると例外にする", () => {
      // WHY toThrow(Error) と message の両方: toThrow("文字列") は throw undefined でも通る（.claude/rules/quality/testing.md）。
      // given
      const yaml = `${VALID_YAML}minimumReleaseAge: 1440\n`;

      // when
      const action = () => readTopLevelSettings(yaml);

      // then
      expect(action).toThrow(
        expect.objectContaining({
          message: expect.stringContaining("minimumReleaseAge"),
        }),
      );
    });
  });

  Scenario("pnpm-workspace.yaml の実ファイル", ({ And }) => {
    // 読み込み → 読み取り → 判定を、本番と同じ readWorkspaceSettings で実ファイルから通す
    //   （.claude/rules/quality/testing.md の「ルール検査テスト」）。
    And(
      "違反を含む pnpm-workspace.yaml からは、違反の設定と実際の値をすべて検出する",
      () => {
        // given
        const file = join(dir, "pnpm-workspace.yaml");
        writeFileSync(
          file,
          [
            "allowBuilds:",
            "  esbuild: false",
            "  lefthook: true",
            "  sharp: true",
            "# minimumReleaseAge: 7200",
            "minimumReleaseAgeStrict: true",
            "savePrefix: '^'",
            "",
          ].join("\n"),
        );

        // when
        const violations = findWorkspaceSettingViolations(
          readWorkspaceSettings(file),
        );

        // then
        expect(violations).toEqual([
          {
            key: "minimumReleaseAge",
            expected: 7200,
            actual: undefined,
          },
          { key: "savePrefix", expected: "", actual: "^" },
          {
            key: "allowBuilds",
            expected: EXPECTED_SETTINGS.allowBuilds,
            actual: { esbuild: false, lefthook: true, sharp: true },
          },
        ]);
      },
    );

    And("サプライチェーン保護と版の書き方の設定が期待どおり", () => {
      // given: 実ファイル（repoRoot の pnpm-workspace.yaml）
      // when
      const violations = findWorkspaceSettingViolations(
        readWorkspaceSettings(join(repoRoot, "pnpm-workspace.yaml")),
      );

      // then
      // 失敗時にどの設定がどの値かが出力に出るよう、違反の一覧を空配列と比較する。
      expect(violations).toEqual([]);
    });
  });

  Scenario("Renovate の設定の判定（must pass）", ({ And }) => {
    And(
      "pnpm と同じ日数を待ち、待つ間は PR を作らず、パッチを当てた依存を更新しない設定は違反なし（パッケージ名そのもの・スコープのワイルドカード・パッチが無い）",
      () => {
        // given
        const cases: [string, string, string][] = [
          ["パッケージ名そのもの", VALID_RENOVATE, VALID_YAML],
          [
            "スコープのワイルドカード",
            replaceOnce(VALID_RENOVATE, '["@scope/pkg"]', '["@scope/**"]'),
            VALID_YAML,
          ],
          [
            "パッチが無い",
            replaceOnce(
              VALID_RENOVATE,
              '"groupName": "Biome" },\n    { "matchPackageNames": ["@scope/pkg"], "enabled": false }\n',
              '"groupName": "Biome" }\n',
            ),
            replaceOnce(
              VALID_YAML,
              "patchedDependencies:\n  '@scope/pkg@1.0.0': patches/@scope__pkg@1.0.0.patch\n",
              "",
            ),
          ],
        ];

        // when
        const result = casesByName(cases, ([, json, yaml]) =>
          renovateViolationsOf(json, yaml),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And("行頭の // のコメントは読まない", () => {
      // given
      const json = replaceOnce(
        VALID_RENOVATE,
        '  "internalChecksFilter": "strict",\n',
        '  "internalChecksFilter": "strict",\n    // "minimumReleaseAge": "1 days",\n',
      );

      // when
      const violations = renovateViolationsOf(json);

      // then
      expect(violations).toEqual([]);
    });
  });

  Scenario("Renovate の設定の判定（must reject）", ({ And }) => {
    And(
      "待つ日数が pnpm と違う・日数で書いていない・無い、待つ間に PR を作る、パッチを当てた依存を更新すると、その設定のキーで違反になる",
      () => {
        // given
        const age = '"minimumReleaseAge": "5 days",';
        const filter = '"internalChecksFilter": "strict",';
        const stop =
          '{ "matchPackageNames": ["@scope/pkg"], "enabled": false }';
        const cases: [string, string, string[]][] = [
          [
            "待つ日数が pnpm と違う（3 日）",
            replaceOnce(VALID_RENOVATE, age, '"minimumReleaseAge": "3 days",'),
            ["minimumReleaseAge"],
          ],
          [
            "日数で書いていない（120 hours）",
            replaceOnce(
              VALID_RENOVATE,
              age,
              '"minimumReleaseAge": "120 hours",',
            ),
            ["minimumReleaseAge"],
          ],
          [
            "日数が数でない（five days）",
            replaceOnce(
              VALID_RENOVATE,
              age,
              '"minimumReleaseAge": "five days",',
            ),
            ["minimumReleaseAge"],
          ],
          [
            "待つ日数が無い",
            replaceOnce(VALID_RENOVATE, `  ${age}\n`, ""),
            ["minimumReleaseAge"],
          ],
          [
            "待つ日数が文字列でない（5）",
            replaceOnce(VALID_RENOVATE, age, '"minimumReleaseAge": 5,'),
            ["minimumReleaseAge"],
          ],
          [
            "待つ間に PR を作る（flexible）",
            replaceOnce(
              VALID_RENOVATE,
              filter,
              '"internalChecksFilter": "flexible",',
            ),
            ["internalChecksFilter"],
          ],
          [
            "internalChecksFilter が無い",
            replaceOnce(VALID_RENOVATE, `  ${filter}\n`, ""),
            ["internalChecksFilter"],
          ],
          [
            "パッチを当てた依存の規則が enabled: true",
            replaceOnce(VALID_RENOVATE, stop, stop.replace("false", "true")),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "パッチを当てた依存の規則に enabled が無い",
            replaceOnce(
              VALID_RENOVATE,
              stop,
              '{ "matchPackageNames": ["@scope/pkg"] }',
            ),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "止めているのが別のパッケージ",
            replaceOnce(VALID_RENOVATE, '["@scope/pkg"]', '["@scope/other"]'),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "止めているのが別のスコープのワイルドカード",
            replaceOnce(VALID_RENOVATE, '["@scope/pkg"]', '["@other/**"]'),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "止めているのが名前の前方一致だけ（@scope/pk）",
            replaceOnce(VALID_RENOVATE, '["@scope/pkg"]', '["@scope/pk"]'),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "止める規則を update の種類（major）で絞る",
            replaceOnce(
              VALID_RENOVATE,
              stop,
              '{ "matchPackageNames": ["@scope/pkg"], "matchUpdateTypes": ["major"], "enabled": false }',
            ),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "止める規則で否定のパターンで外す",
            replaceOnce(
              VALID_RENOVATE,
              '["@scope/pkg"]',
              '["@scope/**", "!@scope/pkg"]',
            ),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "後ろの規則で enabled: true に戻す",
            replaceOnce(
              VALID_RENOVATE,
              `${stop}\n`,
              `${stop},\n    { "matchPackageNames": ["@scope/pkg"], "enabled": true }\n`,
            ),
            ["patchedDependencies:@scope/pkg"],
          ],
          [
            "packageRules が無い",
            replaceOnce(
              VALID_RENOVATE,
              VALID_RENOVATE.slice(
                VALID_RENOVATE.indexOf('  "internalChecksFilter"'),
                VALID_RENOVATE.lastIndexOf("}"),
              ),
              '  "internalChecksFilter": "strict"\n',
            ),
            ["patchedDependencies:@scope/pkg"],
          ],
        ];

        // when
        const result = casesByName(cases, ([, json]) =>
          renovateViolationsOf(json),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );

    And(
      "JSON に行頭の // のコメントだけを足した形でなければ例外にする（値の後ろのコメント・末尾のカンマ）",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "値の後ろのコメント",
            replaceOnce(
              VALID_RENOVATE,
              '"internalChecksFilter": "strict",',
              '"internalChecksFilter": "strict", // 待つ間は作らない',
            ),
          ],
          [
            "末尾のカンマ",
            replaceOnce(
              VALID_RENOVATE,
              '"enabled": false }\n',
              '"enabled": false },\n',
            ),
          ],
        ];

        // when
        const result = casesByName(cases, ([, json]) => {
          try {
            readRenovateConfig(json);
            return "読めた";
          } catch (error) {
            return error instanceof SyntaxError ? "SyntaxError" : "別の例外";
          }
        });

        // then
        expect(result).toEqual(casesByName(cases, () => "SyntaxError"));
      },
    );
  });

  Scenario("Renovate の設定の実ファイル", ({ And }) => {
    And(
      ".github/renovate.json5 は pnpm-workspace.yaml の minimumReleaseAge と同じ日数を待ち、パッチを当てた依存を更新しない",
      () => {
        // given: 実ファイル（repoRoot の .github/renovate.json5 と pnpm-workspace.yaml）
        // when
        const violations = findRenovateViolations(
          readRenovateConfig(
            readFileSync(join(repoRoot, ".github/renovate.json5"), "utf8"),
          ),
          readWorkspaceSettings(join(repoRoot, "pnpm-workspace.yaml")),
        );

        // then
        expect(violations).toEqual([]);
      },
    );
  });
});
