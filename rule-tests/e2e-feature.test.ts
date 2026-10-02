// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはファイルの一覧と .feature を文字列として読むだけで
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
import { dirname, join, posix } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";
import { containsForbiddenWord } from "./feature-business-language";
import {
  type FeatureSection,
  featureLines,
  isSkippedLine,
  lacksSectionDivider,
  nextSection,
} from "./feature-lines";

// E2E（apps/e2e/。Playwright + playwright-bdd。Issue #279、.claude/rules/testing.md の「E2E」、ADR
//   docs/adr/quality/20261002-e2e-in-gherkin-with-playwright-bdd.md）の置き場所と .feature の書き方を、ファイルの一覧と .feature の
//   中身で機械的に検査するテスト。E2E は API ジャーニー（apps/backend/spec/journey/）と同じく、業務の流れを Gherkin の .feature に
//   日本語で書き、step の実装をクラス（*.steps.ts）に書く（daiki の依頼 2026-10-02「ジャーニーテストを参考に cucumber に。
//   シナリオの書き方は真似して」）。
// 違反にするもの:
//   - e2e-feature-placement: apps/e2e/spec/ の直下以外にある *.feature / *.steps.ts（apps/e2e の直下・support/・spec/ の
//     サブディレクトリなど）と、手書きの Playwright のテスト（*.spec.* / *.test.*。どの階層でも）。
//     WHY 手書きのテストを止める: E2E を .feature と step の対だけにし、業務の流れを読める形にそろえる（API ジャーニーが TS だけの
//       ジャーニーを廃止したのと同じ。ADR quality/20260930-gherkin-journeys-with-vitest-cucumber.md）。
//     WHY .feature と step を spec/ に集める（Issue #297）: 直下に .feature・step・土台（fixtures・DB・ログのサーバ）・設定が平置きで
//       見づらかった（daiki の依頼 2026-10-02）。読むもの（業務の仕様と step の対）は spec/、テストの土台は support/ に分ける。
//       名前は backend の spec/ にそろえる。土台を test-support/ にしないのは、backend の test-support/ が「本番のディレクトリの中で
//       本番のビルドに含めないもの」の意味で、全体がテストの apps/e2e では区別にならないため（daiki の指摘）。
//     WHY spec/ の直下に限る: playwright.config.ts の defineBddConfig が spec/ の直下（"spec/*.feature" / "spec/*.steps.ts"）だけを
//       読むので、ほかの場所に置くと実行されないまま残る。
//   - e2e-feature-pair: apps/e2e/spec/<name>.feature には apps/e2e/spec/<name>.steps.ts が要り、<name>.steps.ts には <name>.feature が要る。
//     例外は複数の .feature が使う step を置く shared.steps.ts だけ。
//     WHY: playwright-bdd の step はすべての .feature から見えるので、どの .feature の step がどこにあるかをファイル名で分かるようにする。
//       .feature だけでも bddgen が step の不足で失敗するが、step のファイルだけが残るのは止まらない。
//     限界: step のクラスが対の .feature の step だけを持つか（ほかの .feature の step を書いていないか）は見ない。
//   - e2e-feature-business-language: API ジャーニーの api-journey-business-language と同じ（`#` のコメント行（仕切りは除く）と空行を
//     除くすべての行に、rule-tests/feature-business-language.ts の禁止語があれば違反）。WHY も同じ（.feature は業務の仕様として読む）。
//     画面の部品の探し方・状態コード・ログの形などの技術の検証は step の実装（*.steps.ts）に閉じる。
//   - e2e-feature-section-divider: API ジャーニーの api-journey-section-divider と同じ（シナリオの中の When の直前に仕切り
//     `# ───── <業務の動作> ─────` が要る。Background の When は見ない）。WHY: 長いシナリオでもどこで何をしているかを拾い読みできる。
//   - e2e-feature-tag: タグ（`@` で始まる行の、空白で区切った各語）が ALLOWED_TAGS に無ければ違反（1 行 1 件）。
//     WHY 許すタグを絞る: playwright-bdd の特別なタグ（@skip・@only・@fixme・@fail・@timeout など）はシナリオを黙って止める・
//       ほかのシナリオを止める・結果を変える。API ジャーニーはタグをすべて止める（api-journey-tag）が、E2E はブラウザの言語を
//       シナリオごとに変える手段がタグしか無い（apps/e2e/support/fixtures.ts の locale）ので、そのタグだけを許す。
//   行の読み方（行の区切り・コメント・仕切りの形・区画）は rule-tests/feature-lines.ts（API ジャーニーと共有）。
//   限界: API ジャーニーの .feature の規則と同じ（docstring の中も行として見る・全角の数字と英字・一覧に無い技術の言葉は見ない・
//     キーワードは英語だけ・仕切りを要るのは When の直前だけで、操作を `*` / And で書くと要求されない）。step の名前は *.steps.ts
//     だけを見る（*.steps.js / *.steps.mts は列挙に入らない。playwright.config.ts も *.steps.ts しか読まないので実行もされない）。
// 列挙: apps/e2e/ の下（依存・生成物・Playwright の出力のディレクトリは除く）の *.feature・*.steps.ts・*.spec.*・*.test.*。
//   列挙が 0 件なら実ファイルのテストで失敗させる（0 件だと違反も 0 件で常に緑になる）。
// テストは .feature（e2e-feature.feature）と step の実装（このファイル）に分けた（Issue #282）。

