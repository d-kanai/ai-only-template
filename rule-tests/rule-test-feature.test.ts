// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはファイルを文字列として読むだけで
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

// ルール検査テスト（rule-tests/）を、API 仕様（apps/backend/spec/api/）と同じく .feature（`*` の step）と step の実装に分ける形
//   （daiki の依頼 2026-10-02、Issue #282）を機械的に検査するテスト。
// WHY .feature に分ける: ルール検査テストは規則の仕様そのもの。describe / it の名前がコードの中に散ると、どんな規則を何で
//   止めているかを一覧で読めない。.feature に Scenario（規則のまとまり）と `*` の step（振る舞い 1 つ）を並べ、人が仕様として読む。
//   step の文言がコードとずれると vitest-cucumber が失敗するので、.feature が古くなることも無い。
// 違反にするもの（規則）:
//   - rule-test-feature-pair: rule-tests/ の下の `<名前>.test.ts` と `<名前>.feature` は同じディレクトリに対で置く（片方だけは、
//     置いたファイルの違反）。
//   - rule-test-feature-load: step の実装は対の .feature を `loadFeature("./<名前>.feature")` で読む。
//     WHY: 別の .feature を読むと、対の .feature の step が実行されないまま（vitest-cucumber は読んだ .feature しか照らし合わせない）。
//   - rule-test-feature-no-it: step の実装はファイルの先頭の import で vitest から it / test / describe / suite を import しない
//     （`it as x` の別名も）。WHY: vitest.config.mts は globals を使わないので、import しなければ describe / it を書けない。
//     describe / it で書いたテストは .feature に現れず、仕様の一覧から漏れる。expect・afterAll などのフックは使ってよい。
//   - rule-test-feature-format: .feature の行は `#` のコメント・空行・`Feature:` の見出し（1 つ）・`Scenario:` の見出し・`*` の
//     step だけ。各 Scenario に step が 1 つ以上要る。step の文に先頭のほかの `*` と波かっこ（`{` / `}`）を書かない。
//     WHY `*` だけ（API 仕様の api-spec-step-keyword と同じ）: 1 つの step が前提から検証までの 1 テストで、Given / When / Then の
//       並びを持たない。タグ（`@`）は vitest-cucumber の既定の excludeTags（`@ignore` など）で Scenario を黙って skip させる。
//       Scenario Outline・Background・Rule・説明の行を許すと、仕様の形がファイルごとにばらつく。
//     WHY 文の中の `*` と波かっこを止める（vitest-cucumber 8.0.0 で実測。Issue #282）: 文の中に `*` がある step は、`*` の手前までの
//       文が同じほかの step と同じものとして扱われ、読み込みで ItemAlreadyExistsError になる（`a.b* c` と `a.b* d`）。波かっこは
//       `{string}` / `{int}` などの式として読まれ、別の文の step に一致する（`{int}` を含む 2 つの step が重なった）。どちらも
//       ルール検査テストの step の文には要らないので、書けないようにして読み違いを起こさせない。
// 移していないテスト（PENDING）: 移す PR を分けるので、移していないテストは一覧に載せて検査から外す。一覧にあるのに .feature が
//   あれば、一覧から消し忘れたものとして違反にする（一覧が古くならない）。すべて移したら一覧は空になる。
// 限界: import は先頭の import の並び（コメント・空行を挟んでよい）だけを見る。途中の import・`require`・`import()`・
//   `vitest` の名前空間の import（`import * as v`）の `v.it` は見ない。`Scenario.skip(` / `.only(` は見ない（Biome の
//   noSkippedTests も止めない。今の step の実装には無い）。step が describe / it を使わずに中で検査を回しているか
//   （casesByName の使い方）は見ない（reviewer が見る）。

const RULE_TESTS_DIR = "rule-tests";
const FORBIDDEN_VITEST_IMPORTS = new Set(["it", "test", "describe", "suite"]);

// まだ .feature に移していないルール検査テストの名前（`rule-tests/<名前>.test.ts`）。移したら消す。
const PENDING = new Set([
  "api-journey",
  "instructions",
  "lint",
  "package",
  "pnpm-workspace",
  "settings",
  "test-phases",
  "typecheck",
  "work-logs-check",
]);

// ---- 判定 ----

// ファイルの先頭の import の並び（コメント・空行を飛ばし、最初の import でない文で止める）から、vitest から import した
//   禁止の名前（別名の元の名前）を返す。
function forbiddenVitestImports(source: string): string[] {
  const head = leadingImports(source);
  return [
    ...head.matchAll(
      /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']vitest["']/g,
    ),
  ]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map(
      (specifier) =>
        specifier
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0] ?? "",
    )
    .filter((name) => FORBIDDEN_VITEST_IMPORTS.has(name));
}

