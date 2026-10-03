// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは YAML を文字列として読むだけで DOM を使わないため、
//   node 環境で動かす。
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

// Issue テンプレート（.github/ISSUE_TEMPLATE/。GitHub の Issue forms）の決まりを検査するルール検査テスト（Issue #113）。
//   使い方（API で Issue を作るときも同じ見出しにする）はスキル pr-flow の手順 1。
// WHY テンプレートにする: Issue の形（目的 / 内容 / 完了条件）は運用で揃えていて、人が GitHub の「New issue」から作ると崩れる。
//   Issue forms（YAML）は項目ごとの入力欄と必須の指定を持ち、選んだテンプレートの labels を Issue に付ける
//   （https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms 。
//   2026-10-03 確認）。
// 違反にするもの（違反の文字列の先頭が規則の名前）:
//   - issue-template-files: .github/ISSUE_TEMPLATE/ には type ラベル（ISSUE_TYPES の 5 つ）ごとの `<type>.yml` と config.yml だけを置く。
//     WHY type ごとに分ける: Issue forms の labels はテンプレートごとの固定値で、入力（ドロップダウン）からラベルを付ける仕組みは無い
//       （上の公式の構文に labels の動的な指定が無い）。1 Issue に type ラベルを 1 つ（.claude/rules/workflow/issue-pr.md）を
//       テンプレートの選択で満たすには type ごとに 1 つ要る。
//     WHY .yml だけ: Markdown のテンプレート（.md）は項目の必須を指定できず、置くと選択肢に並んで形が崩れる。拡張子を 1 通りにする。
//   - issue-template-label: `<type>.yml` のトップレベルの labels はファイル名の type 1 つだけ。
//     WHY: 別のラベルや 2 つ以上だと、type ラベル 1 つの決まりが崩れ、ブランチ名・PR のラベルと食い違う。
//   - issue-template-fields: body の項目は「目的」「内容」「完了条件」「前提」の順で、前提だけ任意（required: false）、ほかは必須
//     （required: true）。どの項目も required を明示する。
//     WHY この 4 つ: 目的 = WHY、内容 = WHAT、完了条件 = テスト = 仕様（CLAUDE.md の 2.）、前提 = 依存する Issue（スレッドのコンテキストは
//       共有されないので、スレッドをまたぐ依存は Issue に書く。.claude/rules/workflow/orchestration.md）。前提は無い Issue が多いので任意。
//     WHY required を明示する: 書かないと任意になり（公式の既定）、必須の付け忘れと区別できない。
//   - issue-template-blank: config.yml の `blank_issues_enabled: false`。
//     WHY: 空の Issue を許すと、テンプレートを通らない（見出しもラベルも無い）Issue を UI から作れる。API で作る Issue は
//       この設定に関係なく作れる（テンプレートを通らない）ので、見出しはスキル pr-flow の手順でそろえる。
// 限界（字句で読む。YAML のパーサを依存に足さない。rule-tests/github-actions.test.ts と同じ理由）:
//   - labels はトップレベル（行頭）の `labels:` の 1 行だけを読む。値はフロー形式（`[feat]`）か 1 つのスカラー（`feat`）。
//     ブロック形式の一覧（次の行の `- feat`）は読まず、空として違反にする（見逃しにはならない）。
//   - body の項目は「`- type:` で始まる行から次の `- type:` の行まで」として読み、その中の `attributes:` の行より後（`validations:` の前）の最初の `label:` と、`validations:` の行より後の最初の
//     `required:` の値を取る（validations の下の階層かはインデントで見ない。validations・attributes の後ろに別のキーを置いてその下に required / label を
//     書くと読み違える）。真偽値は引用符の無い `true` / `false` だけを真偽値として読む。
//     項目の type（textarea / input）、description・placeholder の中身、id は見ない（reviewer が見る）。
//   - テンプレートの name / description（選ぶときに見える説明）が type に合っているかは見ない。
//   - GitHub が実際にフォームとして読めるか（YAML の構文の誤り）は見ない。PR の後に「New issue」の画面で確かめる。