type E2eFeatureRuleId =
  | "e2e-feature-placement"
  | "e2e-feature-pair"
  | "e2e-feature-business-language"
  | "e2e-feature-section-divider"
  | "e2e-feature-tag";

// line: .feature の中の位置で決まる違反だけ持つ（1 始まり）。
type E2eFeatureViolation = { rule: E2eFeatureRuleId; line?: number };

const E2E_DIR = "apps/e2e";
// .feature と step の置き場所（Issue #297）。
const SPEC_DIR = `${E2E_DIR}/spec`;

// 使ってよいタグ。apps/e2e/support/fixtures.ts の ENGLISH_BROWSER_TAG と同じ文字列。
const ALLOWED_TAGS = new Set(["@ブラウザの言語が英語"]);

// .feature と対にならない step のファイル（複数の .feature が使う step）。
const SHARED_STEPS = `${SPEC_DIR}/shared.steps.ts`;

// 列挙で入らないディレクトリ。
// WHY 名前を列挙する: node_modules は依存、.features-gen は bddgen の生成物（apps/e2e/playwright.config.ts の outputDir）、
//   test-results / playwright-report / blob-report は Playwright の出力（.gitignore 済み）で、自分たちが書くファイルではない。
//   それ以外の "." のディレクトリは中を見て、置き場所の規則にかける（rule-tests/architecture.test.ts の EXCLUDED_DIRS と同じ考え）。
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".features-gen",
  "test-results",
  "playwright-report",
  "blob-report",
]);

const FEATURE_FILE = /\.feature$/;
const STEPS_FILE = /\.steps\.ts$/;
// 手書きの Playwright / Vitest のテストの名前（拡張子は広く取る）。
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

function isInSpecDir(path: string): boolean {
  return posix.dirname(path) === SPEC_DIR;
}

// 列挙の対象か（置き場所・対・中身のどれかの規則にかかる名前）。
function isTarget(path: string): boolean {
  return (
    FEATURE_FILE.test(path) || STEPS_FILE.test(path) || TEST_FILE.test(path)
  );
}

function isMisplaced(path: string): boolean {
  if (TEST_FILE.test(path)) {
    return true;
  }
  return !isInSpecDir(path);
}

// .feature の中身の違反（行の順。同じ行なら tag・business-language・section-divider の順）。
function findFeatureContentViolations(source: string): E2eFeatureViolation[] {
  const lines = featureLines(source);
  let section: FeatureSection = "other";
  return lines.flatMap((line, index): E2eFeatureViolation[] => {
    const lineNumber = index + 1;
    if (isSkippedLine(line)) {
      return [];
    }
    section = nextSection(line, section);
    const tag: E2eFeatureViolation[] =
      /^\s*@/.test(line) &&
      !line
        .trim()
        .split(/\s+/)
        .every((word) => ALLOWED_TAGS.has(word))
        ? [{ rule: "e2e-feature-tag", line: lineNumber }]
        : [];
    const wording: E2eFeatureViolation[] = containsForbiddenWord(line)
      ? [{ rule: "e2e-feature-business-language", line: lineNumber }]
      : [];
    const divider: E2eFeatureViolation[] = lacksSectionDivider(
      lines,
      index,
      section,
    )
      ? [{ rule: "e2e-feature-section-divider", line: lineNumber }]
      : [];
    return [...tag, ...wording, ...divider];
  });
}