// 先頭のコメント（`//` と `/* */`）・空行・import 文の並び。import 文は `;` で終わるまで（複数行を含む）。
function leadingImports(source: string): string {
  const imports: string[] = [];
  let rest = source;
  for (;;) {
    const skipped = rest.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, "");
    const statement = /^import\b[^;]*;/.exec(skipped);
    if (statement === null) return imports.join("\n");
    imports.push(statement[0]);
    rest = skipped.slice(statement[0].length);
  }
}

// `*` の step の行（trim 済み）の文に、先頭のほかの `*` か波かっこがあれば違反を返す。
function stepTextViolations(line: string, number: number): string[] {
  return /[*{}]/.test(line.slice(1))
    ? [`${number} 行目: step の文に「*」か波かっこがある`]
    : [];
}

// .feature の書き方の違反（1 始まりの行の番号つき）。
function featureFormatViolations(feature: string): string[] {
  const violations: string[] = [];
  let features = 0;
  let scenario: { line: number; steps: number } | undefined;
  const closeScenario = () => {
    if (scenario !== undefined && scenario.steps === 0)
      violations.push(`${scenario.line} 行目の Scenario に step が無い`);
  };
  feature.split(/\r\n|\r|\n/).forEach((raw, index) => {
    const line = raw.trim();
    const number = index + 1;
    if (line === "" || line.startsWith("#")) return;
    if (/^Feature:\s*\S/.test(line)) {
      features += 1;
      if (features > 1)
        violations.push(`${number} 行目: Feature の見出しが 2 つ目`);
      return;
    }
    if (/^Scenario:\s*\S/.test(line)) {
      closeScenario();
      scenario = { line: number, steps: 0 };
      return;
    }
    if (/^\*\s+\S/.test(line) && scenario !== undefined) {
      scenario.steps += 1;
      violations.push(...stepTextViolations(line, number));
      return;
    }
    violations.push(
      `${number} 行目: Feature / Scenario の見出し・\`*\` の step・コメントのどれでもない`,
    );
  });
  closeScenario();
  if (features === 0) violations.push("Feature の見出しが無い");
  return violations;
}

// ---- 列挙と検査（本番と fixture で同じ処理を通す） ----

// rule-tests/ の下の *.test.ts と *.feature（再帰。リポジトリ相対の / 区切り、名前順）。
function listRuleTestFiles(root: string): string[] {
  const walk = (relative: string): string[] => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const path = posix.join(relative, entry.name);
      if (entry.isDirectory()) return walk(path);
      return /\.(?:test\.ts|feature)$/.test(path) ? [path] : [];
    });
  };
  return walk(RULE_TESTS_DIR).sort();
}

function collectRuleTestFeatureViolations(
  root: string,
  pending: ReadonlySet<string>,
): string[] {
  const files = new Set(listRuleTestFiles(root));
  return [...files].flatMap((path) => {
    const base = path.replace(/\.(?:test\.ts|feature)$/, "");
    const name = posix.basename(base);
    const isPending =
      posix.dirname(path) === RULE_TESTS_DIR && pending.has(name);
    const isTest = path.endsWith(".test.ts");
    const pair = isTest ? `${base}.feature` : `${base}.test.ts`;
    if (isPending) {
      return isTest && files.has(pair)
        ? [
            `rule-test-feature-pair: ${path} は .feature に移したので、PENDING から ${name} を消す`,
          ]
        : [];
    }
    if (!files.has(pair))
      return [`rule-test-feature-pair: ${path} に対の ${pair} が無い`];
    const source = readFileSync(join(root, path), "utf8");
    if (!isTest)
      return featureFormatViolations(source).map(
        (violation) => `rule-test-feature-format: ${path} の ${violation}`,
      );
    const violations = forbiddenVitestImports(source).map(
      (imported) =>
        `rule-test-feature-no-it: ${path} が vitest から ${imported} を import している`,
    );
    if (!source.includes(`loadFeature("./${name}.feature")`))
      violations.push(
        `rule-test-feature-load: ${path} が loadFeature("./${name}.feature") で対の .feature を読まない`,
      );
    return violations;
  });
}

const repoRoot = join(import.meta.dirname, "..");
const lines = (...parts: string[]) => parts.join("\n");

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rule-test-feature-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const STEPS = (name: string) =>
  lines(
    'import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";',
    'import { expect } from "vitest";',
    `const feature = await loadFeature("./${name}.feature");`,
  );
const FEATURE = lines("Feature: a", "  Scenario: b", "    * c");
const NOTHING_PENDING = new Set<string>();