const repoRoot = join(import.meta.dirname, "..");
const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";
const CONFIG = "config.yml";
// .claude/rules/workflow/issue-pr.md の type ラベルと同じ並び。
const ISSUE_TYPES = ["feat", "fix", "docs", "chore", "refactor"];
const EXPECTED_FIELDS: Field[] = [
  { label: "目的", required: true },
  { label: "内容", required: true },
  { label: "完了条件", required: true },
  { label: "前提", required: false },
];

type Field = { label: string; required: boolean | undefined };

// ---- 判定 ----

function expectedFiles(): string[] {
  return [...ISSUE_TYPES.map((type) => `${type}.yml`), CONFIG];
}

function findFileViolations(names: string[]): string[] {
  const expected = expectedFiles();
  const missing = expected
    .filter((name) => !names.includes(name))
    .map((name) => `issue-template-files: ${TEMPLATE_DIR}/${name} が無い`);
  const unexpected = names
    .filter((name) => !expected.includes(name))
    .map(
      (name) =>
        `issue-template-files: ${TEMPLATE_DIR}/${name} は決まった名前（${expected.join(" / ")}）でない`,
    );
  return [...missing, ...unexpected];
}

// 行末のコメント（空白の後の `#`）と前後の空白を外す（引用符は残す）。
// WHY 引用符を残す口を分ける: YAML では `"false"` は文字列、`"[feat]"` は一覧でなく 1 つの文字列なので、真偽値とフロー形式の
//   判定は引用符を外す前の値で行う（reviewer の指摘）。
function plain(text: string): string {
  return text.replace(/\s+#.*$/, "").trim();
}

// plain に加えて、前後の引用符を外す（文字列の値）。
function scalar(text: string): string {
  return plain(text).replace(/^(["'])(.*)\1$/, "$2");
}

// トップレベルの labels の値。無ければ undefined。
function readLabels(yaml: string): string[] | undefined {
  const line = yaml.split(/\r?\n/).find((text) => /^labels\s*:/.test(text));
  if (line === undefined) return undefined;
  const value = plain(line.replace(/^labels\s*:/, ""));
  const flow = /^\[(.*)\]$/.exec(value);
  const items = flow === null ? [value] : (flow[1] ?? "").split(",");
  return items.map(scalar).filter((item) => item !== "");
}

function findLabelViolations(type: string, yaml: string): string[] {
  const labels = readLabels(yaml) ?? [];
  if (labels.length === 1 && labels[0] === type) return [];
  return [
    `issue-template-label: ${TEMPLATE_DIR}/${type}.yml の labels が [${labels.join(", ")}]（${type} の 1 つだけにする）`,
  ];
}

// body の行（トップレベルの `body:` の次の行から、次のトップレベルのキーの前まで）。
// WHY トップレベルのキーで止める: body の後ろに別のキーがあれば、その中の label を項目と読まないため。
function bodyLines(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((text) => /^body\s*:/.test(text));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((text) => /^[^\s#]/.test(text));
  return end === -1 ? rest : rest.slice(0, end);
}

// `- type:` の行ごとに区切った項目の行。最初の `- type:` より前の行は捨てる。
function bodyItems(lines: string[]): string[][] {
  const items: string[][] = [];
  for (const text of lines) {
    if (/^\s*-\s+type\s*:/.test(text)) items.push([]);
    items.at(-1)?.push(text);
  }
  return items;
}

// 行の中で最初に現れるキーの値（plain。無ければ undefined）。
function firstValue(lines: string[], key: string): string | undefined {
  const pattern = new RegExp(`^\\s+${key}\\s*:(.*)$`);
  const line = lines.find((text) => pattern.test(text));
  return line === undefined ? undefined : plain(pattern.exec(line)?.[1] ?? "");
}

// 項目の `attributes:` の行より後で、`validations:` の行より前の行。WHY: 公式の構文では見出しは attributes.label で、
//   項目の直下などに書いた label は見出しにならない（Codex の指摘）。
function attributeLines(item: string[]): string[] {
  const start = item.findIndex((text) => /^\s+attributes\s*:/.test(text));
  if (start === -1) return [];
  const rest = item.slice(start + 1);
  const end = rest.findIndex((text) => /^\s+validations\s*:/.test(text));
  return end === -1 ? rest : rest.slice(0, end);
}

// 項目の `validations:` の行より後の行。WHY: 公式の構文では必須の指定は validations.required で、attributes の下などに
//   書いた required は必須にならない（reviewer の指摘）。
function validationLines(item: string[]): string[] {
  const start = item.findIndex((text) => /^\s+validations\s*:/.test(text));
  return start === -1 ? [] : item.slice(start + 1);
}

function toRequired(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// body の項目の見出し（label）と必須の指定（required）を、書いた順に返す。
function readFields(yaml: string): Field[] {
  return bodyItems(bodyLines(yaml)).map((item) => ({
    label: scalar(firstValue(attributeLines(item), "label") ?? ""),
    required: toRequired(firstValue(validationLines(item), "required")),
  }));
}

function describeFields(fields: Field[]): string {
  return fields
    .map(
      ({ label, required }) =>
        `${label}（${required === undefined ? "必須の指定なし" : required ? "必須" : "任意"}）`,
    )
    .join(" / ");
}

function findFieldViolations(type: string, yaml: string): string[] {
  const fields = readFields(yaml);
  if (JSON.stringify(fields) === JSON.stringify(EXPECTED_FIELDS)) return [];
  return [
    `issue-template-fields: ${TEMPLATE_DIR}/${type}.yml の項目が「${describeFields(fields)}」（「${describeFields(EXPECTED_FIELDS)}」にする）`,
  ];
}

function findBlankViolations(config: string | undefined): string[] {
  const line = (config ?? "")
    .split(/\r?\n/)
    .find((text) => /^blank_issues_enabled\s*:/.test(text));
  const value =
    line === undefined
      ? undefined
      : plain(line.replace(/^blank_issues_enabled\s*:/, ""));
  if (value === "false") return [];
  return [
    `issue-template-blank: ${TEMPLATE_DIR}/${CONFIG} が blank_issues_enabled: false でない`,
  ];
}

// ---- 列挙と全体 ----

function listTemplateFiles(root: string): string[] {
  const dir = join(root, TEMPLATE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

function collectViolations(root: string): string[] {
  const names = listTemplateFiles(root);
  const read = (name: string) =>
    names.includes(name)
      ? readFileSync(join(root, TEMPLATE_DIR, name), "utf8")
      : undefined;
  const perType = ISSUE_TYPES.flatMap((type) => {
    const yaml = read(`${type}.yml`);
    if (yaml === undefined) return [];
    return [
      ...findLabelViolations(type, yaml),
      ...findFieldViolations(type, yaml),
    ];
  });
  return [
    ...findFileViolations(names),
    ...perType,
    ...findBlankViolations(read(CONFIG)),
  ];
}

// ---- テスト ----

// 規則を満たすテンプレート（fixture の土台）。
function validTemplate(type: string): string {
  return [
    `name: ${type}`,
    "description: 説明",
    `labels: [${type}]`,
    "body:",
    "  - type: textarea",
    "    id: why",
    "    attributes:",
    "      label: 目的",
    "      description: なぜ必要か",
    "    validations:",
    "      required: true",
    "  - type: textarea",
    "    id: what",
    "    attributes:",
    "      label: 内容",
    "    validations:",
    "      required: true",
    "  - type: textarea",
    "    id: done",
    "    attributes:",
    "      label: 完了条件",
    "    validations:",
    "      required: true",
    "  - type: textarea",
    "    id: depends",
    "    attributes:",
    "      label: 前提",
    "    validations:",
    "      required: false",
  ].join("\n");
}

let dir: string;

beforeAll(() => {
  // WHY: fixture をリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残る。OS の一時ディレクトリに置いて afterAll で消す。
  dir = mkdtempSync(join(tmpdir(), "issue-template-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const feature = await loadFeature("./issue-template.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("テンプレートの置き場所（issue-template-files）", ({ And }) => {
    And(
      "type ラベルごとの 5 つのテンプレートと config.yml がそろっていれば違反なし",
      () => {
        // given
        const names = [
          "chore.yml",
          "config.yml",
          "docs.yml",
          "feat.yml",
          "fix.yml",
          "refactor.yml",
        ];

        // when
        const result = findFileViolations(names);

        // then
        expect(result).toEqual([]);
      },
    );

    And(
      "足りないテンプレートと、決まった名前でないファイル（Markdown のテンプレート・yaml の拡張子・大文字）を 1 件ずつ違反にする",
      () => {
        // given
        const names = [
          "config.yml",
          "docs.yml",
          "feat.yml",
          "fix.yml",
          "bug_report.md",
          "chore.yaml",
          "Refactor.yml",
        ];

        // when
        const result = findFileViolations(names);

        // then
        expect(result).toEqual([
          "issue-template-files: .github/ISSUE_TEMPLATE/chore.yml が無い",
          "issue-template-files: .github/ISSUE_TEMPLATE/refactor.yml が無い",
          "issue-template-files: .github/ISSUE_TEMPLATE/bug_report.md は決まった名前（feat.yml / fix.yml / docs.yml / chore.yml / refactor.yml / config.yml）でない",
          "issue-template-files: .github/ISSUE_TEMPLATE/chore.yaml は決まった名前（feat.yml / fix.yml / docs.yml / chore.yml / refactor.yml / config.yml）でない",
          "issue-template-files: .github/ISSUE_TEMPLATE/Refactor.yml は決まった名前（feat.yml / fix.yml / docs.yml / chore.yml / refactor.yml / config.yml）でない",
        ]);
      },
    );
  });

  Scenario("テンプレートのラベル（issue-template-label）", ({ And }) => {
    And(
      "labels がファイル名の type ラベル 1 つなら違反なし（括弧の一覧・引用符・括弧なし・行末のコメント）",
      () => {
        // given
        const cases: [string, string][] = [
          ["括弧の一覧", "labels: [feat]"],
          ["引用符", 'labels: ["feat"]'],
          ["単引用符と空白", "labels: [ 'feat' ]"],
          ["括弧なし", "labels: feat"],
          ["行末のコメント", "labels: [feat] # type ラベル"],
          ["キーの後の空白", "labels : [feat]"],
        ];

        // when
        const result = casesByName(cases, ([, line]) =>
          findLabelViolations("feat", `name: x\n${line}\nbody:\n`),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "labels が無い・空・別のラベル・2 つ以上・コメントアウト・body の下にだけある・引用符で囲んだ一覧なら違反にする",
      () => {
        // given
        const cases: [string, string, string][] = [
          ["無い", "name: x\nbody:\n", ""],
          ["空の一覧", "labels: []\n", ""],
          ["値が空", "labels:\n", ""],
          ["ブロック形式の一覧", "labels:\n  - feat\n", ""],
          [
            "引用符で囲んだ一覧（1 つの文字列）",
            'labels: "[feat]"\n',
            "[feat]",
          ],
          ["別のラベル", "labels: [fix]\n", "fix"],
          ["2 つ以上", "labels: [feat, docs]\n", "feat, docs"],
          ["コメントアウト", "# labels: [feat]\n", ""],
          [
            "body の下にだけある",
            "body:\n  - type: textarea\n    labels: [feat]\n",
            "",
          ],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          findLabelViolations("feat", yaml),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , labels]) => [
            `issue-template-label: .github/ISSUE_TEMPLATE/feat.yml の labels が [${labels}]（feat の 1 つだけにする）`,
          ]),
        );
      },
    );
  });

  Scenario("テンプレートの項目（issue-template-fields）", ({ And }) => {
    And(
      "項目が 目的・内容・完了条件・前提 の順で、前提だけ任意なら違反なし",
      () => {
        // given
        const yaml = `${validTemplate("feat")}\n# 末尾のコメント\n`;

        // when
        const result = {
          fields: readFields(yaml),
          violations: findFieldViolations("feat", yaml),
        };

        // then
        expect(result).toEqual({ fields: EXPECTED_FIELDS, violations: [] });
      },
    );

    And(
      "項目が足りない・順が違う・見出しが違う・見出しが attributes の外・必須の指定が違う・必須の指定が無い（validations の外・引用符の文字列を含む）なら違反にする",
      () => {
        // given
        const valid = validTemplate("feat");
        const cases: [string, string, string][] = [
          [
            "前提が無い",
            valid.split("  - type: textarea\n    id: depends")[0] ?? "",
            "目的（必須） / 内容（必須） / 完了条件（必須）",
          ],
          [
            "順が違う",
            valid
              .replace("label: 目的", "label: TMP")
              .replace("label: 内容", "label: 目的")
              .replace("label: TMP", "label: 内容"),
            "内容（必須） / 目的（必須） / 完了条件（必須） / 前提（任意）",
          ],
          [
            "見出しが違う",
            valid.replace("label: 完了条件", "label: 受け入れ条件"),
            "目的（必須） / 内容（必須） / 受け入れ条件（必須） / 前提（任意）",
          ],
          [
            "必須が任意",
            valid.replace("required: true", "required: false"),
            "目的（任意） / 内容（必須） / 完了条件（必須） / 前提（任意）",
          ],
          [
            "前提が必須",
            valid.replace(/required: false$/, "required: true"),
            "目的（必須） / 内容（必須） / 完了条件（必須） / 前提（必須）",
          ],
          [
            "必須の指定が無い",
            valid.replace(
              "      label: 内容\n    validations:\n      required: true",
              "      label: 内容",
            ),
            "目的（必須） / 内容（必須の指定なし） / 完了条件（必須） / 前提（任意）",
          ],
          [
            "required が validations の下に無い",
            // 最初の validations（目的）を外し、required を attributes の下に置く。
            valid.replace(
              "    validations:\n      required: true",
              "      required: true",
            ),
            "目的（必須の指定なし） / 内容（必須） / 完了条件（必須） / 前提（任意）",
          ],
          [
            "label が attributes の下に無い",
            valid.replace(
              "    attributes:\n      label: 内容",
              "    label: 内容\n    attributes:",
            ),
            "目的（必須） / （必須） / 完了条件（必須） / 前提（任意）",
          ],
          [
            "required が引用符の文字列",
            valid.replace("required: true", 'required: "true"'),
            "目的（必須の指定なし） / 内容（必須） / 完了条件（必須） / 前提（任意）",
          ],
          ["body が無い", "name: x\nlabels: [feat]\n", ""],
          [
            "body の後ろの別のキー",
            `${valid}\nextra:\n  - type: textarea\n    attributes:\n      label: 余分`,
            "目的（必須） / 内容（必須） / 完了条件（必須） / 前提（任意）",
          ],
        ];

        // when
        const result = casesByName(cases, ([, yaml]) =>
          findFieldViolations("feat", yaml),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([name, , actual]) =>
            name === "body の後ろの別のキー"
              ? []
              : [
                  `issue-template-fields: .github/ISSUE_TEMPLATE/feat.yml の項目が「${actual}」（「目的（必須） / 内容（必須） / 完了条件（必須） / 前提（任意）」にする）`,
                ],
          ),
        );
      },
    );
  });

  Scenario("空の Issue（issue-template-blank）", ({ And }) => {
    And(
      "config.yml が blank_issues_enabled を false にしていれば違反なし",
      () => {
        // given
        const cases: [string, string][] = [
          ["false", "blank_issues_enabled: false\n"],
          ["行末のコメント", "blank_issues_enabled: false # 理由\n"],
          ["ほかのキーと", "contact_links: []\nblank_issues_enabled: false\n"],
        ];

        // when
        const result = casesByName(cases, ([, config]) =>
          findBlankViolations(config),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "config.yml が無い・true・指定が無い・コメントアウト・引用符の文字列なら違反にする",
      () => {
        // given
        const cases: [string, string | undefined][] = [
          ["無い", undefined],
          ["true", "blank_issues_enabled: true\n"],
          ["指定が無い", "contact_links: []\n"],
          ["コメントアウト", "# blank_issues_enabled: false\n"],
          ["引用符の文字列", 'blank_issues_enabled: "false"\n'],
        ];

        // when
        const result = casesByName(cases, ([, config]) =>
          findBlankViolations(config),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, () => [
            "issue-template-blank: .github/ISSUE_TEMPLATE/config.yml が blank_issues_enabled: false でない",
          ]),
        );
      },
    );
  });

  Scenario("実ファイル", ({ And }) => {
    // 列挙 → 読み取り → 判定を、本番と同じ collectViolations で一時ディレクトリから通す（判定だけ正しくても、列挙や読み取りが
    //   漏れれば違反は見逃されるため。.claude/rules/quality/testing.md の「ルール検査テスト」）。
    And(
      "一時ディレクトリの .github/ISSUE_TEMPLATE から、規則ごとの違反をすべて検出する",
      () => {
        // given
        const root = join(dir, "repo");
        const files: Record<string, string> = {
          "feat.yml": validTemplate("feat"),
          "fix.yml": validTemplate("feat"),
          "docs.yml": validTemplate("docs").replace(
            "label: 前提",
            "label: 依存",
          ),
          "chore.yml": validTemplate("chore"),
          "config.yml": "blank_issues_enabled: true\n",
          "question.md": "---\nname: 質問\n---\n",
        };
        mkdirSync(join(root, TEMPLATE_DIR), { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          writeFileSync(join(root, TEMPLATE_DIR, name), content);
        }

        // when
        const result = collectViolations(root);

        // then
        expect(result).toEqual([
          "issue-template-files: .github/ISSUE_TEMPLATE/refactor.yml が無い",
          "issue-template-files: .github/ISSUE_TEMPLATE/question.md は決まった名前（feat.yml / fix.yml / docs.yml / chore.yml / refactor.yml / config.yml）でない",
          "issue-template-label: .github/ISSUE_TEMPLATE/fix.yml の labels が [feat]（fix の 1 つだけにする）",
          "issue-template-fields: .github/ISSUE_TEMPLATE/docs.yml の項目が「目的（必須） / 内容（必須） / 完了条件（必須） / 依存（任意）」（「目的（必須） / 内容（必須） / 完了条件（必須） / 前提（任意）」にする）",
          "issue-template-blank: .github/ISSUE_TEMPLATE/config.yml が blank_issues_enabled: false でない",
        ]);
      },
    );

    And("リポジトリの Issue テンプレートに違反が無い", () => {
      // given: 前提なし（対象はリポジトリの .github/ISSUE_TEMPLATE）
      // when
      const result = {
        files: listTemplateFiles(repoRoot),
        violations: collectViolations(repoRoot),
      };

      // then
      // WHY 一覧も比べる: 列挙が 0 件なら、ファイルの規則が「無い」を出すので緑にはならないが、置いたものを一目で分かるようにする。
      expect(result).toEqual({
        files: [...expectedFiles()].sort(),
        violations: [],
      });
    });
  });
});