// .feature と step の対の違反。files は同じ列挙（listE2eTargets）の結果。
function findPairViolations(
  path: string,
  files: ReadonlySet<string>,
): E2eFeatureViolation[] {
  if (path === SHARED_STEPS) {
    return [];
  }
  const pair = FEATURE_FILE.test(path)
    ? path.replace(FEATURE_FILE, ".steps.ts")
    : path.replace(STEPS_FILE, ".feature");
  return files.has(pair) ? [] : [{ rule: "e2e-feature-pair" }];
}

// path の違反。置き場所が違えば置き場所の違反だけを返す（中身と対は見ない）。
function findE2eFeatureViolations(
  path: string,
  source: string,
  files: ReadonlySet<string>,
): E2eFeatureViolation[] {
  if (isMisplaced(path)) {
    return [{ rule: "e2e-feature-placement" }];
  }
  return [
    ...(FEATURE_FILE.test(path) ? findFeatureContentViolations(source) : []),
    ...findPairViolations(path, files),
  ];
}

// root の下の apps/e2e の対象のファイル（リポジトリ相対の / 区切り、名前順）。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listE2eTargets(root: string): string[] {
  const walk = (relative: string): string[] => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const path = posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRS.has(entry.name) ? [] : walk(path);
      }
      return entry.isFile() && isTarget(path) ? [path] : [];
    });
  };
  return walk(E2E_DIR).sort();
}