const feature = await loadFeature("./rule-test-feature.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("対の .feature と step の実装", ({ And }) => {
    And(
      "同じ名前の .feature と .test.ts がそろい、step の実装が対の .feature を読めば違反なし",
      () => {
        // given
        const root = fixture({
          "rule-tests/a.test.ts": STEPS("a"),
          "rule-tests/a.feature": FEATURE,
          "rule-tests/nested/b.test.ts": STEPS("b"),
          "rule-tests/nested/b.feature": FEATURE,
          "rule-tests/case-table.ts": "export function f() {}",
        });

        // when
        const violations = collectRuleTestFeatureViolations(
          root,
          NOTHING_PENDING,
        );

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      ".feature の無い step の実装と、step の実装の無い .feature は、置いたファイルの違反になる",
      () => {
        // given
        const root = fixture({
          "rule-tests/a.test.ts": STEPS("a"),
          "rule-tests/b.feature": FEATURE,
          "rule-tests/nested/c.test.ts": STEPS("c"),
          "rule-tests/c.feature": FEATURE,
        });

        // when
        const violations = collectRuleTestFeatureViolations(
          root,
          NOTHING_PENDING,
        );

        // then
        expect(violations).toEqual([
          "rule-test-feature-pair: rule-tests/a.test.ts に対の rule-tests/a.feature が無い",
          "rule-test-feature-pair: rule-tests/b.feature に対の rule-tests/b.test.ts が無い",
          "rule-test-feature-pair: rule-tests/c.feature に対の rule-tests/c.test.ts が無い",
          "rule-test-feature-pair: rule-tests/nested/c.test.ts に対の rule-tests/nested/c.feature が無い",
        ]);
      },
    );

    And(
      "step の実装が loadFeature で同じ名前の .feature を読まないと違反になる",
      () => {
        // given
        const root = fixture({
          "rule-tests/a.test.ts": STEPS("other"),
          "rule-tests/a.feature": FEATURE,
          "rule-tests/b.test.ts":
            'const feature = await loadFeature("b.feature");',
          "rule-tests/b.feature": FEATURE,
        });

        // when
        const violations = collectRuleTestFeatureViolations(
          root,
          NOTHING_PENDING,
        );

        // then
        expect(violations).toEqual([
          'rule-test-feature-load: rule-tests/a.test.ts が loadFeature("./a.feature") で対の .feature を読まない',
          'rule-test-feature-load: rule-tests/b.test.ts が loadFeature("./b.feature") で対の .feature を読まない',
        ]);
      },
    );
  });

  Scenario("Vitest の describe と it を使わない", ({ And }) => {
    And(
      "vitest から it・test・describe・suite を import すると違反になる（別名も）",
      () => {
        // given
        const cases: [string, string, string[]][] = [
          [
            "it と describe",
            'import { describe, expect, it } from "vitest";',
            ["describe", "it"],
          ],
          [
            "test と suite",
            "import { suite, test } from 'vitest';",
            ["suite", "test"],
          ],
          ["別名", 'import { it as check } from "vitest";', ["it"]],
          [
            "複数行・コメントの後ろ",
            lines(
              "// WHY",
              "/* x */",
              'import { readFileSync } from "node:fs";',
              "import {",
              "  expect,",
              "  it,",
              '} from "vitest";',
            ),
            ["it"],
          ],
        ];

        // when
        const result = casesByName(cases, ([, source]) =>
          forbiddenVitestImports(source),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );

    And("vitest から expect や afterAll などを import するのは違反なし", () => {
      // given
      const cases: [string, string][] = [
        [
          "expect とフック",
          'import { afterAll, beforeEach, expect, vi } from "vitest";',
        ],
        [
          "名前の一部が it",
          'import { item, tests } from "./x";\nimport { expect } from "vitest";',
        ],
        ["vitest 以外の it", 'import { it } from "./x";'],
      ];

      // when
      const result = casesByName(cases, ([, source]) =>
        forbiddenVitestImports(source),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => []));
    });

    And("コードの途中の文字列にある vitest の import は数えない", () => {
      // given
      const source = lines(
        'import { expect } from "vitest";',
        "const sample = 'x';",
        'const fixture = `import { describe, it } from "vitest";`;',
      );

      // when
      const result = forbiddenVitestImports(source);

      // then
      expect(result).toEqual([]);
    });
  });

  Scenario(".feature の書き方", ({ And }) => {
    And(
      "Feature の見出し・Scenario の見出し・箇条書きの step・コメント・空行だけなら違反なし",
      () => {
        // given
        const feature = lines(
          "# 説明",
          "Feature: a",
          "",
          "  Scenario: b",
          "    * c",
          "    # d",
          "  Scenario: e",
          "    * f\r\n",
        );

        // when
        const result = featureFormatViolations(feature);

        // then
        expect(result).toEqual([]);
      },
    );

    And(
      "Given などのキーワードの step・タグ・Scenario Outline・説明の行は、行の番号で違反になる",
      () => {
        // given
        const feature = lines(
          "@tag",
          "Feature: a",
          "  説明の行",
          "  Scenario: b",
          "    Given c",
          "    * d",
          "  Scenario Outline: e",
          "Feature: f",
        );

        // when
        const result = featureFormatViolations(feature);

        // then
        const notAllowed =
          "Feature / Scenario の見出し・`*` の step・コメントのどれでもない";
        expect(result).toEqual([
          `1 行目: ${notAllowed}`,
          `3 行目: ${notAllowed}`,
          `5 行目: ${notAllowed}`,
          `7 行目: ${notAllowed}`,
          "8 行目: Feature の見出しが 2 つ目",
        ]);
      },
    );

    And("step が 1 つも無い Scenario は違反になる", () => {
      // given
      const cases: [string, string, string[]][] = [
        [
          "途中の Scenario",
          lines("Feature: a", "  Scenario: b", "  Scenario: c", "    * d"),
          ["2 行目の Scenario に step が無い"],
        ],
        [
          "最後の Scenario",
          lines("Feature: a", "  Scenario: b", "    * c", "  Scenario: d"),
          ["4 行目の Scenario に step が無い"],
        ],
        [
          "Feature の見出しが無い",
          lines("Scenario: b", "  * c"),
          ["Feature の見出しが無い"],
        ],
        [
          "Scenario の前の step",
          lines("Feature: a", "  * b"),
          [
            "2 行目: Feature / Scenario の見出し・`*` の step・コメントのどれでもない",
          ],
        ],
      ];

      // when
      const result = casesByName(cases, ([, feature]) =>
        featureFormatViolations(feature),
      );

      // then
      expect(result).toEqual(casesByName(cases, ([, , expected]) => expected));
    });

    And(
      "step の文に、先頭のほかの星印か波かっこがあると、行の番号で違反になる",
      () => {
        // given
        const feature = lines(
          "Feature: a",
          "  Scenario: b",
          "    * *.sql を読む",
          "    * {int} 件",
          "    * 閉じかっこ } だけ",
          "    * 「＊」（全角）と（かっこ）と <名前> は書ける",
        );

        // when
        const result = featureFormatViolations(feature);

        // then
        const brace = "step の文に「*」か波かっこがある";
        expect(result).toEqual([
          `3 行目: ${brace}`,
          `4 行目: ${brace}`,
          `5 行目: ${brace}`,
        ]);
      },
    );
  });

  Scenario("まだ移していないルール検査テスト", ({ And }) => {
    And(
      "移していない一覧にあるテストは、.feature が無くても違反にしない",
      () => {
        // given
        const root = fixture({
          "rule-tests/a.test.ts": 'import { it } from "vitest";',
        });

        // when
        const violations = collectRuleTestFeatureViolations(
          root,
          new Set(["a"]),
        );

        // then
        expect(violations).toEqual([]);
      },
    );

    And(
      "移していない一覧にあるのに .feature があれば、一覧から消すよう違反になる",
      () => {
        // given
        const root = fixture({
          "rule-tests/a.test.ts": STEPS("a"),
          "rule-tests/a.feature": FEATURE,
        });

        // when
        const violations = collectRuleTestFeatureViolations(
          root,
          new Set(["a"]),
        );

        // then
        expect(violations).toEqual([
          "rule-test-feature-pair: rule-tests/a.test.ts は .feature に移したので、PENDING から a を消す",
        ]);
      },
    );
  });

  Scenario("ケースの表", ({ And }) => {
    And("ケース名ごとに値をまとめ、同じケース名があれば例外になる", () => {
      // given
      const cases: [string, number][] = [
        ["a", 1],
        ["b", 2],
      ];
      const duplicated: [string, number][] = [
        ["a", 1],
        ["a", 2],
      ];

      // when
      const result = casesByName(cases, ([, value]) => value * 10);
      const action = () => casesByName(duplicated, ([, value]) => value);

      // then
      expect(result).toEqual({ a: 10, b: 20 });
      expect(action).toThrow(new Error("ケース名が重なっている: a"));
    });
  });

  Scenario("実ファイル", ({ And }) => {
    And(
      "ルール検査テストはすべて .feature と step の実装に分かれている",
      () => {
        // given: 実ファイル（repoRoot）と移していない一覧（PENDING）
        // when
        const files = listRuleTestFiles(repoRoot);
        const violations = collectRuleTestFeatureViolations(repoRoot, PENDING);

        // then
        // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
        expect(files).toContain("rule-tests/rule-test-feature.test.ts");
        expect(files).toContain("rule-tests/rule-test-feature.feature");
        expect(violations).toEqual([]);
      },
    );
  });
});