// 違反を「規則: パス(:行)」の文字列にして返す。
function collectE2eFeatureViolations(root: string): string[] {
  const paths = listE2eTargets(root);
  const files = new Set(paths);
  return paths.flatMap((path) =>
    findE2eFeatureViolations(
      path,
      readFileSync(join(root, path), "utf8"),
      files,
    ).map(({ rule, line }) =>
      line === undefined ? `${rule}: ${path}` : `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const DIVIDER = "    # ───── 一覧を開く ─────";
// 業務の言葉だけで、When の前に仕切りのある .feature（must reject の例は、これに違反を 1 つ足す）。
const GOOD_FEATURE = [
  "# 冒頭のコメントは技術の言葉（DB・API）があってもよい",
  "Feature: 画面での Todo の管理",
  "",
  "  Background: 空の Todo 一覧",
  "    Given Todo が 1 件も無い",
  "",
  "  Scenario: 一覧を見る",
  DIVIDER,
  "    When Todo の一覧を開く",
  "    Then 一覧は空で表示される",
];

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "e2e-feature-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const feature = await loadFeature("./e2e-feature.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario(".feature の中身の判定（must pass）", ({ And }) => {
    And(
      "業務の言葉だけで When の前に仕切りがある .feature は違反なし（許すタグ付きのシナリオ・Background の中の When・助数詞付きの 3 桁の数）",
      () => {
        // given
        const cases: [string, string[]][] = [
          ["業務の言葉だけで、When の前に仕切りがある", GOOD_FEATURE],
          [
            "許すタグ（@ブラウザの言語が英語）が付いたシナリオ",
            [
              ...GOOD_FEATURE.slice(0, 6),
              "  @ブラウザの言語が英語",
              ...GOOD_FEATURE.slice(6),
            ],
          ],
          [
            "Background の中の When（仕切りは要らない）",
            [
              "Feature: x",
              "  Background: y",
              "    When Todo の一覧を開く",
              "  Scenario: z",
              DIVIDER,
              "    When Todo の一覧を開く",
            ],
          ],
          [
            "100 文字・101 文字（業務の数。助数詞付きの 3 桁の数）",
            [
              "Feature: x",
              "  Scenario: y",
              "    # ───── 長すぎるタイトルで Todo を作る ─────",
              "    When タイトルを 101 文字にして Todo を作ろうとする",
              "    Then 上限の 100 文字とともに拒否される",
            ],
          ],
        ];

        // when
        const result = casesByName(cases, ([, lines]) =>
          findFeatureContentViolations(source(...lines)),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );
  });

  Scenario(".feature の中身の判定（must reject）", ({ And }) => {
    And(
      "技術の言葉・状態コード・許さないタグを足した行は、その行の違反になる（API・400・skip・許すタグと同じ行の only）",
      () => {
        // given: GOOD_FEATURE（10 行）の後に 11 行目として足す
        const cases: [string, string, E2eFeatureRuleId][] = [
          [
            "step に技術の言葉（API）",
            "    Then API が呼ばれる",
            "e2e-feature-business-language",
          ],
          [
            "step に状態コード",
            "    Then 400 で拒否される",
            "e2e-feature-business-language",
          ],
          ["許さないタグ（@skip）", "  @skip", "e2e-feature-tag"],
          [
            "許すタグと許さないタグ（@only）が同じ行",
            "  @ブラウザの言語が英語 @only",
            "e2e-feature-tag",
          ],
        ];

        // when
        const result = casesByName(cases, ([, line]) =>
          findFeatureContentViolations(source(...GOOD_FEATURE, line)),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , rule]) => [{ rule, line: 11 }]),
        );
      },
    );

    And(
      "仕切りの無い When・形の違う仕切り（─ が 4 つ）の後の When は、When の行の違反",
      () => {
        // given
        const text = source(
          "Feature: x",
          "  Scenario: y",
          "    When Todo の一覧を開く",
          "    # ──── 一覧を開く ────",
          "    When Todo の一覧を開く",
        );

        // when
        const violations = findFeatureContentViolations(text);

        // then
        expect(violations).toEqual([
          { rule: "e2e-feature-section-divider", line: 3 },
          { rule: "e2e-feature-section-divider", line: 5 },
        ]);
      },
    );

    And(
      "仕切りの見出しの技術の言葉は、仕切りの行の違反（コメントでも読者が読む行）",
      () => {
        // given
        const text = source(
          "Feature: x",
          "  Scenario: y",
          "    # ───── POST する ─────",
          "    When Todo の一覧を開く",
        );

        // when
        const violations = findFeatureContentViolations(text);

        // then
        expect(violations).toEqual([
          { rule: "e2e-feature-business-language", line: 3 },
        ]);
      },
    );
  });

  Scenario("置き場所と対の判定", ({ And }) => {
    And("spec/ の直下の .feature と step の対・共有の step は違反なし", () => {
      // given
      const cases: [string, string, string | undefined][] = [
        [
          "spec/ の .feature（対の step あり）",
          "apps/e2e/spec/a.feature",
          "a.steps.ts",
        ],
        [
          "spec/ の step（対の .feature あり）",
          "apps/e2e/spec/a.steps.ts",
          "a.feature",
        ],
        [
          "共有の step（対は要らない）",
          "apps/e2e/spec/shared.steps.ts",
          undefined,
        ],
      ];

      // when
      const result = casesByName(cases, ([, path, pair]) =>
        findE2eFeatureViolations(
          path,
          "",
          new Set(
            pair === undefined ? [path] : [path, `apps/e2e/spec/${pair}`],
          ),
        ),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => []));
    });

    And(
      "手書きのテスト・spec/ の外とサブディレクトリの .feature と step は置き場所の違反だけになる（中身と対は見ない）",
      () => {
        // given
        const cases: [string, string][] = [
          ["直下の手書きの Playwright のテスト", "apps/e2e/todo.spec.ts"],
          [
            "サブディレクトリの手書きのテスト（.js）",
            "apps/e2e/x/todo.spec.js",
          ],
          ["Vitest の名前のテスト", "apps/e2e/spec/x.test.ts"],
          ["apps/e2e の直下の .feature", "apps/e2e/a.feature"],
          ["support/ の step", "apps/e2e/support/a.steps.ts"],
          ["spec/ のサブディレクトリの .feature", "apps/e2e/spec/x/a.feature"],
          ["spec/ のサブディレクトリの step", "apps/e2e/spec/x/a.steps.ts"],
        ];

        // when
        const result = casesByName(cases, ([, path]) =>
          findE2eFeatureViolations(
            path,
            source("Feature: DB", "  Scenario: y", "    When 状態 201 を返す"),
            new Set([path]),
          ),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [{ rule: "e2e-feature-placement" }]),
        );
      },
    );

    And(
      "対の無い .feature と step は対の違反になる（step の無い .feature・名前の違う step しか無い .feature・.feature の無い step）",
      () => {
        // given
        const cases: [string, string][] = [
          ["step の無い .feature", "apps/e2e/spec/a.feature"],
          ["名前の違う step しか無い .feature", "apps/e2e/spec/b.feature"],
          [".feature の無い step", "apps/e2e/spec/c.steps.ts"],
        ];

        // when
        const result = casesByName(cases, ([, path]) =>
          findE2eFeatureViolations(
            path,
            "",
            new Set([path, "apps/e2e/spec/x.steps.ts"]),
          ),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [{ rule: "e2e-feature-pair" }]),
        );
      },
    );
  });

  Scenario("E2E の列挙と検査（fixture）", ({ And }) => {
    And(
      "apps/e2e の下の .feature・step・手書きのテストを対象にし（依存・生成物・出力は除く）、違反を「規則: パス(:行)」で返す",
      () => {
        // given
        const root = fixture({
          "apps/e2e/spec/good.feature": source(...GOOD_FEATURE),
          "apps/e2e/spec/good.steps.ts": "",
          "apps/e2e/spec/shared.steps.ts": "",
          "apps/e2e/spec/wording.feature": source(
            ...GOOD_FEATURE,
            "    And DB に残る",
          ),
          "apps/e2e/spec/wording.steps.ts": "",
          "apps/e2e/spec/lonely.feature": "Feature: x\n",
          "apps/e2e/todo.spec.ts": "",
          "apps/e2e/spec/nested/a.feature": "Feature: a\n",
          "apps/e2e/root.feature": "Feature: r\n",
          // 対象外: 補助・設定、依存・生成物・Playwright の出力の中、apps/e2e の外。
          "apps/e2e/support/database.ts": "",
          "apps/e2e/playwright.config.ts": "",
          "apps/e2e/node_modules/x/x.spec.ts": "",
          "apps/e2e/.features-gen/good.feature.spec.js": "",
          "apps/e2e/test-results/x/x.spec.ts": "",
          "apps/backend/spec/journey/x.feature": "Feature: DB\n",
        });

        // when
        const result = {
          files: listE2eTargets(root),
          violations: collectE2eFeatureViolations(root),
        };

        // then
        expect(result).toEqual({
          files: [
            "apps/e2e/root.feature",
            "apps/e2e/spec/good.feature",
            "apps/e2e/spec/good.steps.ts",
            "apps/e2e/spec/lonely.feature",
            "apps/e2e/spec/nested/a.feature",
            "apps/e2e/spec/shared.steps.ts",
            "apps/e2e/spec/wording.feature",
            "apps/e2e/spec/wording.steps.ts",
            "apps/e2e/todo.spec.ts",
          ],
          violations: [
            "e2e-feature-placement: apps/e2e/root.feature",
            "e2e-feature-pair: apps/e2e/spec/lonely.feature",
            "e2e-feature-placement: apps/e2e/spec/nested/a.feature",
            "e2e-feature-business-language: apps/e2e/spec/wording.feature:11",
            "e2e-feature-placement: apps/e2e/todo.spec.ts",
          ],
        });
      },
    );

    And(
      "apps/e2e が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const root = fixture({ "README.md": "# x\n" });

        // when
        const result = {
          files: listE2eTargets(root),
          violations: collectE2eFeatureViolations(root),
        };

        // then
        expect(result).toEqual({ files: [], violations: [] });
      },
    );
  });

  Scenario("E2E の実ファイル", ({ And }) => {
    // WHY fixtures.ts のタグと突き合わせる: 片方だけを改名すると、この検査は古いタグを通し続ける（reviewer の指摘、Issue #279）。
    And(
      "許すタグは apps/e2e/support/fixtures.ts の ENGLISH_BROWSER_TAG と同じ",
      () => {
        // given
        const fixtures = readFileSync(
          join(repoRoot, E2E_DIR, "support", "fixtures.ts"),
          "utf8",
        );

        // when
        const tag = /const ENGLISH_BROWSER_TAG = "([^"]+)";/.exec(
          fixtures,
        )?.[1];

        // then
        expect([...ALLOWED_TAGS]).toEqual([tag]);
      },
    );

    And(
      "apps/e2e/spec には対になった .feature と step のファイル（と共有の shared.steps.ts）だけがあり、.feature は業務の言葉だけで When の前に仕切りがあり、許すタグだけを使う",
      () => {
        // given
        // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
        const files = listE2eTargets(repoRoot);

        // when
        const violations = collectE2eFeatureViolations(repoRoot);

        // then
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/e2e/spec/shared.steps.ts",
            "apps/e2e/spec/todo.feature",
            "apps/e2e/spec/todo.steps.ts",
          ]),
        );
        expect(violations).toEqual([]);
      },
    );
  });
});
